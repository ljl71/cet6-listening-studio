import fs from 'node:fs/promises';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {recognizedWords} from '../align.mjs';
if(process.argv.includes('--expanded')){await import('./audit-expanded-openings.mjs');process.exit(0);}
const assets=await readJson('data/assets.json');const report={generatedAt:new Date().toISOString(),readOnly:true,method:'读取各篇第一句CTC原始首词；score<0.8或首词start距当前篇章起点<=0.04秒列风险。不使用padding后/钳位后的候选start，也不把高分当作首词完整证据。只读，不扩大篇章范围、不改时间。',totals:{passages:0,availableReports:0,missingReports:0,risks:0,lowFirstWordScore:0,nearClipStart:0},risks:[],missing:[]};
for(const file of(await fs.readdir('data/papers')).filter(f=>f.endsWith('.json')).sort()){
 const paper=await readJson(`data/papers/${file}`);
 for(const passage of paper.passages){
  report.totals.passages++;const sentence=passage.sentences[0],ctcFile=`data/acoustic-review/${paper.id}/passage-${passage.order}.json`;let bytes;
  try{bytes=await fs.readFile(ctcFile);}catch(error){if(error.code!=='ENOENT')throw error;report.totals.missingReports++;report.missing.push({paperId:paper.id,passageId:passage.id,sentenceId:sentence.id,reason:'No current CTC report'});continue;}
  report.totals.availableReports++;const ctc=JSON.parse(bytes),row=ctc.sentences?.find(s=>s.id===sentence.id),first=row?.words?.[0];
  if(!first){report.missing.push({paperId:paper.id,passageId:passage.id,sentenceId:sentence.id,reason:'First CTC word unavailable'});continue;}
  const distance=+(first.start-passage.start).toFixed(5),low=first.score<0.8,near=distance<=0.04;if(!low&&!near)continue;
  let tiny=null;const tinyFile=`data/alignment/${paper.id}/passage-${passage.order}.json`;try{const b=await fs.readFile(tinyFile),r=JSON.parse(b);tiny={file:tinyFile,sha256:sha256(b),firstWords:recognizedWords(r).slice(0,8).map(w=>({...w,start:+(passage.start+w.start).toFixed(3),end:+(passage.start+w.end).toFixed(3)}))};}catch(error){if(error.code!=='ENOENT')throw error;}
  const sourceRangeMatches=ctc.sourceRange?.start===passage.start&&ctc.sourceRange?.end===passage.end;
  report.risks.push({paperId:paper.id,passageId:passage.id,order:passage.order,sentenceId:sentence.id,text:sentence.text,passageStart:passage.start,passageEnd:passage.end,
   firstRawWord:first,distanceFromClipStart:distance,lowFirstWordScore:low,nearClipStart:near,firstThreeRawWords:row.words.slice(0,3),greedyOpeningWords:ctc.greedyTranscript?.trim().split(/\s+/).slice(0,14).join(' '),
   ctcFile,ctcSha256:sha256(bytes),individualSentenceTextMatches:row.text===sentence.text,sourceRangeMatches,audioMatches:ctc.audioAssetId===paper.audioAssetId&&ctc.mediaSha256===assets[paper.audioAssetId]?.sha256,tiny,
   interpretation:'篇章起点附近没有首词之前的音频证据，可能有裁切；即使词分数很高也不能据此排除。须从完整原音频向前扩窗另核对。'});
  report.totals.risks++;if(low)report.totals.lowFirstWordScore++;if(near)report.totals.nearClipStart++;
 }
}
await writeJson('data/references/passage-opening-risks.json',report);console.log(JSON.stringify({totals:report.totals,risks:report.risks.map(r=>({sentenceId:r.sentenceId,word:r.firstRawWord.text,score:r.firstRawWord.score,distanceFromClipStart:r.distanceFromClipStart,sourceRangeMatches:r.sourceRangeMatches}))},null,2));
