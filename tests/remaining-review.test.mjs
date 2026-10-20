import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {jointUpdateIsSafe,verifyJointBoundaryEvidence} from '../scripts/lib/joint-boundary-evidence.mjs';
import {loadRemainingTranscriptReviews,remainingTranscriptReviewMatches} from '../scripts/lib/remaining-transcript-evidence.mjs';
import {mergeCollectedPaper,parseListeningPage} from '../scripts/lib/corpus.mjs';
import {localFixture} from './local-fixtures.mjs';
const withEvidence=localFixture('data/references/remaining-transcript-decisions.json','runtime/remaining-review-location.json');

test('a joint boundary correction may retreat silence but cannot crop the target or move an earlier opening',()=>{
 const raw={id:'s',acousticStart:5,acousticEnd:6};
 const u={sentenceId:'s',role:'fill-missing-time',before:{start:0,end:0},after:{start:4.88,end:6.16}};
 assert.equal(jointUpdateIsSafe(u,raw),true);
 assert.equal(jointUpdateIsSafe({...u,after:{start:5.001,end:6.16}},raw),false);
 assert.equal(jointUpdateIsSafe({...u,after:{start:4.88,end:5.99}},raw),false);
 const tail={...u,role:'retreat-earlier-neighbor-tail-only',before:{start:5.1,end:7},after:{start:5.1,end:6.16}};
 assert.equal(jointUpdateIsSafe(tail,raw),true,'Existing opening is untouched and is not certified by an end-only correction');
 assert.equal(jointUpdateIsSafe({...tail,after:{start:5.11,end:6.16}},raw),false);
 assert.equal(jointUpdateIsSafe({...tail,after:{start:5.1,end:7.01}},raw),false);
});
test('all 69 real decisions bind current exact text and retain explicit candidate status',withEvidence,async()=>{
 const rows=loadRemainingTranscriptReviews();assert.equal(rows.size,69);
 for(const row of rows.values()){
  const paper=JSON.parse(await fs.readFile(`data/papers/${row.paperId}.json`,'utf8')),s=paper.passages.flatMap(p=>p.sentences).find(s=>s.id===row.sentenceId);
  assert.ok(remainingTranscriptReviewMatches(row,s),s.id);assert.equal(s.reviewed,false);assert.equal(paper.quality.transcript,'candidate');
  assert.equal(remainingTranscriptReviewMatches(row,{...s,text:s.text+' changed'}),false);
 }
});
test('all new joint proofs reject stale text, audio identity, evidence hash and neighbor overlap',withEvidence,async()=>{
 const {root}=JSON.parse(await fs.readFile('runtime/remaining-review-location.json','utf8')),result=JSON.parse(await fs.readFile(`${root}/joint-boundary-application.json`,'utf8')),assets=JSON.parse(await fs.readFile('data/assets.json','utf8'));
 assert.equal(result.filledMissing,26);let checked=0;
 for(const item of result.applied){
  const paper=JSON.parse(await fs.readFile(`data/papers/${item.paperId}.json`,'utf8'));
  for(const u of item.updates){
   const p=paper.passages.find(p=>p.sentences.some(s=>s.id===u.sentenceId)),s=p.sentences.find(s=>s.id===u.sentenceId),asset=assets[paper.audioAssetId];
   assert.ok(await verifyJointBoundaryEvidence(s,paper,p,asset,path.resolve('data')),s.id);
   assert.equal(await verifyJointBoundaryEvidence({...s,text:s.text+' changed'},paper,p,asset,path.resolve('data')),false);
   assert.equal(await verifyJointBoundaryEvidence(s,paper,p,{...asset,sha256:'0'.repeat(64)},path.resolve('data')),false);
   assert.equal(await verifyJointBoundaryEvidence({...s,jointBoundaryEvidence:{...s.jointBoundaryEvidence,ctcReportSha256:'0'.repeat(64)}},paper,p,asset,path.resolve('data')),false);
   const changed=structuredClone(paper),cp=changed.passages.find(x=>x.id===p.id),at=cp.sentences.findIndex(x=>x.id===s.id);
   if(at>0){cp.sentences[at-1].end=s.start+.01;assert.equal(await verifyJointBoundaryEvidence(s,changed,cp,asset,path.resolve('data')),false);}
   assert.equal(s.reviewed,false);assert.equal(s.acousticEvidence,undefined);checked++;
  }
 }
 assert.equal(checked,result.updatedSentences);
});
test('recollection preserves every new stable sentence, transcript decision and joint boundary proof',withEvidence,async()=>{
 const {root}=JSON.parse(await fs.readFile('runtime/remaining-review-location.json','utf8')),snapshot=JSON.parse(await fs.readFile(`${root}/snapshot.json`,'utf8'));
 for(const item of snapshot.papers){
  const id=item.paperId||item.id;if(!id)throw Error('Snapshot paper ID missing');
  const paper=JSON.parse(await fs.readFile(`data/papers/${id}.json`,'utf8')),slug=id.replace(/^cet6-/,''),html=await fs.readFile(`data/raw/${slug}.html`,'utf8');
  const fresh=parseListeningPage(html,{id,year:paper.year,month:paper.month,variant:paper.variant,url:'https://example.test'}).paper,merged=mergeCollectedPaper(fresh,paper);
  for(const s of paper.passages.flatMap(p=>p.sentences).filter(s=>s.transcriptCandidateReview||s.jointBoundaryEvidence))assert.deepEqual(merged.passages.flatMap(p=>p.sentences).find(x=>x.id===s.id),s,s.id);
 }
});
