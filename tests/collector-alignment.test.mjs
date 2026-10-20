import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {words,recognizedWords,alignSentences,alignPassage} from '../scripts/align.mjs';
test('OK and okay are exact spelling equivalents while unlike interjections are not normalized',()=>{
 assert.deepEqual(words('W: OK, fine.'),words('Okay, fine.'));assert.deepEqual(words('M: Ah, well...'),['ah','well']);assert.deepEqual(words('Um, well...'),['um','well']);assert.notDeepEqual(words('Ha.'),words('Huh.'));
});
test('oral question virtual sequences prevent a narrative tail from matching a later question word',()=>{
 const passage={id:'p',start:0,end:30,sentences:[{id:'narrative',text:'People can control their weight.'}]};const paper={questions:[{id:'q1',number:1,passageId:'p',prompt:'What do people believe about their weight?'}]};
 const before=['people','can','control','their','weight'].map((word,i)=>({text:word,offsets:{from:i*400,to:i*400+250}}));const after=['what','do','people','believe','about','their','weight'].map((word,i)=>({text:word,offsets:{from:10000+i*400,to:10250+i*400}}));const recognition={transcription:[...before,...after]};
 const old=alignSentences(passage.sentences,recognizedWords(recognition),0,30)[0];const guarded=alignPassage(paper,passage,recognition,{includeEvidence:true})[0];assert.ok(old.end>10);assert.ok(guarded.end<3);assert.ok(guarded.questionStart>9);assert.equal(guarded.coverage,1);assert.deepEqual(guarded.timingWarnings,[]);
});
test('full lexical recall cannot certify oversized word spans or disconnected word matches',()=>{
 const paper={questions:[]};const p={id:'p',start:0,end:30,sentences:[{id:'s',text:'Hello world.'}]};
 const long=alignPassage(paper,p,{transcription:[{text:'Hello',offsets:{from:1000,to:4500}},{text:'world',offsets:{from:4500,to:4800}}]})[0];assert.equal(long.coverage,1);assert.equal(long.start,0);assert.equal(long.end,0);assert.equal(long.timingWarnings[0].kind,'oversized-word-span');assert.ok(long.rawEnd>4);
 const gap=alignPassage(paper,p,{transcription:[{text:'Hello',offsets:{from:1000,to:1250}},{text:'world',offsets:{from:6000,to:6300}}]})[0];assert.equal(gap.coverage,1);assert.equal(gap.start,0);assert.equal(gap.timingWarnings[0].kind,'non-contiguous-word-match');
});
test('saved real ASR resolves the four missing OK sentences with word timestamp evidence',{skip:!existsSync(new URL('../data/alignment/cet6-2026-06-1/passage-2.json',import.meta.url))},async()=>{
 for(const [paperId,order,ids]of [['cet6-2024-12-1',1,['cet6-2024-12-1-p-1-9-s1']],['cet6-2025-12-1',2,['cet6-2025-12-1-p-5-4-s1']],['cet6-2026-06-1',2,['cet6-2026-06-1-p-5-5-s1','cet6-2026-06-1-p-5-5-s2']]]){
  const paper=JSON.parse(await fs.readFile(new URL(`../data/papers/${paperId}.json`,import.meta.url),'utf8'));const p=paper.passages.find(p=>p.order===order);const r=JSON.parse(await fs.readFile(new URL(`../data/alignment/${paperId}/passage-${order}.json`,import.meta.url),'utf8'));const result=alignSentences(p.sentences,recognizedWords(r),p.start,p.end,{includeEvidence:true});for(const id of ids){const s=result.find(s=>s.id===id);assert.ok(s.end>s.start,id);assert.equal(s.coverage,1);assert.ok(s.wordEvidence.some(w=>w.recognizedWord==='ok'));}
 }
});
