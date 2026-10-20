import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readJson,writeJson,sha256} from './corpus.mjs';
const data=path.resolve('data');
const groups=[{paperId:'cet6-2020-07-1',ids:[2,3,4,5].map(n=>`cet6-2020-07-1-p-9-3-s${n}`)},{paperId:'cet6-2024-06-2',ids:[3,4].map(n=>`cet6-2024-06-2-p-9-3-s${n}`)},{paperId:'cet6-2024-12-2',ids:[1,2].map(n=>`cet6-2024-12-2-p-9-2-s${n}`)}];
const report=await readJson(path.join(data,'references','segmentation-corrections.json'));assert.equal(report.mergedBoundaryCount,19,'Only apply the additional five boundaries once');
const pending=[];const aliases={};const corrections=[];let evidenceUpdated=0;
for(const group of groups){const file=path.join(data,'papers',`${group.paperId}.json`);const bytes=await fs.readFile(file);const paper=JSON.parse(bytes);const original=structuredClone(paper);const p=paper.passages.find(p=>p.sentences.some(s=>s.id===group.ids[0]));assert.ok(p);
 for(const removeId of group.ids.slice(1)){const i=p.sentences.findIndex(s=>s.id===group.ids[0]),first=p.sentences[i],second=p.sentences[i+1];assert.equal(second.id,removeId);assert.equal(first.sourceParagraphId,second.sourceParagraphId);assert.equal(first.reviewed,false);assert.equal(second.reviewed,false);const merged={...first,text:`${first.text} ${second.text}`,start:0,end:0,reviewed:false};delete merged.alignmentConfidence;delete merged.alignmentEvidence;p.sentences.splice(i,2,merged);aliases[second.id]=first.id;corrections.push({paperId:paper.id,passageId:p.id,sourceParagraphId:first.sourceParagraphId,keptId:first.id,mergedId:second.id,before:[first,second],after:merged,reason:'人名/机构缩写中的首字母或St.句点造成错误分句，按原段落合并。'});}
 for(const q of paper.questions){if(!q.evidenceSentenceIds)continue;const mapped=[...new Set(q.evidenceSentenceIds.map(id=>aliases[id]||id))];if(JSON.stringify(mapped)!==JSON.stringify(q.evidenceSentenceIds)){q.evidenceSentenceIds=mapped;evidenceUpdated++;}}
 assert.deepEqual(paper.quality,original.quality);for(const q of paper.questions){const old=original.questions.find(o=>o.id===q.id);assert.equal(q.answer,old.answer);assert.deepEqual(q.options,old.options);}
 for(const oldPassage of original.passages)for(const old of oldPassage.sentences){if(group.ids.includes(old.id))continue;assert.deepEqual(paper.passages.find(p=>p.id===oldPassage.id).sentences.find(s=>s.id===old.id),old,`Unaffected sentence changed ${old.id}`);}
 pending.push({file,paper,bytes,hash:sha256(bytes)});
}
for(const change of pending)assert.equal(sha256(await fs.readFile(change.file)),change.hash,'Concurrent paper modification');
const backup=path.join(data,'references','before-additional-segmentation');await fs.mkdir(backup,{recursive:true});for(const change of pending){await fs.writeFile(path.join(backup,`${change.paper.id}.json`),change.bytes,{flag:'wx'});await writeJson(change.file,change.paper);}
report.aliasMap={...report.aliasMap,...aliases};report.corrections.push(...corrections);report.affectedPaperIds=[...new Set([...report.affectedPaperIds,...pending.map(p=>p.paper.id)])];report.mergedBoundaryCount=24;report.evidenceQuestionsUpdated+=evidenceUpdated;report.additionalCorrectionsAppliedAt=new Date().toISOString();report.additionalCorrectionPaperIds=pending.map(p=>p.paper.id);await writeJson(path.join(data,'references','segmentation-corrections.json'),report);console.log(JSON.stringify({additionalBoundaries:5,totalBoundaries:24,affectedPaperIds:report.additionalCorrectionPaperIds,evidenceUpdated},null,2));
