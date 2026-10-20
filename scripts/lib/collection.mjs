import fs from 'node:fs/promises';
import path from 'node:path';
import {parseCatalog,parseListeningPage,parseHls,sha256,readJson,writeJson,mergeCollectedPaper} from './corpus.mjs';
import {request,downloadFile} from './download.mjs';
import {publicSourceUrl,robotsAllows} from './source-access.mjs';
import {ensureMediaTools,runTool} from './media-tools.mjs';

const catalogUrl='https://english-exam.lazynote.cn/cet6/sections/listening/';
export async function runCollection({root,data,only,years=[],skipAudio=false,refresh=false,minDelay=350,signal,onEvent=()=>{},prepareTools=ensureMediaTools,executeTool=runTool}) {
 const emit=event=>onEvent({...event,at:new Date().toISOString()});
 const check=()=>signal?.throwIfAborted();
 for(const name of ['raw','papers','media'])await fs.mkdir(path.join(data,name),{recursive:true});
 const assets=await readJson(path.join(data,'assets.json'),{});
 const state=await readJson(path.join(data,'collection-state.json'),{entries:{}});
 const robotsByHost=new Map();
 const validateUrl=value=>{
  const url=publicSourceUrl(value),robots=robotsByHost.get(url.hostname);
  if(url.pathname!=='/robots.txt'&&(robots===undefined||!robotsAllows(robots,url.href)))throw Object.assign(new Error('来源 robots 规则不允许获取该资料，已停止。'),{restricted:true});
 };
 async function sourceText(url,name,{fresh=false}={}){
  check();validateUrl(url);const dest=path.join(data,'raw',name);
  if(!refresh&&!fresh){try{return await fs.readFile(dest,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const r=await request(url,{minDelay,signal,validateUrl});
  if(Number(r.headers.get('content-length'))>10*1024*1024){await r.body?.cancel();throw new Error('来源页面异常过大');}
  const chunks=[];let size=0;
  for await(const chunk of r.body){size+=chunk.length;if(size>10*1024*1024)throw new Error('来源页面异常过大');chunks.push(chunk);}
  const body=Buffer.concat(chunks).toString('utf8');await fs.writeFile(dest,body);return body;
 }
 emit({type:'phase',phase:'catalog',message:'正在检查来源规则与真题目录…'});
 for(const host of ['english-exam.lazynote.cn','listening.lazynote.cn']){
  const name=host.startsWith('english')?'robots.txt':'media-robots.txt';
  try{const text=await sourceText(`https://${host}/robots.txt`,name,{fresh:true});if(/^\s*</.test(text))throw new Error('来源规则返回了网页，停止获取。');robotsByHost.set(host,text);}
  catch(error){if(host==='listening.lazynote.cn'&&error.message.startsWith('HTTP 404:')){robotsByHost.set(host,'');await fs.writeFile(path.join(data,'raw',name),'HTTP 404 — checked '+new Date().toISOString());}else throw error;}
 }
 const all=parseCatalog(await sourceText(catalogUrl,'catalog.html',{fresh:true}));
 const entries=all.filter(e=>(!only||[e.slug,e.id].includes(only))&&(!years.length||years.includes(e.year)));
 if(!entries.length)throw new Error('来源目录中没有找到所选年份的资料。');
 const rules={checkedAt:new Date().toISOString(),catalogUrl,robotsUrl:'https://english-exam.lazynote.cn/robots.txt',disallowedPaths:['/downloads/'],usage:'本机个人学习；不打包公开传播；不绕过登录、付费、加密、访问限制。原题版权归考试相关权利人。',requestDelayMilliseconds:minDelay};
 await writeJson(path.join(data,'source-policy.json'),rules);
 await writeJson(path.join(data,'manifest.json'),{schemaVersion:1,updatedAt:new Date().toISOString(),scope:'2020–2025 六个完整年份，增补 2026 年 6 月',expectedPapers:all.length,entries:all});
 emit({type:'catalog',entries:entries.map(({id,year,month,variant})=>({id,title:`${year} 年 ${month} 月 · 第 ${variant} 套`}))});
 let tools=null;let failed=0;
 const validAudio=async paper=>{
  const asset=assets[paper?.audioAssetId];if(!asset?.path||!/^media\/[a-f\d]{64}\.(?:m4a|mp3|wav|ogg|flac|mp4)$/i.test(asset.path))return false;
  try{const bytes=await fs.readFile(path.join(data,asset.path));return bytes.length===asset.size&&sha256(bytes)===asset.sha256;}catch{return false;}
 };
 for(const entry of entries){
  check();const paperPath=path.join(data,'papers',`${entry.id}.json`);let paper;
  try{
   const old=await readJson(paperPath,null);
   if(!refresh&&old?.questions?.length===25&&old?.passages?.length===7&&(skipAudio||await validAudio(old))){emit({type:'entry',id:entry.id,status:'skipped',message:'本机已有资料，已保留原有校对和学习记录。'});continue;}
   emit({type:'entry',id:entry.id,status:'running',message:'正在整理题目、原文和音频…'});
   const parsed=parseListeningPage(await sourceText(entry.url,`${entry.slug}.html`),entry);paper=parsed.paper;
   const {mediaUrl}=parsed;const sourcePassages=structuredClone(paper.passages);mergeCollectedPaper(paper,old);
   let hls=null;
   if(mediaUrl){validateUrl(mediaUrl);hls=parseHls(await sourceText(mediaUrl,`${entry.slug}.m3u8`),mediaUrl);for(const segment of hls.segments)validateUrl(segment.url);}
   if(paper.audioAssetId&&!await validAudio(paper)){paper.audioAssetId=null;paper.quality.audio='missing';}
   if(!paper.audioAssetId&&hls)paper.duration=Number(hls.duration.toFixed(3));
   await writeJson(paperPath,paper);
   if(!skipAudio){
    if(!mediaUrl)throw new Error('来源没有提供完整公开音频，文字已保存。');
    if(!await validAudio(paper)){
     tools??=await prepareTools({root,signal,onProgress:event=>emit({type:'phase',...event})});
     const cache=path.join(data,'raw',`hls-${entry.slug}`);await fs.mkdir(cache,{recursive:true});
     let next=0,completed=0;const downloaded=[];
     emit({type:'phase',phase:'audio',id:entry.id,message:'正在下载音频片段…',segmentsDone:0,segmentsTotal:hls.segments.length});
     // Join every worker before retrying, so no old writer owns a .part file.
     const group=new AbortController();
     const downloadSignal=signal?AbortSignal.any([signal,group.signal]):group.signal;
     let firstError;
     await Promise.all(Array.from({length:3},async()=>{
      try{for(;;){downloadSignal.throwIfAborted();const i=next++;if(i>=hls.segments.length)return;
       const destination=path.join(cache,`${String(i).padStart(4,'0')}.ts`);
       const result=await downloadFile(hls.segments[i].url,destination,{minDelay,signal:downloadSignal,validateUrl});
       downloaded[i]={...hls.segments[i],...result,file:path.relative(data,destination).replaceAll('\\','/')};completed++;
       emit({type:'phase',phase:'audio',id:entry.id,message:'正在下载音频片段…',segmentsDone:completed,segmentsTotal:hls.segments.length});
      }}catch(error){firstError??=error;group.abort(error);}
     }));
     if(firstError)throw firstError;check();
     await writeJson(path.join(cache,'segments.json'),downloaded);
     const combined=path.join(cache,'complete.ts'),output=await fs.open(combined,'w');
     try{for(let i=0;i<hls.segments.length;i++){check();await output.write(await fs.readFile(path.join(cache,`${String(i).padStart(4,'0')}.ts`)));}}finally{await output.close();}
     emit({type:'phase',phase:'verify',id:entry.id,message:'下载完成，正在检查整段音频…'});
     const remuxed=path.join(cache,'complete.m4a');
     await executeTool(tools.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-i',combined,'-map','0:a:0','-c:a','copy','-movflags','+faststart',remuxed],{signal});
     await executeTool(tools.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-xerror','-i',remuxed,'-f','null','-'],{signal});
     const probe=await executeTool(tools.ffprobe,['-v','error','-show_entries','format=duration','-of','json',remuxed],{signal});
     const duration=Number(JSON.parse(probe).format.duration);
     if(!Number.isFinite(duration)||Math.abs(duration-hls.duration)>1)throw new Error('音频时长与来源播放列表不一致，未入库。');
     check();const bytes=await fs.readFile(remuxed),hash=sha256(bytes),assetId=`sha256-${hash}`,file=`${hash}.m4a`;
     await fs.copyFile(remuxed,path.join(data,'media',file));
     assets[assetId]={path:`media/${file}`,mime:'audio/mp4',size:bytes.length,sha256:hash,duration,sourceUrl:mediaUrl,fetchedAt:new Date().toISOString(),verifiedBy:'FFmpeg complete decode and VOD duration comparison'};
     paper.audioAssetId=assetId;paper.duration=duration;paper.quality.audio='verified';
     if(old?.audioAssetId&&old.audioAssetId!==assetId){paper.quality.timing='candidate';for(const p of paper.passages){const source=sourcePassages.find(x=>x.id===p.id);if(source){p.start=source.start;p.end=source.end;}for(const s of p.sentences){s.start=0;s.end=0;s.reviewed=false;}}paper.notes.push('音频版本变化，旧时间轴已清除，需重新校对。');}
     await writeJson(path.join(data,'assets.json'),assets);
    }
    paper.sources.push({url:mediaUrl,label:'懒笔记公开整套听力 VOD',kind:'audio',fetchedAt:new Date().toISOString(),licenseNote:rules.usage});
   }
   paper.sources=[...new Map(paper.sources.map(source=>[`${source.kind}:${source.url}`,source])).values()];
   await writeJson(paperPath,paper);state.entries[entry.id]={status:'collected',updatedAt:new Date().toISOString(),audio:paper.quality.audio,questions:25,passages:7};
   emit({type:'entry',id:entry.id,status:'completed',message:skipAudio?'文字已保存，音频尚未下载。':'音频、25 道题和原文已入库，答案及逐句时间仍待校对。'});
  }catch(error){
   if(signal?.aborted)throw error;
   failed++;state.entries[entry.id]={status:'failed',error:error.message,updatedAt:new Date().toISOString()};
   emit({type:'entry',id:entry.id,status:'failed',message:error.message});
   await writeJson(path.join(data,'collection-state.json'),state);
   if(error.restricted||/Encrypted media/.test(error.message))throw error;
  }
  await writeJson(path.join(data,'collection-state.json'),state);
 }
 return {failed,total:entries.length};
}
