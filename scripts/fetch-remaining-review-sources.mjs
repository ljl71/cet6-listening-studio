import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const location=JSON.parse(await fs.readFile('runtime/remaining-review-location.json','utf8'));
const folder=path.join(location.root,'sources');await fs.mkdir(folder,{recursive:true});
const sources=[
 {key:'and el-author-cyberloafing'.replace(' ',''),url:'https://www.comstocksmag.com/commentary/why-bosses-should-let-employees-surf-web-work',extension:'html',supports:'Original author Stephanie Andel republication: costs employers; study conclusion and relief-valve context.',sentenceIds:['cet6-2023-06-2-p-16-1-s2','cet6-2023-06-2-p-16-4-s1']},
 {key:'atkinson-first-person-interview',url:'https://crimereads.com/kate-atkinson-a-crime-readers-guide-to-the-classics/',extension:'html',supports:"First-person interview and named magazine: Woman’s Own, not Women’s Own. Spelling only.",sentenceIds:['cet6-2023-12-1-p-9-1-s6']},
 {key:'fltrp-colour-food-teacher-resource',url:'https://fltrp-gy.oss-cn-shanghai.aliyuncs.com/bookresource/fltrp/Other/1/3494/6492b057aba6c_0',extension:'pdf',supports:'Publisher teaching resource, Unit 6 page 17: In a 1980 study; same blindfolded beverage experiment. Year/content corroboration; recording wording separately reviewed.',sentenceIds:['cet6-2024-12-1-p-19-3-s2']},
 {key:'merriam-webster-effect-verb',url:'https://www.merriam-webster.com/dictionary/effect',extension:'html',supports:'Dictionary verb effect: bring about; orthographic adjudication of effect change. Does not claim distinguishable homophones by audio.',sentenceIds:['cet6-2020-09-1-p-16-6-s3']},
];
const results=await Promise.allSettled(sources.map(async source=>{
 const destination=path.join(folder,source.key+'.'+source.extension);const response=await fetch(source.url,{signal:AbortSignal.timeout(45000)});
 if(!response.ok)return {...source,status:response.status,available:false,note:'Access failure retained; no access restriction bypass or invented source bytes.'};
 const bytes=Buffer.from(await response.arrayBuffer());await fs.writeFile(destination,bytes);
 return {...source,status:response.status,available:true,file:destination.replaceAll('\\','/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentType:response.headers.get('content-type'),fetchedAt:new Date().toISOString()};
}));
const rows=results.map((r,i)=>r.status==='fulfilled'?r.value:{...sources[i],available:false,error:String(r.reason)});
await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify({generatedAt:new Date().toISOString(),sources:rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(r=>({key:r.key,status:r.status,available:r.available,bytes:r.bytes,file:r.file,error:r.error})),null,2));
