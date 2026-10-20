import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {planAcousticPassage} from '../scripts/lib/plan-acoustic-updates.mjs';
import {acousticEvidenceMatches,sentenceTextHash,passageTextHash,verifyCurrentAcousticEvidence} from '../scripts/lib/acoustic-evidence.mjs';
import {sha256} from '../scripts/lib/corpus.mjs';
import {validateApprovalDocument,approvalMatchesCurrent} from '../scripts/lib/acoustic-approval.mjs';
import {localFixture} from './local-fixtures.mjs';

function fixture(){
 const passage={id:'p',start:0,end:10,sentences:[{id:'a',text:'First complete sentence.',start:0.8,end:3.05,reviewed:false},{id:'b',text:'Second complete sentence.',start:3.05,end:5.2,reviewed:false}]};
 const evidence={sentences:[{id:'a',text:passage.sentences[0].text,acousticStart:1,acousticEnd:3},{id:'b',text:passage.sentences[1].text,acousticStart:3.1,acousticEnd:5}]};
 const audit={sentences:passage.sentences.map(s=>({id:s.id,supportedCandidate:true,requiresListeningBeforeApplication:false,classification:'acoustically-supported-candidate'}))};
 return {passage,evidence,audit};
}
test('adjacent supported CTC candidates share only padding without cutting word evidence',()=>{
 const f=fixture();const before=structuredClone(f);const plan=planAcousticPassage(f.passage,f.audit,f.evidence);
 assert.equal(plan.accepted.length,2);assert.equal(plan.paddingAdjustments.length,1);const [a,b]=plan.accepted;
 assert.equal(a.end,3.05);assert.equal(b.start,3.05);assert.ok(a.end>=a.acousticEnd);assert.ok(b.start<=b.acousticStart);assert.deepEqual(f,before,'Dry-run mutated source objects');
});
test('a conflicting unchanged neighbor is deferred rather than moved to satisfy schema',()=>{
 const f=fixture();f.audit.sentences[1].supportedCandidate=false;f.passage.sentences[1].start=2.9;
 const plan=planAcousticPassage(f.passage,f.audit,f.evidence);assert.equal(plan.accepted.length,0);
 assert.ok(plan.deferred.find(s=>s.sentenceId==='a').reasons.includes('overlap-with-unchanged-or-unsupported-neighbor'));
 assert.equal(f.passage.sentences[1].start,2.9);
});
test('missing or large-drift timings require explicit review while sparse completions stay protected',()=>{
 const f=fixture();f.passage.sentences[0].start=0;f.passage.sentences[0].end=0;f.audit.sentences[0].requiresListeningBeforeApplication=true;
 assert.ok(!planAcousticPassage(f.passage,f.audit,f.evidence).accepted.some(s=>s.sentenceId==='a'));
 assert.ok(planAcousticPassage(f.passage,f.audit,f.evidence,{includeReviewCandidates:true}).accepted.some(s=>s.sentenceId==='a'));
 const protectedPlan=planAcousticPassage(f.passage,f.audit,f.evidence,{includeReviewCandidates:true,protectedIds:new Set(['a'])});
 assert.ok(!protectedPlan.accepted.some(s=>s.sentenceId==='a'));assert.ok(protectedPlan.deferred.find(s=>s.sentenceId==='a').reasons.includes('sparse-completion-protected'));
});
test('even small overlapping acoustic word spans are never cropped to create a legal sentence order',()=>{
 const f=fixture();f.evidence.sentences[1].acousticStart=2.995;
 const plan=planAcousticPassage(f.passage,f.audit,f.evidence);assert.equal(plan.accepted.length,0);assert.ok(plan.deferred.every(s=>s.reasons.includes('acoustic-word-evidence-overlap')));
});
test('deferred candidates propagate conflicts against restored old timings',()=>{
 const f=fixture();f.passage.sentences.push({id:'c',text:'Old unsupported sentence.',start:4.9,end:6,reviewed:false});
 f.audit.sentences.push({id:'c',supportedCandidate:false});f.evidence.sentences.push({id:'c',acousticStart:5.3,acousticEnd:6});
 const plan=planAcousticPassage(f.passage,f.audit,f.evidence);assert.ok(!plan.accepted.some(s=>s.sentenceId==='b'));assert.equal(f.passage.sentences[2].start,4.9);
});
test('sharing a narrow acoustic gap trims padding without increasing either padding limit',()=>{
 const f=fixture();f.evidence.sentences[1].acousticStart=3.27;
 const plan=planAcousticPassage(f.passage,f.audit,f.evidence);const [a,b]=plan.accepted;
 assert.equal(a.end,b.start);assert.ok(a.end<=3.16);assert.ok(b.start>=3.15);
 assert.ok(a.end>=a.acousticEnd);assert.ok(b.start<=b.acousticStart);
});
test('real expanded Throwing boundary permits first-sentence preroll without moving speech or the decoded source range',localFixture('data/opening-review/cet6-2022-12-1/passage-7.json'),async()=>{
 const paper=JSON.parse(await fs.readFile('data/papers/cet6-2022-12-1.json','utf8'));
 const original=paper.passages[6];const opening=JSON.parse(await fs.readFile('data/opening-review/cet6-2022-12-1/passage-7.json','utf8'));
 const complete=JSON.parse(await fs.readFile('data/acoustic-review/cet6-2022-12-1/passage-7.json','utf8'));
 assert.equal(opening.schemaVersion,2);assert.equal(opening.sentences[0].words[0].start,1367.26);assert.equal(original.start,1367.3);
 const sentence=original.sentences[0],raw=complete.sentences.find(s=>s.id===sentence.id);
 const passage={...original,sentences:[sentence]};const before=structuredClone(passage);
 // Geometry-only fixture combines the independently expanded opening boundary
 // with the original full-sentence end. It is NOT a strict-score approval.
 const observed={...raw,acousticStart:opening.sentences[0].words[0].start};
 const evidence={sourceRange:structuredClone(complete.sourceRange),sentences:[observed]};
 const audit={sentences:[{id:sentence.id,supportedCandidate:true,requiresListeningBeforeApplication:true}]};
 const plan=planAcousticPassage(passage,audit,evidence,{includeReviewCandidates:true});
 assert.equal(plan.accepted.length,1);assert.equal(plan.accepted[0].start,1367.14);
 assert.equal(plan.accepted[0].end,Math.floor((raw.acousticEnd+0.16+1e-9)*1000)/1000);
 assert.equal(plan.accepted[0].acousticStart,1367.26);assert.equal(plan.accepted[0].acousticEnd,raw.acousticEnd);
 assert.deepEqual(evidence.sourceRange,{start:original.start,end:original.end});assert.deepEqual(passage,before);
 const strictUnsupported=structuredClone(audit);strictUnsupported.sentences[0].supportedCandidate=false;
 assert.equal(planAcousticPassage(passage,strictUnsupported,evidence,{includeReviewCandidates:true}).accepted.length,0);
 const blocked=planAcousticPassage(passage,audit,evidence,{includeReviewCandidates:true,previousSentenceEnd:1367.2});
 assert.equal(blocked.accepted.length,0);assert.ok(blocked.deferred[0].reasons.includes('overlap-with-previous-passage-sentence'));
});
test('preroll applies only to physical first sentences and never crosses the complete media start',()=>{
 const f=fixture();f.passage.start=1;f.evidence.sentences[0].acousticStart=0.9;f.evidence.sentences[0].acousticEnd=1.2;
 f.evidence.sentences[1].acousticStart=0.95;f.evidence.sentences[1].acousticEnd=1.5;
 const onlyFirst={...f.passage,sentences:[f.passage.sentences[0]]};
 assert.equal(planAcousticPassage(onlyFirst,f.audit,{sentences:[f.evidence.sentences[0]]}).accepted[0].start,0.78);
 const nonFirst={...f.passage,sentences:[{...f.passage.sentences[0],start:0,end:0},f.passage.sentences[1]]};
 const secondAudit={sentences:[{id:'a',supportedCandidate:false},{id:'b',supportedCandidate:true}]};
 assert.ok(planAcousticPassage(nonFirst,secondAudit,{sentences:[f.evidence.sentences[1]]}).deferred.find(s=>s.sentenceId==='b').reasons.includes('passage-clipping-would-cross-acoustic-word-evidence'));
 const zero=fixture();zero.evidence.sentences[0].acousticStart=0.04;zero.evidence.sentences[0].acousticEnd=0.5;
 assert.equal(planAcousticPassage({...zero.passage,sentences:[zero.passage.sentences[0]]},zero.audit,{sentences:[zero.evidence.sentences[0]]}).accepted[0].start,0);
});
test('same-audio same-text CTC provenance protects alignment only when its archived report verifies',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cet6-acoustic-proof-'));
 try{
  const s={id:'s',text:'Hello world.',start:1,end:2.5};const p={start:0,end:10,sentences:[s]};const paper={audioAssetId:'audio'};const asset={sha256:'a'.repeat(64)};
  const evidence={audioAssetId:'audio',mediaSha256:asset.sha256,sourceRange:{start:0,end:10},sentences:[{id:'s',text:s.text,acousticStart:1.12,acousticEnd:2.34}]};
  const bytes=Buffer.from(JSON.stringify(evidence));await fs.writeFile(path.join(dir,'report.json'),bytes);
  s.acousticEvidence={schemaVersion:1,supportedCandidate:true,sentenceId:'s',audioAssetId:'audio',mediaSha256:asset.sha256,sourceRange:evidence.sourceRange,sentenceTextSha256:sentenceTextHash(s),referenceTextSha256:passageTextHash(p),acousticStart:1.12,acousticEnd:2.34,appliedTiming:{start:1,end:2.5},report:'report.json',reportSha256:sha256(bytes)};
  assert.ok(acousticEvidenceMatches(s,paper,p,asset));assert.ok(await verifyCurrentAcousticEvidence(s,paper,p,asset,dir));
  assert.equal(await verifyCurrentAcousticEvidence({...s,text:'Changed source.'},paper,p,asset,dir),false);
  assert.equal(await verifyCurrentAcousticEvidence(s,{audioAssetId:'other'},p,asset,dir),false);
  assert.equal(await verifyCurrentAcousticEvidence(s,paper,{...p,sentences:[s,{id:'extra',text:'Changed passage context.'}]},asset,dir),false);
  const preroll={...s,start:0.84,end:2.5};const prerollPassage={...p,start:1,sentences:[preroll]};
  preroll.acousticEvidence={...s.acousticEvidence,acousticStart:0.96,sourceRange:{start:1,end:10},appliedTiming:{start:0.84,end:2.5},referenceTextSha256:passageTextHash(prerollPassage)};
  assert.ok(acousticEvidenceMatches(preroll,paper,prerollPassage,asset));
  assert.equal(acousticEvidenceMatches(preroll,{...paper,passages:[{id:'earlier',sentences:[{start:0.5,end:0.9}]},prerollPassage]},prerollPassage,asset),false);
  assert.equal(acousticEvidenceMatches({...preroll,start:0.6,acousticEvidence:{...preroll.acousticEvidence,appliedTiming:{start:0.6,end:2.5}}},paper,prerollPassage,asset),false);
  await fs.writeFile(path.join(dir,'report.json'),'{}');assert.equal(await verifyCurrentAcousticEvidence(s,paper,p,asset,dir),false);
 }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});}
});
test('a candidate approval binds the exact reviewed plan row, text, acoustic range, and evidence hash',()=>{
 const row={sentenceId:'s',text:'Known source.',acoustic:{start:1,end:2}};
 const sourcePlan={runId:'run',papers:[{paperId:'paper',passages:[{passageId:'p',evidenceFile:'acoustic-review/paper/passage-1.json',evidenceSha256:'e'.repeat(64),requiresListening:[row]}]}]};
 const approval={paperId:'paper',passageId:'p',sentenceId:'s',text:row.text,textSha256:sha256(Buffer.from(row.text)),acoustic:row.acoustic,evidenceFile:'acoustic-review/paper/passage-1.json',evidenceSha256:'e'.repeat(64),decision:'approve-candidate-timing-only',preserveReviewedFalse:true};
 const document={sourcePlanRunId:'run',sourcePlanSha256:'f'.repeat(64),approvals:[approval]};
 assert.equal(validateApprovalDocument(document,sourcePlan,'f'.repeat(64)).size,1);
 assert.throws(()=>validateApprovalDocument({...document,approvals:[approval,approval]},sourcePlan,'f'.repeat(64)),/重复/);
 assert.throws(()=>validateApprovalDocument(document,sourcePlan,'0'.repeat(64)),/不对应/);
 const changed=structuredClone(document);changed.approvals[0].acoustic.start=1.1;assert.throws(()=>validateApprovalDocument(changed,sourcePlan,'f'.repeat(64)),/不对应/);
 const paper={id:'paper'},passage={id:'p'},sentence={id:'s',text:row.text},evidence={sentences:[{id:'s',acousticStart:1,acousticEnd:2}]};
 assert.ok(approvalMatchesCurrent(approval,paper,passage,sentence,evidence,'e'.repeat(64),approval.evidenceFile));
 assert.equal(approvalMatchesCurrent(approval,paper,passage,sentence,evidence,'0'.repeat(64),approval.evidenceFile),false);
 assert.equal(approvalMatchesCurrent(approval,paper,passage,{...sentence,text:'New words.'},evidence,'e'.repeat(64),approval.evidenceFile),false);
});
