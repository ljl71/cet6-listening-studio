import fs from 'node:fs/promises';
import path from 'node:path';
import {sha256} from './corpus.mjs';
import {sentenceTextHash,passageTextHash} from './acoustic-evidence.mjs';
export const SIX_PROPOSAL_SHA='ccc35f796f42a9352662d77788c5d99a126699f4ac5c8470a5b47c17712b29ff';
export const SIX_BOUNDARIES=new Map([
 ['cet6-2022-12-1-p-22-1-s1',[1367.14,1375.425]],
 ['cet6-2022-12-2-p-12-3-s3',[753.046,759.391]],
 ['cet6-2022-12-2-p-19-1-s3',[1118.793,1124.638]],
 ['cet6-2024-06-1-p-9-3-s1',[511.686,524.111]],
 ['cet6-2025-06-1-p-9-3-s1',[498.653,520.938]],
 ['cet6-2025-12-2-p-19-2-s3',[1148.832,1159.617]],
]);
export function validateSixBoundaryApproval(document,proposal,proposalHash){
 if(document?.kind!=='six-explicit-boundary-candidate-approvals'||proposalHash!==SIX_PROPOSAL_SHA||document.sourceProposalSha256!==SIX_PROPOSAL_SHA||document.approvals?.length!==6)throw new Error('Six-ID approval does not match the exact frozen proposal');
 const ids=new Set();for(const row of document.approvals){
  const approved=SIX_BOUNDARIES.get(row.sentenceId),source=proposal.items.find(i=>i.sentenceId===row.sentenceId);
  if(ids.has(row.sentenceId)||!approved||!source||row.start!==approved[0]||row.end!==approved[1]||row.start!==source.proposed.start||row.end!==source.proposed.end||row.decision!=='approve-boundary-candidate-only'||row.preserveReviewedFalse!==true||row.strictSupported!==false||
   row.textSha256!==source.textSha256||row.mediaSha256!==source.mediaSha256||row.ctcReportSha256!==source.ctcEvidence.sha256||row.prefixReportSha256!==(source.expandedOpeningEvidence?.sha256??null)||!/^[a-f0-9]{64}$/.test(row.expectedPaperSha256))throw new Error(`Invalid or unapproved six-ID boundary row: ${row.sentenceId}`);
  ids.add(row.sentenceId);
 }
 return new Map(document.approvals.map(r=>[r.sentenceId,r]));
}
export function boundaryNeighborConflicts(paper,id,timing){
 const list=paper.passages.flatMap(p=>p.sentences),index=list.findIndex(s=>s.id===id),valid=s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start;
 if(index<0)return [{kind:'missing-sentence'}];const previous=list.slice(0,index).findLast(valid),next=list.slice(index+1).find(valid),conflicts=[];
 if(previous&&timing.start<previous.end)conflicts.push({kind:'previous-overlap',id:previous.id,end:previous.end});if(next&&timing.end>next.start)conflicts.push({kind:'next-overlap',id:next.id,start:next.start});return conflicts;
}
async function checkedJson(dataRoot,relative,hash,cache){
 const file=path.resolve(dataRoot,relative),root=path.resolve(dataRoot);if(!file.startsWith(root+path.sep))return null;const key=`${file}:${hash}`;
 if(!cache.has(key)){try{const bytes=await fs.readFile(file);cache.set(key,sha256(bytes)===hash?JSON.parse(bytes):null);}catch{cache.set(key,null);}}return cache.get(key);
}
export async function verifyCurrentBoundaryCandidateEvidence(sentence,paper,passage,asset,dataRoot,cache=new Map()){
 const e=sentence.boundaryCandidateEvidence,approved=SIX_BOUNDARIES.get(sentence.id);
 if(!e||e.kind!=='root-adjudicated-boundary-candidate'||e.schemaVersion!==1||e.strictSupported!==false||!approved||sentence.start!==approved[0]||sentence.end!==approved[1]||e.sourceProposalSha256!==SIX_PROPOSAL_SHA||e.sentenceTextSha256!==sentenceTextHash(sentence)||e.referenceTextSha256!==passageTextHash(passage)||e.audioAssetId!==paper.audioAssetId||e.mediaSha256!==asset?.sha256||e.sourceRange?.start!==passage.start||e.sourceRange?.end!==passage.end)return false;
 const proposal=await checkedJson(dataRoot,e.sourceProposalSnapshot,e.sourceProposalSha256,cache),approval=await checkedJson(dataRoot,e.approvalSnapshot,e.approvalSha256,cache);
 try{if(!proposal||!approval)return false;validateSixBoundaryApproval(approval,proposal,SIX_PROPOSAL_SHA);}catch{return false;}
 const row=approval.approvals.find(r=>r.sentenceId===sentence.id),source=proposal.items.find(r=>r.sentenceId===sentence.id);
 if(row.textSha256!==sentenceTextHash(sentence)||row.ctcReportSha256!==e.ctcReportSha256||row.prefixReportSha256!==(e.prefixReportSha256??null)||row.start!==sentence.start||row.end!==sentence.end)return false;
 const ctc=await checkedJson(dataRoot,e.ctcReport,e.ctcReportSha256,cache),raw=ctc?.sentences.find(s=>s.id===sentence.id);
 if(!ctc||ctc.audioAssetId!==paper.audioAssetId||ctc.mediaSha256!==asset.sha256||ctc.referenceTextSha256!==passageTextHash(passage)||ctc.sourceRange.start!==passage.start||ctc.sourceRange.end!==passage.end||raw?.text!==sentence.text||raw.acousticEnd!==source.proposed.acousticEnd)return false;
 let start=raw.acousticStart;
 if(e.prefixReportSha256){
  const prefix=await checkedJson(dataRoot,e.prefixReport,e.prefixReportSha256,cache);if(prefix?.schemaVersion!==2||prefix.originalText!==sentence.text||prefix.referenceTextSha256!==sentenceTextHash(sentence)||prefix.mediaSha256!==asset.sha256||prefix.originalPassageRange.start!==passage.start||prefix.originalPassageRange.end!==passage.end)return false;
  start=prefix.sentences[0]?.words[0]?.start;
 }
 return start===source.proposed.acousticStart&&sentence.start<=start&&sentence.end>=raw.acousticEnd&&boundaryNeighborConflicts(paper,sentence.id,sentence).length===0;
}
