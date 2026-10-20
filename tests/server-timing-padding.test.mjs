import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTimings } from '../server/validation.mjs';

const sentence = (id, start, end) => ({ id, start, end, text: 'Real source words.', reviewed: false });
function fixture() {
  return { duration: 30, quality: { transcript: 'candidate', timing: 'candidate' }, passages: [
    { id: 'p1', start: 5, end: 10, sentences: [sentence('s1', 4.7, 9.5)] },
    { id: 'p2', start: 10, end: 20, sentences: [sentence('s2', 9.8, 12), sentence('s3', 13, 15)] }
  ] };
}

test('only a passage first sentence gets at most 300ms preroll without changing the parent or review state', () => {
  const paper = fixture(), original = structuredClone(paper);
  assert.doesNotThrow(() => validateTimings(paper));
  assert.deepEqual(paper, original);
  paper.passages.forEach(p => p.sentences.forEach(s => { s.reviewed = true; }));
  assert.doesNotThrow(() => validateTimings(paper, paper.passages, { strict: true }));
  assert.equal(paper.quality.transcript, 'candidate'); assert.equal(paper.quality.timing, 'candidate');
});

test('preroll is clamped to original audio zero and cannot exceed 300ms', () => {
  const paper = fixture();
  paper.passages = [{ id: 'p1', start: 0.1, end: 2, sentences: [sentence('s1', 0, 1)] }];
  assert.doesNotThrow(() => validateTimings(paper));
  paper.passages[0].sentences[0].start = -0.001;
  assert.throws(() => validateTimings(paper), /句子开始/);
  const tooEarly = fixture(); tooEarly.passages[0].sentences[0].start = 4.699;
  assert.throws(() => validateTimings(tooEarly), /前置缓冲/);
});

test('a later sentence never inherits preroll even when the first sentence is untimed', () => {
  const paper = fixture();
  paper.passages[0].sentences = [sentence('s1', 0, 0), sentence('s1-later', 4.9, 6)];
  assert.throws(() => validateTimings(paper), /前置缓冲/);
});

test('first-sentence preroll cannot overlap the previous passage actual speech', () => {
  const paper = fixture(); paper.passages[0].sentences[0].end = 9.85;
  assert.throws(() => validateTimings(paper), /前置缓冲/);
  paper.passages[1].sentences[0].start = 9.85;
  assert.doesNotThrow(() => validateTimings(paper), 'An exact shared word-free boundary is valid');
});

test('preroll does not relax later-sentence overlap, parent end, or declared passage order', () => {
  const overlap = fixture(); overlap.passages[1].sentences[1].start = 11.9;
  assert.throws(() => validateTimings(overlap), /不重叠/);
  const end = fixture(); end.passages[1].sentences[1].end = 20.002;
  assert.throws(() => validateTimings(end), /不重叠/);
  const order = fixture(); order.passages[1].start = 9.8;
  assert.throws(() => validateTimings(order), /篇章时间/);
  const unreviewed = fixture();
  assert.throws(() => validateTimings(unreviewed, unreviewed.passages, { strict: true }), /勾选/);
});
