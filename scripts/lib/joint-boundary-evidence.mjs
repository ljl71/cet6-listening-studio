import fs from 'node:fs/promises';
import path from 'node:path';
import {sha256} from './corpus.mjs';
import {sentenceTextHash,passageTextHash} from './acoustic-evidence.mjs';
import {boundaryNeighborConflicts} from './six-boundary-evidence.mjs';
export const JOINT_APPROVAL_SHA='a06dcc21e269bf79287a7ff19c5f9ae368051ae163d67b521c7f79102dbe65d1';
async function checked(root,file,hash,cache){
 const full=path.resolve(root,file);if(!full.startsWith(path.resolve(root)+path.sep)||!/^[a-f0-9]{64}$/.test(hash))return null;
 const key=full+':'+hash;if(!cache.has(key)){try{const bytes=await fs.readFile(full);cache.set(key,sha256(bytes)===hash?JSON.parse(bytes):null);}catch{cache.set(key,null);}}return cache.get(key);
}
export function jointUpdateIsSafe(update,raw){
 if(!raw||update.sentenceId!==raw.id||update.after.end<raw.acousticEnd||update.after.end<=update.after.start)return false;
 if(update.role==='retreat-earlier-neighbor-tail-only')return update.after.start===update.before.start&&update.after.end<=update.before.end;
 return update.after.start<=raw.acousticStart&&update.after.start>=raw.acousticStart-.300001&&update.after.end<=raw.acousticEnd+.160001;
}
export async function verifyJointBoundaryEvidence(sentence,paper,passage,asset,dataRoot,cache=new Map()){
 const e=sentence.jointBoundaryEvidence;
 if(!e||e.kind!=='individually-adjudicated-joint-boundary-candidate'||e.approvalSha256!==JOINT_APPROVAL_SHA||e.humanListeningClaimed!==false||e.strictSupported!==false||sentence.reviewed||e.sentenceTextSha256!==sentenceTextHash(sentence)||e.referenceTextSha256!==passageTextHash(passage)||e.mediaSha256!==asset?.sha256||e.audioAssetId!==paper.audioAssetId||e.sourceRange.start!==passage.start||e.sourceRange.end!==passage.end)return false;
 const approval=await checked(dataRoot,e.approval,e.approvalSha256,cache);
 if(!approval||approval.kind!=='remaining-explicit-joint-boundary-candidate-approvals'||approval.humanListeningClaimed!==false)return false;
 const group=approval.items.find(i=>i.updates.some(u=>u.sentenceId===sentence.id)),u=group?.updates.find(u=>u.sentenceId===sentence.id);
 if(!u||group.paperId!==paper.id||group.passageId!==passage.id||group.mediaSha256!==asset.sha256||group.referenceTextSha256!==passageTextHash(passage)||u.textSha256!==sentenceTextHash(sentence)||u.after.start!==sentence.start||u.after.end!==sentence.end||group.ctc.sha256!==e.ctcReportSha256)return false;
 const ctc=await checked(dataRoot,group.ctc.snapshot,group.ctc.sha256,cache),raw=ctc?.sentences.find(s=>s.id===sentence.id);
 if(!ctc||ctc.referenceTextSha256!==passageTextHash(passage)||ctc.audioAssetId!==paper.audioAssetId||ctc.mediaSha256!==asset.sha256||ctc.sourceRange.start!==passage.start||ctc.sourceRange.end!==passage.end||raw?.text!==sentence.text||!jointUpdateIsSafe(u,raw))return false;
 const meta=await checked(dataRoot,group.independentRecognition.metadata,group.independentRecognition.metadataSha256,cache),recognition=await checked(dataRoot,group.independentRecognition.file,group.independentRecognition.sha256,cache);
 if(!meta||!recognition||meta.expectedTranscriptSupplied!==false||meta.recognitionSha256!==group.independentRecognition.sha256||meta.identity.audioAssetId!==paper.audioAssetId||meta.identity.mediaSha256!==asset.sha256||!meta.identity.targets.some(t=>t.sentenceId===group.sentenceId))return false;
 return boundaryNeighborConflicts(paper,sentence.id,sentence).length===0;
}
