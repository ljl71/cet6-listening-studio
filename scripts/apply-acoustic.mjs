import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runAudit,auditPassage,THRESHOLDS} from './lib/audit-acoustic.mjs';
import {readJson,writeJson,sha256} from './lib/corpus.mjs';
import {sentenceTextHash,verifyCurrentAcousticEvidence} from './lib/acoustic-evidence.mjs';
import {planAcousticPassage} from './lib/plan-acoustic-updates.mjs';
import {previousTimedSentenceEnd} from './lib/sentence-timing-bounds.mjs';
import {validateApprovalDocument,approvalMatchesCurrent} from './lib/acoustic-approval.mjs';
import {validatePaper} from '../server/validation.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const data=path.join(root,'data');
const relativeData=file=>path.relative(data,file).replaceAll('\\','/');
const countReasons=items=>items.reduce((counts,item)=>{for(const reason of item.reasons)counts[reason]=(counts[reason]||0)+1;return counts;},{});
const readBytes=async file=>{const bytes=await fs.readFile(file);return {bytes,value:JSON.parse(bytes),sha256:sha256(bytes)};};

export async function buildAcousticPlan({approval=null}={}){
 const sourceAudit=runAudit({root,output:path.join(data,'references','acoustic-application-source-audit.json')});
 const assets=await readJson(path.join(data,'assets.json'));
 const completion=await readJson(path.join(data,'references','missing-alignment-completion.json'),{changes:[]});
 const protectedIds=new Set(completion.changes.map(c=>c.sentenceId));
 const runId=new Date().toISOString().replace(/[:.]/g,'-');
 const report={schemaVersion:1,runId,generatedAt:new Date().toISOString(),readOnly:true,thresholds:THRESHOLDS,
  rule:'只提出strict audit通过的CTC候选；原缺时或大于2秒漂移另列待听审。7句补缺与人工勾选句受保护。仅相邻两句均有采纳证据时收回padding，共享点不得跨声学词边界；与旧/证据不足邻句冲突则暂缓。',
  sourceAuditProgress:sourceAudit.progress,totals:{papers:0,completedPassages:0,strictlySupported:0,normalSafe:0,selectedSafe:0,approvedReviewSafe:0,requiresListening:0,afterReviewSafe:0,protected:0},
  approvalCheck:{file:approval?.file||null,sha256:approval?.sha256||null,submitted:approval?.rows.size||0,matchingSentenceIds:[],staleOrPending:[]},deferredReasonCounts:{},papers:[]};
 for(const file of(await fs.readdir(path.join(data,'papers'))).filter(f=>f.endsWith('.json')).sort()){
  const snapshot=await readBytes(path.join(data,'papers',file));const paper=snapshot.value;const asset=assets[paper.audioAssetId];
  const item={paperId:paper.id,paperFile:`papers/${file}`,paperSha256:snapshot.sha256,audioAssetId:paper.audioAssetId,mediaSha256:asset?.sha256,passages:[]};
  report.totals.papers++;
  for(const passage of paper.passages){
   const checked=sourceAudit.passages.find(p=>p.passageId===passage.id);
   if(checked?.status!=='completed')continue;
   const evidenceFile=path.join(data,'acoustic-review',paper.id,`passage-${passage.order}.json`);
   const source=await readBytes(evidenceFile);
   const audit=auditPassage(paper,passage,source.value,asset);
   if(audit.status!=='completed'||!sourceAudit.mediaHashChecks[paper.audioAssetId]?.ok)continue;
   report.totals.completedPassages++;
   const approvedReviewIds=new Set();
   if(approval)for(const sentence of passage.sentences){const row=approval.rows.get(sentence.id);if(!row)continue;
    if(approvalMatchesCurrent(row,paper,passage,sentence,source.value,source.sha256,relativeData(evidenceFile))){approvedReviewIds.add(sentence.id);report.approvalCheck.matchingSentenceIds.push(sentence.id);}
   }
   const previousSentenceEnd=previousTimedSentenceEnd(paper,passage);
   const normal=planAcousticPassage(passage,audit,source.value,{protectedIds,previousSentenceEnd});
   const selected=planAcousticPassage(passage,audit,source.value,{protectedIds,approvedReviewIds,previousSentenceEnd});
   const afterReview=planAcousticPassage(passage,audit,source.value,{protectedIds,includeReviewCandidates:true,previousSentenceEnd});
   const decorate=candidate=>{
    const sentence=passage.sentences.find(s=>s.id===candidate.sentenceId);
    const row=audit.sentences.find(s=>s.id===sentence.id);
    const raw=source.value.sentences.find(s=>s.id===sentence.id);
    return {...candidate,text:sentence.text,before:{start:sentence.start,end:sentence.end},sentenceTextSha256:sentenceTextHash(sentence),
     score:row.score,greedy:row.independentTranscript,deltaFromCurrent:row.deltaFromCurrent,
     firstWords:raw.words.slice(0,2),lastWords:raw.words.slice(-2),textCorrection:sentence.textCorrection||null,
     acousticEvidence:{schemaVersion:1,supportedCandidate:true,sentenceId:sentence.id,audioAssetId:paper.audioAssetId,mediaSha256:asset.sha256,
      sourceRange:source.value.sourceRange,pcmSha256:source.value.pcmSha256,sentenceTextSha256:sentenceTextHash(sentence),
      referenceTextSha256:audit.referenceTextSha256,method:source.value.method,model:source.value.model,lexicalNormalizationVersion:source.value.lexicalNormalizationVersion||1,
      report:`references/acoustic-evidence/${source.sha256}.json`,reportSha256:source.sha256,liveReport:relativeData(evidenceFile),
      acousticStart:raw.acousticStart,acousticEnd:raw.acousticEnd,appliedTiming:{start:candidate.start,end:candidate.end},
      previousTiming:{start:sentence.start,end:sentence.end},previousAlignmentEvidence:sentence.alignmentEvidence||null,
      previousTimingWarnings:sentence.timingWarnings||[],paddingAdjustments:candidate.paddingAdjustments,
      scores:row.score,independentGreedy:row.independentTranscript,requiresListening:row.requiresListeningBeforeApplication,
      ...(approvedReviewIds.has(sentence.id)?{candidateApproval:{file:approval.file,sha256:approval.sha256,reviewer:approval.document.reviewer,sourcePlanRunId:approval.document.sourcePlanRunId,decision:'approve-candidate-timing-only'}}:{}),
      applicationReport:`references/acoustic-applications/${runId}/plan.json`,backup:`references/acoustic-applications/${runId}/before/${file}`}};
   };
   const normalSafe=normal.accepted.map(decorate),selectedSafe=selected.accepted.map(decorate),afterReviewSafe=afterReview.accepted.map(decorate);
   const requiresListening=audit.sentences.filter(s=>s.supportedCandidate&&s.requiresListeningBeforeApplication).map(row=>{
    const raw=source.value.sentences.find(s=>s.id===row.id);const s=passage.sentences.find(s=>s.id===row.id);
    return {sentenceId:row.id,text:row.text,current:row.current,acoustic:row.acoustic,deltaFromCurrent:row.deltaFromCurrent,score:row.score,greedy:row.independentTranscript,firstWords:raw.words.slice(0,2),lastWords:raw.words.slice(-2),textCorrection:s.textCorrection||null,
     possibleAfterReview:afterReview.accepted.some(c=>c.sentenceId===row.id),deferredReasons:afterReview.deferred.find(c=>c.sentenceId===row.id)?.reasons||[],protected:protectedIds.has(row.id)};
   });
   item.passages.push({passageId:passage.id,order:passage.order,sourceRange:{start:passage.start,end:passage.end},evidenceFile:relativeData(evidenceFile),evidenceSha256:source.sha256,
    referenceTextSha256:audit.referenceTextSha256,normalSafe,selectedSafe,requiresListening,afterReviewSafe,normalDeferred:normal.deferred,selectedDeferred:selected.deferred,afterReviewDeferred:afterReview.deferred,
    normalPaddingAdjustments:normal.paddingAdjustments,afterReviewPaddingAdjustments:afterReview.paddingAdjustments});
   report.totals.strictlySupported+=audit.sentences.filter(s=>s.supportedCandidate).length;
   report.totals.normalSafe+=normalSafe.length;report.totals.selectedSafe+=selectedSafe.length;report.totals.approvedReviewSafe+=selectedSafe.filter(c=>c.requiresListening).length;report.totals.requiresListening+=requiresListening.length;report.totals.afterReviewSafe+=afterReviewSafe.length;
   report.totals.protected+=audit.sentences.filter(s=>protectedIds.has(s.id)).length;
  }
  report.papers.push(item);
 }
 report.deferredReasonCounts=countReasons(report.papers.flatMap(p=>p.passages.flatMap(p=>p.normalDeferred)));
 if(approval)for(const row of approval.rows.values())if(!report.approvalCheck.matchingSentenceIds.includes(row.sentenceId))report.approvalCheck.staleOrPending.push({sentenceId:row.sentenceId,paperId:row.paperId,passageId:row.passageId,reason:'当前完整来源报告、文字或证据hash未与该审批匹配；不沿用批准。'});
 return report;
}

