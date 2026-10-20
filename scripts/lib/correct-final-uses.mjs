import fs from 'node:fs/promises';
import {writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const proposals=[
 ['data/references/transcript-final-gives-uses-proposal.json','460e1b66ec2e9b2e857346c08a7466de612498ebf7148ac34a3e3fdb26ace8aa'],
 ['data/references/transcript-final-uses-proposal.json','9802039e48075d4b54ffd507d4eab67861f2c7ee1d8cff8a4c1ac73d762218bf'],
];
const folder='data/references/transcript-adjudication-snapshots';await fs.mkdir(folder,{recursive:true});const proofs=[];
for(const[file,expected]of proposals){const bytes=await fs.readFile(file);if(sha256(bytes)!==expected)throw new Error('Final uses proof differs from exact approved bytes');const snapshot=`${folder}/${expected}.json`;await fs.writeFile(snapshot,bytes);proofs.push({file,sha256:expected,snapshot,value:JSON.parse(bytes)});}
const proof=proofs[0].value,source=proof.source;
if(sha256(await fs.readFile(source.file))!==source.sha256||sha256(await fs.readFile(proof.ctc.file))!==proof.ctc.sha256)throw new Error('Public source or archived pre-correction CTC changed');
for(const w of proof.whisper)if(sha256(await fs.readFile(w.file))!==w.sha256)throw new Error('Original Whisper bytes changed');
const paperId='cet6-2024-12-1',file=`data/papers/${paperId}.json`,bytes=await fs.readFile(file),paper=JSON.parse(bytes),passage=paper.passages.find(p=>p.order===4),sentence=passage.sentences.find(s=>s.id===proof.sentenceId);
if(sentence.text===proof.proposedFullSentence){console.log('Final uses correction already applied');process.exit(0);}
if(sentence.text!==proof.oldFullSentence||sentence.text.replace('system gives feedback','system uses feedback')!==proof.proposedFullSentence)throw new Error('Current sentence is not the approved single-word edit');
const checkedAt=new Date().toISOString(),before=structuredClone(sentence);if(sentence.textCorrection)(sentence.textCorrectionHistory??=[]).push(sentence.textCorrection);
sentence.text=proof.proposedFullSentence;sentence.textCorrection={previousText:before.text,text:sentence.text,url:source.url,sourceSha256:source.sha256,checkedAt,reason:'根代理核读两份冻结单项提案后批准仅system gives feedback→system uses feedback；二源和两ASR实际目标词均uses，保留其它姓名/词/缩约。旧上下文规则受CTC SOFTWEART拼写差异影响，不将新词尚未生成的forced score冒称已通过。',report:'references/final-uses-correction.json',proofs:proofs.map(({value,...p})=>p)};
const explanationCorrections=[],relatedQuestionChecks=[];for(const q of paper.questions.filter(q=>q.passageId===passage.id)){
 const old=q.explanation||'',from='system gives feedback',to='system uses feedback',count=old.split(from).length-1;relatedQuestionChecks.push({questionId:q.id,exactOldPhrase:from,exactMatches:count});if(!count)continue;
 q.explanation=old.replaceAll(from,to);const c={checkedAt,basisSentenceId:sentence.id,previousExplanation:old,explanation:q.explanation,changedFrom:from,changedTo:to,exactOccurrences:count,origin:'developer-corrected-English-quote-from-adjudicated-transcript',basisReport:'references/final-uses-correction.json',originalSourcePreserved:true};(q.explanationCorrections??=[]).push(c);explanationCorrections.push({questionId:q.id,...c});
}
validatePaper(paper);if(sha256(await fs.readFile(file))!==sha256(bytes))throw new Error('Concurrent paper change detected');const backup='data/references/before-final-uses-correction';await fs.mkdir(backup,{recursive:true});try{await fs.writeFile(`${backup}/${paperId}.json`,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await writeJson(file,paper);await writeJson('data/references/final-uses-correction.json',{checkedAt,paperId,passageId:passage.id,sentenceId:sentence.id,before,after:sentence,proofs:proofs.map(({value,...p})=>p),source,whisper:proof.whisper,ctc:proof.ctc,relatedQuestionChecks,explanationCorrections,timingChanged:false,reviewFlagsChanged:false,qualityChanged:false,humanListeningClaimed:false});console.log(JSON.stringify({sentenceId:sentence.id,changed:'system gives feedback → system uses feedback',explanationCorrections:explanationCorrections.length,timingChanged:false}));
