import test from 'node:test';
import assert from 'node:assert/strict';
import { words, alignSentences } from '../scripts/align.mjs';
test('alignment maps recognized words to source sentences without claiming review', () => {
  assert.deepEqual(words("W: It's Anna's book."), ['its','annas','book']);
  const sentences = [{id:'a',text:'Hello dear friend.'},{id:'b',text:'How are you?'}];
  const recognized = ['hello','dear','friend','how','are','you'].map((word,i)=>({word,start:i,end:i+0.5}));
  const aligned = alignSentences(sentences, recognized, 10, 20);
  assert.equal(aligned[0].coverage,1); assert.equal(aligned[0].reviewed,false); assert.equal(aligned[1].start,12.88);
  assert.ok(aligned[0].end < aligned[1].start);
});
test('unmatched sentences keep zero timestamps instead of estimated equal spacing', () => {
  const [result] = alignSentences([{id:'a',text:'Entirely missing words.'}], [{word:'something',start:2,end:3}],10,20);
  assert.equal(result.start,0); assert.equal(result.end,0);
});
