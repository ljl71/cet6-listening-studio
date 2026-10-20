import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {acousticEvidenceMatches} from './acoustic-evidence.mjs';
import {validatePaper} from '../../server/validation.mjs';
const planFile=process.argv.find(a=>a.startsWith('--plan='))?.slice(7)||'data/references/acoustic-application-plan.json';
const report=await readJson(planFile);const assets=await readJson('data/assets.json');const checks=[],issues=[];
for(const field of ['normalSafe','selectedSafe','afterReviewSafe']){
 let candidatesValidated=0,papersValidated=0;
 for(const item of report.papers){
  const bytes=await fs.readFile(path.join('data',item.paperFile));
  if(sha256(bytes)!==item.paperSha256){issues.push({paperId:item.paperId,field,reason:'当前套题已改变，需重新生成候选计划。'});continue;}
  const original=JSON.parse(bytes),paper=structuredClone(original);
  for(const passage of paper.passages){
   const proposals=item.passages.find(p=>p.passageId===passage.id)?.[field]||[];
   for(const candidate of proposals){
    const sentence=passage.sentences.find(s=>s.id===candidate.sentenceId);
    Object.assign(sentence,{start:candidate.start,end:candidate.end,acousticEvidence:candidate.acousticEvidence,timingWarnings:[]});
    if(!acousticEvidenceMatches(sentence,paper,passage,assets[paper.audioAssetId]))issues.push({sentenceId:sentence.id,field,reason:'候选元数据未与文字/整篇参考/音频/时间对应。'});
    candidatesValidated++;
   }
  }
  try{validatePaper(paper);papersValidated++;}catch(error){issues.push({paperId:paper.id,field,reason:error.message});}
  if(JSON.stringify(paper.quality)!==JSON.stringify(original.quality)||JSON.stringify(paper.passages.flatMap(p=>p.sentences.map(s=>s.reviewed)))!==JSON.stringify(original.passages.flatMap(p=>p.sentences.map(s=>s.reviewed))))issues.push({paperId:paper.id,field,reason:'质量或人工勾选状态发生改变。'});
 }
 checks.push({field,papersValidated,candidatesValidated});
}
const result={generatedAt:new Date().toISOString(),runId:report.runId,readOnly:true,checks,issues,approvalSubmitted:report.approvalCheck?.submitted||0,approvalMatching:report.approvalCheck?.matchingSentenceIds.length||0,approvalStaleOrPending:report.approvalCheck?.staleOrPending.length||0,papersWritten:0};
await writeJson('data/references/acoustic-application-plan-validation.json',result);console.log(JSON.stringify(result,null,2));if(issues.length)process.exitCode=1;
