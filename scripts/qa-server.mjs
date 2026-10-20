// Browser acceptance testing uses a separate database so test answers do not
// become the learner's first-attempt results.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.join(root,'runtime','qa-data');
await fs.mkdir(path.join(dataDir,'papers'),{recursive:true});
await fs.mkdir(path.join(dataDir,'media'),{recursive:true});
for(const filename of await fs.readdir(path.join(root,'data','papers'))) if(filename.endsWith('.json')) await fs.copyFile(path.join(root,'data','papers',filename),path.join(dataDir,'papers',filename));
await fs.copyFile(path.join(root,'data','assets.json'),path.join(dataDir,'assets.json'));
for(const filename of await fs.readdir(path.join(root,'data','media'))){
  const source=path.join(root,'data','media',filename),destination=path.join(dataDir,'media',filename);
  try{await fs.link(source,destination);}catch(error){if(error.code!=='EEXIST')await fs.copyFile(source,destination);}
}
const server=await startServer({dataDir,port:3261});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
