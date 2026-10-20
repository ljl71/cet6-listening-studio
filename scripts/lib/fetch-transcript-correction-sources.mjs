import fs from 'node:fs/promises';
import {request} from './download.mjs';
import {readJson,writeJson,sha256,stripHtml} from './corpus.mjs';
const targets=[
 {paperId:'cet6-2020-09-1',kind:'xdf-html',url:'https://mtoutiao.xdf.cn/cet4-6/202009/11109073.html',file:'cet6-2020-09-1-independent-transcript-xdf.html'},
 {paperId:'cet6-2020-09-1',kind:'xdf-pdf',url:'https://file.xdf.cn/uploads/200922/1581_200922170109TdfJW63bRkzStHSS.pdf',file:'cet6-2020-09-1-independent-transcript-xdf.pdf'},
];
const file='data/references/transcript-correction-sources.json';const records=(await readJson(file,{records:[]})).records;
for(const target of targets){const destination=`data/references/${target.file}`;let bytes;try{bytes=await fs.readFile(destination);}catch(error){if(error.code!=='ENOENT')throw error;const response=await request(target.url);bytes=Buffer.from(await response.arrayBuffer());await fs.writeFile(destination,bytes);}const record={...target,file:destination,sha256:sha256(bytes),bytes:bytes.length,fetchedAt:new Date().toISOString(),...(target.kind==='xdf-html'?{excerptMatches:stripHtml(bytes.toString()).match(/.{0,40}(?:worthy cause|which to feed|closer inspection|preventing the rise).{0,50}/g)||[]}: {hasPDFMagic:bytes.subarray(0,5).toString()==='%PDF-'})};if(target.kind==='xdf-pdf'&&!record.hasPDFMagic)throw new Error('Expected real PDF bytes');const index=records.findIndex(r=>r.url===target.url);if(index<0)records.push(record);else records[index]=record;console.log(JSON.stringify(record));}
await writeJson(file,{records});
