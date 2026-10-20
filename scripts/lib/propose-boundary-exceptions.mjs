import fs from 'node:fs/promises';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {sentenceTextHash,passageTextHash} from './acoustic-evidence.mjs';
import {sentenceTimingLowerBound} from './sentence-timing-bounds.mjs';

// Read-only, per-ID evidence proposals. This intentionally has no apply flag
// and does not alter the strict audit or the production application channel.
const planFile='data/references/acoustic-application-plan.json',planBytes=await fs.readFile(planFile),plan=JSON.parse(planBytes),planSha256=sha256(planBytes);
const missingFile='data/references/missing-acoustic-evidence.json',missingBytes=await fs.readFile(missingFile),missing=JSON.parse(missingBytes);
const openingSummary=await readJson('data/references/expanded-passage-opening-summary.json');
const folder=`data/references/acoustic-boundary-exceptions/${plan.runId}`;await fs.mkdir(`${folder}/reports`,{recursive:true});
await fs.writeFile(`${folder}/source-plan.json`,planBytes);await fs.writeFile(`${folder}/missing-evidence.json`,missingBytes);
const paperCache=new Map(),reports=new Map();
async function paperFor(id){if(!paperCache.has(id)){const file=`data/papers/${id}.json`,bytes=await fs.readFile(file);paperCache.set(id,{file,bytes,sha256:sha256(bytes),paper:JSON.parse(bytes)});}return paperCache.get(id);}
async function freezeReport(file,expectedHash){
 const key=`${file}:${expectedHash}`;if(reports.has(key))return reports.get(key);
 const bytes=await fs.readFile(file),hash=sha256(bytes);if(expectedHash&&hash!==expectedHash)throw new Error('Evidence changed while freezing boundary proposals');
 const archivedReport=`${folder}/reports/${hash}.json`;await fs.writeFile(archivedReport,bytes);const result={file,sha256:hash,archivedReport,value:JSON.parse(bytes)};reports.set(key,result);return result;
}
const ceilMillis=x=>Math.max(0,Math.ceil((x-1e-9)*1000)/1000),floorMillis=x=>Math.floor((x+1e-9)*1000)/1000;
const valid=s=>Number.isFinite(s?.start)&&Number.isFinite(s?.end)&&s.end>s.start;
function geometry(paper,id,candidate,mode){
 const planned=new Map(plan.papers.find(p=>p.paperId===paper.id)?.passages.flatMap(p=>p[mode]||[]).map(s=>[s.sentenceId,s])||[]);
 const sequence=paper.passages.flatMap(p=>p.sentences.map(s=>({id:s.id,text:s.text,start:s.start,end:s.end,passageId:p.id,...(planned.has(s.id)?{start:planned.get(s.id).start,end:planned.get(s.id).end,basis:'hypothetical-strict-plan-after-review'}:{basis:'current-saved-time'})})));
 const index=sequence.findIndex(s=>s.id===id),previous=sequence.slice(0,index).findLast(valid)||null,next=sequence.slice(index+1).find(valid)||null;
 const conflicts=[];if(previous&&candidate.start<previous.end)conflicts.push({kind:'previous-sentence-overlap',sentenceId:previous.id,previousEnd:previous.end,candidateStart:candidate.start,actualSpeechAlsoOverlaps:candidate.acousticStart<previous.end});
 if(next&&candidate.end>next.start)conflicts.push({kind:'next-sentence-overlap',sentenceId:next.id,candidateEnd:candidate.end,nextStart:next.start,actualSpeechAlsoOverlaps:candidate.acousticEnd>next.start});
 return {mode,previous,next,conflicts,geometricallyPossibleWithoutMovingNeighbors:conflicts.length===0};
}
const reasons={
 'cet6-2022-12-2-p-12-3-s3':'完整CTC首末词分数高；独立贪心实际为SEBWAY CUSTOMARIS，来源与Whisper为subway customers。全局贪心文字匹配却延伸到口播问题，故strict仍拒绝；仅提真实强制词边界，不能据此宣称贪心锚点通过。',
 'cet6-2022-12-2-p-19-1-s3':'末词独立贪心拼为DANGEROUCE，使末端文字锚点失败；真实CTC危险词边界及首尾词分数尚可，Whisper和第二原文均对应dangerous。',
 'cet6-2023-06-2-p-16-4-s1':'首尾连续词锚点均有；内部CYBELOAFING、WORK A TURN OVER的拼写/拆词使严格全文WER超限。保留词文争议和原严格拒绝。',
 'cet6-2024-06-1-p-1-12-s5':'首尾连续词锚点均有；内部TO强制分数低，贪心为A。第二原文及Whisper保留to，不据边界提案改词。',
 'cet6-2024-06-1-p-9-2-s2':'首尾声学边界高分；内部姓名/机构及ONLINE拆词造成全文贪心差异，不能以此认可姓名拼写或全文已核验。',
 'cet6-2024-06-1-p-9-3-s1':'首词高分、末词PROCESSED .845；贪心末词为PROCESS，Monteiro另有拼写差异。仅提边界，不将截词/专名差异当作归一化等价。',
 'cet6-2024-06-1-p-12-3-s2':'首尾连续词锚点高分；内部ZHU姓名分数低，贪心为JU，另有MEHTA/INCENTIVE拼写差异，严格通道保持拒绝。',
 'cet6-2025-06-1-p-9-3-s1':'首词RESEARCHERS和末词IT声学分数高；紧随的TAREK及多个人名贪心不同，首二词文字锚点失败，来源也保留异文。仅恢复可听边界候选，不裁决姓名。',
 'cet6-2025-12-2-p-19-2-s3':'首尾连续词锚点高分；内部THAT .302/贪心AP，第二来源THE。保留该内部词争议，候选边界不能证明本地THAT正确。',
 'cet6-2026-06-2-p-16-2-s2':'首尾声学词分数高；贪心把MASTERING作MUSTERING、COUNTERINTUITIVE拆成COUNTER INTUITIVE，严格全文WER及末锚点不通过。PDF及Whisper对应本地文本。',
};
const items=[];
for(const original of missing.items){
 const loaded=await paperFor(original.paperId),paper=loaded.paper,passage=paper.passages.find(p=>p.id===original.passageId),index=passage.sentences.findIndex(s=>s.id===original.sentenceId),sentence=passage.sentences[index];
 if(sentence.start!==0||sentence.end!==0||sentence.text!==original.text)throw new Error('Missing sentence changed since evidence collection');
 const sourcePlanPaper=plan.papers.find(p=>p.paperId===paper.id);if(sourcePlanPaper?.paperSha256!==loaded.sha256)throw new Error('Current paper differs from frozen main plan');
 const base={paperId:paper.id,passageId:passage.id,sentenceId:sentence.id,text:sentence.text,textSha256:sentenceTextHash(sentence),referenceTextSha256:passageTextHash(passage),paperSha256:loaded.sha256,
  current:structuredClone(sentence),audioAssetId:paper.audioAssetId,mediaSha256:original.mediaSha256,sourceRange:{start:passage.start,end:passage.end},strictSupported:original.ctc.supportedCandidate,strictClassification:original.ctc.classification,
  transcriptDisputesRetained:true,humanListeningClaimed:false,preserveReviewedFalse:true,qualityUpgradeAllowed:false};
 if(original.ctc.supportedCandidate){
  const p=sourcePlanPaper.passages.find(p=>p.passageId===passage.id);items.push({...base,status:'handled-only-by-strict-main-plan',mainPlanAfterReviewCandidate:p.afterReviewSafe.find(s=>s.sentenceId===sentence.id)||null,mainPlanDeferredReasons:p.afterReviewDeferred.find(s=>s.sentenceId===sentence.id)?.reasons||[]});continue;
 }
 const ctc=await freezeReport(original.ctc.file,original.ctc.sha256),raw=ctc.value.sentences.find(s=>s.id===sentence.id);
 if(raw?.text!==sentence.text||ctc.value.referenceTextSha256!==passageTextHash(passage)||ctc.value.lexicalNormalizationVersion!==3)throw new Error('Boundary exception requires current complete V3 evidence');
 let acousticStart=raw.acousticStart,acousticEnd=raw.acousticEnd,expandedOpeningEvidence=null;
 if(sentence.id==='cet6-2022-12-1-p-22-1-s1'){
  const summary=openingSummary.items.find(i=>i.sentenceId===sentence.id)?.expandedOpeningEvidence;
  const expanded=await freezeReport('data/opening-review/cet6-2022-12-1/passage-7.json',summary?.reportSha256),value=expanded.value;
  if(value.schemaVersion!==2||value.originalText!==sentence.text||value.referenceTextSha256!==sentenceTextHash(sentence)||value.mediaSha256!==original.mediaSha256||value.originalPassageRange.start!==passage.start||value.originalPassageRange.end!==passage.end||!summary?.currentEvidenceFresh||!summary.independentFourWordAnchorSupported||!summary.openingWordScores.originalThresholdsSupported)throw new Error('Expanded Throwing opening is not current complete V2 evidence');
  acousticStart=value.sentences[0].words[0].start;expandedOpeningEvidence={file:expanded.file,sha256:expanded.sha256,archivedReport:expanded.archivedReport,sourceRange:value.sourceRange,originalPassageRange:value.originalPassageRange,firstTwelveWords:value.sentences[0].words,greedy:value.greedyTranscript,summary};
 }
 const boundaryStartScore=expandedOpeningEvidence?.firstTwelveWords[0].score??raw.firstWordScore,boundaryEndScore=raw.lastWordScore;
 const proposed={start:ceilMillis(Math.max(sentenceTimingLowerBound(passage,index),acousticStart-.12)),end:floorMillis(Math.min(passage.end,acousticEnd+.16)),acousticStart,acousticEnd,
  startBasis:expandedOpeningEvidence?'expanded-original-media-V2-first-word':'complete-passage-V3-first-word',endBasis:'complete-passage-V3-last-word',parentRangeChanged:false,wordEvidenceMoved:false};
 const boundaryScoresSufficient=boundaryStartScore>=.8&&boundaryEndScore>=.8;
 const reason=expandedOpeningEvidence?'主报告首词THROWING仅.749且被原p.start裁去40ms；从原完整媒体前扩2秒的V2报告有首词.9995、首12词mean.96254/min.83232及独立四词连续锚点。只用扩窗首词1367.26与主报告真实末词1375.265联合提案，不移动原p.start/sourceRange。':reasons[sentence.id]||'边界首词或末词低于原声学门槛；暂不提出可采纳例外。';
 const currentGeometry=geometry(paper,sentence.id,proposed,'none'),afterMainReviewGeometry=geometry(paper,sentence.id,proposed,'afterReviewSafe');
 const warnings=[...original.ctc.tags];if(!boundaryScoresSufficient)warnings.push('boundary-score-still-below-original-threshold');if(afterMainReviewGeometry.conflicts.length)warnings.push('neighbor-conflict-must-remain-deferred');
 items.push({...base,status:boundaryScoresSufficient?'boundary-only-proposal-awaiting-exact-root-approval':'held-low-boundary-score',reason,proposed,boundaryScores:{first:boundaryStartScore,last:boundaryEndScore},
  ctcEvidence:{file:ctc.file,sha256:ctc.sha256,archivedReport:ctc.archivedReport,fullSentence:raw,strictAudit:original.ctc},expandedOpeningEvidence,whisperEvidence:original.whisper,secondSource:original.secondSource,
  currentGeometry,afterMainReviewGeometry,warnings,approvalRequiredFields:['sentenceId','textSha256','paperSha256','ctcEvidence.sha256','expandedOpeningEvidence.sha256 (when present)','proposed.start','proposed.end','individualReason'],
  applicationPolicy:'Strict主通道保持拒绝。本文件仅是逐ID边界提案；须根代理单独批准冻结行后手动精确应用。文字争议/warnings和原0时间保留，reviewed=false，quality不升级；邻居冲突跳过，不挪邻居。'});
}
for(const p of paperCache.values())if(sha256(await fs.readFile(p.file))!==p.sha256)throw new Error('Paper changed during read-only proposal audit');
const proposals=items.filter(i=>i.status==='boundary-only-proposal-awaiting-exact-root-approval'),held=items.filter(i=>i.status==='held-low-boundary-score');
const report={schemaVersion:1,generatedAt:new Date().toISOString(),readOnly:true,papersWritten:0,sourcePlan:{file:planFile,runId:plan.runId,sha256:planSha256,archivedFile:`${folder}/source-plan.json`},sourceMissingEvidence:{file:missingFile,sha256:sha256(missingBytes),archivedFile:`${folder}/missing-evidence.json`},
 totals:{missingSentences:items.length,strictMainChannel:items.filter(i=>i.strictSupported).length,strictlyUnsupported:items.filter(i=>!i.strictSupported).length,boundaryOnlyProposals:proposals.length,lowBoundaryHeld:held.length,geometricallyPossibleAfterMainReview:proposals.filter(i=>i.afterMainReviewGeometry.geometricallyPossibleWithoutMovingNeighbors).length,neighborDeferredAfterMainReview:proposals.filter(i=>!i.afterMainReviewGeometry.geometricallyPossibleWithoutMovingNeighbors).length},
 notes:['不新增任何strict绕过或apply选项；此脚本不写papers。','根代理的证据裁决不等同人工听校；全部文字差异和强制词分数限制保留。','afterReview几何仅在主计划所有候选都另获批准并实际成功应用的假设下比较；真实应用须再次CAS核验并检查实际邻居。'],items};
await writeJson(`${folder}/proposals.json`,report);await writeJson('data/references/acoustic-boundary-exception-proposals.json',report);
console.log(JSON.stringify({totals:report.totals,sourcePlanRunId:plan.runId,proposals:proposals.map(i=>({id:i.sentenceId,start:i.proposed.start,end:i.proposed.end,readyAfterMainReview:i.afterMainReviewGeometry.geometricallyPossibleWithoutMovingNeighbors,conflicts:i.afterMainReviewGeometry.conflicts})),held:held.map(i=>({id:i.sentenceId,boundaryScores:i.boundaryScores}))},null,2));
