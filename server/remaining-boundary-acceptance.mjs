import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {discover,prepareData,openService,openPaper,launchContext} from './browser-acceptance.mjs';
const root=process.cwd(),read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
if(!process.argv.includes('--run')||!process.argv.includes('--user-authorized'))throw Error('Requires authorized isolated real browser run');
const available=await discover(),{chromium}=await import(pathToFileURL(available.playwrightModule).href);
const {root:reviewRoot}=await read('runtime/remaining-review-location.json'),snapshot=await read(`${reviewRoot}/snapshot.json`);
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),runRoot=path.join(root,'runtime',`remaining-browser-${stamp}`),evidence=path.join(root,'docs',`remaining-browser-${stamp}`);
await fs.mkdir(evidence,{recursive:true});const report={startedAt:new Date().toISOString(),scope:'26 actual native UI seeks and audio starts in each installed browser; external network isolated; does not certify phonetic word boundaries.',productionWrites:false,results:[]};
for(const name of ['edge','chrome']){
 const item={name,status:'running',events:{blockedRequests:[],blockedWebSockets:[],pageErrors:[]},sentences:[]};let context,service;
 try{
  const data=path.join(runRoot,name,'data');await prepareData(data);service=await openService(data);
  context=await launchContext(chromium,available.browsers[name],path.join(runRoot,name,'profile'),service.url,item.events);
  item.version=context.browser().version();const page=await context.newPage();await page.goto(service.url,{waitUntil:'networkidle'});await page.bringToFront();
  let active='';
  for(const missing of snapshot.missingTime){
   const paper=await read(`data/papers/${missing.paperId}.json`),s=paper.passages.flatMap(p=>p.sentences).find(s=>s.id===missing.sentence.id);
   if(active!==paper.id){await openPaper(page,paper);active=paper.id;await page.getByLabel('原文显示方式').selectOption('english');}
   await page.locator('.sentence-content').filter({hasText:s.text}).click();
   await page.waitForFunction(start=>Math.abs(document.querySelector('audio').currentTime-start)<.03,s.start);
   const selected=await page.locator('.sentence.selected .sentence-words').innerText();assert.equal(selected,s.text);
   const seek=await page.locator('audio').evaluate(a=>({position:a.currentTime,paused:a.paused,source:a.currentSrc}));assert.equal(seek.paused,true);
   await page.getByRole('button',{name:'播放听力',exact:true}).click();
   await page.waitForFunction(start=>{const a=document.querySelector('audio');return !a.paused&&a.currentTime>start+.12;},s.start);
   await page.getByRole('button',{name:'暂停播放',exact:true}).click();
   const played=await page.locator('audio').evaluate(a=>a.currentTime);assert.ok(played>s.start+.12);
   item.sentences.push({sentenceId:s.id,start:s.start,end:s.end,observedSeek:seek.position,observedPlayingPosition:played,originalAsset:paper.audioAssetId});
   if(item.sentences.length===1||item.sentences.length===26)await page.screenshot({path:path.join(evidence,`${name}-${item.sentences.length}.png`),fullPage:true});
  }
  assert.equal(item.sentences.length,26);assert.deepEqual(item.events.pageErrors,[]);item.status='passed';
 }catch(e){item.status='failed';item.error=e.stack;}finally{await context?.close();if(service)await new Promise(r=>service.server.close(r));}
 report.results.push(item);console.log(JSON.stringify({browser:name,status:item.status,sentences:item.sentences.length,error:item.error}));
}
report.status=report.results.every(r=>r.status==='passed')?'passed':'failed';report.finishedAt=new Date().toISOString();
await fs.writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile('docs/remaining-boundary-browser-acceptance.json',JSON.stringify(report,null,2)+'\n');
if(report.status!=='passed')process.exitCode=1;
