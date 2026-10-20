import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = 'http://127.0.0.1:3260';
async function healthy() {
  try { const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) }); return response.ok && (await response.json()).app === 'cet6-listening-studio'; } catch { return false; }
}
function openBrowser() { spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref(); }
if (!fs.existsSync(path.join(root,'dist','index.html'))) throw new Error('网页尚未构建，请在项目目录先运行 npm run build。');
if (await healthy()) { openBrowser(); } else {
  fs.mkdirSync(path.join(root,'runtime'),{recursive:true});
  const log = fs.openSync(path.join(root,'runtime','server.log'),'a');
  const child = spawn(process.execPath,[path.join(root,'server','index.mjs')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',log,log]});
  child.unref();
  fs.closeSync(log);
  let ready=false;
  for(let count=0;count<30;count++){ if(await healthy()){ready=true;break;} await new Promise(resolve=>setTimeout(resolve,300)); }
  if(!ready) throw new Error('启动未成功，请查看 runtime/server.log；3260端口可能正被其他应用占用。');
  openBrowser();
}
