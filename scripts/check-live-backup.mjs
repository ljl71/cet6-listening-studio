import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/index.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=await fetch('http://127.0.0.1:3261/api/backup/export');
assert.equal(source.status,200);
const exported=await source.json();
const dataDir=await fs.mkdtemp(path.join(root,'runtime','restore-check-'));
const server=createServer({dataDir,automaticBackup:false});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const url=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(`${url}/api/backup/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(exported)});
  assert.equal(response.status,200,await response.text());
  const restored=await(await fetch(`${url}/api/backup/export`)).json();
  for(const kind of ['attempts','progress','annotations','stats'])assert.deepEqual(restored[kind],exported[kind],`${kind} restoration differs`);
  console.log(JSON.stringify({restored:true,attempts:restored.attempts.length,annotations:restored.annotations.length,progress:restored.progress.length,listeningSeconds:restored.stats.listeningSeconds}));
}finally{await new Promise(resolve=>server.close(resolve));}
