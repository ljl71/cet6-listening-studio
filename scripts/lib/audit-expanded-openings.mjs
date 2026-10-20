import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {spokenWords,alignWords} from './audit-acoustic.mjs';
const assets=await readJson('data/assets.json');const legacyFile='data/references/passage-opening-risks.json';let legacy=null,legacySha256=null;
try{const bytes=await fs.readFile(legacyFile);legacy=JSON.parse(bytes);legacySha256=sha256(bytes);}catch(error){if(error.code!=='ENOENT')throw error;}
const mediaChecks=new Map(),near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<0.000001;
async function actualMedia(assetId){
 if(!mediaChecks.has(assetId)){
  const asset=assets[assetId];const file=asset?.path?path.resolve('data',asset.path):null;const dataRoot=path.resolve('data')+path.sep;
  let result={available:false,matches:false};
  if(file?.startsWith(dataRoot))try{const bytes=await fs.readFile(file);result={available:true,matches:sha256(bytes)===asset.sha256,actualSha256:sha256(bytes),expectedSha256:asset.sha256};}catch(error){result.error=error.message;}
  mediaChecks.set(assetId,result);
 }
 return mediaChecks.get(assetId);
}
const report={generatedAt:new Date().toISOString(),readOnly:true,legacyReport:legacyFile,legacyReportSha256:legacySha256,
 method:'仅汇总完整原媒体向前扩2秒、向后14秒的独立开头证据。核对当前句子ID/英文SHA、完整媒体实际字节SHA、原篇章范围和独立解码范围；记录原始声学delta/首两词score与12词greedy上下文。显著提前、低分和其余分别列示，不改paper，不因强制路径匹配早先同词就判定需要移动边界。',
 thresholds:{requiredSchemaVersion:2,significantlyEarlierSeconds:-0.1,firstAndLastWordScore:0.8,meanWordScore:0.85,minimumWordScore:0.4,independentContinuousAnchorWords:4},
 totals:{passages:0,available:0,pending:0,fresh:0,needsNormalizationRefresh:0,staleOrIncomplete:0,significantlyEarlier:0,lowFirstWordScore:0,other:0,earlierWithSupportedOpeningProposal:0},
 groups:{significantlyEarlier:[],lowFirstWordScore:[],other:[],needsNormalizationRefresh:[],staleOrIncomplete:[],pending:[]},items:[]};
