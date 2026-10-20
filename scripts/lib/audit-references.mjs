import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseReference,normalize} from '../verify-answers.mjs';
import {readJson,writeJson,stripHtml,sha256} from './corpus.mjs';
const data=path.resolve(fileURLToPath(new URL('../../data',import.meta.url)));const references=path.join(data,'references');
const reconciliation=await readJson(path.join(references,'reconciliation.json'),null);if(!reconciliation)throw new Error('Run the independent-source reconciliation first');
const report={checkedAt:new Date().toISOString(),papers:0,questions:0,mappedOptions:0,declaredSpellingOrWordingExceptions:0,additionalProofFiles:[],answerConflictProofs:[],issues:[],remaining:['完整英文原文尚未逐句听校，transcriptVerified 仍为 0。','语音识别产生的时间是候选，全部 reviewed=false；须人工听校才能 timingVerified。'],notes:['初次 answer-verification.json 保留原始差异报告；最终以 reconciliation.json 和当前 papers 为准。']};
for(const summary of reconciliation.summaries){
 const paper=await readJson(path.join(data,'papers',`${summary.paperId}.json`),null);if(!paper){report.issues.push(`${summary.paperId}: missing paper`);continue;}report.papers++;
 const reference=parseReference(await fs.readFile(path.join(references,`${summary.referenceId}-reference.html`),'utf8'));
 if(!paper.sources.some(s=>s.url===summary.url))report.issues.push(`${paper.id}: missing final answer source provenance`);
 for(const result of summary.results){report.questions++;const local=paper.questions.find(q=>q.number===result.number);const other=reference.find(q=>q.number===result.number);if(!local||!other){report.issues.push(`${paper.id} Q${result.number}: absent source question`);continue;}
  if(other.answer!==result.referenceAnswer)report.issues.push(`${paper.id} Q${result.number}: source answer marker differs from reconciliation`);
  if(new Set(Object.values(result.mapping)).size!==4)report.issues.push(`${paper.id} Q${result.number}: mapping is not bijective`);
  for(const [key,text]of Object.entries(local.options)){report.mappedOptions++;const referenceKey=result.mapping[key];if(normalize(text)===normalize(other.options[referenceKey]||''))continue;
   const exception=result.reviewedExceptions?.find(e=>e.localKey===key&&e.referenceKey===referenceKey&&normalize(e.localText)===normalize(text)&&normalize(e.referenceText)===normalize(other.options[referenceKey]||''));
   if(!exception)report.issues.push(`${paper.id} Q${result.number}${key}: undocumented option difference`);else{report.declaredSpellingOrWordingExceptions++;if(!exception.equivalent&&!result.additionalOptionProof?.proven)report.issues.push(`${paper.id} Q${result.number}${key}: material option difference lacks a third source`);}
  }
  const expected=result.answerCorrection?.correctedAnswer||(result.thirdSourceOverride?result.localAnswer:result.mappedAnswer);
  if(local.answer!==expected)report.issues.push(`${paper.id} Q${result.number}: final answer differs from supported result`);
 }
}
for(const proof of reconciliation.optionProofs||[]){const bytes=await fs.readFile(path.join(references,proof.filename));const digest=sha256(bytes);const expected=proof.sha256||proof.expectedSha256;const hashMatches=digest===expected;let textMatches=null;if(proof.snippets){const text=normalize(stripHtml(bytes.toString('utf8')));textMatches=proof.snippets.every(s=>text.includes(normalize(s)));}if(!hashMatches||textMatches===false)report.issues.push(`${proof.paperId}: original-paper proof integrity/content mismatch`);report.additionalProofFiles.push({paperId:proof.paperId,filename:proof.filename,sha256Matches:hashMatches,htmlTextMatches:textMatches,pdfContentCheck:textMatches===null?'只校验保存文件 hash；页面内容沿用原核验者逐页检查记录。':undefined});}
for(const proof of [reconciliation.thirdSource,reconciliation.correctionSource]){const html=await fs.readFile(path.join(references,proof.sourceFile),'utf8');const text=stripHtml(html);const index=normalize(text).indexOf(normalize(proof.selectedText));const supported=index>=0;if(!supported)report.issues.push(`${proof.paperId} Q${proof.number}: selected content missing from third-source evidence`);report.answerConflictProofs.push({paperId:proof.paperId,number:proof.number,sourceFile:proof.sourceFile,selectedTextFound:supported});}
await writeJson(path.join(references,'independent-audit.json'),report);console.log(JSON.stringify(report,null,2));if(report.issues.length)process.exitCode=1;
