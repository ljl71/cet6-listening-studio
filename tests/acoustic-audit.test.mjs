import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditPassage, alignWords, spokenWords } from '../scripts/lib/audit-acoustic.mjs';
import {localFixture} from './local-fixtures.mjs';

function fixture() {
  const source = { id: 's1', text: 'The students were reading interesting books today.', start: 1, end: 3 };
  const words = spokenWords(source.text).map((text, index) => ({ text, sentenceId: source.id, start: 1 + index * 0.2, end: 1.15 + index * 0.2, score: 0.98 }));
  const passage = { id: 'p1', order: 1, start: 0, end: 10, sentences: [source] };
  const paper = { id: 'paper', audioAssetId: 'audio', passages: [passage], questions: [{ passageId: 'p1', prompt: 'What were the students doing?' }] };
  const asset = { sha256: 'a'.repeat(64) };
  const evidence = { paperId: paper.id, passageId: passage.id, audioAssetId: paper.audioAssetId, mediaSha256: asset.sha256,
    sourceRange: { start: passage.start, end: passage.end }, pcmSha256: 'b'.repeat(64), referenceSha256: 'legacy-hash-containing-old-timings',
    greedyTranscript: source.text + ' What were the students doing?', sentences: [{ id: source.id, text: source.text,
      acousticStart: words[0].start, acousticEnd: words.at(-1).end, existingStart: source.start, existingEnd: source.end,
      words, firstWordScore: 0.98, lastWordScore: 0.98, meanWordScore: 0.98, minimumWordScore: 0.98, maxWordGap: 0.05 }] };
  return { paper, passage, evidence, asset };
}

function withText(text, greedy, version = 1) {
  const f = fixture();
  f.passage.sentences[0].text = text;
  const words = spokenWords(text, { version, hint: greedy }).map((text, index) => ({ text, sentenceId: 's1', start: 1 + index * 0.2, end: 1.15 + index * 0.2, score: 0.98 }));
  f.passage.sentences[0].end = words.at(-1).end;
  Object.assign(f.evidence.sentences[0], { text, acousticStart: words[0].start, acousticEnd: words.at(-1).end, words });
  f.evidence.greedyTranscript = greedy + ' What were the students doing?';
  if (version >= 2) f.evidence.lexicalNormalizationVersion = version;
  return f;
}

test('lexical normalization follows the acoustic source reference, including numbers and titles', () => {
  assert.deepEqual(spokenWords('W: Dr. Reed paid $1,250.50 and 20%.'),
    ['DOCTOR', 'REED', 'PAID', 'ONE', 'THOUSAND', 'TWO', 'HUNDRED', 'FIFTY', 'POINT', 'FIVE', 'ZERO', 'DOLLARS', 'AND', 'TWENTY', 'PERCENT']);
});

test('ordered greedy alignment preserves repeated word positions and context', () => {
  const result = alignWords(['A', 'CAT', 'THEN', 'A', 'DOG'], ['A', 'CAT', 'THEN', 'A', 'FROG']);
  assert.deepEqual(result.mapping.map(word => word?.hypothesisIndex), [0, 1, 2, 3, 4]);
  assert.equal(result.mapping.at(-1).exact, false);
  assert.equal(result.substitutions, 1);
});

test('consistent high-scoring evidence needs independent first and last word anchors', () => {
  const { paper, passage, evidence, asset } = fixture();
  let result = auditPassage(paper, passage, evidence, asset);
  assert.equal(result.status, 'completed');
  assert.equal(result.sentences[0].supportedCandidate, true);
  assert.equal(result.sentences[0].reviewed, false);
  evidence.greedyTranscript = 'The teachers were reading interesting books yesterday. What were the students doing?';
  result = auditPassage(paper, passage, evidence, asset);
  assert.equal(result.sentences[0].score.meanWordScore, 0.98);
  assert.equal(result.sentences[0].supportedCandidate, false);
  assert.equal(result.sentences[0].classification, 'independent-transcript-disagreement');
});

