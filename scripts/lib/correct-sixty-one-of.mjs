import fs from 'node:fs/promises';
import {writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const evidenceFile='data/references/transcript-2020-07-61-of-evidence.json',evidenceBytes=await fs.readFile(evidenceFile),evidenceSha256=sha256(evidenceBytes);
if(evidenceSha256!=='a21e29e7353197ea307b43b82d3f65b9ce83bf37b5727dd090b98dd925493338')throw new Error('Evidence differs from the explicitly approved frozen bytes');
const evidence=JSON.parse(evidenceBytes);for(const source of evidence.sources)if(sha256(await fs.readFile(source.file))!==source.sha256)throw new Error('Public source checksum changed');
if(sha256(await fs.readFile(evidence.whisper.file))!==evidence.whisper.sha256||sha256(await fs.readFile(evidence.ctc.archivedReport))!==evidence.ctc.sha256)throw new Error('Saved model proof checksum changed');
const snapshot=`data/references/transcript-adjudication-snapshots/${evidenceSha256}.json`;await fs.writeFile(snapshot,evidenceBytes);
const paperId='cet6-2020-07-1',file=`data/papers/${paperId}.json`,original=await fs.readFile(file),paper=JSON.parse(original),passage=paper.passages.find(p=>p.order===5),sentence=passage.sentences.find(s=>s.id===evidence.sentenceId);
if(sentence.text===evidence.proposedText){console.log('Approved of insertion already applied');process.exit(0);}
if(sentence.text!==evidence.oldText||sentence.text.replace('61% male respondents','61% of male respondents')!==evidence.proposedText)throw new Error('Current source differs from the minimum approved insertion');
const before=structuredClone(sentence),checkedAt=new Date().toISOString();sentence.text=evidence.proposedText;
sentence.textCorrection={previousText:before.text,text:sentence.text,url:evidence.sources[0].url,sourceSha256:evidence.sources[0].sha256,checkedAt,reason:'根代理批准补齐61%后的of；教师PDF、tiny与无提示CTC greedy一致，新插入词强制路径分数待新稿重放，不改原时间。',report:'references/sixty-one-of-correction.json',evidenceSnapshot:snapshot,evidenceSha256};
const explanationCorrections=[];
for(const q of paper.questions.filter(q=>q.passageId===passage.id)){
 const previous=q.explanation||'',from='61% male respondents',to='61% of male respondents',count=previous.split(from).length-1;if(!count)continue;
 q.explanation=previous.replaceAll(from,to);const correction={checkedAt,basisSentenceId:sentence.id,previousExplanation:previous,explanation:q.explanation,changedFrom:from,changedTo:to,exactOccurrences:count,origin:'developer-corrected-English-quote-from-adjudicated-transcript',basisReport:'references/sixty-one-of-correction.json',originalSourcePreserved:true};
 (q.explanationCorrections??=[]).push(correction);explanationCorrections.push({questionId:q.id,...correction});
}
validatePaper(paper);const backup='data/references/before-sixty-one-of-correction';await fs.mkdir(backup,{recursive:true});try{await fs.writeFile(`${backup}/${paperId}.json`,original,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await writeJson(file,paper);await writeJson('data/references/sixty-one-of-correction.json',{checkedAt,paperId,passageId:passage.id,sentenceId:sentence.id,before,after:sentence,evidenceFile,evidenceSha256,evidenceSnapshot:snapshot,sources:evidence.sources,whisper:evidence.whisper,ctc:evidence.ctc,explanationCorrections,timingChanged:false,newWordForcedScoreClaimed:false,humanListeningClaimed:false});
console.log(JSON.stringify({sentenceId:sentence.id,insertedWord:'of',explanationCorrections:explanationCorrections.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),timingChanged:false}));
