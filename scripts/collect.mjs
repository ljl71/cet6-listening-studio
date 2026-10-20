import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runCollection} from './lib/collection.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const args=process.argv.slice(2),arg=name=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const controller=new AbortController();
process.on('message',message=>{if(message?.type==='cancel')controller.abort(new Error('已取消获取，下载进度已保留。'));});
process.on('disconnect',()=>controller.abort(new Error('本地服务已关闭，获取任务停止。')));
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>controller.abort(new Error('已停止获取，下载进度已保留。')));
if(arg('ffmpeg'))process.env.CET6_FFMPEG=arg('ffmpeg');
if(arg('ffprobe'))process.env.CET6_FFPROBE=arg('ffprobe');
const emit=event=>{if(process.send&&process.connected)process.send(event);else console.log(JSON.stringify(event));};
try{
 const result=await runCollection({root,data:path.resolve(process.env.CET6_DATA_DIR||path.join(root,'data')),only:arg('only'),years:arg('years')?.split(',').map(Number)||[],skipAudio:args.includes('--text-only'),refresh:args.includes('--refresh'),minDelay:Number(arg('delay')||350),signal:controller.signal,onEvent:emit});
 emit({type:'done',...result});process.exitCode=result.failed?1:0;
}catch(error){emit({type:controller.signal.aborted?'cancelled':'fatal',message:error.message});process.exitCode=controller.signal.aborted?2:1;}
finally{if(process.connected)process.disconnect();}