test('timing edits alone keep acoustic evidence current; text, ID or source range edits do not', () => {
  const { paper, passage, evidence, asset } = fixture();
  passage.sentences[0].start = 7;
  passage.sentences[0].end = 9;
  let result = auditPassage(paper, passage, evidence, asset);
  assert.equal(result.status, 'completed');
  assert.equal(result.sentences[0].supportedCandidate, true);
  assert.equal(result.sentences[0].requiresListeningBeforeApplication, true);
  assert.equal(result.sentences[0].evidenceBaseline.start, 1);
  passage.sentences[0].text += ' Changed.';
  result = auditPassage(paper, passage, evidence, asset);
  assert.equal(result.status, 'stale');
  assert.equal(result.sentences[0].supportedCandidate, false);
  assert.ok(result.issues.some(issue => issue.startsWith('sentence-text-mismatch')));
  passage.sentences[0].text = evidence.sentences[0].text;
  passage.end = 11;
  assert.ok(auditPassage(paper, passage, evidence, asset).issues.includes('decoded-source-range-mismatch'));
});

test('missing decode provenance and source media mismatch cannot become supported candidates', () => {
  const { paper, passage, evidence, asset } = fixture();
  delete evidence.sourceRange;
  let result = auditPassage(paper, passage, evidence, asset);
  assert.equal(result.status, 'incomplete-provenance');
  assert.equal(result.sentences[0].supportedCandidate, false);
  evidence.sourceRange = { start: 0, end: 10 };
  evidence.mediaSha256 = 'c'.repeat(64);
  result = auditPassage(paper, passage, evidence, asset);
  assert.equal(result.status, 'stale');
  assert.ok(result.issues.includes('original-media-sha256-mismatch'));
});

test('word duration anomalies remain visible even when scores and greedy transcript match', () => {
  const { paper, passage, evidence, asset } = fixture();
  evidence.sentences[0].words[2].end = 4;
  const result = auditPassage(paper, passage, evidence, asset);
  assert.equal(result.sentences[0].supportedCandidate, false);
  assert.equal(result.sentences[0].classification, 'word-or-boundary-anomaly');
  assert.ok(result.sentences[0].anomalies.some(item => item.type === 'word-duration'));
  assert.ok(result.sentences[0].anomalies.some(item => item.type === 'word-gap-or-overlap'));
});

test('high acoustic scores and exact source words do not hide extra independently recognized words', () => {
  const { paper, passage, evidence, asset } = fixture();
  evidence.greedyTranscript = 'The students were really not reading interesting books today. What were the students doing?';
  const result = auditPassage(paper, passage, evidence, asset);
  const sentence = result.sentences[0];
  assert.equal(sentence.independentTranscript.exactWordFraction, 1);
  assert.equal(sentence.independentTranscript.internalInsertions, 2);
  assert.ok(sentence.independentTranscript.wordErrorRate > 0.15);
  assert.equal(sentence.supportedCandidate, false);
});

test('one omitted negation in a long sentence blocks an otherwise supported candidate', () => {
  const source = 'The students were reading interesting books today because they did not want to waste any time before the important examination at the end of the academic year.';
  const f = withText(source, source.replace('did not want', 'did want'));
  const row = auditPassage(f.paper, f.passage, f.evidence, f.asset).sentences[0];
  assert.ok(row.independentTranscript.wordErrorRate < 0.15);
  assert.equal(row.independentTranscript.firstAnchor, true);
  assert.equal(row.independentTranscript.lastAnchor, true);
  assert.equal(row.supportedCandidate, false);
  assert.equal(row.classification, 'critical-lexical-disagreement');
  assert.equal(row.independentTranscript.criticalLexicalEdits[0].source, 'NOT');
});

test('direction and quantifier differences require listening even at a low overall error rate', () => {
  const source = 'The students were reading more interesting books today because they wanted to prepare carefully for the important examination at the end of this academic year.';
  const f = withText(source, source.replace('more', 'less'));
  const row = auditPassage(f.paper, f.passage, f.evidence, f.asset).sentences[0];
  assert.ok(row.independentTranscript.wordErrorRate < 0.15);
  assert.equal(row.independentTranscript.directionOrQuantifierEdits.length, 1);
  assert.equal(row.requiresListeningBeforeApplication, true);
  assert.ok(row.tags.includes('direction-or-quantifier-lexical-edit'));
});

