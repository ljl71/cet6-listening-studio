import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReference, compareAnswers } from '../scripts/verify-answers.mjs';

test('reference parser reads marked answer and preserves four options', () => {
  const labels = ['A','B','C','D'].map(key => `<label><input value="${key}"><span class="whitespace-pre-wrap break-words">${key}&amp; answer</span>${key === 'B' ? '<span>✓ 正确答案</span>' : ''}</label>`).join('');
  const parsed = parseReference(`<div data-question-id="q1">${labels}</div>`);
  assert.equal(parsed.length, 1); assert.equal(parsed[0].answer, 'B'); assert.equal(parsed[0].options.A, 'A& answer');
});
test('cross-source match follows option text rather than letter order', () => {
  const paper = { id: 'sample', questions: [{ number: 1, answer: 'A', options: {A:'same answer',B:'two',C:'three',D:'four'} }] };
  const result = compareAnswers(paper, [{ number: 1, answer:'D', options:{A:'two',B:'three',C:'four',D:'Same answer.'} }]);
  assert.equal(result.results[0].agrees, true); assert.equal(result.verified, false);
  assert.equal(compareAnswers(paper, [{number:1, answer:'A', options:{A:'wrong',B:'two',C:'three',D:'four'}}]).results[0].agrees, false);
});
