import fs from 'node:fs/promises';
import path from 'node:path';
import {request} from './download.mjs';
import {sha256,stripHtml,writeJson} from './corpus.mjs';
const entries=[{id:'cet6-2021-12-1',url:'https://cet4-6.xdf.cn/202112/11348898.html',expected:"And that's a bit of a departure for you."},{id:'cet6-2024-12-2',url:'https://m.koolearn.com/cet6/20241214/893921.html',expected:'M:Um,well'}];
for(const entry of entries){const r=await request(entry.url);const text=await r.text();const file=path.join('data','references',`${entry.id}-transcript-refinement.html`);await fs.writeFile(file,text);entry.filename=path.basename(file);entry.sha256=sha256(Buffer.from(text));entry.fetchedAt=new Date().toISOString();entry.exactExpectedFound=stripHtml(text).includes(entry.expected);console.log(entry.id,r.status,text.length,entry.exactExpectedFound);console.log(stripHtml(text).match(/.{0,160}(?:departure for you|Um\s*,\s*well|Um,well).{0,200}/gi));}
await writeJson(path.join('data','references','refinement-sources.json'),{entries});
