import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
const tests=readdirSync(new URL('../tests/',import.meta.url)).filter(f=>f.endsWith('.test.mjs')).map(f=>'tests/'+f);
const result=spawnSync(process.execPath,['--test',...tests],{cwd:new URL('../',import.meta.url),stdio:'inherit',windowsHide:true,env:{...process.env,CET6_REQUIRE_LOCAL_FIXTURES:'1'}});
if(result.error)throw result.error;process.exitCode=result.status??1;
