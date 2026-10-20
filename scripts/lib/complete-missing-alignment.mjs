import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {alignSentences,recognizedWords} from '../align.mjs';
import {readJson,writeJson,sha256,stripHtml} from './corpus.mjs';
import {validateTimings} from '../../server/validation.mjs';
const data=path.resolve('data');
const ids=['cet6-2020-12-2-p-1-6-s1','cet6-2021-12-1-p-5-3-s2','cet6-2024-12-1-p-1-9-s1','cet6-2024-12-2-p-1-6-s1','cet6-2025-12-1-p-5-4-s1','cet6-2026-06-1-p-5-5-s1','cet6-2026-06-1-p-5-5-s2'];
const fixes={
 'cet6-2021-12-1-p-5-3-s2':{text:"And that's a bit of a departure for you.",quote:"And that's a bit of a departure for you.",paperId:'cet6-2021-12-1'},
 'cet6-2024-12-2-p-1-6-s1':{text:'M: Um, well...',quote:'M:Um,well...',paperId:'cet6-2024-12-2'}
};
const sources=await readJson(path.join(data,'references','refinement-sources.json'));
const windows=await readJson(path.join(data,'alignment-refinement','windows.json'));
const report={createdAt:new Date().toISOString(),method:'既有公开原文交叉纠错；OK/okay仅规范拼写；缺句使用完整篇章base.en逐词ASR对齐并保留原始词时间。重叠仅收回邻句原先附加的padding，记录前后值；没有按字数或句数分配时间。全部仍为未听校候选。',changes:[],boundaryAdjustments:[],unresolvedTranscriptionVariants:[],papers:[]};
const pending=[];
for(const paperId of [...new Set(ids.map(id=>id.slice(0,14)))]){
 const file=path.join(data,'papers',`${paperId}.json`);const bytes=await fs.readFile(file);const paper=JSON.parse(bytes);const before=structuredClone(paper);const targets=ids.filter(id=>id.startsWith(`${paperId}-`));
 for(const id of targets){const sentence=paper.passages.flatMap(p=>p.sentences).find(s=>s.id===id);assert.ok(sentence,id);assert.equal(sentence.reviewed,false);assert.equal(sentence.start,0,`${id} already has a candidate; refuse an unreviewed repeat mutation`);assert.equal(sentence.end,0);const fix=fixes[id];if(!fix)continue;
  const source=sources.entries.find(s=>s.id===fix.paperId);assert.ok(source?.exactExpectedFound,'Missing independent original transcript');const html=await fs.readFile(path.join(data,'references',source.filename));assert.equal(sha256(html),source.sha256);assert.ok(stripHtml(html.toString('utf8')).includes(fix.quote));
  sentence.textCorrection={previousText:sentence.text,text:fix.text,url:source.url,sourceSha256:source.sha256,checkedAt:new Date().toISOString(),reason:'独立公开原文与本地音频识别共同否定原采集句，保留稳定ID纠正；尚未标为人工听校完成。'};sentence.text=fix.text;
  if(!paper.sources.some(s=>s.kind==='transcript'&&s.url===source.url))paper.sources.push({kind:'transcript',url:source.url,label:'新东方公开当日六级听力原文 · 局部原文纠错',fetchedAt:source.fetchedAt});
 }
 for(const passage of paper.passages){const targetIds=targets.filter(id=>passage.sentences.some(s=>s.id===id));if(!targetIds.length)continue;
  const baseFile=path.join(data,'alignment',paper.id,`passage-${passage.order}-base.json`);const primaryFile=path.join(data,'alignment',paper.id,`passage-${passage.order}.json`);let sourceFile=baseFile,recognition=await readJson(baseFile,null);if(!recognition){sourceFile=primaryFile;recognition=await readJson(primaryFile);}assert.ok(recognition.params.model.includes('base.en'),'Use actual larger-model recognition');
  const alignmentText=structuredClone(passage.sentences);
  const hesitation=alignmentText.find(s=>s.id==='cet6-2020-12-2-p-1-6-s1');if(hesitation){assert.equal(hesitation.text,'M: Ha.');hesitation.text='M: Huh.';report.unresolvedTranscriptionVariants.push({sentenceId:hesitation.id,publishedLocalText:'M: Ha.',recognizedVariant:'Huh,',reason:'完整tiny/base及局部base均在同一对话回合识别Huh；仅据此定位该非词汇感叹声，尚未找到独立原文支持改拼写，保留Ha并要求听校。'});}
  const aligned=alignSentences(alignmentText,recognizedWords(recognition),passage.start,passage.end,{includeEvidence:true});
  for(const id of targetIds){const target=passage.sentences.find(s=>s.id===id);const candidate=aligned.find(s=>s.id===id);assert.ok(candidate.end>candidate.start,`${id} is not supported by recognized words`);assert.ok(candidate.end-candidate.start<=5,'Unexpected long candidate');const old=structuredClone(before.passages.flatMap(p=>p.sentences).find(s=>s.id===id));
   target.start=candidate.start;target.end=candidate.end;target.reviewed=false;target.alignmentConfidence=candidate.coverage;target.alignmentEvidence={report:'references/missing-alignment-completion.json',method:hesitation?.id===id?'context-confirmed-interjection-variant':'base.en-word-alignment',sourceFile:path.relative(data,sourceFile).replaceAll('\\','/')};
   const window=windows.windows.find(w=>w.sentenceIds.includes(id));
   report.changes.push({paperId,passageId:passage.id,sentenceId:id,before:old,after:structuredClone(target),recognitionSource:path.relative(data,sourceFile).replaceAll('\\','/'),recognitionSha256:sha256(await fs.readFile(sourceFile)),recognizedModel:recognition.params.model,coverage:candidate.coverage,matchedWords:candidate.matchedWords,expectedWords:candidate.expectedWords,wordEvidence:candidate.wordEvidence,localContextEvidence:window||null});
  }
  for(const [i,s]of passage.sentences.entries()){
   if(!targetIds.includes(s.id))continue;
   const previous=passage.sentences.slice(0,i).reverse().find(x=>x.end>x.start);const next=passage.sentences.slice(i+1).find(x=>x.end>x.start);
   if(previous&&previous.end>s.start&&!targetIds.includes(previous.id)){const oldEnd=previous.end;assert.ok(s.start>previous.start);previous.end=s.start;report.boundaryAdjustments.push({paperId,sentenceId:previous.id,field:'end',before:oldEnd,after:previous.end,reason:`收回旧padding，截止到有逐词证据的 ${s.id} 起点`,wordEvidence:aligned.find(a=>a.id===previous.id)?.wordEvidence});}
   if(next&&next.start<s.end&&!targetIds.includes(next.id)){const oldStart=next.start;assert.ok(s.end<next.end);next.start=s.end;report.boundaryAdjustments.push({paperId,sentenceId:next.id,field:'start',before:oldStart,after:next.start,reason:`收回旧padding，从有逐词证据的 ${s.id} 终点开始`,wordEvidence:aligned.find(a=>a.id===next.id)?.wordEvidence});}
  }
 }
 assert.deepEqual(paper.questions,before.questions,'All answers, options and evidence IDs must remain unchanged');assert.deepEqual(paper.quality,before.quality,'No verification status can change');validateTimings(paper);assert.ok(paper.passages.flatMap(p=>p.sentences).every(s=>s.reviewed===false));pending.push({file,paper,bytes,hash:sha256(bytes)});report.papers.push(paperId);
}
for(const change of pending)assert.equal(sha256(await fs.readFile(change.file)),change.hash,'Concurrent paper mutation; refuse overwrite');
const backup=path.join(data,'references','before-missing-completion');await fs.mkdir(backup,{recursive:true});
for(const change of pending){await fs.writeFile(path.join(backup,`${change.paper.id}.json`),change.bytes,{flag:'wx'});await writeJson(change.file,change.paper);}
await writeJson(path.join(data,'references','missing-alignment-completion.json'),report);
console.log(JSON.stringify({changedSentences:report.changes.length,adjacentPaddingAdjustments:report.boundaryAdjustments.length,papers:report.papers,unresolvedTranscriptionVariants:report.unresolvedTranscriptionVariants},null,2));
