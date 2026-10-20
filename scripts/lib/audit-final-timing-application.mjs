import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {verifyCurrentAcousticEvidence} from './acoustic-evidence.mjs';
import {verifyCurrentBoundaryCandidateEvidence} from './six-boundary-evidence.mjs';
import {validatePaper} from '../../server/validation.mjs';
const remainingRun=await readJson('runtime/remaining-review-location.json',null);
if(remainingRun&&await readJson(`${remainingRun.root}/joint-boundary-application.json`,null)){
 const historical=`${remainingRun.root}/prior-final-timing-application-audit.json`;
 try{await fs.writeFile(historical,await fs.readFile('data/references/final-timing-application-audit.json'),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
 await import('../audit-remaining-review.mjs');
 const report=await readJson('docs/remaining-review-acceptance.json');
 await writeJson('data/references/final-timing-application-audit.json',{...report,priorHistoricalAudit:historical});
 process.exit(report.issues.length?1:0);
}
const main=await readJson('data/references/acoustic-application-result.json'),boundary=await readJson('data/references/acoustic-six-boundary-application-result.json'),assets=await readJson('data/assets.json'),sparse=await readJson('data/references/missing-alignment-completion.json'),cache=new Map(),issues=[],paperHashes={},checked={papers:0,strictApplied:0,strictArchivedProofsValid:0,boundaryApplied:0,boundaryJointProofsValid:0,sparseCompletionProtected:0,reviewed:0,qualityChanges:0};
for(const file of(await fs.readdir('data/papers')).filter(f=>f.endsWith('.json')).sort()){
 const bytes=await fs.readFile(`data/papers/${file}`),paper=JSON.parse(bytes),original=await readJson(`data/${main.backup}/before/${file}`),asset=assets[paper.audioAssetId];paperHashes[paper.id]=sha256(bytes);checked.papers++;
 try{validatePaper(paper);}catch(error){issues.push({paperId:paper.id,reason:error.message});}
 if(JSON.stringify(original.quality)!==JSON.stringify(paper.quality)){checked.qualityChanges++;issues.push({paperId:paper.id,reason:'quality-flags-changed'});}
 if(JSON.stringify(original.questions)!==JSON.stringify(paper.questions))issues.push({paperId:paper.id,reason:'questions-changed-during-timing-application'});
 for(const passage of paper.passages)for(const sentence of passage.sentences){
  const before=original.passages.flatMap(p=>p.sentences).find(s=>s.id===sentence.id);if(!before||before.text!==sentence.text||before.reviewed!==sentence.reviewed)issues.push({sentenceId:sentence.id,reason:'text-id-or-review-state-changed'});if(sentence.reviewed)checked.reviewed++;
  if(sentence.acousticEvidence){checked.strictApplied++;if(await verifyCurrentAcousticEvidence(sentence,paper,passage,asset,path.resolve('data'),cache))checked.strictArchivedProofsValid++;else issues.push({sentenceId:sentence.id,reason:'strict-archived-proof-invalid'});}
  if(sentence.boundaryCandidateEvidence){checked.boundaryApplied++;if(await verifyCurrentBoundaryCandidateEvidence(sentence,paper,passage,asset,path.resolve('data'),cache))checked.boundaryJointProofsValid++;else issues.push({sentenceId:sentence.id,reason:'boundary-joint-proof-invalid'});if(sentence.acousticEvidence)issues.push({sentenceId:sentence.id,reason:'boundary-candidate-misrepresented-as-strict'});}
  if(sparse.changes.some(c=>c.sentenceId===sentence.id)){if(before.start===sentence.start&&before.end===sentence.end)checked.sparseCompletionProtected++;else issues.push({sentenceId:sentence.id,reason:'seven-sparse-completion-time-overwritten'});}
 }
}
if(checked.strictApplied!==main.sentences||checked.boundaryApplied!==boundary.sentences||checked.sparseCompletionProtected!==7)issues.push({reason:'applied-count-or-protected-seven-mismatch'});
const report={generatedAt:new Date().toISOString(),readOnly:true,papersWritten:0,checks:checked,issues,paperSha256:paperHashes,mainApplicationBackup:main.backup,boundaryApplicationBackup:boundary.backup};await writeJson('data/references/final-timing-application-audit.json',report);console.log(JSON.stringify({checks:checked,issues},null,2));if(issues.length)process.exitCode=1;
