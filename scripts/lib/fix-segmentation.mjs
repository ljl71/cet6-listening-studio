import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readJson,writeJson,sha256} from './corpus.mjs';
const data=path.resolve(fileURLToPath(new URL('../../data',import.meta.url)));
const prior=await readJson(path.join(data,'references','segmentation-corrections.json'),null);
if(prior?.mergedBoundaryCount>=19){
 let alreadyApplied=true;
 for(const paperId of prior.affectedPaperIds){const paper=await readJson(path.join(data,'papers',`${paperId}.json`),null);const ids=new Set(paper?.passages.flatMap(p=>p.sentences.map(s=>s.id)));for(const c of prior.corrections.filter(c=>c.paperId===paperId))if(ids.has(c.mergedId)||!ids.has(c.keptId))alreadyApplied=false;}
 if(alreadyApplied){console.log(`The ${prior.mergedBoundaryCount} audited corrections are already applied; no papers changed.`);process.exit(0);}
 throw new Error('A previous correction record exists but current papers disagree; refuse an automatic second mutation');
}
const audit=await readJson(path.join(data,'references','alignment-summary.json'),null);
if(!audit)throw new Error('Missing prior segmentation audit');
const warnings=audit.papers.flatMap(p=>p.segmentationWarnings.map(w=>({...w,paperId:p.paperId})));
assert.equal(warnings.length,19,'Only the previously audited 19 boundaries may be merged');
const aliasMap={};const corrections=[];const pending=[];let beforeCount=0,afterCount=0,evidenceUpdates=0;
const metadata=paper=>{const copy=structuredClone(paper);for(const p of copy.passages)delete p.sentences;for(const q of copy.questions)delete q.evidenceSentenceIds;return copy;};
for(const paperId of [...new Set(warnings.map(w=>w.paperId))]){
 const file=path.join(data,'papers',`${paperId}.json`);const bytes=await fs.readFile(file);const paper=JSON.parse(bytes);const original=structuredClone(paper);const beforeIds=new Set(paper.passages.flatMap(p=>p.sentences.map(s=>s.id)));
 for(const w of warnings.filter(w=>w.paperId===paperId)){
  const passage=paper.passages.find(p=>p.sentences.some(s=>s.id===w.sentenceId));assert.ok(passage,`Missing ${w.sentenceId}`);
  const index=passage.sentences.findIndex(s=>s.id===w.sentenceId);const first=passage.sentences[index],second=passage.sentences[index+1];
  assert.equal(second?.id,w.nextSentenceId,'Only adjacent sentences may merge');assert.equal(first.sourceParagraphId,second.sourceParagraphId,'Only sentences in the same source paragraph may merge');assert.equal(first.text,w.text);assert.equal(second.text,w.nextText);assert.equal(first.reviewed,false);assert.equal(second.reviewed,false);
  const merged={...first,text:`${first.text} ${second.text}`,start:0,end:0,reviewed:false};delete merged.alignmentConfidence;
  passage.sentences.splice(index,2,merged);aliasMap[second.id]=first.id;
  corrections.push({paperId,passageId:passage.id,sourceParagraphId:first.sourceParagraphId,keptId:first.id,mergedId:second.id,before:[first,second],after:merged});
 }
 const aliases=Object.fromEntries(corrections.filter(c=>c.paperId===paperId).map(c=>[c.mergedId,c.keptId]));
 for(const q of paper.questions){if(!q.evidenceSentenceIds)continue;const changed=[...new Set(q.evidenceSentenceIds.map(id=>aliases[id]||id))];if(JSON.stringify(changed)!==JSON.stringify(q.evidenceSentenceIds)){evidenceUpdates++;q.evidenceSentenceIds=changed;}}
 const afterIds=new Set(paper.passages.flatMap(p=>p.sentences.map(s=>s.id)));for(const id of beforeIds)if(!aliases[id])assert.ok(afterIds.has(id),`Unaffected ID changed: ${id}`);
 for(const oldPassage of original.passages){const changed=paper.passages.find(p=>p.id===oldPassage.id);for(const s of oldPassage.sentences){if(aliases[s.id]||Object.values(aliases).includes(s.id))continue;assert.deepEqual(changed.sentences.find(x=>x.id===s.id),s,`Unaffected sentence mutated: ${s.id}`);}}
 for(const q of paper.questions)for(const id of q.evidenceSentenceIds||[])assert.ok(afterIds.has(id),`Dangling question evidence ${id}`);
 assert.deepEqual(metadata(paper),metadata(original),'Verified answers and unrelated metadata must remain identical');
 beforeCount+=beforeIds.size;afterCount+=afterIds.size;pending.push({file,paper,bytes,sha256:sha256(bytes)});
}
for(const change of pending)assert.equal(sha256(await fs.readFile(change.file)),change.sha256,'Paper changed concurrently; refuse overwrite');
const folder=path.join(data,'references','before-segmentation');await fs.mkdir(folder,{recursive:true});
for(const change of pending){const backup=path.join(folder,`${change.paper.id}.json`);try{await fs.writeFile(backup,change.bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}await writeJson(change.file,change.paper);}
const result={appliedAt:new Date().toISOString(),reason:'合并称谓缩写句点造成的19处错误断句；保留前句ID，其余句子保留原始Segmenter索引和既有内容。',affectedPaperIds:pending.map(p=>p.paper.id),aliasMap,mergedBoundaryCount:corrections.length,affectedPaperSentenceCountBefore:beforeCount,affectedPaperSentenceCountAfter:afterCount,evidenceQuestionsUpdated:evidenceUpdates,reviewed:false,requiresRealignment:true,corrections};
await writeJson(path.join(data,'references','segmentation-corrections.json'),result);
console.log(JSON.stringify({affectedPaperIds:result.affectedPaperIds,mergedBoundaryCount:result.mergedBoundaryCount,evidenceQuestionsUpdated:evidenceUpdates,sentencesRemoved:beforeCount-afterCount},null,2));
