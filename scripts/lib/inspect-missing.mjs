import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson} from './corpus.mjs';
const data=path.resolve('data');
for(const name of(await fs.readdir(path.join(data,'papers'))).filter(n=>n.endsWith('.json'))){
 const paper=await readJson(path.join(data,'papers',name));
 for(const passage of paper.passages){
  for(const [i,s]of passage.sentences.entries()){
   if(s.end>s.start)continue;
   const previous=passage.sentences.slice(0,i).reverse().find(s=>s.end>s.start),next=passage.sentences.slice(i+1).find(s=>s.end>s.start);
   console.log(JSON.stringify({paper:paper.id,passage:passage.order,offset:passage.start,id:s.id,text:s.text,confidence:s.alignmentConfidence,previous,next},null,2));
   for(const suffix of ['', '-base']){
    const file=path.join(data,'alignment',paper.id,`passage-${passage.order}${suffix}.json`);const r=await readJson(file,null);if(!r)continue;
    const from=(previous?.start||passage.start)-passage.start,to=(next?.end||passage.end)-passage.start;
    console.log(suffix||'tiny',r.params?.model,JSON.stringify(r.transcription.filter(t=>t.offsets.from/1000>=from-2&&t.offsets.to/1000<=to+2).map(t=>({text:t.text,start:t.offsets.from/1000,end:t.offsets.to/1000})),null,2));
   }
  }
 }
}
