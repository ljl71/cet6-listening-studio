import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
// The public source repository deliberately excludes copyrighted corpus files
// and local audio/model caches. Synthetic regression tests always run.
export function localFixture(...files){
 const missing=files.filter(f=>!existsSync(path.join(root,f)));
 if(missing.length&&process.env.CET6_REQUIRE_LOCAL_FIXTURES==='1')throw Error('Local integration fixture missing: '+missing.join(', '));
 return {skip:missing.length?'Local corpus/model fixture is not distributed; restore your own data to run this integration test.':false};
}
