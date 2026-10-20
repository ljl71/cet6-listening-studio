import fs from 'node:fs/promises';
import {writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const proposalFile='data/references/transcript-proposals-batch-03.json',bytes=await fs.readFile(proposalFile),proposalSha256=sha256(bytes);
if(proposalSha256!=='5fb99512e4cee08f9cb2e5e276b57fb187a5e51a7ede97a244508ce39ec3c7ce')throw new Error('Batch 03 differs from root-approved frozen evidence');
const proposal=JSON.parse(bytes);if(proposal.records.length!==10||new Set(proposal.records.map(r=>r.sentenceId)).size!==10)throw new Error('Unexpected correction scope');
const folder='data/references/transcript-adjudication-snapshots';await fs.mkdir(folder,{recursive:true});const proposalSnapshot=`${folder}/${proposalSha256}.json`;await fs.writeFile(proposalSnapshot,bytes);
let ledgerSnapshot=null;const expectedLedgerSnapshot=`${folder}/${proposal.ledgerSnapshot.sha256}.json`;
for(const candidate of[expectedLedgerSnapshot,proposal.ledgerSnapshot.file]){try{const original=await fs.readFile(candidate);if(sha256(original)!==proposal.ledgerSnapshot.sha256)continue;await fs.writeFile(expectedLedgerSnapshot,original);ledgerSnapshot=expectedLedgerSnapshot;break;}catch(error){if(error.code!=='ENOENT')throw error;}}
const checkedAt=new Date().toISOString(),papers=new Map(),changes=[],relatedQuestionChecks=[],explanationCorrections=[];
for(const record of proposal.records){
 if(sha256(await fs.readFile(record.source.file))!==record.source.sha256||sha256(await fs.readFile(record.ctc.file))!==record.ctc.sha256)throw new Error('Original source or frozen CTC bytes changed');
 for(const v of record.whisper)if(sha256(await fs.readFile(v.file))!==v.sha256)throw new Error('Original Whisper evidence changed');
 let newText=record.oldFullSentence;for(const c of record.changes){if(!c.old||!c.new||newText.split(c.old).length!==2)throw new Error('Approved phrase must occur once');newText=newText.replace(c.old,c.new);}if(newText!==record.proposedFullSentence)throw new Error('Only the listed minimum substitutions are allowed');
 const paperId=record.sentenceId.match(/^(cet6-\d{4}-\d{2}-\d+)/)[1];if(!papers.has(paperId)){const file=`data/papers/${paperId}.json`,original=await fs.readFile(file);papers.set(paperId,{file,original,sha256:sha256(original),paper:JSON.parse(original)});}
 const target=papers.get(paperId),paper=target.paper,passage=paper.passages.find(p=>p.sentences.some(s=>s.id===record.sentenceId)),sentence=passage.sentences.find(s=>s.id===record.sentenceId);
 if(sentence.text===newText)continue;if(sentence.text!==record.oldFullSentence)throw new Error('Current sentence changed after adjudication');
 const before=structuredClone(sentence);if(sentence.textCorrection)(sentence.textCorrectionHistory??=[]).push(sentence.textCorrection);
 sentence.text=newText;sentence.textCorrection={previousText:before.text,text:newText,url:record.source.url,sourceSha256:record.source.sha256,checkedAt,
  reason:'根代理逐项核读批次03混合来源和两ASR实际上下文后批准的明列最小替换；不复制第二来源整句，保留his、a passion、do及已有Right句，排除Recording标题和ASR错拼。',report:'references/transcript-batch-03-corrections.json',proposalSnapshot,proposalSha256};
 changes.push({paperId,passageId:passage.id,sentenceId:sentence.id,replacements:record.changes,before,after:structuredClone(sentence),source:record.source,whisper:record.whisper,ctc:record.ctc,note:record.note,newWordForcedScoreClaimed:false});
 for(const q of paper.questions.filter(q=>q.passageId===passage.id))for(const c of record.changes){
  const previous=q.explanation||'',count=previous.split(c.old).length-1;relatedQuestionChecks.push({questionId:q.id,basisSentenceId:sentence.id,exactOldPhrase:c.old,exactMatches:count,evidenceLinked:q.evidenceSentenceIds?.includes(sentence.id)||false});
  if(!count)continue;q.explanation=previous.replaceAll(c.old,c.new);const correction={checkedAt,basisSentenceId:sentence.id,previousExplanation:previous,explanation:q.explanation,changedFrom:c.old,changedTo:c.new,exactOccurrences:count,origin:'developer-corrected-English-quote-from-adjudicated-transcript',basisReport:'references/transcript-batch-03-corrections.json',originalSourcePreserved:true};(q.explanationCorrections??=[]).push(correction);explanationCorrections.push({paperId,questionId:q.id,...correction});
 }
}
for(const p of papers.values())validatePaper(p.paper);
const backup='data/references/before-transcript-batch-03-corrections';await fs.mkdir(backup,{recursive:true});
for(const[paperId,p]of papers){if(!changes.some(c=>c.paperId===paperId))continue;if(sha256(await fs.readFile(p.file))!==p.sha256)throw new Error('Concurrent paper change detected');try{await fs.writeFile(`${backup}/${paperId}.json`,p.original,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}await writeJson(p.file,p.paper);}
if(changes.length)await writeJson('data/references/transcript-batch-03-corrections.json',{checkedAt,proposalFile,proposalSha256,proposalSnapshot,ledgerSnapshot,ledgerOriginalBytesAvailable:!!ledgerSnapshot,changes,relatedQuestionChecks,explanationCorrections,timingChanged:false,reviewFlagsChanged:false,qualityChanged:false,humanListeningClaimed:false});
console.log(JSON.stringify({changedSentences:changes.length,affectedPassages:[...new Set(changes.map(c=>c.passageId))],explanationCorrections:explanationCorrections.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),ledgerOriginalBytesAvailable:!!ledgerSnapshot,timingChanged:false},null,2));
