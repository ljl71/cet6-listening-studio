import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {recognizedWords,words} from '../align.mjs';
import {validatePaper} from '../../server/validation.mjs';
const decisions=[
 {id:'cet6-2024-06-1-p-9-4-s1',from:'which are packed high',to:'which are often high'},
 {id:'cet6-2022-06-1-p-9-2-s8',from:'The searches',to:'These searches'},
 {id:'cet6-2020-12-2-p-16-3-s3',from:'this solitude influences',to:'this solitude influenced'},
 {id:'cet6-2023-12-1-p-19-1-s1',from:'dog owners would tell',to:'dog owners will tell'},
];
const input='data/references/transcript-acoustic-crosscheck.json';const crosscheck=await readJson(input);
const reportFile='data/references/crosschecked-transcript-corrections.json';const existing=await readJson(reportFile,{changes:[]});
const checkedAt=new Date().toISOString();const changes=[];const touched=new Map();
for(const decision of decisions){
 const item=crosscheck.items.find(item=>item.sentenceId===decision.id);if(!item)throw new Error('Missing explicit crosscheck item');
 const html=await fs.readFile(item.sourceHtml);if(sha256(html)!==item.sourceHash)throw new Error('Saved public transcript checksum changed');
 if(!item.closestIndependentSentence.includes(decision.to))throw new Error('Second public source does not contain approved replacement');
 const tokens=words(decision.to);const contains=values=>values.findIndex((_,i)=>values.slice(i,i+tokens.length).join(' ')===tokens.join(' '));
 const whisperEvidence=[];
 for(const variant of item.whisperVariants||[]){const bytes=await fs.readFile(variant.file);const recognition=recognizedWords(JSON.parse(bytes));const index=contains(recognition.map(w=>w.word));if(index>=0)whisperEvidence.push({file:variant.file,sha256:sha256(bytes),timeBasis:'passage-relative',wordEvidence:recognition.slice(index,index+tokens.length)});}
 if(!whisperEvidence.length)throw new Error('Actual Whisper cache does not support approved words');
 const acousticFile=item.acoustic?.report;if(!acousticFile)throw new Error('Missing independent acoustic report');const acousticBytes=await fs.readFile(acousticFile);const acoustic=JSON.parse(acousticBytes);
 if(contains(words(acoustic.greedyTranscript))<0)throw new Error('Independent unprompted greedy transcript does not support approved words');
 const acousticHash=sha256(acousticBytes);const archived=`data/references/transcript-correction-acoustic-cache/${acousticHash}.json`;await fs.mkdir(path.dirname(archived),{recursive:true});await fs.writeFile(archived,acousticBytes);
 if(!touched.has(item.paperId)){const file=`data/papers/${item.paperId}.json`;const bytes=await fs.readFile(file);touched.set(item.paperId,{file,bytes,paper:JSON.parse(bytes)});}
 const current=touched.get(item.paperId);const sentence=current.paper.passages.flatMap(p=>p.sentences).find(s=>s.id===decision.id);
 if(sentence.text.includes(decision.to)&&!sentence.text.includes(decision.from))continue;
 if(!sentence.text.includes(decision.from))throw new Error('Current text does not contain the approved original phrase');
 const before=structuredClone(sentence);sentence.text=sentence.text.replace(decision.from,decision.to);
 if(sentence.textCorrection)(sentence.textCorrectionHistory??=[]).push(sentence.textCorrection);
 sentence.textCorrection={previousText:before.text,text:sentence.text,url:item.sourceUrl,sourceSha256:item.sourceHash,checkedAt,reason:'第二公开原文、Whisper真实音频识别与独立CTC无提示greedy三个实词证据一致；仅改确认词，保留ID和候选时间。',report:'references/crosschecked-transcript-corrections.json'};
 changes.push({paperId:item.paperId,passageId:item.passageId,audioAssetId:current.paper.audioAssetId,sourceRange:{start:current.paper.passages.find(p=>p.id===item.passageId).start,end:current.paper.passages.find(p=>p.id===item.passageId).end},sentenceId:sentence.id,before,after:structuredClone(sentence),replacement:decision,
  publicText:{url:item.sourceUrl,file:item.sourceHtml,sha256:item.sourceHash,confirmedPhrase:decision.to},whisperEvidence,
  ctcEvidence:{liveReport:acousticFile,archivedReport:archived,sha256:acousticHash,greedyConfirmedPhrase:decision.to,forcedReferenceWasOldText:true},reviewed:false});
}
for(const [paperId,current]of touched){validatePaper(current.paper);const folder='data/references/before-crosschecked-transcript-corrections';await fs.mkdir(folder,{recursive:true});try{await fs.writeFile(`${folder}/${paperId}.json`,current.bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}if(changes.some(c=>c.paperId===paperId))await writeJson(current.file,current.paper);}
if(changes.length)await writeJson(reportFile,{checkedAt,timingChanged:false,reviewFlagsChanged:false,changes:[...existing.changes,...changes],notes:['CTC强制参考仍为旧稿，只使用不受参考提示的greedy确认目标词；该篇须用新稿重对齐后才能采纳时间。','保留study等未获三个证据同时支持的原词；不照搬第二网站整句。']});
console.log(JSON.stringify({changes:changes.map(c=>({sentenceId:c.sentenceId,replacement:c.replacement})),timingChanged:false}));
