import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,sha256,stripHtml} from './corpus.mjs';
import {recognizedWords} from '../align.mjs';
import {validatePaper} from '../../server/validation.mjs';

// Narrow, idempotent correction supported by a second saved public transcript
// and both cached acoustic recognizers. Timings and review flags are untouched.
const paperId='cet6-2020-12-2';
const manifest=await readJson('data/references/independent-transcript-source-manifest.json');
const source=manifest.records.find(record=>record.paperId===paperId);
const raw=await fs.readFile(source.file);
if(sha256(raw)!==source.sha256)throw new Error('Independent source hash changed');
const text=[...raw.toString().matchAll(/<span[^>]*class="transcript-english"[^>]*>([\s\S]*?)<\/span>/g)].map(match=>stripHtml(match[1])).join(' ');
const quote="Huh, I've gone one step further.";
if(!text.includes(quote))throw new Error('Independent transcript does not contain expected wording');
const paperFile=path.join('data','papers',`${paperId}.json`);
const paper=await readJson(paperFile);const passage=paper.passages.find(p=>p.order===1);
const acoustic=[];
for(const suffix of ['', '-base']){
 const file=`data/alignment/${paperId}/passage-1${suffix}.json`;
 const bytes=await fs.readFile(file);const recognition=JSON.parse(bytes);
 const tokens=recognizedWords(recognition);
 const match=tokens.findIndex((word,i)=>word.word==='huh'&&tokens.slice(i,i+6).map(w=>w.word).join(' ')==='huh ive gone one step further');
 if(match<0)throw new Error(`Acoustic cache does not support Huh/gone: ${file}`);
 acoustic.push({file,sha256:sha256(bytes),model:recognition.params?.model,words:tokens.slice(match,match+6).map(word=>({...word,start:+(passage.start+word.start).toFixed(3),end:+(passage.start+word.end).toFixed(3)}))});
}
const expected=[{id:`${paperId}-p-1-6-s1`,previousText:'M: Ha.',text:'M: Huh.'},{id:`${paperId}-p-1-6-s2`,previousText:"I've got one step further.",text:"I've gone one step further."}];
const changes=[];const checkedAt=new Date().toISOString();
for(const change of expected){
 const sentence=passage.sentences.find(s=>s.id===change.id);
 if(sentence.text===change.text){changes.push({sentenceId:sentence.id,alreadyApplied:true,text:sentence.text});continue;}
 if(sentence.text!==change.previousText)throw new Error(`Unexpected current text: ${change.id}`);
 const before=structuredClone(sentence);
 sentence.text=change.text;
 sentence.textCorrection={previousText:change.previousText,text:change.text,url:source.url,sourceSha256:source.sha256,checkedAt,reason:'第二公开站点原文与tiny/base两份真实音频识别一致，保留ID与已有候选时间；不是人工听校完成。',report:'references/interjection-source-correction.json'};
 changes.push({sentenceId:sentence.id,before,after:structuredClone(sentence)});
}
validatePaper(paper);
const backup=path.join('data','references','before-interjection-source-correction');await fs.mkdir(backup,{recursive:true});
try{await fs.writeFile(path.join(backup,`${paperId}.json`),await fs.readFile(paperFile),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await writeJson(paperFile,paper);
const reportFile='data/references/interjection-source-correction.json';const prior=await readJson(reportFile,null);
if(!prior||changes.some(c=>!c.alreadyApplied))await writeJson(reportFile,{checkedAt,paperId,source:{url:source.url,file:source.file,sha256:source.sha256,quote,independentAuthorshipEstablished:false},acoustic,changes,timingChanged:false,reviewFlagsChanged:false,notes:['另一公开网站的文字和两个识别缓存一致，不能据此声称人工听校。','不使用第二网站的 data-time；其音频版本不同。','先前 missing-alignment-completion.json 的 Ha/Huh 未决记录是修正前历史，本报告补充可追溯的文字证据。']});
console.log(JSON.stringify({paperId,changes:changes.map(c=>({sentenceId:c.sentenceId,text:c.after?.text||c.text,alreadyApplied:!!c.alreadyApplied})),timingChanged:false}));
