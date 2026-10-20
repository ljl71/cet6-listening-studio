import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readJson,writeJson} from './corpus.mjs';
const root=path.resolve('.');const data=path.join(root,'data');const output=path.join(data,'alignment-refinement');await fs.mkdir(output,{recursive:true});
const media=await readJson(path.join(root,'runtime','media-tools.json'));const speech=await readJson(path.join(root,'runtime','speech-tools.json'));const assets=await readJson(path.join(data,'assets.json'));
const run=(command,args,log)=>new Promise((resolve,reject)=>{const p=spawn(command,args,{cwd:root,windowsHide:true});let s='';p.stdout.on('data',b=>s+=b);p.stderr.on('data',b=>s+=b);p.on('error',reject);p.on('close',async c=>{if(log)await fs.writeFile(log,s);c?reject(new Error(s.slice(-2000))):resolve();});});
const windows=[];
for(const name of(await fs.readdir(path.join(data,'papers'))).filter(n=>n.endsWith('.json'))){const paper=await readJson(path.join(data,'papers',name));for(const passage of paper.passages){for(const [i,s]of passage.sentences.entries()){if(s.end>s.start)continue;const previous=passage.sentences.slice(0,i).reverse().find(s=>s.end>s.start),next=passage.sentences.slice(i+1).find(s=>s.end>s.start);const from=Math.max(passage.start,(previous?.start||passage.start)-0.3),to=Math.min(passage.end,(next?.end||passage.end)+0.3);let w=windows.find(w=>w.paperId===paper.id&&w.from===from&&w.to===to);if(w){w.sentenceIds.push(s.id);continue;}w={paperId:paper.id,audioAssetId:paper.audioAssetId,passageId:passage.id,passageOrder:passage.order,from:+from.toFixed(3),to:+to.toFixed(3),sentenceIds:[s.id],model:'base.en',strategy:'unprompted context crop, beam 5, token DTW; no expected transcript is supplied'};windows.push(w);}}}
for(const w of windows){
 const stem=path.join(output,w.sentenceIds[0]);const wav=`${stem}.wav`;const json=`${stem}-base-dtw-nfa.json`;
 if(!await readJson(json,null)){
  await run(media.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-ss',String(w.from),'-i',path.join(data,assets[w.audioAssetId].path),'-t',String(w.to-w.from),'-ar','16000','-ac','1','-c:a','pcm_s16le',wav]);
  await run(speech.whisper,['-m',path.relative(root,speech.model),'-f',path.relative(root,wav),'-l','en','-t','6','-ng','-nfa','-ml','1','-sow','-bo','5','-bs','5','-nf','-dtw','base.en','-ojf','-of',path.relative(root,`${stem}-base-dtw-nfa`)],`${stem}-base-dtw-nfa.log`);
 }
 w.wav=path.relative(data,wav).replaceAll('\\','/');w.recognition=path.relative(data,json).replaceAll('\\','/');
 const r=await readJson(json);console.log(w.paperId,w.sentenceIds,`offset ${w.from}`,r.transcription.map(t=>t.text).join(''));
}
await writeJson(path.join(output,'windows.json'),{createdAt:new Date().toISOString(),windows});
