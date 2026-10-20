import fs from 'node:fs/promises';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const proposalFile='data/references/question-evidence-proposals.json',bytes=await fs.readFile(proposalFile),proposalSha256=sha256(bytes),plan=JSON.parse(bytes);
if(plan.proposals.length!==16||plan.proposals.reduce((n,p)=>n+p.addSentenceIds.length,0)!==17||plan.proposals.some(p=>p.removeSentenceIds.length))throw new Error('Plan differs from the approved 16-question/17-addition scope');
const immutable=`data/references/transcript-adjudication-snapshots/${proposalSha256}.json`;await fs.mkdir('data/references/transcript-adjudication-snapshots',{recursive:true});await fs.writeFile(immutable,bytes);
const groups=new Map();for(const p of plan.proposals){if(!groups.has(p.paperId))groups.set(p.paperId,[]);groups.get(p.paperId).push(p);}
const prepared=[],changes=[];const checkedAt=new Date().toISOString();
for(const [paperId,proposals]of groups){
 const file=`data/papers/${paperId}.json`,beforeBytes=await fs.readFile(file),beforeHash=sha256(beforeBytes),paper=JSON.parse(beforeBytes);
 if(proposals.every(p=>JSON.stringify(paper.questions.find(q=>q.id===p.questionId)?.evidenceSentenceIds)===JSON.stringify(p.proposedEvidenceSentenceIds)))continue;
 if(proposals.some(p=>p.paperSha256!==beforeHash))throw new Error(`${paperId}: paper changed after the approved proposal`);
 for(const p of proposals){
  const q=paper.questions.find(q=>q.id===p.questionId),passage=paper.passages.find(passage=>passage.id===p.passageId);
  if(q.passageId!==p.passageId||q.answer!==p.answerUnchanged||q.prompt!==p.prompt||JSON.stringify(q.evidenceSentenceIds)!==JSON.stringify(p.currentEvidenceSentenceIds))throw new Error('Question identity or current evidence differs from approved snapshot');
  if(new Set(p.proposedEvidenceSentenceIds).size!==p.proposedEvidenceSentenceIds.length)throw new Error('Duplicate proposed evidence ID');
  for(const id of p.proposedEvidenceSentenceIds){const sentence=passage.sentences.find(s=>s.id===id),snapshot=p.evidence.find(s=>s.sentenceId===id);if(!sentence||!snapshot||sentence.text!==snapshot.text)throw new Error('Evidence is missing, cross-passage, or changed after approval');}
  const correction={checkedAt,previousEvidenceSentenceIds:[...q.evidenceSentenceIds],evidenceSentenceIds:[...p.proposedEvidenceSentenceIds],proposalSha256,proposalSnapshot:immutable,reason:p.reason,adjudicatedBy:'coding-agent-root',humanListeningClaimed:false};
  q.evidenceSentenceIds=[...p.proposedEvidenceSentenceIds];(q.evidenceCorrections??=[]).push(correction);changes.push({paperId,questionId:q.id,...correction});
 }
 validatePaper(paper);prepared.push({file,paper,beforeBytes,beforeHash});
}
const backup='data/references/before-question-evidence-corrections';await fs.mkdir(backup,{recursive:true});
for(const p of prepared){if(sha256(await fs.readFile(p.file))!==p.beforeHash)throw new Error('Paper changed while preparing evidence update');try{await fs.writeFile(`${backup}/${p.paper.id}.json`,p.beforeBytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}await writeJson(p.file,p.paper);}
const report={checkedAt,proposalFile,proposalSha256,proposalSnapshot:immutable,changedQuestions:changes.length,addedReferences:changes.reduce((n,c)=>n+c.evidenceSentenceIds.filter(id=>!c.previousEvidenceSentenceIds.includes(id)).length,0),removedReferences:0,changes,questionOptionsChanged:false,answersChanged:false,sentencesChanged:false,reviewFlagsChanged:false};
if(changes.length)await writeJson('data/references/question-evidence-corrections.json',report);console.log(JSON.stringify({changedQuestions:report.changedQuestions,addedReferences:report.addedReferences,removedReferences:0,proposalSha256},null,2));
