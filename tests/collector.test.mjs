import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {parseCatalog,parseListeningPage,parseHls,sha256,mergeCollectedPaper,segmentTranscript} from '../scripts/lib/corpus.mjs';
import {downloadFile} from '../scripts/lib/download.mjs';
const sourceFixtureAvailable=existsSync(new URL('../data/raw/catalog.html',import.meta.url));
const withSource={skip:sourceFixtureAvailable?false:'Run npm run collect -- --text-only to enable source integration checks'};

test('source catalog yields the 27 target papers without unrelated older years',withSource,async()=>{
 const html=await fs.readFile(new URL('../data/raw/catalog.html',import.meta.url),'utf8');const entries=parseCatalog(html);
 assert.equal(entries.length,27);assert.equal(new Set(entries.map(e=>e.id)).size,27);assert.equal(entries.filter(e=>e.year<2026).length,25);assert.deepEqual([...new Set(entries.map(e=>e.year))].sort(),[2020,2021,2022,2023,2024,2025,2026]);
});
test('all collected HTML pages preserve 25 four-choice questions and seven passage types',withSource,async()=>{
 const catalog=parseCatalog(await fs.readFile(new URL('../data/raw/catalog.html',import.meta.url),'utf8'));
 for(const entry of catalog){const html=await fs.readFile(new URL(`../data/raw/${entry.slug}.html`,import.meta.url),'utf8');const {paper,mediaUrl}=parseListeningPage(html,entry);assert.equal(paper.questions.length,25);assert.equal(paper.passages.length,7);assert.deepEqual(paper.questions.map(q=>q.number),Array.from({length:25},(_,i)=>i+1));assert.equal(paper.questions.filter(q=>q.answer).length,25);assert.equal(paper.passages.filter(p=>p.type==='conversation').length,2);assert.equal(paper.passages.filter(p=>p.type==='passage').length,2);assert.equal(paper.passages.filter(p=>p.type==='lecture').length,3);assert.ok(mediaUrl.endsWith('/index.m3u8'));assert.ok(paper.passages.every(p=>p.end>p.start));assert.ok(paper.passages.flatMap(p=>p.sentences).every(s=>s.start===0&&s.end===0&&!s.reviewed));assert.equal(paper.quality.answers,'candidate');assert.equal(paper.quality.timing,'candidate');}
});
test('sample options are English only and evidence refers to the matching transcript sentence',withSource,async()=>{
 const html=await fs.readFile(new URL('../data/raw/2025-12-1.html',import.meta.url),'utf8');const {paper}=parseListeningPage(html,{id:'cet6-2025-12-1',year:2025,month:12,variant:'1',url:'https://example.test'});
 assert.equal(paper.questions[0].options.A,'He has distinguished himself in foreign service.');assert.equal(paper.questions[24].options.D,'Opportunities for income.');assert.deepEqual(paper.questions[0].evidenceSentenceIds,['cet6-2025-12-1-p-1-1-s1']);assert.ok(paper.passages[0].sourceParagraphs[0].translation.includes('布莱克威尔'));assert.equal(paper.passages[0].sentences[0].translation,undefined);
});
test('every source answer reference maps to an existing sentence, including abridged quotations',withSource,async()=>{
 const catalog=parseCatalog(await fs.readFile(new URL('../data/raw/catalog.html',import.meta.url),'utf8'));
 for(const entry of catalog){const {paper}=parseListeningPage(await fs.readFile(new URL(`../data/raw/${entry.slug}.html`,import.meta.url),'utf8'),entry);const ids=new Set(paper.passages.flatMap(p=>p.sentences.map(s=>s.id)));for(const q of paper.questions){assert.ok(q.evidenceSentenceIds.length,`${q.id} missing evidence`);assert.ok(q.evidenceSentenceIds.every(id=>ids.has(id)),`${q.id} invalid evidence reference`);}}
});
test('HLS parser computes real segment durations and refuses encrypted or incomplete media',()=>{
 const hls=parseHls('#EXTM3U\n#EXTINF:10.5,\na.ts\n#EXTINF:2.25,\nb.ts\n#EXT-X-ENDLIST\n','https://example.test/media/index.m3u8');assert.equal(hls.duration,12.75);assert.equal(hls.segments[1].url,'https://example.test/media/b.ts');assert.throws(()=>parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="secret"\n#EXTINF:1,\nx.ts\n#EXT-X-ENDLIST','https://example.test'),/Encrypted/);assert.throws(()=>parseHls('#EXTM3U\n#EXTINF:1,\nx.ts','https://example.test'),/complete/);
});
test('honorifics stay with names and retain the original Segmenter index for later sentences',()=>{
 const text='M: With me in the studio today is Ms. Jane Logan, author of a new book, Secrets to Success. Welcome. So Ms. Logan, in your book, you claim that successful people have many things in common.';
 const segmented=segmentTranscript(text);assert.deepEqual(segmented.map(s=>s.sourceIndex),[1,3,4]);assert.equal(segmented[0].text,'M: With me in the studio today is Ms. Jane Logan, author of a new book, Secrets to Success.');assert.equal(segmented[1].text,'Welcome.');assert.equal(segmented[2].text,'So Ms. Logan, in your book, you claim that successful people have many things in common.');
 for(const title of ['Mr.','Mrs.','Ms.','Dr.','Prof.']){const parts=segmentTranscript(`W: ${title} Taylor, welcome. Thank you.`);assert.equal(parts.length,2);assert.equal(parts[0].text,`W: ${title} Taylor, welcome.`);assert.equal(parts.at(-1).text,'Thank you.');}
 assert.equal(segmentTranscript('The house can do well as a B&B. On the other hand, location matters.').length,2);
});
test('real source paragraphs merge exactly 24 audited title/name boundaries without renumbering other IDs',withSource,async()=>{
 const catalog=parseCatalog(await fs.readFile(new URL('../data/raw/catalog.html',import.meta.url),'utf8'));let merged=0;
 for(const entry of catalog){const {paper}=parseListeningPage(await fs.readFile(new URL(`../data/raw/${entry.slug}.html`,import.meta.url),'utf8'),entry);for(const passage of paper.passages){for(const paragraph of passage.sourceParagraphs){const legacy=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(paragraph.text)].map(s=>s.segment.trim()).filter(Boolean);const current=passage.sentences.filter(s=>s.sourceParagraphId===paragraph.sourceId);merged+=legacy.length-current.length;for(const sentence of current){const originalIndex=Number(sentence.id.match(/-s(\d+)$/)[1])-1;assert.ok(sentence.text.startsWith(legacy[originalIndex]),`Unstable original index: ${sentence.id}`);assert.ok(!/\b(?:Mr|Mrs|Ms|Dr|Prof)\.$/i.test(sentence.text),`Detached honorific: ${sentence.id}`);}}}}
 assert.equal(merged,24);
});
test('real personal and institutional abbreviations remain in one sentence with stable original indices',withSource,async()=>{
 const get=async slug=>parseListeningPage(await fs.readFile(new URL(`../data/raw/${slug}.html`,import.meta.url),'utf8'),{id:`cet6-${slug}`,year:Number(slug.slice(0,4)),month:Number(slug.slice(5,7)),variant:slug.slice(8),url:'https://example.test'}).paper;
 const a=await get('2020-07-1');const sentence=a.passages.flatMap(p=>p.sentences).find(s=>s.id==='cet6-2020-07-1-p-9-3-s2');assert.ok(sentence.text.includes("Lynn N. Mark, a speaker on workplace humour for St. Mary's Health Centre in St. Louis."));assert.ok(!a.passages.flatMap(p=>p.sentences).some(s=>/p-9-3-s[345]$/.test(s.id)));
 const b=await get('2024-06-2');assert.ok(b.passages.flatMap(p=>p.sentences).find(s=>s.id==='cet6-2024-06-2-p-9-3-s3').text.includes('John A. Rogers said.'));
 const c=await get('2024-12-2');assert.ok(c.passages.flatMap(p=>p.sentences).find(s=>s.id==='cet6-2024-12-2-p-9-2-s1').text.includes("C.S. Mott Children's Hospital."));
});
test('recollection retains verified answer corrections and reviewed sentence edits',()=>{
 const original={audioAssetId:'audio',duration:30,quality:{audio:'verified',questions:'verified',answers:'verified',transcript:'candidate',timing:'candidate'},sources:[{url:'https://reference.test',kind:'answers'}],notes:['第23题由C纠正为B'],questions:[{id:'q23',number:23,answer:'B',explanation:'Two sources agree on B'}],passages:[{id:'p1',start:2,end:25,sentences:[{id:'s1',text:'Edited transcript.',translation:'已校对译文',start:3,end:5,reviewed:true},{id:'s2',text:'Unchanged.',start:6,end:8,reviewed:false}]}]};
 const fresh={audioAssetId:null,duration:0,quality:{audio:'missing',questions:'candidate',answers:'candidate',transcript:'candidate',timing:'candidate'},sources:[],notes:['尚待独立来源核对'],questions:[{id:'q23',number:23,answer:'C'}],passages:[{id:'p1',start:1,end:24,sentences:[{id:'s1',text:'Old source transcription.',start:0,end:0,reviewed:false},{id:'s2',text:'Unchanged.',start:0,end:0,reviewed:false}]}]};
 const merged=mergeCollectedPaper(fresh,original);assert.equal(merged.questions[0].answer,'B');assert.equal(merged.questions[0].explanation,'Two sources agree on B');assert.equal(merged.passages[0].sentences[0].text,'Edited transcript.');assert.equal(merged.passages[0].sentences[0].translation,'已校对译文');assert.equal(merged.passages[0].sentences[1].start,6);assert.equal(merged.passages[0].start,2);assert.ok(!merged.notes.includes('尚待独立来源核对'));
});
test('real unreviewed cross-source transcript corrections and timing evidence survive recollection',withSource,async()=>{
 let checked=0;
 for(const entry of parseCatalog(await fs.readFile(new URL('../data/raw/catalog.html',import.meta.url),'utf8'))){
  const slug=entry.slug;
  const old=JSON.parse(await fs.readFile(new URL(`../data/papers/${entry.id}.json`,import.meta.url),'utf8'));
  const corrections=old.passages.flatMap(p=>p.sentences).filter(s=>s.textCorrection&&!s.reviewed);
  if(!corrections.length)continue;
  const fresh=parseListeningPage(await fs.readFile(new URL(`../data/raw/${slug}.html`,import.meta.url),'utf8'),entry).paper;
  const merged=mergeCollectedPaper(fresh,old);
  assert.deepEqual(merged.questions,old.questions,`${entry.id} reverted verified answers, corrected quotes or evidence metadata`);
  for(const original of corrections){const retained=merged.passages.flatMap(p=>p.sentences).find(s=>s.id===original.id);assert.deepEqual(retained,original,`${original.id} lost the corrected text or provenance`);checked++;}
 }
 assert.ok(checked>=82,'Expected every approved cross-source correction to remain intact');
});
test('the sixteen adjudicated question evidence refinements survive source recollection',withSource,async()=>{
 const report=JSON.parse(await fs.readFile(new URL('../data/references/question-evidence-corrections.json',import.meta.url),'utf8'));
 assert.equal(report.changes.length,16);let checked=0;
 for(const entry of parseCatalog(await fs.readFile(new URL('../data/raw/catalog.html',import.meta.url),'utf8'))){
  const relevant=report.changes.filter(c=>c.paperId===entry.id);if(!relevant.length)continue;
  const old=JSON.parse(await fs.readFile(new URL(`../data/papers/${entry.id}.json`,import.meta.url),'utf8'));
  const fresh=parseListeningPage(await fs.readFile(new URL(`../data/raw/${entry.slug}.html`,import.meta.url),'utf8'),entry).paper;
  const merged=mergeCollectedPaper(fresh,old);
  for(const change of relevant){const before=old.questions.find(q=>q.id===change.questionId),after=merged.questions.find(q=>q.id===change.questionId);assert.deepEqual(after,before);assert.deepEqual(after.evidenceSentenceIds,change.evidenceSentenceIds);checked++;}
 }
 assert.equal(checked,16);
});
test('recollection retains rejection warnings and source provenance for unchanged zero-time text',()=>{
 const candidate={id:'s',text:'Unchanged sentence.',start:0,end:0,reviewed:false,sourceParagraphId:'source-p',alignmentConfidence:1,timingWarnings:[{kind:'oversized-word-span'}],alignmentEvidence:{method:'question-guarded-local-whisper-word-alignment',report:'alignment/sample/candidates.json'}};
 const old={audioAssetId:'a',duration:20,quality:{audio:'verified',questions:'candidate',answers:'candidate',transcript:'candidate',timing:'candidate'},sources:[],questions:[],passages:[{id:'p',start:1,end:15,sentences:[candidate]}]};
 const fresh={audioAssetId:null,duration:0,quality:{},sources:[],questions:[],passages:[{id:'p',start:1,end:15,sentences:[{id:'s',text:'Unchanged sentence.',start:0,end:0,reviewed:false}]}]};
 assert.deepEqual(mergeCollectedPaper(fresh,old).passages[0].sentences[0],candidate);
});
test('the corrected rise translation survives recollection while original English paragraph snapshots remain raw',withSource,async()=>{
 const entry={id:'cet6-2020-09-1',year:2020,month:9,variant:'1',url:'https://example.test'};
 const old=JSON.parse(await fs.readFile(new URL('../data/papers/cet6-2020-09-1.json',import.meta.url),'utf8'));
 const fresh=parseListeningPage(await fs.readFile(new URL('../data/raw/2020-09-1.html',import.meta.url),'utf8'),entry).paper;
 const rawSnapshot=fresh.passages.find(p=>p.order===5).sourceParagraphs.find(p=>p.sourceId==='p-16-6').text;
 const merged=mergeCollectedPaper(fresh,old);const p=merged.passages.find(p=>p.order===5).sourceParagraphs.find(p=>p.sourceId==='p-16-6');
 assert.equal(p.text,rawSnapshot);assert.ok(p.text.includes('preventing the right'));
 assert.ok(p.translation.startsWith('这一切都归结于维护掌权者的权力，以及阻止无权者崛起。'));
 assert.equal(p.translationCorrection.origin,'developer-translated-from-corrected-english');
});
test('download resumes interrupted responses, verifies length and avoids duplicate requests',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cet6-downloader-'));const bytes=Buffer.from('public-listening-media');let calls=0;const ranges=[];
 const server=http.createServer((req,res)=>{calls++;ranges.push(req.headers.range);const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0);if(calls===1){res.writeHead(200,{'content-length':bytes.length});res.write(bytes.subarray(0,6));setTimeout(()=>res.destroy(),30);return;}res.writeHead(offset?206:200,{'content-length':bytes.length-offset,...(offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})});res.end(bytes.subarray(offset));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url=`http://127.0.0.1:${server.address().port}/audio`;const destination=path.join(dir,'audio.ts');const result=await downloadFile(url,destination,{minDelay:0});assert.equal(result.sha256,sha256(bytes));assert.equal(result.size,bytes.length);assert.equal(ranges[1],'bytes=6-');const count=calls;const cached=await downloadFile(url,destination,{minDelay:0});assert.equal(cached.cached,true);assert.equal(calls,count);assert.deepEqual(await fs.readFile(destination),bytes);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
