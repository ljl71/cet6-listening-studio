import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {words} from '../align.mjs';
import {validatePaper} from '../../server/validation.mjs';

// Explicit root adjudication: the ninth proposal (their guests/the guest) is
// deliberately absent. Only these literal phrases may change.
const approved=[
 {id:'cet6-2020-07-1-p-1-4-s1',from:'science and technology have helped',to:'science and technology has helped'},
 {id:'cet6-2020-09-1-p-1-3-s2',from:'all of these',to:'all of this'},
 {id:'cet6-2021-12-1-p-16-4-s5',from:'nurse for their children',to:'nurse for the children'},
 {id:'cet6-2021-12-2-p-22-3-s7',from:'it is there the population',to:'it is there that population'},
 {id:'cet6-2023-06-2-p-16-2-s2',from:'such behaviors may',to:'such behavior may'},
 {id:'cet6-2024-12-1-p-9-2-s3',from:'less to do with the password itself',to:'less to do with the intricacy of the password itself'},
 {id:'cet6-2024-12-1-p-22-3-s2',from:'because rich individuals',to:'because richer individuals'},
 {id:'cet6-2025-12-1-p-9-1-s6',from:'reached the deadlock',to:'reached a deadlock'},
];
const ledgerFile='data/references/transcript-text-adjudication-ledger.json';
const evidenceFile='data/references/transcript-nine-proposals-evidence.json';
const ledgerBytes=await fs.readFile(ledgerFile),evidenceBytes=await fs.readFile(evidenceFile);
const ledger=JSON.parse(ledgerBytes),evidence=JSON.parse(evidenceBytes);
// Speech evidence cannot distinguish this explicit US/UK spelling pair; keep
// the local American display spelling selected in the adjudication.
const proofWords=text=>words(text).map(word=>word==='behaviour'?'behavior':word);
const ledgerHash=sha256(ledgerBytes),evidenceHash=sha256(evidenceBytes);
const snapshotFolder='data/references/transcript-adjudication-snapshots';await fs.mkdir(snapshotFolder,{recursive:true});
await fs.writeFile(`${snapshotFolder}/${ledgerHash}.json`,ledgerBytes);await fs.writeFile(`${snapshotFolder}/${evidenceHash}.json`,evidenceBytes);
const reportFile='data/references/approved-ledger-transcript-corrections.json';
const existing=await readJson(reportFile,{changes:[],explanationCorrections:[]});const changes=[],explanationCorrections=[],relatedQuestionChecks=[];
const papers=new Map();const checkedAt=new Date().toISOString();
for(const decision of approved){
 const item=ledger.items.find(s=>s.sentenceId===decision.id);const proof=evidence.records.find(s=>s.sentenceId===decision.id);
 if(!item||!proof||item.decision!=='propose-source2-correction-two-models')throw new Error('Missing explicitly approved ledger proposal');
 const source=proof.source;if(sha256(await fs.readFile(source.file))!==source.sha256)throw new Error('Source HTML checksum changed');
 const acousticBytes=await fs.readFile(proof.ctc.archivedReport);if(sha256(acousticBytes)!==proof.ctc.sha256)throw new Error('Archived CTC proof checksum changed');
 const acoustic=JSON.parse(acousticBytes);const phrase=proofWords(decision.to).join(' ');
 if(!proofWords(proof.source.text).join(' ').includes(phrase)||!proofWords(acoustic.greedyTranscript).join(' ').includes(phrase))throw new Error('Approved words not supported by source and independent greedy');
 let whisperSupported=false;
 for(const variant of proof.whisper){const bytes=await fs.readFile(variant.file);if(sha256(bytes)!==variant.sha256)throw new Error('Whisper evidence checksum changed');if(proofWords(variant.text).join(' ').includes(phrase))whisperSupported=true;}
 if(!whisperSupported)throw new Error('Approved words not supported by Whisper evidence');
 if(!papers.has(item.paperId)){const file=`data/papers/${item.paperId}.json`,bytes=await fs.readFile(file);papers.set(item.paperId,{file,bytes,sha256:sha256(bytes),paper:JSON.parse(bytes)});}
 const target=papers.get(item.paperId),paper=target.paper,passage=paper.passages.find(p=>p.id===item.passageId);
 const sentence=passage.sentences.find(s=>s.id===decision.id);
 if(sentence.text.includes(decision.to)&&!sentence.text.includes(decision.from))continue;
 if(sentence.text!==proof.oldText||!sentence.text.includes(decision.from))throw new Error('Current sentence differs from the approved old wording');
 if(proof.ctc.audioAssetId!==paper.audioAssetId||proof.ctc.sourceRange.start!==passage.start||proof.ctc.sourceRange.end!==passage.end)throw new Error('Audio version or decoded range differs from the approved proof');
 const before=structuredClone(sentence);sentence.text=sentence.text.replace(decision.from,decision.to);
 if(sentence.textCorrection)(sentence.textCorrectionHistory??=[]).push(sentence.textCorrection);
 sentence.textCorrection={previousText:before.text,text:sentence.text,url:source.url,sourceSha256:source.sha256,checkedAt,reason:'根代理逐项审阅第二公开原文、Whisper和独立CTC greedy上下文后批准的最小词级纠错；保留标签/标点/ID/候选时间，并非人工听校完成。',report:'references/approved-ledger-transcript-corrections.json',ledgerSha256:ledgerHash,evidenceSha256:evidenceHash};
 changes.push({paperId:paper.id,passageId:passage.id,sentenceId:sentence.id,replacement:decision,before,after:structuredClone(sentence),source,
  ledgerSnapshot:`${snapshotFolder}/${ledgerHash}.json`,ledgerSha256:ledgerHash,evidenceSnapshot:`${snapshotFolder}/${evidenceHash}.json`,evidenceSha256:evidenceHash,
  whisper:proof.whisper.map(v=>({file:v.file,sha256:v.sha256,model:v.model})),ctc:proof.ctc,humanListeningClaimed:false});
 for(const question of paper.questions.filter(q=>q.passageId===passage.id)){
  const old=question.explanation||'';const matches=old.split(decision.from).length-1;
  relatedQuestionChecks.push({paperId:paper.id,questionId:question.id,sentenceId:sentence.id,evidenceLinked:question.evidenceSentenceIds?.includes(sentence.id)||false,literalOldPhrase:decision.from,exactMatches:matches});
  if(!matches)continue;
  const corrected=old.replaceAll(decision.from,decision.to);question.explanation=corrected;
  const correction={checkedAt,basisSentenceId:sentence.id,previousExplanation:old,explanation:corrected,changedFrom:decision.from,changedTo:decision.to,exactOccurrences:matches,origin:'developer-corrected-English-quote-from-adjudicated-transcript',basisReport:'references/approved-ledger-transcript-corrections.json',originalSourcePreserved:true};
  (question.explanationCorrections??=[]).push(correction);explanationCorrections.push({paperId:paper.id,questionId:question.id,...correction});
 }
}
for(const target of papers.values())validatePaper(target.paper);
const backup='data/references/before-approved-ledger-corrections';await fs.mkdir(backup,{recursive:true});
for(const [paperId,target]of papers){
 if(!changes.some(c=>c.paperId===paperId))continue;
 if(sha256(await fs.readFile(target.file))!==target.sha256)throw new Error('Paper changed during correction; refusing to overwrite');
 try{await fs.writeFile(`${backup}/${paperId}.json`,target.bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
 await writeJson(target.file,target.paper);
}
if(changes.length)await writeJson(reportFile,{checkedAt,adjudicatedBy:'coding-agent-root',humanListeningClaimed:false,timingChanged:false,reviewFlagsChanged:false,
 excludedPendingSentenceId:'cet6-2023-03-1-p-12-2-s2',changes:[...existing.changes,...changes],explanationCorrections:[...existing.explanationCorrections,...explanationCorrections],relatedQuestionChecks,
 notes:['只按明确批准的八个短语做精确替换，保留本地美式behavior、标签与标点。','题目解释仅替换同篇完全命中的旧英文引文片段；中文解释、题目选项、答案、来源及依据句ID不变。','强制路径分数仍针对旧参考词；新词时间须全量V2重对齐。']});
console.log(JSON.stringify({changedSentences:changes.length,changedExplanations:explanationCorrections.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),affectedPassages:[...new Set(changes.map(c=>c.passageId))],timingChanged:false},null,2));
