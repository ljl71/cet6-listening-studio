import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson,writeJson} from './corpus.mjs';
import {sentenceTimingLowerBound} from './sentence-timing-bounds.mjs';
const data=path.resolve(fileURLToPath(new URL('../../data',import.meta.url)));
const assets=await readJson(path.join(data,'assets.json'),{});
const report={generatedAt:new Date().toISOString(),method:'只读检查当前已保存套题；有效候选必须是有限数值、end>start、位于完整音频内。仅物理首句可比原篇章起点早最多0.3秒，仍不得与上篇实际句子重叠；其余句子须位于原篇章范围。0/0视为尚无时间；另列ASR词跨度/匹配空档风险。重叠容差为0.000001秒。未执行人工听校，不修改任何套题。',totals:{papers:0,passages:0,sentences:0,alignedCandidates:0,validCandidates:0,missingTime:0,invalidTimes:0,outOfBounds:0,overlaps:0,reviewedSentences:0,transcriptVerified:0,timingVerified:0,segmentationWarnings:0,acousticRiskSentences:0},issues:[],papers:[]};
const tolerance=0.000001;
for(const name of(await fs.readdir(path.join(data,'papers'))).filter(n=>n.endsWith('.json')).sort()){
 const paper=await readJson(path.join(data,'papers',name),null);
 const item={paperId:paper.id,title:paper.title,totalSentences:0,alignedCandidateCount:0,validCandidateCount:0,missingTimeSentenceIds:[],invalidTimeSentences:[],outOfBoundsSentences:[],overlaps:[],segmentationWarnings:[],acousticRiskSentences:[],reviewedSentenceIds:[],minimumConfidence:1,below80PercentConfidence:[],passages:[]};
 report.totals.papers++;if(paper.quality.transcript==='verified')report.totals.transcriptVerified++;if(paper.quality.timing==='verified')report.totals.timingVerified++;
 const asset=assets[paper.audioAssetId];if(!asset)report.issues.push(`${paper.id}: missing audio asset`);else if(Math.abs(asset.duration-paper.duration)>0.05)report.issues.push(`${paper.id}: paper/asset duration mismatch`);
 const candidates=await readJson(path.join(data,'alignment',paper.id,'candidates.json'),null);if(!candidates)report.issues.push(`${paper.id}: no saved candidate provenance`);else if(candidates.audioAssetId!==paper.audioAssetId)report.issues.push(`${paper.id}: candidate audio version mismatch`);
 let previousGlobal=null;
 for(const p of paper.passages){
  report.totals.passages++;const passageItem={id:p.id,order:p.order,totalSentences:p.sentences.length,validCandidates:0,missingTimeSentenceIds:[]};
  if(!Number.isFinite(p.start)||!Number.isFinite(p.end)||p.start<0||p.end<=p.start||p.end>paper.duration+tolerance)report.issues.push(`${p.id}: invalid passage time`);
  let previous=null;
  for(const [index,s]of p.sentences.entries()){
   item.totalSentences++;report.totals.sentences++;const start=s.start,end=s.end;
   const next=p.sentences[index+1];
   if(next&&s.sourceParagraphId===next.sourceParagraphId&&(/\b(?:Dr|Ms|Mr|Mrs|Prof|St)\.$/i.test(s.text)||/(?:^|\s)(?:[A-Z]\.)+$/.test(s.text))){item.segmentationWarnings.push({sentenceId:s.id,text:s.text,nextSentenceId:next.id,nextText:next.text,reason:'称谓、地名或姓名缩写可能被拆句，需核查是否应与同段下一句合并。'});report.totals.segmentationWarnings++;}
   if(s.timingWarnings?.length){item.acousticRiskSentences.push({sentenceId:s.id,text:s.text,warnings:s.timingWarnings,hasCandidate:end>start});report.totals.acousticRiskSentences++;}
   if(s.reviewed){item.reviewedSentenceIds.push(s.id);report.totals.reviewedSentences++;}
   if(start===0&&end===0){item.missingTimeSentenceIds.push(s.id);passageItem.missingTimeSentenceIds.push(s.id);report.totals.missingTime++;continue;}
   if(typeof start!=='number'||typeof end!=='number'||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start){item.invalidTimeSentences.push({id:s.id,start,end});report.totals.invalidTimes++;continue;}
   item.alignedCandidateCount++;report.totals.alignedCandidates++;
   const lowerBound=sentenceTimingLowerBound(p,index);
   const out=start<lowerBound-tolerance||end>p.end+tolerance||end>paper.duration+tolerance;
   if(out){item.outOfBoundsSentences.push({id:s.id,start,end,passageStart:p.start,earliestAllowedStart:lowerBound,passageEnd:p.end,audioDuration:paper.duration});report.totals.outOfBounds++;}
   else{item.validCandidateCount++;passageItem.validCandidates++;report.totals.validCandidates++;}
   if(previous&&start<previous.end-tolerance){item.overlaps.push({previousSentenceId:previous.id,sentenceId:s.id,previousEnd:previous.end,start,overlapSeconds:+(previous.end-start).toFixed(6)});report.totals.overlaps++;}
   else if(!previous&&previousGlobal&&start<previousGlobal.end-tolerance){item.overlaps.push({previousSentenceId:previousGlobal.id,sentenceId:s.id,previousEnd:previousGlobal.end,start,overlapSeconds:+(previousGlobal.end-start).toFixed(6),crossPassage:true});report.totals.overlaps++;}
   previous=s;previousGlobal=s;
   if(Number.isFinite(s.alignmentConfidence)){item.minimumConfidence=Math.min(item.minimumConfidence,s.alignmentConfidence);if(s.alignmentConfidence<0.8)item.below80PercentConfidence.push({id:s.id,confidence:s.alignmentConfidence});}
   else report.issues.push(`${s.id}: missing alignment confidence`);
  }
  item.passages.push(passageItem);
 }
 item.coveragePercent=+(100*item.validCandidateCount/item.totalSentences).toFixed(3);
 report.papers.push(item);
}
report.totals.coveragePercent=+(100*report.totals.validCandidates/report.totals.sentences).toFixed(3);
report.totals.below80PercentConfidence=report.papers.reduce((sum,p)=>sum+p.below80PercentConfidence.length,0);
report.needsTimingCorrection=report.issues.length>0||report.totals.invalidTimes>0||report.totals.outOfBounds>0||report.totals.overlaps>0;
report.needsTranscriptSegmentationCorrection=report.totals.segmentationWarnings>0;
report.needsCorrection=report.needsTimingCorrection||report.needsTranscriptSegmentationCorrection;
report.needsCompletion=report.totals.missingTime>0;
report.remaining='无候选时间的句子仍需补齐；所有有效时间也仅为语音识别候选，人工听校前保持 reviewed=false、timing=candidate。';
await writeJson(path.join(data,'references','alignment-summary.json'),report);
console.log(JSON.stringify({totals:report.totals,issues:report.issues,needsCorrection:report.needsCorrection,papers:report.papers.map(p=>({id:p.paperId,total:p.totalSentences,valid:p.validCandidateCount,missing:p.missingTimeSentenceIds.length,invalid:p.invalidTimeSentences.length,outOfBounds:p.outOfBoundsSentences.length,overlaps:p.overlaps.length,minConfidence:p.minimumConfidence,below80:p.below80PercentConfidence.length}))},null,2));
if(report.needsCorrection)process.exitCode=1;
