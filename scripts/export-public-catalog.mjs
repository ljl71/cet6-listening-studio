// Publish metadata only. Never copies audio, question text, answers, transcripts,
// notes, local paths, browser state, or personal learning records.
import fs from 'node:fs/promises';
import path from 'node:path';
import {sha256,writeJson} from './lib/corpus.mjs';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const manifest=await read('data/manifest.json'),assets=await read('data/assets.json');
function publicUrl(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hostname==='localhost'||/^(127\.|10\.|192\.168\.)/.test(u.hostname))return null;
  if([...u.searchParams.keys()].some(k=>/token|secret|signature|authorization|password/i.test(k)))throw Error('Credential-like query key in source URL');return u.href;
 }catch(e){if(e.message.includes('Credential-like'))throw e;return null;}
}
const entries=[];
for(const m of manifest.entries){
 const p=await read(`data/papers/${m.id}.json`),a=assets[p.audioAssetId];
 entries.push({id:p.id,title:p.title,year:p.year,month:p.month,variant:p.variant,actualDate:p.actualDate||null,originalPeriod:p.originalPeriod||null,
  counts:{questions:p.questions.length,passages:p.passages.length,sentences:p.passages.reduce((n,q)=>n+q.sentences.length,0)},quality:p.quality,
  audio:a?{sha256:a.sha256,bytes:a.size,durationSeconds:a.duration,mime:a.mime}:null,
  sources:[...new Map(p.sources.flatMap(s=>{const url=publicUrl(s.url);return url?[{label:s.label,kind:s.kind,url}]:[];}).map(s=>[s.kind+':'+s.url,s])).values()]});
}
const sources=[];
for(const file of ['data/references/independent-transcript-source-manifest.json','data/references/transcript-correction-sources.json']){
 const value=await read(file);for(const r of value.records||[]){const url=publicUrl(r.url);if(!url||!r.file)continue;const b=await fs.readFile(r.file);if(r.sha256&&sha256(b)!==r.sha256)throw Error('Changed original source');sources.push({paperId:r.paperId||null,url,fileName:path.basename(r.file),bytes:b.length,sha256:sha256(b),redistributionPermission:'not-confirmed-original-not-published'});}
}
const pdfSources=await read('data/references/independent-pdf-transcript-comparison.json');
for(const p of pdfSources.papers){
 const s=p.source,url=publicUrl(s?.publicDirectory||s?.url);if(!url||!s?.file)continue;
 const bytes=await fs.readFile(s.file);if(sha256(bytes)!==s.sha256)throw Error('Changed PDF original');
 sources.push({paperId:p.paperId,url,fileName:s.sourceFileName||path.basename(s.file),bytes:bytes.length,sha256:s.sha256,kind:'reference-pdf',redistributionPermission:'not-confirmed-original-not-published'});
}
await writeJson('resources/catalog.json',{schemaVersion:1,asOf:'2026-10-20',scope:manifest.scope,originalFilesIncluded:false,formalDeliveryPassed:false,entries});
await writeJson('resources/reference-sources.json',{schemaVersion:1,asOf:'2026-10-20',originalFilesIncluded:false,records:sources});
// A complete structural template contains original placeholders only.
const counts=[4,4,3,4,3,3,4],types=['conversation','conversation','passage','passage','lecture','lecture','lecture'];
const passages=counts.map((_,i)=>({id:`template-p${i+1}`,order:i+1,type:types[i],title:`自制结构占位 · 篇章${i+1}`,start:0,end:0,sentences:[{id:`template-p${i+1}-s1`,start:0,end:0,text:`Replace this original placeholder with your own authorized transcript for passage ${i+1}.`,reviewed:false}]}));
let number=0;const questions=passages.flatMap((p,i)=>Array.from({length:counts[i]},()=>({id:`template-q${++number}`,number,passageId:p.id,options:{A:'Your original option A',B:'Your original option B',C:'Your original option C',D:'Your original option D'},answer:'A',explanation:'Placeholder only. Replace with your independently checked explanation.',evidenceSentenceIds:[p.sentences[0].id]})));
await writeJson('examples/paper.template.json',{id:'original-paper-template',title:'自制结构模板 · 非真题',year:2025,month:6,variant:'template',contentId:'original-paper-template-content',audioAssetId:null,duration:0,required:false,sources:[],quality:{audio:'missing',questions:'candidate',answers:'candidate',transcript:'candidate',timing:'candidate'},passages,questions,notes:['全部内容均为结构占位。请替换、填写实际音频时长并校对；A不是实际答案。']});
console.log(JSON.stringify({papers:entries.length,sourceMetadata:sources.length,originalFilesPublished:0}));