test('version two numeric renderings match only strictly equal-valued greedy year/hundreds phrases', () => {
  const normalizations = [];
  assert.deepEqual(spokenWords('$85 billion in 2011, 1500 and 1901.', { version: 2, hint: 'EIGHTY FIVE BILLION DOLLARS IN TWENTY ELEVEN FIFTEEN HUNDRED AND NINETEEN OH ONE', normalizations }),
    ['EIGHTY', 'FIVE', 'BILLION', 'DOLLARS', 'IN', 'TWENTY', 'ELEVEN', 'FIFTEEN', 'HUNDRED', 'AND', 'NINETEEN', 'OH', 'ONE']);
  assert.equal(normalizations.length, 4);
  assert.ok(normalizations.every(n => n.type === 'numeric-spoken-rendering-normalization'));
  assert.deepEqual(spokenWords('1500', { version: 2, hint: 'FIFTEEN HUNDREDS' }), ['ONE', 'THOUSAND', 'FIVE', 'HUNDRED']);
  assert.deepEqual(spokenWords('$85 billion in 2011.'), ['EIGHTY', 'FIVE', 'DOLLARS', 'BILLION', 'IN', 'TWO', 'THOUSAND', 'ELEVEN']);
});

test('PER CENT equivalence does not change reference word scores or forced-alignment token validation', () => {
  const source = 'Sales increased by twenty per cent this year.';
  const f = withText(source, 'SALES INCREASED BY TWENTY PERCENT THIS YEAR');
  const row = auditPassage(f.paper, f.passage, f.evidence, f.asset).sentences[0];
  assert.equal(row.wordCount, 8);
  assert.equal(row.independentTranscript.referenceWords, 7);
  assert.equal(row.independentTranscript.wordErrorRate, 0);
  assert.equal(row.anomalies.length, 0);
  assert.equal(row.score.meanWordScore, 0.98);
  assert.ok(row.lexicalNormalizations.some(n => n.type === 'explicit-lexical-equivalence'));
  assert.equal(row.supportedCandidate, true);
});

test('real one-word responses have one independent word anchor while retaining every acoustic gate', localFixture('data/acoustic-review/cet6-2021-06-1/passage-2.json','data/acoustic-review/cet6-2022-06-1/passage-3.json'), () => {
  for (const [paperId, order, id] of [['cet6-2021-06-1', 2, 'cet6-2021-06-1-p-5-21-s2'], ['cet6-2022-06-1', 3, 'cet6-2022-06-1-p-9-2-s9']]) {
    const paper = JSON.parse(readFileSync(new URL(`../data/papers/${paperId}.json`, import.meta.url))),
      evidence = JSON.parse(readFileSync(new URL(`../data/acoustic-review/${paperId}/passage-${order}.json`, import.meta.url))),
      assets = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url))), passage = paper.passages.find(p => p.order === order);
    const row = auditPassage(paper, passage, evidence, assets[paper.audioAssetId]).sentences.find(s => s.id === id);
    assert.equal(row.independentTranscript.anchorWordCount, 1);
    assert.equal(row.independentTranscript.firstAnchor, true); assert.equal(row.independentTranscript.lastAnchor, true);
    assert.equal(row.independentTranscript.wordErrorRate, 0); assert.equal(row.supportedCandidate, true);
  }
});

test('real final ON stays with its sentence instead of the later BASED ON question introduction', localFixture('data/acoustic-review/cet6-2020-09-1/passage-6.json'), () => {
  const paperId = 'cet6-2020-09-1';
  const paper = JSON.parse(readFileSync(new URL(`../data/papers/${paperId}.json`, import.meta.url))),
    evidence = JSON.parse(readFileSync(new URL(`../data/acoustic-review/${paperId}/passage-6.json`, import.meta.url))),
    assets = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url)));
  const row = auditPassage(paper, paper.passages.find(p => p.order === 6), evidence, assets[paper.audioAssetId]).sentences.find(s => s.text === 'And so the story goes on.');
  assert.equal(row.independentTranscript.greedyWindow, 'AND SO THE STORY GOES ON');
  assert.equal(row.independentTranscript.lastAnchor, true); assert.equal(row.independentTranscript.wordErrorRate, 0);
});

test('explicit WASNT apostrophe equivalence does not excuse a weak sentence end', () => {
  const f = withText("He wasn't alone in experiencing the extreme physical effects of the game.", 'HE WASNT ALONE IN EXPERIENCING THE EXTREME PHYSICAL EFFECTS OF THE GAY A');
  const row = auditPassage(f.paper, f.passage, f.evidence, f.asset).sentences[0];
  assert.equal(row.independentTranscript.criticalLexicalEdits.length, 0);
  assert.equal(row.independentTranscript.lastAnchor, false); assert.equal(row.supportedCandidate, false);
});

