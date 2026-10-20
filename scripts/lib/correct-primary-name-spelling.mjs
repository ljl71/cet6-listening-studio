import fs from 'node:fs/promises';
import {writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const proofFile='data/references/transcript-primary-name-adjudication.json',proofBytes=await fs.readFile(proofFile),proofSha256=sha256(proofBytes);
if(proofSha256!=='e2dcb8bc72c3b7d62579db712f0ba20ad32cf856183909a84270680a119cec51')throw new Error('Proper-name proposal differs from approved frozen bytes');
const proof=JSON.parse(proofBytes),approved=new Map([
 ['cet6-2021-06-1-p-9-2-s2',['Hillary Schulman','Hillary Shulman']],
 ['cet6-2021-06-1-p-9-4-s3',['Schulman','Shulman']],
 ['cet6-2021-06-1-p-22-5-s1',['Rob MeInerney','Rob McInerney']],
]);
if(proof.records.length!==approved.size||proof.records.some(r=>!approved.has(r.sentenceId)))throw new Error('Unexpected spelling-correction scope');
const folder='data/references/transcript-adjudication-snapshots';await fs.mkdir(folder,{recursive:true});const proofSnapshot=`${folder}/${proofSha256}.json`;await fs.writeFile(proofSnapshot,proofBytes);
const paperId='cet6-2021-06-1',file=`data/papers/${paperId}.json`,original=await fs.readFile(file),originalSha256=sha256(original),paper=JSON.parse(original),checkedAt=new Date().toISOString();
const changes=[],explanationCorrections=[],relatedQuestionChecks=[];
for(const record of proof.records){
 const[from,to]=approved.get(record.sentenceId);if(record.old!==from||record.new!==to||record.oldFullSentence.replace(from,to)!==record.proposedFullSentence)throw new Error('Proposal is not the exact approved name spelling');
 if(sha256(await fs.readFile(record.source.file))!==record.source.sha256)throw new Error('Original institutional source changed');
 for(const v of record.whisper)if(sha256(await fs.readFile(v.file))!==v.sha256)throw new Error('Original ASR evidence changed');
 const passage=paper.passages.find(p=>p.sentences.some(s=>s.id===record.sentenceId)),sentence=passage.sentences.find(s=>s.id===record.sentenceId);
 if(sentence.text===record.proposedFullSentence)continue;if(sentence.text!==record.oldFullSentence)throw new Error('Current sentence differs from the reviewed old spelling');
 const before=structuredClone(sentence),ctcBytes=await fs.readFile(record.ctc.report),ctc=JSON.parse(ctcBytes),ctcSha256=sha256(ctcBytes),ctcSnapshot=`${folder}/${ctcSha256}.json`;
 if(ctc.sentences.find(s=>s.id===sentence.id)?.text!==sentence.text)throw new Error('CTC report does not preserve current pre-correction text');await fs.writeFile(ctcSnapshot,ctcBytes);
 if(sentence.textCorrection)(sentence.textCorrectionHistory??=[]).push(sentence.textCorrection);
 sentence.text=record.proposedFullSentence;sentence.textCorrection={previousText:before.text,text:sentence.text,url:record.source.url,sourceSha256:record.source.sha256,checkedAt,
  reason:'根代理逐项核读原机构姓名资料和ASR上下文后批准仅修正专名拼写；保留Hillary双l，不照搬第二原文的Hilary或McKinney。机构姓名页面不用于宣称完整原文或时间轴已听校。',report:'references/primary-name-spelling-corrections.json',proofSnapshot,proofSha256};
 changes.push({paperId,passageId:passage.id,sentenceId:sentence.id,from,to,before,after:structuredClone(sentence),source:record.source,whisper:record.whisper,ctc:{liveReport:record.ctc.report,archivedReport:ctcSnapshot,sha256:ctcSha256,greedy:record.ctc.greedy},newSpellingForcedScoreClaimed:false});
 for(const q of paper.questions.filter(q=>q.passageId===passage.id)){
  const previous=q.explanation||'',count=previous.split(from).length-1;
  relatedQuestionChecks.push({questionId:q.id,basisSentenceId:sentence.id,exactOldPhrase:from,exactMatches:count,evidenceLinked:q.evidenceSentenceIds?.includes(sentence.id)||false});
  if(!count)continue;q.explanation=previous.replaceAll(from,to);const correction={checkedAt,basisSentenceId:sentence.id,previousExplanation:previous,explanation:q.explanation,changedFrom:from,changedTo:to,exactOccurrences:count,origin:'developer-corrected-English-quote-from-adjudicated-name-spelling',basisReport:'references/primary-name-spelling-corrections.json',originalSourcePreserved:true};
  (q.explanationCorrections??=[]).push(correction);explanationCorrections.push({questionId:q.id,...correction});
 }
}
if(changes.length){
 validatePaper(paper);if(sha256(await fs.readFile(file))!==originalSha256)throw new Error('Concurrent paper change detected');
 const backup='data/references/before-primary-name-spelling-corrections';await fs.mkdir(backup,{recursive:true});try{await fs.writeFile(`${backup}/${paperId}.json`,original,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
 await writeJson(file,paper);await writeJson('data/references/primary-name-spelling-corrections.json',{checkedAt,paperId,proofFile,proofSha256,proofSnapshot,changes,explanationCorrections,relatedQuestionChecks,timingChanged:false,reviewFlagsChanged:false,qualityChanged:false,humanListeningClaimed:false});
}
console.log(JSON.stringify({changedSentences:changes.length,affectedPassages:[...new Set(changes.map(c=>c.passageId))],explanationCorrections:explanationCorrections.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),timingChanged:false},null,2));
