import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runCollection} from '../scripts/lib/collection.mjs';
const host='https://english-exam.lazynote.cn',media='https://listening.lazynote.cn/test/';
const catalog='<a href="/cet6/sections/listening/2025-12-1/">Original fixture</a><a href="/cet6/sections/listening/2024-06-1/">Original second fixture</a>';
const originalAudio=Buffer.from('self-authored-test-audio-placeholder');
function page(){
 const props=JSON.stringify({src:[0,media+'index.m3u8']}).replaceAll('"','&quot;');
 return `<astro-island component-url="ListeningAudioBar" props="${props}"></astro-island>`+
  [1,5,9,12,16,19,22].map(n=>`<div id="lt-${n}" class="lt-piece"><p id="p-${n}-1" class="lt-en">This is an original test sentence.</p></div>`).join('')+
  '<astro-island>'+Array.from({length:25},(_,i)=>`<div id="q-${i+1}" class="lqp-unit">${['A','B','C','D'].map(k=>`<span data-pdh-letter="${k}">Original option ${k}</span>`).join('')}<strong class="rp-ans">A</strong></div>`).join('')+'</astro-island>';
}
async function setup(t,{rules='User-agent: *\nDisallow: /downloads/',audioStatus=200,redirect=false,encrypted=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cet6-collect-')),data=path.join(root,'data'),events=[],calls=[];
 const original=globalThis.fetch;t.after(async()=>{globalThis.fetch=original;await fs.rm(root,{recursive:true,force:true});});
 globalThis.fetch=async(value,options)=>{
  const url=String(value);calls.push({url,range:options?.headers?.Range});
  if(url.endsWith('robots.txt'))return new Response(rules);
  if(url===host+'/cet6/sections/listening/')return new Response(catalog);
  if(url.startsWith(host))return new Response(page());
  if(url.endsWith('index.m3u8'))return new Response('#EXTM3U\n'+(encrypted?'#EXT-X-KEY:METHOD=AES-128,URI="secret"\n':'')+'#EXTINF:10,\n000.ts\n#EXT-X-ENDLIST');
  if(redirect)return new Response('',{status:302,headers:{location:'http://127.0.0.1/secret'}});
  if(audioStatus!==200)return new Response('',{status:audioStatus});
  const offset=Number(options?.headers?.Range?.match(/bytes=(\d+)-/)?.[1]||0);
  return new Response(originalAudio.subarray(offset),{status:offset?206:200,headers:{'Content-Length':originalAudio.length-offset,...(offset?{'Content-Range':`bytes ${offset}-${originalAudio.length-1}/${originalAudio.length}`}:{})}});
 };
 let toolCalls=0;
 const options={root,data,years:[2025],minDelay:0,onEvent:event=>events.push(event),prepareTools:async()=>{toolCalls++;return {ffmpeg:'mock-converter',ffprobe:'mock-probe'};},executeTool:async(command,args)=>{
  if(command==='mock-probe')return JSON.stringify({format:{duration:10}});
  if(args.at(-1).endsWith('.m4a'))await fs.writeFile(args.at(-1),originalAudio);return '';
 }};
 return {root,data,events,calls,options,toolCalls:()=>toolCalls};
}
test('fresh collection resumes cached bytes, saves all contents, and preserves reviewed data on repetition',async t=>{
 const f=await setup(t),cache=path.join(f.data,'raw/hls-2025-12-1');await fs.mkdir(cache,{recursive:true});await fs.writeFile(path.join(cache,'0000.ts.part'),originalAudio.subarray(0,5));
 assert.deepEqual(await runCollection(f.options),{failed:0,total:1});
 assert.equal(f.calls.find(c=>c.url.endsWith('000.ts')).range,'bytes=5-');
 const file=path.join(f.data,'papers/cet6-2025-12-1.json'),paper=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(paper.questions.length,25);assert.equal(paper.passages.length,7);assert.ok(paper.audioAssetId);
 assert.equal(paper.quality.audio,'verified');assert.equal(paper.quality.answers,'candidate');assert.equal(paper.quality.timing,'candidate');
 assert.ok(paper.passages.every(p=>p.sentences[0].start===0&&!p.sentences[0].reviewed));
 paper.passages[0].sentences[0].text='A reviewed local correction.';paper.passages[0].sentences[0].reviewed=true;await fs.writeFile(file,JSON.stringify(paper));
 const before=await fs.readFile(file,'utf8');f.calls.length=0;
 await runCollection(f.options);assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(f.toolCalls(),1);
 assert.equal(f.calls.filter(c=>!c.url.endsWith('robots.txt')).length,1);assert.equal(f.events.at(-1).status,'skipped');
 assert.equal((await fs.readdir(path.join(f.data,'media'))).length,1);
});
test('text is retained after media restriction and a later retry obtains the missing audio',async t=>{
 const f=await setup(t,{audioStatus:403});await assert.rejects(runCollection(f.options),/Access restricted/);
 const file=path.join(f.data,'papers/cet6-2025-12-1.json');assert.equal(JSON.parse(await fs.readFile(file,'utf8')).audioAssetId,null);
 assert.equal(f.calls.filter(c=>c.url.endsWith('000.ts')).length,1);
 assert.equal(f.events.at(-1).status,'failed');
 const original=globalThis.fetch;globalThis.fetch=async(url,options)=>String(url).endsWith('000.ts')?new Response(originalAudio):original(url,options);
 assert.deepEqual(await runCollection(f.options),{failed:0,total:1});assert.ok(JSON.parse(await fs.readFile(file,'utf8')).audioAssetId);
});
test('robots denial and encrypted media stop without downloading audio',async t=>{
 const f=await setup(t,{rules:'User-agent: *\nDisallow: /cet6/'});
 await assert.rejects(runCollection(f.options),/robots/);assert.equal(f.calls.some(c=>c.url.includes('/test/')),false);
});
test('redirects cannot escape to a private host even when supplied by an allowed source',async t=>{
 const f=await setup(t,{redirect:true});await assert.rejects(runCollection(f.options),/来源地址/);
 assert.equal(f.calls.some(c=>c.url.includes('127.0.0.1')),false);
});
test('encrypted playlists are not fetched and pre-cancelled work makes no network request',async t=>{
 const f=await setup(t,{encrypted:true});await assert.rejects(runCollection(f.options),/Encrypted/);assert.equal(f.calls.some(c=>c.url.endsWith('000.ts')),false);
 f.calls.length=0;await assert.rejects(runCollection({...f.options,signal:AbortSignal.abort(new Error('cancelled'))}),/cancelled/);assert.equal(f.calls.length,0);
});
