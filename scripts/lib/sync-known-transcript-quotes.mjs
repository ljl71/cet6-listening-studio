import fs from 'node:fs/promises';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const approved=[
 {paperId:'cet6-2023-12-1',questionId:'cet6-2023-12-1-q19',sentenceId:'cet6-2023-12-1-p-19-1-s1',from:'dog owners would tell',to:'dog owners will tell'},
 {paperId:'cet6-2024-06-1',questionId:'cet6-2024-06-1-q11',sentenceId:'cet6-2024-06-1-p-9-4-s1',from:'which are packed high',to:'which are often high'},
];
const proofFile='data/references/crosschecked-transcript-corrections.json';const proof=await fs.readFile(proofFile);const changes=[];const checkedAt=new Date().toISOString();
for(const target of approved){
 const file=`data/papers/${target.paperId}.json`,bytes=await fs.readFile(file),paper=JSON.parse(bytes);
 const sentence=paper.passages.flatMap(p=>p.sentences).find(s=>s.id===target.sentenceId);const q=paper.questions.find(q=>q.id===target.questionId);
 if(!sentence.text.includes(target.to)||!q.evidenceSentenceIds.includes(sentence.id))throw new Error('Corrected sentence is not the existing cited evidence');
 if(!q.explanation.includes(target.from)){if(q.explanation.includes(target.to))continue;throw new Error('Expected exact old English quotation not found');}
 const previousExplanation=q.explanation;const exactOccurrences=previousExplanation.split(target.from).length-1;
 q.explanation=previousExplanation.replaceAll(target.from,target.to);
 const correction={checkedAt,basisSentenceId:sentence.id,previousExplanation,explanation:q.explanation,changedFrom:target.from,changedTo:target.to,exactOccurrences,origin:'developer-corrected-English-quote-from-adjudicated-transcript',basisReport:'references/crosschecked-transcript-corrections.json',basisReportSha256:sha256(proof),originalSourcePreserved:true};
 (q.explanationCorrections??=[]).push(correction);validatePaper(paper);
 const folder='data/references/before-known-transcript-quote-sync';await fs.mkdir(folder,{recursive:true});try{await fs.writeFile(`${folder}/${paper.id}.json`,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
 await writeJson(file,paper);changes.push({paperId:paper.id,questionId:q.id,...correction});
}
if(changes.length)await writeJson('data/references/known-transcript-quote-sync.json',{checkedAt,changes,evidenceSentenceIdsChanged:false,ChineseExplanationChanged:false,notes:['只同步已获确认原文纠错且英文片段完全命中的两道既有依据引文；不扩展依据句、不改中文或原来源。']});
console.log(JSON.stringify({changedExplanations:changes.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),evidenceSentenceIdsChanged:false}));
