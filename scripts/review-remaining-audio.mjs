import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const read=async file=>JSON.parse(await fs.readFile(path.resolve(ROOT,file),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n');};
const run=(program,args,log)=>new Promise((resolve,reject)=>{
 const child=spawn(program,args,{cwd:ROOT,windowsHide:true});let output='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 child.on('error',reject);child.on('close',async code=>{await fs.writeFile(log,output);if(code)reject(new Error(`Exit ${code}: ${output.slice(-1800)}`));else resolve();});
});
const location=await read('runtime/remaining-review-location.json'),snapshot=await read(`${location.root}/snapshot.json`);
const assets=await read('data/assets.json'),media=await read('runtime/media-tools.json');
const model=path.join(ROOT,'runtime','ggml-small.en.bin');
const modelSha=sha(await fs.readFile(model));
if(modelSha!=='c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d')throw new Error('Unverified review model');
const windows=[];
for(const row of snapshot.pendingText){
 const start=row.ctc?.acoustic?.start??row.currentTiming.start,end=row.ctc?.acoustic?.end??row.currentTiming.end;
 if(!(end>start))throw new Error(`No text review audio interval: ${row.sentenceId}`);
 windows.push({paperId:row.paperId,passageId:row.passageId,from:Math.max(0,start-2.5),to:end+2.5,targets:[{kind:'transcript',sentenceId:row.sentenceId}]});
}
for(const row of snapshot.missingTime){
 windows.push({paperId:row.paperId,passageId:row.passageId,from:Math.max(0,row.ctc.acousticStart-5),to:row.ctc.acousticEnd+4,targets:[{kind:'missing-time-and-neighbor-boundary',sentenceId:row.sentence.id}]});
}
windows.sort((a,b)=>a.paperId.localeCompare(b.paperId)||a.from-b.from);
const merged=[];
for(const w of windows){const old=merged.at(-1);if(old&&old.paperId===w.paperId&&old.passageId===w.passageId&&w.from<=old.to&&Math.max(w.to,old.to)-old.from<55){old.to=Math.max(old.to,w.to);old.targets.push(...w.targets);}else merged.push({...w});}
const output=path.join(ROOT,location.root,'audio');await fs.mkdir(output,{recursive:true});
const report={createdAt:new Date().toISOString(),model:'whisper-small.en',modelSha256:modelSha,expectedTranscriptSupplied:false,method:'Unprompted independently decoded original-media crops, beam 5 and token DTW. Evidence only; never changes papers or human-reviewed flags.',windows:merged};
const hashes=new Map();let completed=0;
const limit=Number(process.argv.find(a=>a.startsWith('--limit='))?.slice(8)||Infinity);
for(let index=0;index<merged.length;index++){
 const w=merged[index];
 if(index>=limit)break;
 const paper=await read(`data/papers/${w.paperId}.json`),asset=assets[paper.audioAssetId];
 const source=path.join(ROOT,'data',asset.path);if(!hashes.has(paper.audioAssetId))hashes.set(paper.audioAssetId,sha(await fs.readFile(source)));if(hashes.get(paper.audioAssetId)!==asset.sha256)throw new Error('Original audio hash changed');
 w.from=+w.from.toFixed(3);w.to=+Math.min(w.to,paper.duration).toFixed(3);
 const stem=path.join(output,`${String(index+1).padStart(3,'0')}-${w.paperId}`),wav=stem+'.wav',json=stem+'.json',meta=stem+'.meta.json';
 const identity={audioAssetId:paper.audioAssetId,mediaSha256:asset.sha256,sourceRange:{start:w.from,end:w.to},modelSha256:modelSha,targets:w.targets};
 let cached=false;
 try{const prior=JSON.parse(await fs.readFile(meta,'utf8'));cached=JSON.stringify(prior.identity)===JSON.stringify(identity)&&sha(await fs.readFile(wav))===prior.wavSha256&&sha(await fs.readFile(json))===prior.recognitionSha256;}catch{}
 if(!cached){
  await run(media.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-ss',String(w.from),'-i',source,'-t',String(w.to-w.from),'-ar','16000','-ac','1','-c:a','pcm_s16le',wav],stem+'.decode.log');
  const started=Date.now();
  await run(path.join(ROOT,'runtime','whisper','Release','whisper-cli.exe'),['-m',path.relative(ROOT,model),'-f',path.relative(ROOT,wav),'-l','en','-t','4','-ng','-nf','-bo','5','-bs','5','-nfa','-dtw','small.en','-ml','1','-sow','-ojf','-of',path.relative(ROOT,stem)],stem+'.recognition.log');
  await write(meta,{identity,wavSha256:sha(await fs.readFile(wav)),recognitionSha256:sha(await fs.readFile(json)),elapsedSeconds:(Date.now()-started)/1000,createdAt:new Date().toISOString(),expectedTranscriptSupplied:false,timeBasis:'Model times relative to this exact independently decoded crop; add sourceRange.start for original-audio seconds.'});
 }
 const result=JSON.parse(await fs.readFile(json,'utf8'));
 w.wav=path.relative(ROOT,wav).replaceAll('\\','/');w.recognition=path.relative(ROOT,json).replaceAll('\\','/');w.metadata=path.relative(ROOT,meta).replaceAll('\\','/');w.text=result.transcription.map(t=>t.text).join('').trim();w.completed=true;completed++;
 await write(path.join(output,'windows.json'),{...report,updatedAt:new Date().toISOString(),completed});
 console.log(JSON.stringify({window:index+1,total:merged.length,cached,targets:w.targets,text:w.text}));
}
console.log(JSON.stringify({completed,total:merged.length,report:path.relative(ROOT,path.join(output,'windows.json'))}));
