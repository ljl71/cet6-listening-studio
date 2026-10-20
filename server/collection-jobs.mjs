import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,openSync,writeFileSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './store.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const active=new Set(['running','cancelling']);
const idle=()=>({id:null,status:'idle',phase:'',message:'选择年份后，点击开始获取。',entries:[]});
const conflict=message=>Object.assign(new Error(message),{status:409});
const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};

export function createCollectionJobs({dataDir,workerPath=path.join(root,'scripts/collect.mjs'),spawnWorker=fork}={}) {
 const stateFile=path.join(dataDir,'collection-job.json'),lockFile=path.join(dataDir,'.collection.lock');
 let child=null,job=null,finish=null,lastWrite=0;
 const persist=()=>{job.updatedAt=new Date().toISOString();atomicJson(stateFile,job);lastWrite=Date.now();};
 function snapshot(){
  const saved=child?job:read(stateFile)||idle();
  if(!child&&active.has(saved.status)){
   const lock=read(lockFile);
   if(!lock||!alive(lock.pid)){saved.status='interrupted';saved.message='上次获取被中断，点击继续即可复用已下载的片段。';atomicJson(stateFile,saved);}
  }
  return structuredClone(saved);
 }
 const release=()=>{const lock=read(lockFile);if(lock?.id===job.id)unlinkSync(lockFile);};
 function start({years=[]}={}){
  if(child)throw conflict('已有资料获取任务正在运行，请勿重复开始。');
  mkdirSync(dataDir,{recursive:true});
  const id=randomUUID();
  for(let tries=0;tries<2;tries++){
   try{const fd=openSync(lockFile,'wx');try{writeFileSync(fd,JSON.stringify({id,pid:process.pid}));}finally{closeSync(fd);}break;}
   catch(error){if(error.code!=='EEXIST')throw error;const lock=read(lockFile);if(alive(lock?.pid)||tries)throw conflict('另一个本机窗口正在获取资料，请等待完成。');unlinkSync(lockFile);}
  }
  job={id,status:'running',phase:'catalog',message:'正在连接资料来源…',years,entries:[],startedAt:new Date().toISOString()};finish=null;persist();
  try{
   child=spawnWorker(workerPath,years.length?[`--years=${years.join(',')}`]:[],{cwd:root,env:{...process.env,CET6_DATA_DIR:dataDir},windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
   const worker=child;
   child.stderr?.resume(); // Stack traces stay out of the public status API.
   child.on('message',event=>{
    if(child!==worker||!event||typeof event!=='object')return;
    if(event.type==='catalog'){job.entries=event.entries.map(e=>({...e,status:'pending',message:'等待获取'}));}
    else if(event.type==='entry'){
     const entry=job.entries.find(e=>e.id===event.id);if(entry)Object.assign(entry,{status:event.status,message:event.message});
     job.currentId=event.id;job.phase='paper';job.message=event.message;delete job.segmentsDone;delete job.segmentsTotal;delete job.received;delete job.total;
    }else if(event.type==='phase'){
     if(job.phase!==event.phase){delete job.segmentsDone;delete job.segmentsTotal;delete job.received;delete job.total;}
     for(const key of ['phase','message','segmentsDone','segmentsTotal','received','total'])if(event[key]!==undefined)job[key]=event[key];
     if(event.id)job.currentId=event.id;
    }else if(['done','fatal','cancelled'].includes(event.type)){finish=event;}
    if(event.type!=='phase'||Date.now()-lastWrite>250)persist();
   });
   const end=error=>{
    if(child!==worker)return;
    job.status=job.status==='cancelling'||finish?.type==='cancelled'?'cancelled':finish?.type==='done'?(finish.failed?'partial':'completed'):'failed';
    job.message=job.status==='completed'?'所选资料获取完成，已自动加入真题库。':job.status==='partial'?'部分资料未能获取，已保存成功项；点击继续可重试缺项。':job.status==='cancelled'?'已停止获取，已下载内容保留，可随时继续。':finish?.message||error?.message||'获取进程意外结束，点击继续可重试。';
    for(const entry of job.entries)if(entry.status==='running'){entry.status='pending';entry.message='尚未完成，可继续获取';}
    job.finishedAt=new Date().toISOString();persist();release();child=null;
   };
   child.once('error',end);child.once('close',()=>end());
  }catch(error){job.status='failed';job.message='无法启动资料获取任务';persist();release();child=null;throw error;}
  return snapshot();
 }
 function cancel(){if(child&&job.status==='running'){job.status='cancelling';job.message='正在停止并保存已下载内容…';persist();if(child.connected)child.send({type:'cancel'},()=>{});}return snapshot();}
 return {start,cancel,snapshot,isRunning:()=>active.has(snapshot().status),close:cancel};
}
