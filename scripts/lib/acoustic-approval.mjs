import {sha256} from './corpus.mjs';
import {sentenceTextHash} from './acoustic-evidence.mjs';
export function validateApprovalDocument(document,sourcePlan,sourcePlanSha256){
 if(!Array.isArray(document?.approvals)||document.sourcePlanSha256!==sourcePlanSha256||document.sourcePlanRunId!==sourcePlan.runId)throw new Error('审批文件和已审计划校验值不对应');
 const ids=new Set();const available=new Map();
 for(const paper of sourcePlan.papers)for(const passage of paper.passages)for(const row of passage.requiresListening||[])available.set(row.sentenceId,{paper,passage,row});
 for(const row of document.approvals){
  if(ids.has(row.sentenceId))throw new Error('审批文件包含重复句子ID');ids.add(row.sentenceId);
  const source=available.get(row.sentenceId);
  if(!source||row.decision!=='approve-candidate-timing-only'||row.preserveReviewedFalse!==true||
   row.paperId!==source.paper.paperId||row.passageId!==source.passage.passageId||
   row.text!==source.row.text||row.textSha256!==sha256(Buffer.from(row.text))||
   row.acoustic?.start!==source.row.acoustic.start||row.acoustic?.end!==source.row.acoustic.end||
   row.evidenceFile!==source.passage.evidenceFile||row.evidenceSha256!==source.passage.evidenceSha256)throw new Error(`审批行与原已审证据不对应：${row.sentenceId}`);
 }
 return new Map(document.approvals.map(row=>[row.sentenceId,row]));
}
export function approvalMatchesCurrent(row,paper,passage,sentence,evidence,evidenceSha256,evidenceFile){
 const acoustic=evidence.sentences?.find(s=>s.id===sentence.id);
 return !!(row&&row.paperId===paper.id&&row.passageId===passage.id&&row.sentenceId===sentence.id&&
  row.text===sentence.text&&row.textSha256===sentenceTextHash(sentence)&&row.evidenceSha256===evidenceSha256&&row.evidenceFile===evidenceFile&&
  row.acoustic?.start===acoustic?.acousticStart&&row.acoustic?.end===acoustic?.acousticEnd);
}
