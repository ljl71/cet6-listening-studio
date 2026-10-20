import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {downloadFile,request} from './download.mjs';
import {readJson,writeJson,sha256} from './corpus.mjs';

export function runTool(command,args,{signal,env}={}) {
 return new Promise((resolve,reject)=>{
  signal?.throwIfAborted();
  const child=spawn(command,args,{windowsHide:true,signal,env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout=(stdout+b).slice(-65536);});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-65536);});
  child.once('error',reject);child.once('close',code=>code===0?resolve(stdout):reject(new Error(`${path.basename(command)} 运行失败：${stderr.slice(-600)}`)));
 });
}

export async function ensureMediaTools({root,signal,onProgress=()=>{}}) {
 const saved=await readJson(path.join(root,'runtime/media-tools.json'),{});
 const ffmpeg=process.env.CET6_FFMPEG||saved.ffmpeg||'ffmpeg';
 const ffprobe=process.env.CET6_FFPROBE||saved.ffprobe||ffmpeg.replace(/ffmpeg(?:\.exe)?$/i,process.platform==='win32'?'ffprobe.exe':'ffprobe');
 try{await runTool(ffmpeg,['-version'],{signal});await runTool(ffprobe,['-version'],{signal});return {ffmpeg,ffprobe};}catch(error){if(signal?.aborted)throw error;}
 if(process.platform!=='win32'||process.arch!=='x64')throw new Error('未找到音频处理工具。请安装 FFmpeg 和 FFprobe 后点击继续；Windows x64 支持自动准备。');
 onProgress({phase:'tools',message:'首次使用：正在准备音频处理工具，只需下载一次。'});
 const directory=path.join(root,'runtime/collection-tools');await fs.mkdir(directory,{recursive:true});
 const archive=path.join(directory,'ffmpeg-release-essentials.zip');
 const url='https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
 const validateUrl=value=>{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='www.gyan.dev'||u.port||u.username||u.password)throw Object.assign(new Error('媒体工具来源发生变化，已停止下载'),{restricted:true});};
 const hashText=await (await request(url+'.sha256',{signal,validateUrl})).text();
 const expected=hashText.trim().match(/^[a-f\d]{64}(?:\s|$)/i)?.[0].trim().toLowerCase();
 if(!expected)throw new Error('媒体工具校验信息无效，未执行下载文件。');
 let last=0;
 await downloadFile(url,archive,{signal,validateUrl,onProgress:progress=>{if(Date.now()-last<500)return;last=Date.now();onProgress({phase:'tools',message:'正在下载音频处理工具',...progress});}});
 if(sha256(await fs.readFile(archive))!==expected){await fs.unlink(archive);throw new Error('媒体工具校验失败，已移除文件，请重试。');}
 // Extract only the two fixed executables through the built-in .NET ZIP API.
 // This also works when PowerShell's Archive module cannot be auto-loaded;
 // archive entry names never become output paths.
 onProgress({phase:'tools',message:'下载完成，正在解压音频处理工具。'});
 const destination=path.join(directory,'extracted');
 const extract="$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Directory]::CreateDirectory($env:CET6_TOOLS_DEST) | Out-Null; $archive=[IO.Compression.ZipFile]::OpenRead($env:CET6_TOOLS_ARCHIVE); try { foreach($entry in $archive.Entries) { if($entry.FullName -match '/bin/(ffmpeg|ffprobe)\\.exe$') { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,[IO.Path]::Combine($env:CET6_TOOLS_DEST,$entry.Name),$true) } } } finally { $archive.Dispose() }";
 await runTool('powershell.exe',['-NoProfile','-NonInteractive','-Command',extract],{signal,env:{...process.env,CET6_TOOLS_ARCHIVE:archive,CET6_TOOLS_DEST:destination}});
 const find=async(name,dir)=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isFile()&&entry.name===name)return full;if(entry.isDirectory()){const nested=await find(name,full);if(nested)return nested;}}};
 const tools={ffmpeg:await find('ffmpeg.exe',destination),ffprobe:await find('ffprobe.exe',destination)};
 if(!tools.ffmpeg||!tools.ffprobe)throw new Error('下载包中缺少音频处理工具。');
 await runTool(tools.ffmpeg,['-version'],{signal});await runTool(tools.ffprobe,['-version'],{signal});
 await writeJson(path.join(root,'runtime/media-tools.json'),{...tools,source:url,sha256:expected});return tools;
}
