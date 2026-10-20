import fs from 'node:fs/promises';
import {readJson,writeJson,sha256,stripHtml} from './corpus.mjs';
import {recognizedWords,words} from '../align.mjs';
import {validatePaper} from '../../server/validation.mjs';
const paperId='cet6-2020-09-1';const paperFile=`data/papers/${paperId}.json`;
const paper=await readJson(paperFile);const passage=paper.passages.find(p=>p.order===5);
const sources=(await readJson('data/references/transcript-correction-sources.json')).records.filter(r=>r.paperId===paperId);
const wordcram=(await readJson('data/references/independent-transcript-source-manifest.json')).records.find(r=>r.paperId===paperId);
for(const source of [...sources,wordcram])if(sha256(await fs.readFile(source.file))!==source.sha256)throw new Error('Correction source checksum mismatch');
const raw=await fs.readFile(wordcram.file,'utf8');const otherText=[...raw.matchAll(/<span[^>]*class="transcript-english"[^>]*>([\s\S]*?)<\/span>/g)].map(m=>stripHtml(m[1])).join(' ');
const recognitionFile=`data/alignment/${paperId}/passage-5.json`;const recognitionBytes=await fs.readFile(recognitionFile);const recognized=recognizedWords(JSON.parse(recognitionBytes));
const records=[
 {suffix:'p-16-2-s3',before:'worthy calls',after:'worthy cause',pdfLine:12},
 {suffix:'p-16-3-s3',before:'on which they feed',after:'on which to feed',pdfLine:14},
 {suffix:'p-16-4-s2',before:'On close inspection',after:'On closer inspection',pdfLine:16},
 {suffix:'p-16-6-s1',before:'preventing the right',after:'preventing the rise',pdfLine:18},
];const changes=[];const checkedAt=new Date().toISOString();
for(const change of records){
 const sentence=passage.sentences.find(s=>s.id===`${paperId}-${change.suffix}`);if(!sentence)throw new Error('Missing stable sentence ID');
 if(!otherText.includes(change.after))throw new Error(`Second public transcript does not support ${change.after}`);
 const tokens=words(change.after);const match=recognized.findIndex((word,i)=>recognized.slice(i,i+tokens.length).map(w=>w.word).join(' ')===tokens.join(' '));if(match<0)throw new Error('Actual audio recognition does not support correction');
 if(!sentence.text.includes(change.before)){if(sentence.text.includes(change.after)){changes.push({sentenceId:sentence.id,alreadyApplied:true});continue;}throw new Error('Unexpected source wording');}
 const before=structuredClone(sentence);sentence.text=sentence.text.replace(change.before,change.after);
 const pdf=sources.find(s=>s.kind==='xdf-pdf');
 sentence.textCorrection={previousText:before.text,text:sentence.text,url:pdf.url,sourceSha256:pdf.sha256,checkedAt,reason:'新东方当日教师原文PDF、第二公开站点原文与真实音频ASR实词三者一致；保留稳定ID及候选时间，未声称人工听校。',report:'references/radical-transcript-corrections.json'};
 changes.push({sentenceId:sentence.id,before,after:structuredClone(sentence),correction:{previous:change.before,replacement:change.after},pdfEvidence:{page:1,extractedLine:change.pdfLine,checkedBy:'root independent PDF read and collector web PDF text verification'},wordEvidence:recognized.slice(match,match+tokens.length).map(w=>({...w,start:+(passage.start+w.start).toFixed(3),end:+(passage.start+w.end).toFixed(3)}))});
}
validatePaper(paper);const backup='data/references/before-radical-transcript-corrections';await fs.mkdir(backup,{recursive:true});try{await fs.writeFile(`${backup}/${paperId}.json`,await fs.readFile(paperFile),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await writeJson(paperFile,paper);const reportFile='data/references/radical-transcript-corrections.json';if(!(await readJson(reportFile,null))||changes.some(c=>!c.alreadyApplied))await writeJson(reportFile,{checkedAt,paperId,sources:[...sources,wordcram],recognition:{file:recognitionFile,sha256:sha256(recognitionBytes)},changes,timingChanged:false,reviewFlagsChanged:false,notes:['新东方HTML的without fear一句有自身误写and which；该句以PDF on which to feed、WordCram和音频三项吻合为据。','不替换 effect/affect 等其它未确认为错误的词。']});
console.log(JSON.stringify({paperId,corrections:changes.map(c=>({sentenceId:c.sentenceId,change:c.correction,alreadyApplied:!!c.alreadyApplied})),timingChanged:false}));
