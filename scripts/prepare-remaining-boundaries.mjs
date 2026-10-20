import fs from 'node:fs/promises';
import {sha256,writeJson} from './lib/corpus.mjs';
import {passageTextHash,sentenceTextHash} from './lib/acoustic-evidence.mjs';
import {boundaryNeighborConflicts,verifyCurrentBoundaryCandidateEvidence} from './lib/six-boundary-evidence.mjs';
import path from 'node:path';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const {root}=await read('runtime/remaining-review-location.json');
const snapshot=await read(`${root}/snapshot.json`),assets=await read('data/assets.json');
const items=[];
for(const missing of snapshot.missingTime){
 const file=`data/papers/${missing.paperId}.json`,bytes=await fs.readFile(file),paper=JSON.parse(bytes);
 const passage=paper.passages.find(p=>p.id===missing.passageId),index=passage.sentences.findIndex(s=>s.id===missing.sentence.id),sentence=passage.sentences[index];
 if(sentence.start!==0||sentence.end!==0||sentence.text!==missing.sentence.text)throw Error('Missing sentence snapshot changed');
 const ctcFile=`data/acoustic-review/${paper.id}/passage-${passage.order}.json`,ctcBytes=await fs.readFile(ctcFile),ctc=JSON.parse(ctcBytes);
 if(ctc.referenceTextSha256!==passageTextHash(passage)||ctc.mediaSha256!==assets[paper.audioAssetId].sha256)throw Error('Stale acoustic evidence');
 const raw=ctc.sentences.find(s=>s.id===sentence.id),r=x=>+x.toFixed(3);
 const updates=[{sentenceId:sentence.id,role:'fill-missing-time',before:{start:0,end:0},after:{start:r(raw.acousticStart-.12),end:r(raw.acousticEnd+.16)},acoustic:raw}];
 const previous=passage.sentences[index-1],next=passage.sentences[index+1];
 if(previous&&previous.end>updates[0].after.start){
  const p=ctc.sentences.find(s=>s.id===previous.id);
  updates.push({sentenceId:previous.id,role:'retreat-previous-tail-and-restore-opening-if-clipped',before:{start:previous.start,end:previous.end},after:{start:Math.min(previous.start,r(p.acousticStart-.12)),end:r(p.acousticEnd+.16)},acoustic:p});
 }
 if(next&&next.start>ctc.sentences.find(s=>s.id===next.id).acousticStart+.3&&sentence.id==='cet6-2022-12-2-p-5-13-s1'){
  const p=ctc.sentences.find(s=>s.id===next.id);
  updates.push({sentenceId:next.id,role:'restore-clipped-next-opening',before:{start:next.start,end:next.end},after:{start:r(p.acousticStart-.12),end:r(p.acousticEnd+.16)},acoustic:p});
 }
 // Restoring an opening can expose old midpoint padding on the preceding row.
 // Retreat only that old tail, never its speech, rather than clipping the opening.
 for(let n=0;n<updates.length;n++){
  const u=updates[n],at=passage.sentences.findIndex(s=>s.id===u.sentenceId),p=passage.sentences[at-1];
  if(!p||updates.some(x=>x.sentenceId===p.id)||p.end<=u.after.start)continue;
  const rawPrevious=ctc.sentences.find(s=>s.id===p.id);
  if(!rawPrevious||rawPrevious.acousticEnd>u.after.start)throw Error(`Actual speech conflict: ${p.id}`);
  updates.push({sentenceId:p.id,role:'retreat-earlier-neighbor-tail-only',before:{start:p.start,end:p.end},after:{start:p.start,end:r(Math.min(rawPrevious.acousticEnd+.16,u.after.start))},acoustic:rawPrevious});
 }
 const hypothetical=structuredClone(paper);
 for(const u of updates){const s=hypothetical.passages.flatMap(p=>p.sentences).find(s=>s.id===u.sentenceId);Object.assign(s,u.after);}
 const conflicts=updates.flatMap(u=>boundaryNeighborConflicts(hypothetical,u.sentenceId,u.after).map(c=>({sentenceId:u.sentenceId,...c})));
 for(const u of updates)if((u.after.start>u.acoustic.acousticStart&&u.role!=='retreat-earlier-neighbor-tail-only')||u.after.end<u.acoustic.acousticEnd||u.after.end<=u.after.start)conflicts.push({sentenceId:u.sentenceId,kind:'would-clip-acoustic-word'});
 items.push({paperId:paper.id,passageId:passage.id,sentenceId:sentence.id,text:sentence.text,textSha256:sentenceTextHash(sentence),referenceTextSha256:passageTextHash(passage),paperSha256:sha256(bytes),audioAssetId:paper.audioAssetId,mediaSha256:ctc.mediaSha256,sourceRange:ctc.sourceRange,ctc:{file:ctcFile,sha256:sha256(ctcBytes)},updates,conflicts});
}
// One older boundary candidate's internal transcript is in the 69-item batch.
// Rebind that exact saved span to new text/CTC plus its independent audio window.
for(const file of(await fs.readdir('data/papers')).filter(f=>f.endsWith('.json'))){
 const bytes=await fs.readFile(`data/papers/${file}`),paper=JSON.parse(bytes);
 for(const passage of paper.passages)for(const s of passage.sentences){
  if(!s.boundaryCandidateEvidence||await verifyCurrentBoundaryCandidateEvidence(s,paper,passage,assets[paper.audioAssetId],path.resolve('data')))continue;
  if(s.id!=='cet6-2025-12-2-p-19-2-s3'||!s.transcriptCandidateReview)throw Error('Unexpected stale older boundary candidate');
  const ctcFile=`data/acoustic-review/${paper.id}/passage-${passage.order}.json`,ctcBytes=await fs.readFile(ctcFile),ctc=JSON.parse(ctcBytes),raw=ctc.sentences.find(r=>r.id===s.id);
  if(ctc.referenceTextSha256!==passageTextHash(passage)||raw.text!==s.text)throw Error('Stale rebound boundary evidence');
  items.push({paperId:paper.id,passageId:passage.id,sentenceId:s.id,text:s.text,textSha256:sentenceTextHash(s),referenceTextSha256:passageTextHash(passage),paperSha256:sha256(bytes),audioAssetId:paper.audioAssetId,mediaSha256:ctc.mediaSha256,sourceRange:ctc.sourceRange,ctc:{file:ctcFile,sha256:sha256(ctcBytes)},
   updates:[{sentenceId:s.id,role:'revalidate-existing-boundary-after-text-correction',before:{start:s.start,end:s.end},after:{start:s.start,end:s.end},acoustic:raw}],conflicts:boundaryNeighborConflicts(paper,s.id,s)});
 }
}
await writeJson(`${root}/joint-boundary-proposals.json`,{kind:'joint-neighbor-boundary-proposals',createdAt:new Date().toISOString(),humanListeningClaimed:false,preserveReviewedFalse:true,items});
console.log(JSON.stringify(items.map(i=>({id:i.sentenceId,text:i.text,updates:i.updates.map(u=>({id:u.sentenceId,role:u.role,before:u.before,after:u.after,raw:[u.acoustic.acousticStart,u.acoustic.acousticEnd],scores:[u.acoustic.firstWordScore,u.acoustic.lastWordScore]})),conflicts:i.conflicts})),null,2));
