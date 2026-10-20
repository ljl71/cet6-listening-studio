import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createCollectionJobs} from '../server/collection-jobs.mjs';
import {createServer} from '../server/index.mjs';
import {robotsAllows,publicSourceUrl} from '../scripts/lib/source-access.mjs';
import {request} from '../scripts/lib/download.mjs';
const workerPath=fileURLToPath(new URL('./fixtures/collection-worker.mjs',import.meta.url));
const wait=async(predicate)=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Job did not reach expected state');};
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'cet6-jobs-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));return dataDir;}

test('robots obeys longest path, allow ties, wildcards, query and specific agent groups',()=>{
 const source='https://english-exam.lazynote.cn';
 const rules='User-agent: *\nDisallow: /\nUser-agent: CET6LocalStudy\nDisallow: /cet6/\nAllow: /cet6/public/\nDisallow: /*?pay=1$';
 assert.equal(robotsAllows(rules,source+'/cet6/private/'),false);
 assert.equal(robotsAllows(rules,source+'/cet6/public/'),true);
 assert.equal(robotsAllows(rules,source+'/other'),true);
 assert.equal(robotsAllows(rules,source+'/other?pay=1'),false);
 assert.equal(robotsAllows('User-agent: *\nDisallow: /a\nAllow: /a',source+'/a'),true);
 assert.equal(robotsAllows('User-agent: *\nDisallow:',source+'/anywhere'),true);
});
test('source allowlist rejects local, foreign, credential, port and restricted URLs',()=>{
 for(const url of ['http://127.0.0.1/','https://evil.example/','https://english-exam.lazynote.cn:444/','https://user:secret@listening.lazynote.cn/','https://english-exam.lazynote.cn/downloads/a','https://english-exam.lazynote.cn/login'])assert.throws(()=>publicSourceUrl(url));
 assert.equal(publicSourceUrl('https://listening.lazynote.cn/a/index.m3u8').hostname,'listening.lazynote.cn');
});
test('request stops at access restrictions, refuses unsafe redirects and observes cancellation',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('',{status:403});};
 await assert.rejects(request('https://english-exam.lazynote.cn/a',{minDelay:0}),/Access restricted/);assert.equal(calls,1);
 globalThis.fetch=async()=>{calls++;return new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}});};
 await assert.rejects(request('https://english-exam.lazynote.cn/a',{minDelay:0,validateUrl:publicSourceUrl}),/来源地址/);assert.equal(calls,2);
 const signal=AbortSignal.abort(new Error('test cancelled'));
 await assert.rejects(request('https://english-exam.lazynote.cn/a',{minDelay:0,signal}),/test cancelled/);assert.equal(calls,2);
});
test('job survives UI reconnect, rejects duplicate owners, completes and persists status',async t=>{
 const dataDir=await fixture(t),jobs=createCollectionJobs({dataDir,workerPath});
 assert.equal(jobs.snapshot().status,'idle');const job=jobs.start({years:[2020]});assert.equal(job.status,'running');
 assert.throws(()=>jobs.start(),e=>e.status===409);
 assert.throws(()=>createCollectionJobs({dataDir,workerPath}).start(),e=>e.status===409);
 await wait(()=>jobs.snapshot().status==='completed');assert.equal(jobs.snapshot().entries[0].status,'completed');
 assert.equal(createCollectionJobs({dataDir,workerPath}).snapshot().id,job.id);
 jobs.start({years:[2021]});await wait(()=>jobs.snapshot().status==='partial');assert.equal(jobs.snapshot().entries[0].status,'failed');
});
test('cancel is acknowledged before another job can acquire the same lock',async t=>{
 const dataDir=await fixture(t),jobs=createCollectionJobs({dataDir,workerPath});jobs.start({years:[2022]});
 assert.equal(jobs.cancel().status,'cancelling');assert.throws(()=>jobs.start(),e=>e.status===409);
 await wait(()=>jobs.snapshot().status==='cancelled');jobs.start({years:[2020]});await wait(()=>jobs.snapshot().status==='completed');
});
test('stale jobs become resumable after restart and cannot keep a dead lock',async t=>{
 const dataDir=await fixture(t);
 await fs.writeFile(path.join(dataDir,'collection-job.json'),JSON.stringify({id:'old',status:'running',entries:[]}));
 await fs.writeFile(path.join(dataDir,'.collection.lock'),JSON.stringify({id:'old',pid:2147483647}));
 const jobs=createCollectionJobs({dataDir,workerPath});assert.equal(jobs.snapshot().status,'interrupted');
 jobs.start();await wait(()=>jobs.snapshot().status==='completed');
});
test('HTTP starts a fixed-source job, rejects arbitrary commands/years and keeps record writes available',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'cet6-jobs-http-')),server=createServer({dataDir,collectionOptions:{workerPath}});
 await fs.mkdir(path.join(dataDir,'papers'),{recursive:true});
 await fs.writeFile(path.join(dataDir,'papers/private-study.json'),JSON.stringify({id:'private-study',duration:30,questions:[],passages:[]}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(dataDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await (await fetch(base+'/api/collection')).json()).status,'idle');
 for(const body of [{years:[2019]},{years:['2025']},{url:'http://127.0.0.1'},{command:'evil'},{years:Array(8).fill(2020)}])assert.equal((await post('/api/collection',body)).status,400);
 assert.equal((await post('/api/collection',{years:[2022]})).status,202);
 assert.equal((await post('/api/collection',{})).status,409);
 assert.equal((await post('/api/import',{})).status,409);
 assert.equal((await fetch(base+'/api/backup/full')).status,409);
 const progress=await fetch(base+'/api/progress/private-study',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({position:8,rate:1})});
 assert.equal(progress.status,200);assert.equal((await progress.json()).position,8);
 assert.equal((await (await fetch(base+'/api/progress')).json())[0].position,8);
 assert.equal((await fetch(base+'/api/backup/export')).status,200);
 assert.equal((await post('/api/collection/cancel',{})).status,200);
 // Wait through the actual HTTP status; no download process remains at cleanup.
 for(let i=0;i<300;i++){if((await (await fetch(base+'/api/collection')).json()).status==='cancelled')return;await new Promise(r=>setTimeout(r,10));}
 assert.fail('cancelled state not visible through HTTP');
});
