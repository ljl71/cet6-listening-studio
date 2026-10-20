import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseCatalog,parseListeningPage,parseHls,sha256,readJson,writeJson,mergeCollectedPaper} from './lib/corpus.mjs';
import {request,downloadFile} from './lib/download.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const data=path.resolve(process.env.CET6_DATA_DIR||path.join(root,'data'));
const catalogUrl='https://english-exam.lazynote.cn/cet6/sections/listening/';
const args=process.argv.slice(2);const only=args.find(a=>a.startsWith('--only='))?.slice(7);
const skipAudio=args.includes('--text-only');const refresh=args.includes('--refresh');
const mediaTools=await readJson(path.join(root,'runtime','media-tools.json'),{});
const ffmpeg=args.find(a=>a.startsWith('--ffmpeg='))?.slice(9)||process.env.CET6_FFMPEG||mediaTools.ffmpeg||'ffmpeg';
const ffprobe=args.find(a=>a.startsWith('--ffprobe='))?.slice(10)||process.env.CET6_FFPROBE||mediaTools.ffprobe||ffmpeg.replace(/ffmpeg(?:\.exe)?$/i,process.platform==='win32'?'ffprobe.exe':'ffprobe');
const minDelay=Number(args.find(a=>a.startsWith('--delay='))?.slice(8)||120);
await fs.mkdir(path.join(data,'raw'),{recursive:true});
await fs.mkdir(path.join(data,'papers'),{recursive:true});
await fs.mkdir(path.join(data,'media'),{recursive:true});
const assets=await readJson(path.join(data,'assets.json'),{});
const state=await readJson(path.join(data,'collection-state.json'),{entries:{}});
async function sourceText(url,name){const dest=path.join(data,'raw',name);if(!refresh){try{return await fs.readFile(dest,'utf8');}catch{}}const r=await request(url,{minDelay});const body=await r.text();await fs.writeFile(dest,body);return body;}
// Respect the published disallow rules. The source explicitly blocks /downloads/.
const robots=await sourceText('https://english-exam.lazynote.cn/robots.txt','robots.txt');
if(/Disallow:\s*\/(?:cet6(?:\/sections)?|\s*$)/m.test(robots))throw new Error('Source robots disallows the selected content');
await sourceText('https://listening.lazynote.cn/robots.txt','media-robots.txt').catch(async e=>{if(!/404/.test(e.message))throw e;await fs.writeFile(path.join(data,'raw','media-robots.txt'),'HTTP 404 — no robots file, checked '+new Date().toISOString());});
const catalog=await sourceText(catalogUrl,'catalog.html');
const all=parseCatalog(catalog);const entries=only?all.filter(e=>e.slug===only||e.id===only):all;
if(!entries.length)throw new Error('No matching papers in the source catalog');
const rules={checkedAt:new Date().toISOString(),catalogUrl,robotsUrl:'https://english-exam.lazynote.cn/robots.txt',disallowedPaths:['/downloads/'],usage:'本机个人学习；不打包公开传播；不绕过登录、付费、加密、访问限制。原题版权归考试相关权利人。',sourceFooter:'真题版权归全国硕士研究生招生考试 / 全国大学英语四六级考试委员会所有',requestDelayMilliseconds:minDelay};
await writeJson(path.join(data,'source-policy.json'),rules);
await writeJson(path.join(data,'manifest.json'),{schemaVersion:1,updatedAt:new Date().toISOString(),scope:'2020–2025 六个完整年份，增补 2026 年 6 月',expectedPapers:all.length,entries:all});
console.log(`Catalog: ${all.length} papers; processing ${entries.length}; audio ${skipAudio?'off':'on'}`);
for(const entry of entries){
 try{
  const html=await sourceText(entry.url,`${entry.slug}.html`);const {paper,mediaUrl}=parseListeningPage(html,entry);
  const paperPath=path.join(data,'papers',`${paper.id}.json`);const old=await readJson(paperPath,null);
  const sourcePassages=structuredClone(paper.passages);
  mergeCollectedPaper(paper,old);
  // Read the public VOD duration even for text-only imports; passage times must
  // never be published against a zero-duration paper.
  let hls=null;
  if(mediaUrl){const playlist=await sourceText(mediaUrl,`${entry.slug}.m3u8`);hls=parseHls(playlist,mediaUrl);if(!paper.audioAssetId)paper.duration=Number(hls.duration.toFixed(3));}
  // Text remains available even when a media download, external tool or remote host fails.
  await writeJson(paperPath,paper);
  if(mediaUrl&&!skipAudio){
   let validAsset=false;if(paper.audioAssetId&&assets[paper.audioAssetId]){try{const a=assets[paper.audioAssetId];const b=await fs.readFile(path.join(data,a.path));validAsset=b.length===a.size&&sha256(b)===a.sha256;}catch{}}
   if(!validAsset){
    paper.duration=Number(hls.duration.toFixed(3));
    const cache=path.join(data,'raw',`hls-${entry.slug}`);await fs.mkdir(cache,{recursive:true});
    console.log(`${entry.slug}: ${paper.questions.length} questions, ${paper.passages.length} passages, ${hls.segments.length} segments (${Math.round(hls.duration)}s)`);
    let next=0;const downloaded=[];
    await Promise.all(Array.from({length:3},async()=>{for(;;){const i=next++;if(i>=hls.segments.length)return;const segment=hls.segments[i];const destination=path.join(cache,`${String(i).padStart(4,'0')}.ts`);const result=await downloadFile(segment.url,destination,{minDelay});downloaded[i]={...segment,...result,file:path.relative(data,destination).replaceAll('\\','/')};}}));
    await writeJson(path.join(cache,'segments.json'),downloaded);
    const combined=path.join(cache,'complete.ts');const output=await fs.open(combined,'w');try{for(let i=0;i<hls.segments.length;i++)await output.write(await fs.readFile(path.join(cache,`${String(i).padStart(4,'0')}.ts`)));}finally{await output.close();}
    const remuxed=path.join(cache,'complete.m4a');
    const remux=spawnSync(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-i',combined,'-map','0:a:0','-c:a','copy','-movflags','+faststart',remuxed],{encoding:'utf8'});
    if(remux.error)throw new Error(`Need FFmpeg to create an offline audio file (${remux.error.message}); downloaded segments preserved`);
    if(remux.status!==0)throw new Error(`Remux failed: ${remux.stderr.slice(-1000)}`);
    const decode=spawnSync(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-xerror','-i',remuxed,'-f','null','-'],{encoding:'utf8'});
    if(decode.status!==0)throw new Error(`Audio decoding failed: ${decode.stderr.slice(-1000)}`);
    const probe=spawnSync(ffprobe,['-v','error','-show_entries','format=duration','-of','json',remuxed],{encoding:'utf8'});if(probe.status!==0)throw new Error('Cannot verify the final audio duration');
    const duration=Number(JSON.parse(probe.stdout).format.duration);if(Math.abs(duration-hls.duration)>1)throw new Error('Playlist / final audio duration mismatch');
    const bytes=await fs.readFile(remuxed);const hash=sha256(bytes);const assetId=`sha256-${hash}`;const file=`${hash}.m4a`;
    await fs.copyFile(remuxed,path.join(data,'media',file));
    assets[assetId]={path:`media/${file}`,mime:'audio/mp4',size:bytes.length,sha256:hash,duration,sourceUrl:mediaUrl,fetchedAt:new Date().toISOString(),verifiedBy:'FFmpeg complete decode and duration comparison with the source VOD playlist'};
    paper.audioAssetId=assetId;paper.duration=duration;paper.quality.audio='verified';
    if(old?.audioAssetId&&old.audioAssetId!==assetId){
     paper.quality.timing='candidate';
     for(const p of paper.passages){const source=sourcePassages.find(x=>x.id===p.id);if(source){p.start=source.start;p.end=source.end;}for(const s of p.sentences){s.start=0;s.end=0;s.reviewed=false;}}
     paper.notes.push('音频资产发生变化，旧句子时间轴已清除，需要重新对齐和人工校对。');
    }
    await writeJson(path.join(data,'assets.json'),assets);
   }
   paper.sources.push({url:mediaUrl,label:'懒笔记公开整套听力 VOD',kind:'audio',fetchedAt:new Date().toISOString(),licenseNote:rules.usage});
  }
  paper.sources=[...new Map(paper.sources.map(source=>[`${source.kind}:${source.url}`,source])).values()];
  await writeJson(paperPath,paper);state.entries[entry.id]={status:'collected',updatedAt:new Date().toISOString(),audio:paper.quality.audio,questions:paper.questions.length,passages:paper.passages.length};
  console.log(`${entry.slug}: saved ${paper.audioAssetId?'offline audio + ':''}25 questions / ${paper.passages.flatMap(p=>p.sentences).length} sentences; quality ${JSON.stringify(paper.quality)}`);
 }catch(e){state.entries[entry.id]={status:'failed',error:e.message,updatedAt:new Date().toISOString()};console.error(`${entry.slug}: ${e.message}`);}
 await writeJson(path.join(data,'collection-state.json'),state);
}
console.log('Collection finished. Run npm run audit for the honest coverage and outstanding review report.');
