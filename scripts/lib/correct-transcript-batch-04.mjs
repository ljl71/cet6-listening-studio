import fs from 'node:fs/promises';
import {writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const replacements={
 'cet6-2023-06-2-p-5-7-s3':[['why you think','why do you think']],
 'cet6-2023-06-2-p-19-2-s1':[['the forest grew','the forests grew']],
 'cet6-2023-12-1-p-12-1-s7':[['products, economy','products, the economy']],
 'cet6-2023-12-1-p-22-3-s1':[['Onward has identified','Onward have identified']],
 'cet6-2023-12-2-p-1-8-s5':[['order at the van','order to the van']],
 'cet6-2023-12-2-p-9-1-s15':[['effects vary by gender','effects varied by gender']],
 'cet6-2023-12-2-p-12-1-s14':[['transmit them in real time','transmit them real time']],
 'cet6-2024-06-2-p-1-10-s2':[['different ingredient combinations','different ingredients']],
 'cet6-2024-06-2-p-19-2-s2':[['that the decline','that a decline'],['in America.','in general.']],
 'cet6-2024-06-2-p-22-2-s3':[['rashes, sleeplessness, headaches','rashes, sleepiness, headaches']],
 'cet6-2024-12-1-p-1-1-s7':[['can come through it','can comb through it']],
 'cet6-2024-12-1-p-1-3-s5':[['myself included, is happy','myself included, are happy']],
 'cet6-2024-12-1-p-5-9-s4':[['at least 85% score','at least an 85% score']],
 'cet6-2024-12-2-p-12-3-s1':[['will include pursuit','will include the pursuit']],
 'cet6-2024-12-2-p-16-1-s2':[['so you want',"so you'll want"]],
 'cet6-2024-12-2-p-19-2-s3':[['These stories in people','These stories of people']],
 'cet6-2025-06-1-p-5-11-s2':[['articulating that argument','articulating their argument']],
 'cet6-2025-06-1-p-16-4-s1':[['succeed push the button','succeed pushed the button']],
 'cet6-2025-06-2-p-12-3-s5':[['if you ran out','if you run out']],
 'cet6-2025-12-1-p-1-6-s1':[['our expert envoys','our export envoys']],
};
const proposalFile='data/references/transcript-proposals-batch-04-lexical.json',proposalBytes=await fs.readFile(proposalFile),proposalSha256=sha256(proposalBytes);
if(proposalSha256!=='7b5ffc958201d97937ee2404e5013111fbf524ad38c62dd2a078242e7ff9f6ff')throw new Error('Batch 04 differs from the approved lexical-only frozen bytes');
const proposal=JSON.parse(proposalBytes);if(proposal.records.length!==20||proposal.records.some(r=>!replacements[r.sentenceId])||new Set(proposal.records.map(r=>r.sentenceId)).size!==20)throw new Error('Unexpected batch 04 correction scope');
const folder='data/references/transcript-adjudication-snapshots';await fs.mkdir(folder,{recursive:true});const proposalSnapshot=`${folder}/${proposalSha256}.json`;await fs.writeFile(proposalSnapshot,proposalBytes);
let sourceSnapshot=null;const expectedSource=`${folder}/${proposal.sourceSnapshot.sha256}.json`;
for(const candidate of[expectedSource,proposal.sourceSnapshot.file]){try{const bytes=await fs.readFile(candidate);if(sha256(bytes)!==proposal.sourceSnapshot.sha256)continue;await fs.writeFile(expectedSource,bytes);sourceSnapshot=expectedSource;break;}catch(error){if(error.code!=='ENOENT')throw error;}}
const checkedAt=new Date().toISOString(),papers=new Map(),changes=[],relatedQuestionChecks=[],explanationCorrections=[];
for(const record of proposal.records){
 if(sha256(await fs.readFile(record.source.file))!==record.source.sha256||sha256(await fs.readFile(record.ctc.file))!==record.ctc.sha256)throw new Error('Original source or frozen CTC changed');
 for(const v of record.whisper)if(sha256(await fs.readFile(v.file))!==v.sha256)throw new Error('Original Whisper evidence changed');
 let newText=record.oldFullSentence;for(const[from,to]of replacements[record.sentenceId]){if(newText.split(from).length!==2)throw new Error('Approved contextual phrase must occur exactly once');newText=newText.replace(from,to);}
 const paperId=record.sentenceId.match(/^(cet6-\d{4}-\d{2}-\d+)/)[1];if(!papers.has(paperId)){const file=`data/papers/${paperId}.json`,original=await fs.readFile(file);papers.set(paperId,{file,original,sha256:sha256(original),paper:JSON.parse(original)});}
 const target=papers.get(paperId),paper=target.paper,passage=paper.passages.find(p=>p.sentences.some(s=>s.id===record.sentenceId)),sentence=passage.sentences.find(s=>s.id===record.sentenceId);
 if(sentence.text===newText)continue;if(sentence.text!==record.oldFullSentence)throw new Error('Current text changed after root adjudication');
 const before=structuredClone(sentence);if(sentence.textCorrection)(sentence.textCorrectionHistory??=[]).push(sentence.textCorrection);
 sentence.text=newText;sentence.textCorrection={previousText:before.text,text:newText,url:record.source.url,sourceSha256:record.source.sha256,checkedAt,
  reason:'根代理逐项核读批次04 lexical-only的第二原文和两ASR实际短语后批准的词级替换；明列邻接片段定位插词及同词多次出现的目标，不复制整句标点/英美拼写/其他缩约。',report:'references/transcript-batch-04-corrections.json',proposalSnapshot,proposalSha256};
 changes.push({paperId,passageId:passage.id,sentenceId:sentence.id,replacements:replacements[sentence.id],approvedLexicalChanges:record.changes,before,after:structuredClone(sentence),source:record.source,whisper:record.whisper,ctc:record.ctc,newWordForcedScoreClaimed:false});
 for(const q of paper.questions.filter(q=>q.passageId===passage.id))for(const[from,to]of replacements[record.sentenceId]){
  const previous=q.explanation||'',count=previous.split(from).length-1;relatedQuestionChecks.push({questionId:q.id,basisSentenceId:sentence.id,exactOldPhrase:from,exactMatches:count,evidenceLinked:q.evidenceSentenceIds?.includes(sentence.id)||false});
  if(!count)continue;q.explanation=previous.replaceAll(from,to);const correction={checkedAt,basisSentenceId:sentence.id,previousExplanation:previous,explanation:q.explanation,changedFrom:from,changedTo:to,exactOccurrences:count,origin:'developer-corrected-English-quote-from-adjudicated-transcript',basisReport:'references/transcript-batch-04-corrections.json',originalSourcePreserved:true};(q.explanationCorrections??=[]).push(correction);explanationCorrections.push({paperId,questionId:q.id,...correction});
 }
}
for(const target of papers.values())validatePaper(target.paper);
const backup='data/references/before-transcript-batch-04-corrections';await fs.mkdir(backup,{recursive:true});
for(const[paperId,target]of papers){if(!changes.some(c=>c.paperId===paperId))continue;if(sha256(await fs.readFile(target.file))!==target.sha256)throw new Error('Concurrent paper change detected');try{await fs.writeFile(`${backup}/${paperId}.json`,target.original,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}await writeJson(target.file,target.paper);}
if(changes.length)await writeJson('data/references/transcript-batch-04-corrections.json',{checkedAt,proposalFile,proposalSha256,proposalSnapshot,sourceSnapshot,sourceOriginalBytesAvailable:!!sourceSnapshot,changes,relatedQuestionChecks,explanationCorrections,timingChanged:false,reviewFlagsChanged:false,qualityChanged:false,humanListeningClaimed:false});
console.log(JSON.stringify({changedSentences:changes.length,affectedPassages:[...new Set(changes.map(c=>c.passageId))],explanationCorrections:explanationCorrections.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),sourceOriginalBytesAvailable:!!sourceSnapshot,timingChanged:false},null,2));
