import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sha256} from '../scripts/lib/corpus.mjs';
import {SIX_PROPOSAL_SHA,SIX_BOUNDARIES,validateSixBoundaryApproval,boundaryNeighborConflicts,verifyCurrentBoundaryCandidateEvidence} from '../scripts/lib/six-boundary-evidence.mjs';
import {acousticEvidenceMatches} from '../scripts/lib/acoustic-evidence.mjs';
import {localFixture} from './local-fixtures.mjs';
const withEvidence=localFixture('data/references/acoustic-boundary-exception-proposals.json','data/references/acoustic-six-boundary-application-result.json');

test('only the six exact reviewed boundary IDs, hashes and millisecond spans are approved',withEvidence,async()=>{
 const bytes=await fs.readFile('data/references/acoustic-boundary-exception-proposals.json'),proposal=JSON.parse(bytes);
 assert.equal(sha256(bytes),SIX_PROPOSAL_SHA);
 const document=JSON.parse(await fs.readFile('data/references/acoustic-six-boundary-evidence-review.json','utf8'));
 assert.equal(validateSixBoundaryApproval(document,proposal,SIX_PROPOSAL_SHA).size,6);
 const changed=structuredClone(document);changed.approvals[0].start+=.001;assert.throws(()=>validateSixBoundaryApproval(changed,proposal,SIX_PROPOSAL_SHA),/Invalid/);
 const wrongHash=structuredClone(document);wrongHash.approvals[0].ctcReportSha256='0'.repeat(64);assert.throws(()=>validateSixBoundaryApproval(wrongHash,proposal,SIX_PROPOSAL_SHA),/Invalid/);
 const seventh=structuredClone(document);seventh.approvals[0].sentenceId='cet6-2021-12-2-p-22-5-s5';assert.throws(()=>validateSixBoundaryApproval(seventh,proposal,SIX_PROPOSAL_SHA),/Invalid/);
 const duplicate=structuredClone(document);duplicate.approvals[1]=duplicate.approvals[0];assert.throws(()=>validateSixBoundaryApproval(duplicate,proposal,SIX_PROPOSAL_SHA),/Invalid/);
 assert.throws(()=>validateSixBoundaryApproval(document,proposal,'0'.repeat(64)),/frozen proposal/);
});
test('boundary exceptions cannot move an old neighbor or crop a word to satisfy order',()=>{
 const paper={passages:[{sentences:[{id:'before',start:1,end:3},{id:'target',start:0,end:0},{id:'after',start:5,end:6}]}]};const before=structuredClone(paper);
 assert.equal(boundaryNeighborConflicts(paper,'target',{start:2.99,end:4.9})[0].kind,'previous-overlap');
 assert.equal(boundaryNeighborConflicts(paper,'target',{start:3.1,end:5.01})[0].kind,'next-overlap');
 assert.equal(boundaryNeighborConflicts(paper,'target',{start:3,end:5}).length,0);assert.deepEqual(paper,before);
});
test('all six real archived joint proofs protect candidates without presenting them as strict or reviewed',withEvidence,async()=>{
 const result=JSON.parse(await fs.readFile('data/references/acoustic-six-boundary-application-result.json','utf8')),assets=JSON.parse(await fs.readFile('data/assets.json','utf8'));
 assert.equal(result.sentences,6);let checked=0;
 for(const item of result.applied){
  // Verify the historical six-item application against its complete original
  // paper. Later independently adjudicated text must not corrupt this fixture.
  const paper=JSON.parse(await fs.readFile(`data/${result.backup}/before/${item.paperId}.json`,'utf8'));
  for(const change of item.changes){const p=paper.passages.find(p=>p.sentences.some(s=>s.id===change.sentenceId)),i=p.sentences.findIndex(s=>s.id===change.sentenceId);p.sentences[i]=structuredClone(change.after);}
  for(const change of item.changes){
   const passage=paper.passages.find(p=>p.sentences.some(s=>s.id===change.sentenceId)),sentence=passage.sentences.find(s=>s.id===change.sentenceId),asset=assets[paper.audioAssetId];
   assert.ok(SIX_BOUNDARIES.has(sentence.id));assert.equal(sentence.reviewed,false);assert.equal(sentence.acousticEvidence,undefined);assert.equal(sentence.boundaryCandidateEvidence.strictSupported,false);
   assert.equal(acousticEvidenceMatches(sentence,paper,passage,asset),false);
   assert.ok(await verifyCurrentBoundaryCandidateEvidence(sentence,paper,passage,asset,path.resolve('data')));
   assert.equal(await verifyCurrentBoundaryCandidateEvidence({...sentence,text:sentence.text+'Changed.'},paper,passage,asset,path.resolve('data')),false);
   assert.equal(await verifyCurrentBoundaryCandidateEvidence(sentence,paper,passage,{...asset,sha256:'0'.repeat(64)},path.resolve('data')),false);
   const changed=structuredClone(sentence);changed.boundaryCandidateEvidence.ctcReportSha256='0'.repeat(64);assert.equal(await verifyCurrentBoundaryCandidateEvidence(changed,paper,passage,asset,path.resolve('data')),false);
   assert.deepEqual(sentence.timingWarnings,change.before.timingWarnings);checked++;
  }
 }
 assert.equal(checked,6);
});
