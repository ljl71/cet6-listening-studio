import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,CheckCircle2,Info,LoaderCircle,RotateCcw,Square,XCircle} from 'lucide-react';
import {api} from './api';

type Entry={id:string;title:string;status:'pending'|'running'|'completed'|'skipped'|'failed';message:string};
type Job={id:string|null;status:'idle'|'running'|'cancelling'|'completed'|'partial'|'failed'|'cancelled'|'interrupted';phase:string;message:string;years?:number[];entries:Entry[];currentId?:string;segmentsDone?:number;segmentsTotal?:number;received?:number;total?:number;updatedAt?:string};
const active=(job:Job|null)=>job?.status==='running'||job?.status==='cancelling';
export function useCollectionJob(){
 const [job,setJob]=useState<Job|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const sequence=useRef(0);
 useEffect(()=>{
  let live=true,loading=false;
  const poll=async()=>{if(loading)return;loading=true;const own=++sequence.current;try{const next=await api<Job>('/api/collection');if(live&&own===sequence.current){setJob(next);setError('');}}catch(e){if(live&&own===sequence.current)setError((e as Error).message);}finally{loading=false;}};
  void poll();const timer=setInterval(()=>void poll(),2000);return()=>{live=false;clearInterval(timer);};
 },[]);
 const change=useCallback(async(url:string,body:unknown)=>{
  setBusy(true);setError('');const own=++sequence.current;
  try{const next=await api<Job>(url,'POST',body);if(own===sequence.current)setJob(next);}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 },[]);
 return {job,error,busy,running:active(job),start:(years:number[])=>change('/api/collection',{years}),cancel:()=>change('/api/collection/cancel',{})};
}
export type CollectionController=ReturnType<typeof useCollectionJob>;
const labels:Record<Entry['status'],string>={pending:'等待',running:'获取中',completed:'已入库',skipped:'本机已有',failed:'未完成'};

export function CollectionPanel({controller}:{controller:CollectionController}){
 const {job,error,busy,running,start,cancel}=controller;
 const [year,setYear]=useState('all');
 const done=job?.entries.filter(e=>e.status==='completed'||e.status==='skipped').length||0;
 const total=job?.entries.length||0;
 const current=job?.entries.find(e=>e.id===job.currentId);
 const resume=job&&['partial','failed','cancelled','interrupted'].includes(job.status);
 const headline=running?'正在为你准备真题':job?.status==='completed'?'资料已加入真题库':resume?'可以继续上次获取':'一键准备历年真题';
 return <section className="collection-panel" aria-labelledby="collection-title">
  <div className="collection-intro"><span className="setting-action-icon"><ArrowDownToLine size={25}/></span><div><h3 id="collection-title">{headline}</h3><p>从公开来源获取整套音频、25 道题与英文原文，自动保存到这台电脑，完成后可离线听。</p></div></div>
  <div className="collection-controls"><label>获取范围<select aria-label="资料获取年份" value={year} disabled={running||busy} onChange={e=>setYear(e.target.value)}><option value="all">2020—2025 全部 + 2026 年 6 月</option>{[2026,2025,2024,2023,2022,2021,2020].map(y=><option key={y} value={y}>{y} 年{y===2026?' 6 月增补':''}</option>)}</select></label><button className="button primary" disabled={running||busy||!job} onClick={()=>void start(year==='all'?[]:[Number(year)])}>{busy?<LoaderCircle className="spin" size={17}/>:resume?<RotateCcw size={17}/>:<ArrowDownToLine size={17}/>}开始获取</button>{resume&&<button className="button outlined" disabled={busy} onClick={()=>void start(job.years||[])}><RotateCcw size={16}/>继续上次获取</button>}{running&&<button className="button outlined" disabled={busy||job?.status==='cancelling'} onClick={()=>void cancel()}><Square size={14}/>{job?.status==='cancelling'?'正在停止…':'停止获取'}</button>}</div>
  <p className="collection-help">首次获取需联网并预留约 5 GB 空间。Windows x64 会自动准备音频处理工具，无需另装 Python；其他系统需先安装 FFmpeg。已有资料和学习记录会保留，重复点击会跳过已完成的资料。</p>
  {error&&<div className="collection-error" role="alert">操作或状态读取未完成：{error}。请稍后重试。</div>}
  {job&&job.status!=='idle'&&<div className="collection-progress"><div className="collection-status" role="status" aria-live="polite">{running?<LoaderCircle size={19} className="spin"/>:job.status==='completed'?<CheckCircle2 size={19}/>:<Info size={19}/>}<strong>{job.message}</strong>{total>0&&<span>{done} / {total} 套</span>}</div>{total>0&&<progress aria-label="资料获取进度" max={total} value={done}/>}<p>{current?.title}{job.phase==='audio'&&job.segmentsTotal?` · 音频片段 ${job.segmentsDone||0} / ${job.segmentsTotal}`:''}{job.phase==='tools'&&job.received?` · 已下载 ${(job.received/1048576).toFixed(1)} MB${job.total?` / ${(job.total/1048576).toFixed(1)} MB`:''}`:''}</p>{job.entries.length>0&&<ul className="collection-entries" aria-label="各套资料获取状态">{job.entries.map(entry=><li key={entry.id} className={entry.status}><div><span>{entry.title}</span><strong>{entry.status==='failed'&&<XCircle size={14}/>} {labels[entry.status]}</strong></div><p>{entry.message}</p></li>)}</ul>}</div>}
  <div className="notice"><Info size={17}/><span>资料来自<a href="https://english-exam.lazynote.cn/cet6/sections/listening/" target="_blank" rel="noreferrer">懒笔记公开整理页</a>，仅获取公开、未加密内容，遇到登录或访问限制会停止。来源答案和逐句时间仍须校对：可以播放、阅读和保存答题草稿，未核验答案暂不能自动批改，也不会伪造单句时间。</span></div>
 </section>;
}
