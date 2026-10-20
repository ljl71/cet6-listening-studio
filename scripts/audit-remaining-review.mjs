import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {sha256,writeJson} from './lib/corpus.mjs';
import {verifyCurrentAcousticEvidence} from './lib/acoustic-evidence.mjs';
import {verifyCurrentBoundaryCandidateEvidence} from './lib/six-boundary-evidence.mjs';
import {verifyJointBoundaryEvidence} from './lib/joint-boundary-evidence.mjs';
import {loadRemainingTranscriptReviews,remainingTranscriptReviewMatches} from './lib/remaining-transcript-evidence.mjs';
import {validatePaper} from '../server/validation.mjs';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const {root}=await read('runtime/remaining-review-location.json'),snapshot=await read(`${root}/snapshot.json`),assets=await read('data/assets.json'),reviews=loadRemainingTranscriptReviews(),application=await read(`${root}/joint-boundary-application.json`);
const changedTimings=new Map(application.applied.flatMap(p=>p.updates.map(u=>[u.sentenceId,u]))),issues=[],cache=new Map();
const counts={papers:0,sentences:0,changedText:0,retainedText:0,adjudicatedText:0,validTimes:0,missingTimes:0,strictProofs:0,olderBoundaryProofs:0,jointBoundaryProofs:0,reviewed:0,qualityUpgrades:0,questions:0,originalSevenPreserved:0};
const hashes={},seven=new Set((await read('data/references/missing-alignment-completion.json')).changes.map(c=>c.sentenceId));
for(const saved of snapshot.papers){
 const bytes=await fs.readFile('data/'+saved.file),paper=JSON.parse(bytes),before=await read(`${root}/before/${paper.id}.json`);hashes[paper.id]=sha256(bytes);counts.papers++;
 try{
  validatePaper(paper);assert.deepEqual(paper.quality,before.quality,'Quality flags changed');
  const core=q=>Object.fromEntries(Object.entries(q).filter(([k])=>!['explanation','explanationCorrections'].includes(k)));
  assert.deepEqual(paper.questions.map(core),before.questions.map(core),'Question, option, answer or evidence link changed');counts.questions+=paper.questions.length;
  assert.deepEqual(paper.passages.map(p=>({id:p.id,start:p.start,end:p.end,ids:p.sentences.map(s=>s.id)})),before.passages.map(p=>({id:p.id,start:p.start,end:p.end,ids:p.sentences.map(s=>s.id)})),'Stable IDs or source range changed');
  for(const p of paper.passages)for(const s of p.sentences){
   counts.sentences++;const old=before.passages.flatMap(p=>p.sentences).find(x=>x.id===s.id),r=reviews.get(s.id),u=changedTimings.get(s.id);
   assert.equal(s.reviewed,old.reviewed,'Review flag changed');if(s.reviewed)counts.reviewed++;
   if(r){assert.ok(remainingTranscriptReviewMatches(r,s),'Decision current text differs');counts.adjudicatedText++;counts[s.text===old.text?'retainedText':'changedText']++;}else assert.equal(s.text,old.text,'Unapproved transcript change');
   if(u)assert.deepEqual({start:s.start,end:s.end},{start:u.after.start,end:u.after.end},'Approved timing not adopted');else assert.deepEqual({start:s.start,end:s.end},{start:old.start,end:old.end},'Unapproved timing change');
   if(s.end>s.start)counts.validTimes++;else counts.missingTimes++;
   if(seven.has(s.id)){assert.deepEqual({start:s.start,end:s.end},{start:old.start,end:old.end},'Original seven overwritten');counts.originalSevenPreserved++;}
   if(s.acousticEvidence){assert.ok(await verifyCurrentAcousticEvidence(s,paper,p,assets[paper.audioAssetId],path.resolve('data'),cache),'Invalid current strict proof: '+s.id);counts.strictProofs++;}
   if(s.boundaryCandidateEvidence){assert.ok(await verifyCurrentBoundaryCandidateEvidence(s,paper,p,assets[paper.audioAssetId],path.resolve('data'),cache),'Invalid older boundary proof: '+s.id);counts.olderBoundaryProofs++;}
   if(s.jointBoundaryEvidence){assert.ok(await verifyJointBoundaryEvidence(s,paper,p,assets[paper.audioAssetId],path.resolve('data'),cache),'Invalid new joint proof: '+s.id);counts.jointBoundaryProofs++;}
  }
 }catch(e){issues.push({paperId:paper.id,error:e.message});}
}
if(counts.adjudicatedText!==69||counts.originalSevenPreserved!==7)issues.push({error:'Scope count mismatch',adjudicated:counts.adjudicatedText,seven:counts.originalSevenPreserved});
const report={generatedAt:new Date().toISOString(),scope:'Current entire corpus compared with immutable pre-69/26 snapshot; every currently attached proof checked, no past-proposal count substituted.',counts,issues,paperSha256:hashes,formalDeliveryPassed:false,formalBlocker:'所有4138句尚无逐句人工听校确认；编辑/机器校对与有效候选时间不等同于正式核验。',humanListeningClaimed:false,learningRecordsChanged:false};
await writeJson('docs/remaining-review-acceptance.json',report);console.log(JSON.stringify({counts,issues},null,2));if(issues.length)process.exitCode=1;
