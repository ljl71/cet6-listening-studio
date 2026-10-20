import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson} from './corpus.mjs';
import {alignPassage} from '../align.mjs';
const data=path.resolve('data');const completion=await readJson(path.join(data,'references','missing-alignment-completion.json'),{changes:[]});const protectedIds=new Set(completion.changes.map(s=>s.sentenceId));
const report={generatedAt:new Date().toISOString(),readOnly:true,method:'整篇英文后追加对应口播问题作为虚拟句参与全局LCS；逐词span>2秒或相邻匹配词间gap>2秒强制拒绝候选。比较缓存tiny/base，优先有效句数，再最少风险，再最高token recall。不改papers。',totals:{papers:0,passages:0,sentences:0,currentValid:0,guardedValid:0,timingRiskSentences:0,missingWithoutTimingRisk:0,changedOverPoint3:0,protectedCompletionSentences:0},changes:[],risks:[],missing:[],passages:[]};
for(const file of(await fs.readdir(path.join(data,'papers'))).filter(f=>f.endsWith('.json')).sort()){
 const paper=await readJson(path.join(data,'papers',file));report.totals.papers++;
 for(const p of paper.passages){report.totals.passages++;let options=[];
  for(const suffix of ['', '-base']){const filename=path.join(data,'alignment',paper.id,`passage-${p.order}${suffix}.json`);const r=await readJson(filename,null);if(!r)continue;const aligned=alignPassage(paper,p,r,{includeEvidence:true});const valid=aligned.filter(s=>s.end>s.start).length;const risk=aligned.filter(s=>s.timingWarnings.length).length;const recall=aligned.reduce((sum,s)=>sum+s.coverage,0);options.push({filename,model:r.params?.model,aligned,valid,risk,recall});}
  options.sort((a,b)=>b.valid-a.valid||a.risk-b.risk||b.recall-a.recall);const selected=options[0];if(!selected)throw new Error(`No recognition cache ${p.id}`);
  report.passages.push({paperId:paper.id,passageId:p.id,selectedModel:selected.model,recognitionFile:path.relative(data,selected.filename).replaceAll('\\','/'),valid:selected.valid,total:p.sentences.length,risks:selected.risk});
  for(const s of p.sentences){report.totals.sentences++;if(s.end>s.start)report.totals.currentValid++;const candidate=selected.aligned.find(a=>a.id===s.id);if(protectedIds.has(s.id))report.totals.protectedCompletionSentences++;
   if(candidate.end>candidate.start)report.totals.guardedValid++;
   if(candidate.timingWarnings.length){report.totals.timingRiskSentences++;report.risks.push({paperId:paper.id,passageId:p.id,sentenceId:s.id,text:s.text,current:{start:s.start,end:s.end},candidate});}
   else if(candidate.end<=candidate.start){report.totals.missingWithoutTimingRisk++;report.missing.push({paperId:paper.id,passageId:p.id,sentenceId:s.id,text:s.text,candidate});}
   const delta=Math.max(Math.abs(s.start-candidate.start),Math.abs(s.end-candidate.end));if(delta>0.3){report.totals.changedOverPoint3++;report.changes.push({paperId:paper.id,passageId:p.id,sentenceId:s.id,text:s.text,protectedCompletion:protectedIds.has(s.id),current:{start:s.start,end:s.end},candidate,delta:+delta.toFixed(3)});}
  }
 }
}
await writeJson(path.join(data,'references','alignment-guard-comparison.json'),report);console.log(JSON.stringify(report.totals,null,2));console.log('Risk IDs',report.risks.map(r=>r.sentenceId));console.log('Newly missing',report.missing.map(r=>r.sentenceId));
