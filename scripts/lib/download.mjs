import fs from 'node:fs/promises';
import path from 'node:path';
import {sha256} from './corpus.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let lastRequest=0;
let gate=Promise.resolve();
async function throttle(milliseconds){const own=gate.then(async()=>{await sleep(Math.max(0,lastRequest+milliseconds-Date.now()));lastRequest=Date.now();});gate=own.catch(()=>{});await own;}
export async function request(url,{headers={},attempts=4,minDelay=120,signal,validateUrl}={}){
 for(let attempt=0;attempt<attempts;attempt++){
  await throttle(minDelay);
  try {
   signal?.throwIfAborted();
   let target=url;
   for(let redirect=0;redirect<=5;redirect++){
    validateUrl?.(target);
    const r=await fetch(target,{headers:{'User-Agent':'CET6LocalStudy/0.1 (personal study, rate limited)',...headers},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000),redirect:validateUrl?'manual':'follow'});
    if([301,302,303,307,308].includes(r.status)&&validateUrl){await r.body?.cancel();if(redirect===5)throw new Error('Too many redirects');target=new URL(r.headers.get('location'),target).href;continue;}
    if(r.status===401||r.status===403||r.status===429)throw Object.assign(new Error(`Access restricted ${r.status}: ${target}`),{restricted:true});
    if(!r.ok&&r.status!==416)throw new Error(`HTTP ${r.status}: ${target}`);return r;
   }
  }
  catch(e){if(e.restricted||signal?.aborted||attempt===attempts-1)throw e;await sleep(600*2**attempt);}
 }
}
export async function downloadFile(url,destination,{minDelay=120,signal,validateUrl,onProgress}={}){
 signal?.throwIfAborted();
 await fs.mkdir(path.dirname(destination),{recursive:true});
 try{const done=await fs.readFile(destination);return {size:done.length,sha256:sha256(done),cached:true};}catch(e){if(e.code!=='ENOENT')throw e;}
 const partial=`${destination}.part`;
 for(let attempt=0;attempt<4;attempt++){
  let offset=0;try{offset=(await fs.stat(partial)).size;}catch{}
  try{
   const response=await request(url,{headers:offset?{Range:`bytes=${offset}-`}:{},minDelay,signal,validateUrl});
   if(response.status===416){await fs.rm(partial,{force:true});continue;}
   if(response.status===206){const range=response.headers.get('content-range');if(!range?.startsWith(`bytes ${offset}-`))throw new Error('Invalid resumed byte range');}
   else if(offset){offset=0;await fs.rm(partial,{force:true});}
   const handle=await fs.open(partial,offset?'a':'w');let received=0;
   try{for await(const chunk of response.body){signal?.throwIfAborted();await handle.write(chunk);received+=chunk.length;onProgress?.({received:offset+received,total:offset+Number(response.headers.get('content-length')||0)});}}finally{await handle.close();}
   const expected=Number(response.headers.get('content-length'));if(expected&&received!==expected)throw new Error('Incomplete response');
   const bytes=await fs.readFile(partial);if(!bytes.length)throw new Error('Empty download');await fs.rename(partial,destination);
   return {size:bytes.length,sha256:sha256(bytes),cached:false};
  }catch(e){if(e.restricted||signal?.aborted||attempt===3)throw e;await sleep(400*2**attempt);}
 }
 throw new Error('Download failed');
}