for(const file of(await fs.readdir('data/papers')).filter(f=>f.endsWith('.json')).sort()){
 const paper=await readJson(`data/papers/${file}`);
 for(const passage of paper.passages){
  report.totals.passages++;const sentence=passage.sentences[0];const evidenceFile=`data/opening-review/${paper.id}/passage-${passage.order}.json`;
  const item={paperId:paper.id,passageId:passage.id,order:passage.order,sentenceId:sentence.id,text:sentence.text,currentPassageRange:{start:passage.start,end:passage.end},evidenceFile};
  const old=legacy?.risks.find(r=>r.passageId===passage.id);if(old)item.legacyOpeningRisk={sourceReport:legacyFile,sourceReportSha256:legacySha256,firstRawWord:old.firstRawWord,distanceFromClipStart:old.distanceFromClipStart,lowFirstWordScore:old.lowFirstWordScore,nearClipStart:old.nearClipStart};
  let bytes;try{bytes=await fs.readFile(evidenceFile);}catch(error){if(error.code!=='ENOENT')throw error;item.status='pending';report.totals.pending++;report.groups.pending.push(sentence.id);report.items.push(item);continue;}
  report.totals.available++;const e=JSON.parse(bytes),row=e.sentences?.find(s=>s.id===sentence.id),first=row?.words?.[0],word2=row?.words?.[1],media=await actualMedia(paper.audioAssetId);
  const currentTextSha256=sha256(Buffer.from(sentence.text)),expectedRange={start:Math.max(0,passage.start-2),end:Math.min(paper.duration,passage.end,passage.start+14)};
  const freshness={normalizationSchema:e.schemaVersion===2,paperId:e.paperId===paper.id,passageId:e.passageId===passage.id,sentenceId:e.sentenceId===sentence.id&&row?.id===sentence.id,
   originalText:e.originalText===sentence.text,referenceTextHash:e.referenceTextSha256===currentTextSha256,audioAssetId:e.audioAssetId===paper.audioAssetId,
   mediaRegistryHash:e.mediaSha256===assets[paper.audioAssetId]?.sha256,mediaActualBytesHash:media.matches,
   originalPassageRange:near(e.originalPassageRange?.start,passage.start)&&near(e.originalPassageRange?.end,passage.end),
   decodedSourceRange:near(e.sourceRange?.start,expectedRange.start)&&near(e.sourceRange?.end,expectedRange.end),
   pcmHashRecorded:/^[a-f0-9]{64}$/.test(e.pcmSha256||''),firstWordAvailable:!!first&&Number.isFinite(first.start)&&Number.isFinite(first.end)&&first.end>first.start&&Number.isFinite(first.score)};
  const fresh=Object.values(freshness).every(Boolean),delta=first?+(first.start-passage.start).toFixed(3):null;
  const reference=e.referenceOpeningWords||[];const greedy=spokenWords(e.greedyTranscript,{version:3}),comparison=alignWords(reference,greedy),mapping=comparison.mapping.filter(Boolean);
  const firstIndex=mapping[0]?.hypothesisIndex,lastIndex=mapping.at(-1)?.hypothesisIndex;
  const openingWords=row?.words||[],scores=openingWords.map(w=>w.score),mean=scores.length?scores.reduce((n,s)=>n+s,0)/scores.length:null,minimum=scores.length?Math.min(...scores):null;
  const firstFour=reference.slice(0,4),anchorMatches=[];
  if(firstFour.length===4)for(let i=0;i<=greedy.length-4;i++)if(firstFour.every((w,j)=>w===greedy[i+j]))anchorMatches.push({greedyIndex:i,words:greedy.slice(i,i+4),context:greedy.slice(Math.max(0,i-3),i+7).join(' ')});
  const scoresSupported=first?.score>=0.8&&openingWords.at(-1)?.score>=0.8&&mean>=0.85&&minimum>=0.4;
  const anchorSupported=firstFour.length===4&&anchorMatches.length===1;
  const pendingReasons=[];if(!anchorSupported)pendingReasons.push(firstFour.length<4?'fewer-than-four-independent-opening-words':anchorMatches.length?'ambiguous-repeated-four-word-anchor':'first-four-words-not-an-independent-continuous-greedy-sequence');if(!scoresSupported)pendingReasons.push('opening-first-last-or-mean-min-score-below-original-thresholds');
  const proposalSupported=fresh&&delta<=-0.1&&scoresSupported&&anchorSupported;
  item.expandedOpeningEvidence={schemaVersion:e.schemaVersion,reportSha256:sha256(bytes),method:e.method,model:e.model,sourceRange:e.sourceRange,expectedSourceRange:expectedRange,originalPassageRange:e.originalPassageRange,
   referenceTextSha256:e.referenceTextSha256,currentTextSha256,audioAssetId:e.audioAssetId,mediaSha256:e.mediaSha256,actualMediaCheck:media,pcmSha256:e.pcmSha256,
   freshness,currentEvidenceFresh:fresh,firstRawWord:first||null,secondRawWord:word2||null,firstTwoWordScores:[first?.score??null,word2?.score??null],
   referenceOpeningWords:reference,referenceOpeningWordCount:reference.length,firstWordStartDifference:delta,recordedFirstWordStartDifference:e.firstWordStartDifference,
   deltaSummaryMatches:near(delta,e.firstWordStartDifference),firstTwelveRawWordTimes:row?.words?.slice(0,12)||[],
   openingWordScores:{count:openingWords.length,first:first?.score??null,last:openingWords.at(-1)?.score??null,mean:mean===null?null:+mean.toFixed(5),minimum,recordedMean:row?.meanWordScore,recordedMinimum:row?.minimumWordScore,originalThresholdsSupported:scoresSupported},
   firstFourReferenceWords:firstFour,greedyFirstFourRawWords:greedy.slice(0,4),firstFourIndependentContinuousMatches:anchorMatches,independentFourWordAnchorSupported:anchorSupported,
   openingGreedyEditComparison:{referenceWords:reference.length,greedyWords:greedy.length,mapping:comparison.mapping,edits:comparison.edits,note:'完整扩窗含前置口播与后续语句，因此整体插入词数不直接当作前12词的错误率。'},
   startAdjustmentProposalState:proposalSupported?'supported-candidate-for-root-review':delta!==null&&delta<=-0.1?'pending-listening-or-opening-evidence':'no-earlier-start-proposed',pendingOpeningEvidenceReasons:pendingReasons,
   greedyFirstTwelveWords:greedy.slice(0,12).join(' '),greedyReferenceOpeningContext:firstIndex===undefined?'':greedy.slice(Math.max(0,firstIndex-3),lastIndex+4).join(' '),greedyTranscript:e.greedyTranscript,
   caution:'这里只是开头候选声学证据。强制路径可能抓住更早的同词；需连同完整12词顺序、独立greedy和原媒体窗口裁决，不自动改变篇章或句子。'};
  if(e.schemaVersion!==2){item.status='needs-normalization-refresh';report.totals.needsNormalizationRefresh++;report.groups.needsNormalizationRefresh.push(sentence.id);}
  else if(!fresh){item.status='stale-or-incomplete';report.totals.staleOrIncomplete++;report.groups.staleOrIncomplete.push(sentence.id);}
  else{
   report.totals.fresh++;
   if(delta<=report.thresholds.significantlyEarlierSeconds){item.status='significantly-earlier';report.totals.significantlyEarlier++;report.groups.significantlyEarlier.push(sentence.id);}
   else if(first.score<report.thresholds.firstAndLastWordScore){item.status='low-first-word-score';report.totals.lowFirstWordScore++;report.groups.lowFirstWordScore.push(sentence.id);}
   else{item.status='other';report.totals.other++;report.groups.other.push(sentence.id);}
   item.alsoLowFirstWordScore=first.score<report.thresholds.firstAndLastWordScore;if(proposalSupported)report.totals.earlierWithSupportedOpeningProposal++;
  }
  report.items.push(item);
 }
}
await writeJson('data/references/expanded-passage-opening-summary.json',report);
console.log(JSON.stringify({totals:report.totals,earlier:report.items.filter(i=>i.status==='significantly-earlier').map(i=>({sentenceId:i.sentenceId,delta:i.expandedOpeningEvidence.firstWordStartDifference,first:i.expandedOpeningEvidence.firstRawWord})),low:report.items.filter(i=>i.status==='low-first-word-score').map(i=>({sentenceId:i.sentenceId,delta:i.expandedOpeningEvidence.firstWordStartDifference,first:i.expandedOpeningEvidence.firstRawWord})),legacyReportPreserved:legacyFile},null,2));
