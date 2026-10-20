import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,sha256} from './corpus.mjs';
const folder='data/references/transcript-adjudication-snapshots';await fs.mkdir(folder,{recursive:true});
const checks=[];const cache=new Map();const mutableEvidencePaths=[];
async function originalSnapshotOrLive(snapshot,live,expectedSha256){
 if(snapshot){try{await fs.access(snapshot);return snapshot;}catch(error){if(error.code!=='ENOENT')throw error;}}
 return live;
}
async function observeMutable(file,expectedSha256){
 try{const bytes=await fs.readFile(file);const actualSha256=sha256(bytes);mutableEvidencePaths.push({file,expectedOriginalSha256:expectedSha256,currentSha256:actualSha256,changedSinceCorrection:actualSha256!==expectedSha256});}
 catch(error){if(error.code!=='ENOENT')throw error;mutableEvidencePaths.push({file,expectedOriginalSha256:expectedSha256,available:false});}
}
async function check(kind,file,expectedSha256,sentenceId){
 const key=`${file}:${expectedSha256}`;let result=cache.get(key);
 if(!result){result={file,expectedSha256,available:false,matches:false};try{const bytes=await fs.readFile(file);result.available=true;result.actualSha256=sha256(bytes);result.matches=result.actualSha256===expectedSha256;
   if(result.matches&&path.extname(file)==='.json'){result.immutableSnapshot=`${folder}/${expectedSha256}.json`;await fs.writeFile(result.immutableSnapshot,bytes);}
  }catch(error){if(error.code!=='ENOENT')throw error;result.error='Expected original bytes are unavailable; no replacement is represented as the old file.';}
  cache.set(key,result);
 }
 checks.push({kind,sentenceId,...result});return result;
}
const cross=await readJson('data/references/crosschecked-transcript-corrections.json',{changes:[]});
for(const c of cross.changes){await check('ctc-original-archived',c.ctcEvidence.archivedReport,c.ctcEvidence.sha256,c.sentenceId);await check('public-original',c.publicText.file,c.publicText.sha256,c.sentenceId);for(const v of c.whisperEvidence)await check('whisper-original',v.file,v.sha256,c.sentenceId);}
const ledger=await readJson('data/references/approved-ledger-transcript-corrections.json',{changes:[]});
for(const c of ledger.changes){await check('ctc-original-archived',c.ctc.archivedReport,c.ctc.sha256,c.sentenceId);await check('ledger-original-archived',c.ledgerSnapshot,c.ledgerSha256,c.sentenceId);await check('ledger-frozen-proposals',c.evidenceSnapshot,c.evidenceSha256,c.sentenceId);await check('public-original',c.source.file,c.source.sha256,c.sentenceId);for(const v of c.whisper)await check('whisper-original',v.file,v.sha256,c.sentenceId);}
const missing=await readJson('data/references/missing-alignment-completion.json',{changes:[]});
for(const c of missing.changes)await check('sparse-whisper-original',`data/${c.recognitionSource}`,c.recognitionSha256,c.sentenceId);
const refinementSources=await readJson('data/references/refinement-sources.json',{entries:[]});
for(const source of refinementSources.entries)await check('public-original',`data/references/${source.filename}`,source.sha256,source.id);
const interjection=await readJson('data/references/interjection-source-correction.json',null);
if(interjection){await check('public-original',interjection.source.file,interjection.source.sha256,'interjection-Huh-gone');for(const a of interjection.acoustic)await check('whisper-original',a.file,a.sha256,'interjection-Huh-gone');}
const radical=await readJson('data/references/radical-transcript-corrections.json',null);
if(radical){for(const s of radical.sources)await check('public-original',s.file,s.sha256,'radical-four-corrections');await check('whisper-original',radical.recognition.file,radical.recognition.sha256,'radical-four-corrections');}
const causeFile='data/references/cause-preposition-correction.json';const cause=await readJson(causeFile,null);
if(cause){
 const snapshot=await check('short-window-report-original',await originalSnapshotOrLive(cause.evidence.shortWindowImmutableSnapshot,cause.evidence.shortWindowReport,cause.evidence.sha256),cause.evidence.sha256,cause.sentenceId);
 const recognition=await check('short-window-recognition-original',await originalSnapshotOrLive(cause.evidence.recognitionImmutableSnapshot,cause.evidence.window.recognition.file,cause.evidence.window.recognition.sha256),cause.evidence.window.recognition.sha256,cause.sentenceId);
 await observeMutable(cause.evidence.shortWindowReport,cause.evidence.sha256);
 await check('whisper-original',cause.evidence.tinyFile,cause.evidence.tinySha256,cause.sentenceId);await check('public-original',cause.source.file,cause.source.sha256,cause.sentenceId);
 if(snapshot.immutableSnapshot)cause.evidence.shortWindowImmutableSnapshot=snapshot.immutableSnapshot;
 if(recognition.immutableSnapshot)cause.evidence.recognitionImmutableSnapshot=recognition.immutableSnapshot;
 await writeJson(causeFile,cause);
}
const ofCorrection=await readJson('data/references/sixty-one-of-correction.json',null);
if(ofCorrection){await check('ctc-original-archived',ofCorrection.ctc.archivedReport,ofCorrection.ctc.sha256,ofCorrection.sentenceId);await check('frozen-of-proposal',ofCorrection.evidenceSnapshot,ofCorrection.evidenceSha256,ofCorrection.sentenceId);await check('whisper-original',ofCorrection.whisper.file,ofCorrection.whisper.sha256,ofCorrection.sentenceId);for(const s of ofCorrection.sources)await check('public-original',s.file,s.sha256,ofCorrection.sentenceId);}
const questionEvidence=await readJson('data/references/question-evidence-corrections.json',null);
if(questionEvidence)await check('question-evidence-frozen-proposal',questionEvidence.proposalSnapshot,questionEvidence.proposalSha256,'16-question-17-reference-refinement');
const batch02=await readJson('data/references/transcript-batch-02-corrections.json',null);
if(batch02){
 await check('batch02-frozen-proposal',batch02.batchSnapshot,batch02.batchSha256,'24-approved-text-corrections');
 if(batch02.sourceSnapshot){const originalBatch=await readJson(batch02.batchSnapshot);await check('batch02-source-ledger-frozen',batch02.sourceSnapshot,originalBatch.sourceSnapshot.sha256,'24-approved-text-corrections');}
 for(const c of batch02.changes){await check('ctc-original-archived',c.ctc.file,c.ctc.sha256,c.sentenceId);await check('public-original',c.source.file,c.source.sha256,c.sentenceId);for(const v of c.whisper)await check('whisper-original',v.file,v.sha256,c.sentenceId);}
}
const guest=await readJson('data/references/guest-article-correction.json',null);
if(guest){await check('guest-frozen-third-source',guest.proofSnapshot,guest.proofSha256,guest.sentenceId);await check('public-original',guest.pdfSource.file,guest.pdfSource.sha256,guest.sentenceId);}
const names=await readJson('data/references/primary-name-spelling-corrections.json',null);
if(names){
 await check('name-spelling-frozen-primary-proposal',names.proofSnapshot,names.proofSha256,'three-approved-name-spellings');
 for(const c of names.changes){await check('ctc-original-archived',c.ctc.archivedReport,c.ctc.sha256,c.sentenceId);await check('public-institutional-name-original',c.source.file,c.source.sha256,c.sentenceId);for(const v of c.whisper)await check('whisper-original',v.file,v.sha256,c.sentenceId);}
}
const batch03=await readJson('data/references/transcript-batch-03-corrections.json',null);
if(batch03){
 await check('batch03-frozen-proposal',batch03.proposalSnapshot,batch03.proposalSha256,'ten-approved-minimum-lexical-corrections');
 if(batch03.ledgerSnapshot){const originalProposal=await readJson(batch03.proposalSnapshot);await check('batch03-source-ledger-frozen',batch03.ledgerSnapshot,originalProposal.ledgerSnapshot.sha256,'ten-approved-minimum-lexical-corrections');}
 for(const c of batch03.changes){await check('ctc-original-archived',c.ctc.file,c.ctc.sha256,c.sentenceId);await check('public-original',c.source.file,c.source.sha256,c.sentenceId);for(const v of c.whisper)await check('whisper-original',v.file,v.sha256,c.sentenceId);}
}
const batch04=await readJson('data/references/transcript-batch-04-corrections.json',null);
if(batch04){
 await check('batch04-frozen-lexical-proposal',batch04.proposalSnapshot,batch04.proposalSha256,'twenty-approved-minimum-lexical-corrections');
 if(batch04.sourceSnapshot){const originalProposal=await readJson(batch04.proposalSnapshot);await check('batch04-source-ledger-frozen',batch04.sourceSnapshot,originalProposal.sourceSnapshot.sha256,'twenty-approved-minimum-lexical-corrections');}
 for(const c of batch04.changes){await check('ctc-original-archived',c.ctc.file,c.ctc.sha256,c.sentenceId);await check('public-original',c.source.file,c.source.sha256,c.sentenceId);for(const v of c.whisper)await check('whisper-original',v.file,v.sha256,c.sentenceId);}
}
const tension=await readJson('data/references/diplomacy-tension-correction.json',null);
if(tension){
 await check('tension-disputed-evidence-frozen',tension.proofSnapshot,tension.proofSha256,tension.sentenceId);
 await check('public-original',tension.source.file,tension.source.sha256,tension.sentenceId);
 await check('public-PDF-page-image',tension.source.image,tension.source.imageSha256,tension.sentenceId);
 const e=tension.conflictingEvidence;await check('ctc-original-archived',e.ctc.snapshot,e.ctc.sha256,tension.sentenceId);
 await check('whisper-original',e.fullPassageWhisper.snapshot,e.fullPassageWhisper.sha256,tension.sentenceId);await check('disputed-short-window-whisper-original',e.shortWindow.snapshot,e.shortWindow.sha256,tension.sentenceId);
 await check('disputed-short-window-audio',e.shortWindow.wav.file,e.shortWindow.wav.sha256,tension.sentenceId);
}
const uses=await readJson('data/references/final-uses-correction.json',null);
if(uses){for(const p of uses.proofs)await check('final-uses-frozen-proposal',p.snapshot,p.sha256,uses.sentenceId);await check('ctc-original-archived',uses.ctc.file,uses.ctc.sha256,uses.sentenceId);await check('public-original',uses.source.file,uses.source.sha256,uses.sentenceId);for(const w of uses.whisper)await check('whisper-original',w.file,w.sha256,uses.sentenceId);}
const unique=[...cache.values()];const report={generatedAt:new Date().toISOString(),papersChanged:false,checks,mutableEvidencePaths,
 totals:{referenceChecks:checks.length,uniqueOriginalFiles:unique.length,missingOriginalFiles:unique.filter(c=>!c.available).length,checksumMismatch:unique.filter(c=>c.available&&!c.matches).length,
  archivedCTCReferenceChecks:checks.filter(c=>c.kind==='ctc-original-archived').length,archivedCTCReferenceChecksValid:checks.filter(c=>c.kind==='ctc-original-archived'&&c.matches&&c.immutableSnapshot).length},
 notes:['只在当前原件SHA与原纠错记录一致时保存不可变副本；没有把后续重放的新文件冒称旧证据。','CTC旧分数仅证明旧参考强制路径；纠正文稿后的新词分数仍待重新对齐。','早期两项公开原文纠错和7项补缺依赖保存的Whisper缓存，没有声称使用当时尚未生成的CTC。']};
await writeJson('data/references/correction-evidence-archive-audit.json',report);console.log(JSON.stringify(report.totals,null,2));if(report.totals.missingOriginalFiles||report.totals.checksumMismatch)process.exitCode=1;