async function loadApproval(file){
 if(!file)return null;const loaded=await readBytes(path.resolve(file));const document=loaded.value;
 const candidates=[path.join(data,'references','acoustic-application-plans',`${document.sourcePlanRunId}.json`),path.join(data,'references','acoustic-application-plan.json')];let source;
 for(const candidate of candidates){try{const snapshot=await readBytes(candidate);if(snapshot.sha256===document.sourcePlanSha256){source=snapshot;break;}}catch(error){if(error.code!=='ENOENT')throw error;}}
 if(!source)throw new Error('无法找到审批所依据的原始计划及其匹配SHA256');
 const rows=validateApprovalDocument(document,source.value,source.sha256);
 const archive=path.join(data,'references','acoustic-application-plans',`${document.sourcePlanRunId}.json`);await fs.mkdir(path.dirname(archive),{recursive:true});await fs.writeFile(archive,source.bytes);
 return {...loaded,file:relativeData(path.resolve(file)),document,rows};
}

async function applyPlan(plan,{fromPlan}={}){
 if(!fromPlan)throw new Error('应用必须传 --from-plan=已审阅的计划文件；默认运行只生成dry-run。');
 const reviewed=await readJson(path.resolve(fromPlan));
 const allowed=new Map();
 for(const p of reviewed.papers)for(const passage of p.passages)for(const candidate of [...passage.normalSafe,...(passage.selectedSafe||[]),...passage.afterReviewSafe]){
  if(!allowed.has(candidate.sentenceId))allowed.set(candidate.sentenceId,[]);allowed.get(candidate.sentenceId).push(candidate);
 }
 const oldPaperHashes=new Map(reviewed.papers.map(p=>[p.paperId,p.paperSha256]));
 const sourceHashes=new Map(reviewed.papers.flatMap(p=>p.passages.map(p=>[p.passageId,p.evidenceSha256])));
 const assets=await readJson(path.join(data,'assets.json'));const prepared=[];const skipped=[];
 const approvedReviewIds=new Set(plan.approvalCheck.matchingSentenceIds);
 for(const item of plan.papers){
  const updates=item.passages.flatMap(p=>p.selectedSafe);
  if(!updates.length)continue;
  if(oldPaperHashes.get(item.paperId)!==item.paperSha256){skipped.push({paperId:item.paperId,reason:'reviewed-paper-hash-changed'});continue;}
  const old=await readBytes(path.join(data,item.paperFile));if(old.sha256!==item.paperSha256){skipped.push({paperId:item.paperId,reason:'paper-changed-during-plan'});continue;}
  const paper=structuredClone(old.value);const active=[];
  for(const passage of paper.passages){const proposed=item.passages.find(p=>p.passageId===passage.id);if(!proposed)continue;
   if(!proposed.selectedSafe.length)continue;
   if(sourceHashes.get(passage.id)!==proposed.evidenceSha256){skipped.push({passageId:passage.id,reason:'reviewed-evidence-hash-changed'});continue;}
   let reason=null;
   for(const candidate of proposed.selectedSafe){
    const prior=allowed.get(candidate.sentenceId)?.find(c=>c.sentenceTextSha256===candidate.sentenceTextSha256&&c.start===candidate.start&&c.end===candidate.end);
    if(!prior){reason='candidate-not-in-reviewed-plan';break;}
    if(candidate.requiresListening&&!approvedReviewIds.has(candidate.sentenceId)){reason='missing-exact-candidate-approval';break;}
   }
   if(reason){skipped.push({passageId:passage.id,reason});continue;}
   const evidence=await fs.readFile(path.join(data,proposed.evidenceFile));
   if(sha256(evidence)!==proposed.evidenceSha256){skipped.push({passageId:passage.id,reason:'live-evidence-changed-during-plan'});continue;}
   active.push({...proposed,evidence});
   for(const candidate of proposed.selectedSafe){
    const sentence=passage.sentences.find(s=>s.id===candidate.sentenceId);
    sentence.start=candidate.start;sentence.end=candidate.end;sentence.acousticEvidence=candidate.acousticEvidence;sentence.timingWarnings=[];
   }
  }
  if(!active.length)continue;
  try{validatePaper(paper);}catch(error){skipped.push({paperId:item.paperId,reason:'combined-candidates-failed-validation',error:error.message});continue;}
  prepared.push({item,paper,old,active});
 }
 const folder=path.join(data,'references','acoustic-applications',plan.runId);
 await fs.mkdir(path.join(folder,'before'),{recursive:true});await writeJson(path.join(folder,'plan.json'),{...plan,readOnly:false,approvedReviewIds:[...approvedReviewIds]});
 for(const {active}of prepared)for(const p of active){
   const destination=path.join(data,'references','acoustic-evidence',`${p.evidenceSha256}.json`);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,p.evidence);
  }
 const result={generatedAt:new Date().toISOString(),papers:0,sentences:0,approvedReviewSentences:0,backup:relativeData(folder),applied:[],skipped};
 for(const {item,paper,old,active}of prepared){
  let valid=true;
  for(const p of paper.passages)for(const s of p.sentences)if(active.find(x=>x.passageId===p.id)?.selectedSafe.some(x=>x.sentenceId===s.id)&&!await verifyCurrentAcousticEvidence(s,paper,p,assets[paper.audioAssetId],data)){valid=false;skipped.push({sentenceId:s.id,reason:'archived-evidence-verification-failed'});}
  if(!valid)continue;
  const current=await fs.readFile(path.join(data,item.paperFile));if(sha256(current)!==old.sha256){skipped.push({paperId:item.paperId,reason:'paper-changed-before-write'});continue;}
  await fs.writeFile(path.join(folder,'before',path.basename(item.paperFile)),old.bytes);await writeJson(path.join(data,item.paperFile),paper);
  const applied=active.flatMap(p=>p.selectedSafe.map(c=>({sentenceId:c.sentenceId,before:c.before,after:{start:c.start,end:c.end},requiresListening:c.requiresListening,reportSha256:c.acousticEvidence.reportSha256})));
  result.papers++;result.sentences+=applied.length;result.approvedReviewSentences+=applied.filter(c=>c.requiresListening).length;result.applied.push({paperId:item.paperId,sentences:applied});
 }
 await writeJson(path.join(folder,'result.json'),result);await writeJson(path.join(data,'references','acoustic-application-result.json'),result);return result;
}