test('version three expands MPH once, preserves previous versions, and records the explicit rendering', () => {
  const source = 'at 31,000 mph (miles per hour) two years ago', notes = [];
  const words = spokenWords(source, { version: 3, normalizations: notes });
  assert.deepEqual(words, ['AT', 'THIRTY', 'ONE', 'THOUSAND', 'MILES', 'PER', 'HOUR', 'TWO', 'YEARS', 'AGO']);
  assert.equal(notes.length, 1); assert.equal(notes[0].expansionCount, 1);
  assert.equal(notes[0].type, 'abbreviation-spoken-rendering-normalization');
  assert.equal(spokenWords(source, { version: 2 }).filter(w => w === 'MPH').length, 1);
  assert.deepEqual(spokenWords('31000mph(miles per hour)', { version: 3 }), ['THIRTY', 'ONE', 'THOUSAND', 'MILES', 'PER', 'HOUR']);
});

test('version three A 100 uses A HUNDRED only with matching article and independent numeric speech', () => {
  const notes = [];
  assert.deepEqual(spokenWords('in a 100-meter dash', { version: 3, hint: 'IN AN A HUNDRED METER DASH', normalizations: notes }), ['IN', 'A', 'HUNDRED', 'METER', 'DASH']);
  assert.equal(notes[0].kind, 'article-a-hundred-reading');
  assert.deepEqual(spokenWords('in a 100-meter dash', { version: 3, hint: 'IN A ONE HUNDRED METER DASH' }), ['IN', 'A', 'ONE', 'HUNDRED', 'METER', 'DASH']);
  assert.deepEqual(spokenWords('100 meters', { version: 3, hint: 'A HUNDRED METERS' }), ['ONE', 'HUNDRED', 'METERS']);
});

test('NONE THE LESS is explicit adverb word division while standalone NONE remains a critical negation', () => {
  const source = 'These are mostly harmless lies, but lies nonetheless.';
  let f = withText(source, 'THESE ARE MOSTLY HARMLESS LIES BUT LIES NONE THE LESS');
  let row = auditPassage(f.paper, f.passage, f.evidence, f.asset).sentences[0];
  assert.equal(row.independentTranscript.criticalLexicalEdits.length, 0); assert.equal(row.independentTranscript.wordErrorRate, 0);
  assert.equal(row.supportedCandidate, true);
  f = withText('These were harmless claims that appeared in the newspaper every day.', 'THESE WERE HARMLESS CLAIMS THAT NONE APPEARED IN THE NEWSPAPER EVERY DAY');
  row = auditPassage(f.paper, f.passage, f.evidence, f.asset).sentences[0];
  assert.equal(row.supportedCandidate, false); assert.ok(row.independentTranscript.criticalLexicalEdits.length > 0);
});

test('Python and JavaScript V3 numeric and abbreviation renderings agree without loading the model', localFixture('runtime/alignment-env/Scripts/python.exe'), () => {
  const python = new URL('../runtime/alignment-env/Scripts/python.exe', import.meta.url);
  const source = new URL('../scripts/acoustic-review.py', import.meta.url);
  const program = `import ast,json,re,unicodedata\nfrom pathlib import Path\ntree=ast.parse(Path(${JSON.stringify(fileURLToPath(source))}).read_text(encoding="utf-8"))\ndefs=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ("number_words","number_reading","spoken_words")]\nexec(compile(ast.Module(body=defs,type_ignores=[]),"pure-normalizers","exec"))\nsamples=json.loads(${JSON.stringify(JSON.stringify([['31000mph(miles per hour)', ''], ['in a 100-meter dash', 'AN A HUNDRED METER DASH'], ['$85 billion in 2011', 'EIGHTY FIVE BILLION DOLLARS IN TWENTY ELEVEN']]))})\nprint(json.dumps([spoken_words(t,h) for t,h in samples]))`;
  const result = spawnSync(fileURLToPath(python), ['-c', program], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const expected = [['31000mph(miles per hour)', ''], ['in a 100-meter dash', 'AN A HUNDRED METER DASH'], ['$85 billion in 2011', 'EIGHTY FIVE BILLION DOLLARS IN TWENTY ELEVEN']].map(([text, hint]) => spokenWords(text, { version: 3, hint }));
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
