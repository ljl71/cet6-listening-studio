import fs from 'node:fs/promises';
import {writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const proofFile='data/references/transcript-2023-03-guest-third-source.json',proofBytes=await fs.readFile(proofFile),proofSha256=sha256(proofBytes);
if(proofSha256!=='f381a4f0baee723d1660cd4c85db59c1294493b5999c4e8c9729f268c25340ee')throw new Error('Third-source proof differs from approved frozen evidence');
const proof=JSON.parse(proofBytes);if(sha256(await fs.readFile(proof.pdfSource.file))!==proof.pdfSource.sha256)throw new Error('Original PDF hash changed');
const immutable=`data/references/transcript-adjudication-snapshots/${proofSha256}.json`;await fs.writeFile(immutable,proofBytes);
const paperId='cet6-2023-03-1',file=`data/papers/${paperId}.json`,original=await fs.readFile(file),paper=JSON.parse(original),passage=paper.passages.find(p=>p.order===4),sentence=passage.sentences.find(s=>s.id===proof.sentenceId);
if(sentence.text===proof.minimumProposal){console.log('Guest article correction already applied');process.exit(0);}
if(sentence.text!==proof.oldLocalText||sentence.text.replace('their guests','the guests')!==proof.minimumProposal)throw new Error('Current text differs from the approved one-article edit');
const before=structuredClone(sentence),checkedAt=new Date().toISOString();sentence.text=proof.minimumProposal;
sentence.textCorrection={previousText:before.text,text:sentence.text,url:proof.pdfSource.url,sourceSha256:proof.pdfSource.sha256,checkedAt,reason:'根代理对照另一公开学习资料PDF物理第6页/印刷第17页批准仅their guests→the guests；保留PDF明确的guests复数，不因ASR弱尾音误识而删除s。',report:'references/guest-article-correction.json',evidenceSnapshot:immutable,evidenceSha256:proofSha256};
const explanationCorrections=[];for(const q of paper.questions.filter(q=>q.passageId===passage.id)){
 const old=q.explanation||'',from='their guests refused',to='the guests refused',count=old.split(from).length-1;if(!count)continue;q.explanation=old.replaceAll(from,to);
 const c={checkedAt,basisSentenceId:sentence.id,previousExplanation:old,explanation:q.explanation,changedFrom:from,changedTo:to,exactOccurrences:count,origin:'developer-corrected-English-quote-from-adjudicated-transcript',basisReport:'references/guest-article-correction.json',originalSourcePreserved:true};(q.explanationCorrections??=[]).push(c);explanationCorrections.push({questionId:q.id,...c});
}
validatePaper(paper);const backup='data/references/before-guest-article-correction';await fs.mkdir(backup,{recursive:true});try{await fs.writeFile(`${backup}/${paperId}.json`,original,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await writeJson(file,paper);await writeJson('data/references/guest-article-correction.json',{checkedAt,paperId,passageId:passage.id,sentenceId:sentence.id,before,after:sentence,proofFile,proofSha256,proofSnapshot:immutable,pdfSource:proof.pdfSource,otherEvidence:proof.otherEvidence,explanationCorrections,retainedPluralGuests:true,timingChanged:false,humanListeningClaimed:false});
console.log(JSON.stringify({sentenceId:sentence.id,change:'their guests → the guests',explanationCorrections:explanationCorrections.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),retainedPluralGuests:true,timingChanged:false}));
