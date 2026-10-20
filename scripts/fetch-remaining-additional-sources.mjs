import fs from 'node:fs/promises';
import {sha256,writeJson} from './lib/corpus.mjs';
const {root}=JSON.parse(await fs.readFile('runtime/remaining-review-location.json','utf8'));
const list=[
 {key:'leonard-author-persistence',url:'https://www.salon.com/2017/09/24/babies-can-learn-value-of-persistence-by-watching-grownups_partner/',extension:'html',kind:'Named original research author Julia Leonard, authorized Conversation republication',supports:['independent of IQ','beliefs about effort','decisions about effort']},
 {key:'oxford-effect-verb',url:'https://www.oxfordlearnersdictionaries.com/us/definition/american_english/effect_2',extension:'html',kind:'Oxford dictionary publisher; orthography only',supports:['effect change']},
 {key:'koolearn-2020-world-is-seeing',url:'https://cet6.koolearn.com/20200711/835108.html',extension:'html',kind:'Contemporaneous teacher transcript; publisher source',supports:['The world is seeing']},
 {key:'2021-12-complete-teacher-transcript',url:'https://jgxm-question.oss-cn-beijing.aliyuncs.com/productfile/bb3ee33c1bc54d58848c2bc720750b92.pdf',extension:'pdf',kind:'Third typeset teaching paper; publisher independence not established',supports:['regarded as sufficient']},
];
const results=await Promise.allSettled(list.map(async s=>{
 const response=await fetch(s.url,{signal:AbortSignal.timeout(45000)});
 if(!response.ok)return{...s,status:response.status,available:false};
 const bytes=Buffer.from(await response.arrayBuffer()),file=`${root}/sources/${s.key}.${s.extension}`;await fs.writeFile(file,bytes);
 return{...s,file,status:response.status,available:true,bytes:bytes.length,sha256:sha256(bytes),fetchedAt:new Date().toISOString()};
}));
const sources=results.map((r,i)=>r.status==='fulfilled'?r.value:{...list[i],available:false,error:String(r.reason)});
await writeJson(`${root}/sources/additional-manifest.json`,{sources,generatedAt:new Date().toISOString()});
console.log(JSON.stringify(sources,null,2));