async function main(){
 const args=process.argv.slice(2);const approvalFile=args.find(a=>a.startsWith('--approval='))?.slice('--approval='.length);
 if(args.some(a=>a.startsWith('--approved-review-ids=')))throw new Error('不接收裸ID白名单；请用 --approval=含原计划/文字/报告SHA及声学边界的审批JSON。');
 const approval=await loadApproval(approvalFile);const plan=await buildAcousticPlan({approval});
 const fromPlan=args.find(a=>a.startsWith('--from-plan='))?.slice(12);
 const output=args.find(a=>a.startsWith('--output='))?.slice(9)||path.join(data,'references',args.includes('--apply')?'acoustic-application-current-plan.json':'acoustic-application-plan.json');
 if(args.includes('--apply')&&(!fromPlan||path.resolve(fromPlan)===path.resolve(output)))throw new Error('应用需要单独的 --from-plan=已审计划；不能覆盖这份已审文件。');
 await writeJson(path.resolve(output),plan);console.log(JSON.stringify({totals:plan.totals,deferredReasons:plan.deferredReasonCounts,output},null,2));
 const archive=path.join(data,'references','acoustic-application-plans',`${plan.runId}.json`);await writeJson(archive,plan);
 if(args.includes('--apply')){const result=await applyPlan(plan,{fromPlan});console.log(JSON.stringify({...result,applied:result.applied.map(p=>({paperId:p.paperId,sentences:p.sentences.length}))},null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
