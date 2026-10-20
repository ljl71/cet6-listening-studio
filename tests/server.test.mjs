import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createServer, parseRange } from '../server/index.mjs';
import { createStore, atomicJson } from '../server/store.mjs';
import { crc32 } from '../server/zip.mjs';
import { validatePaper } from '../server/validation.mjs';
import {localFixture} from './local-fixtures.mjs';

const audio = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const TEST_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', '.test-temp');
mkdirSync(TEST_ROOT, { recursive: true });
function paperFixture(id = '2025-12-1') {
  const counts = [4, 4, 3, 4, 3, 3, 4], types = ['conversation', 'conversation', 'passage', 'passage', 'lecture', 'lecture', 'lecture'];
  const passages = counts.map((_, index) => ({ id: `${id}-p${index + 1}`, order: index + 1, type: types[index], title: `篇章 ${index + 1}`, start: index * 10 + 1, end: index * 10 + 10, sentences: [{ id: `${id}-s${index + 1}`, start: index * 10 + 2, end: index * 10 + 8, text: `Sample transcript sentence ${index + 1}.`, reviewed: true }] }));
  let number = 0;
  const questions = passages.flatMap((passage, index) => Array.from({ length: counts[index] }, () => ({ id: `${id}-q${++number}`, number, passageId: passage.id, options: { A: 'Option alpha', B: 'Option bravo', C: 'Option charlie', D: 'Option delta' }, answer: number % 2 ? 'A' : 'B', evidenceSentenceIds: [passage.sentences[0].id] })));
  return { id, title: '2025 年 12 月第一套测试资料', year: 2025, month: 12, variant: '第一套', contentId: `${id}-content`, audioAssetId: 'sample-audio', duration: 80, required: true, sources: [{ url: 'https://example.com/test', label: '隔离测试夹具', kind: 'catalog' }], quality: { audio: 'verified', questions: 'verified', answers: 'verified', transcript: 'verified', timing: 'verified' }, passages, questions };
}
function writeFixture(directory, paper = paperFixture()) {
  mkdirSync(path.join(directory, 'papers'), { recursive: true }); mkdirSync(path.join(directory, 'media'), { recursive: true });
  atomicJson(path.join(directory, 'papers', `${paper.id}.json`), paper);
  writeFileSync(path.join(directory, 'media', 'sample.mp3'), audio);
  atomicJson(path.join(directory, 'assets.json'), { 'sample-audio': { path: 'media/sample.mp3', mime: 'audio/mpeg', size: audio.length, sha256: createHash('sha256').update(audio).digest('hex'), duration: paper.duration } });
  return paper;
}
async function setup(t, { fixture = true, now } = {}) {
  const directory = mkdtempSync(path.join(TEST_ROOT, 'cet6-server-'));
  const paper = fixture ? writeFixture(directory) : null;
  let server = createServer({ dataDir: directory, distDir: path.join(directory, 'dist'), now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (route, { method = 'GET', body, headers = {}, raw = false } = {}) => {
    if (headers.Host) return new Promise((resolve, reject) => {
      const outgoing = http.request(base + route, { method, headers }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      outgoing.on('error', reject); outgoing.end();
    });
    const response = await fetch(base + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (raw) return response;
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const restart = async () => { await close(); server = createServer({ dataDir: directory, distDir: path.join(directory, 'dist'), now }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; };
  return { directory, paper, request, restart };
}

test('an empty corpus stays empty and is never reported ready', async t => {
  const { request } = await setup(t, { fixture: false });
  const health = await request('/api/health');
  assert.equal(health.status, 200); assert.equal(health.body.ready, false); assert.deepEqual(health.body.corpus, { total: 0, ready: 0, missing: 0, years: [] });
  assert.deepEqual((await request('/api/papers')).body, []);
  assert.equal((await request('/api/papers/unknown')).status, 404);
});

test('grading handles unanswered items, immutable results, review mode, and sticky assistance', async t => {
  const { request, paper } = await setup(t);
  assert.equal((await request('/api/papers')).body[0].ready, true);
  const draft = (await request('/api/attempts', { method: 'POST', body: { paperId: paper.id } })).body;
  assert.equal(draft.mode, 'first');
  const resumed = await request('/api/attempts', { method: 'POST', body: { paperId: paper.id } }); assert.equal(resumed.body.id, draft.id);
  const answers = { [paper.questions[0].id]: 'A', [paper.questions[1].id]: 'C' };
  await request(`/api/attempts/${draft.id}`, { method: 'PATCH', body: { answers, assisted: true } });
  const sticky = await request(`/api/attempts/${draft.id}`, { method: 'PATCH', body: { assisted: false } }); assert.equal(sticky.body.assisted, true);
  const submitted = await request(`/api/attempts/${draft.id}/submit`, { method: 'POST' });
  assert.equal(submitted.status, 200);
  assert.deepEqual(submitted.body.result, { correct: 1, total: 25, unanswered: 23, byType: { conversation: { correct: 1, total: 8 }, passage: { correct: 0, total: 7 }, lecture: { correct: 0, total: 10 } } });
  const repeat = await request(`/api/attempts/${draft.id}/submit`, { method: 'POST' }); assert.deepEqual(repeat.body, submitted.body);
  assert.equal((await request(`/api/attempts/${draft.id}`, { method: 'PATCH', body: { answers } })).status, 409);
  const review = await request('/api/attempts', { method: 'POST', body: { paperId: paper.id, mode: 'first' } }); assert.equal(review.body.mode, 'review');
});

test('unverified answers preserve drafts and reject grading', async t => {
  const { request, paper, directory } = await setup(t);
  paper.quality.answers = 'candidate'; atomicJson(path.join(directory, 'papers', `${paper.id}.json`), paper);
  const draft = (await request('/api/attempts', { method: 'POST', body: { paperId: paper.id } })).body;
  await request(`/api/attempts/${draft.id}`, { method: 'PATCH', body: { answers: { [paper.questions[0].id]: 'A' } } });
  assert.equal((await request(`/api/attempts/${draft.id}/submit`, { method: 'POST' })).status, 409);
  assert.equal((await request('/api/attempts')).body[0].status, 'draft');
  assert.equal((await request('/api/papers')).body[0].ready, false);
});

test('invalid answers fail without corrupting a draft and null removes an answer', async t => {
  const { request, paper } = await setup(t);
  const draft = (await request('/api/attempts', { method: 'POST', body: { paperId: paper.id } })).body;
  assert.equal((await request(`/api/attempts/${draft.id}`, { method: 'PATCH', body: { answers: { unexpected: 'A' } } })).status, 400);
  await request(`/api/attempts/${draft.id}`, { method: 'PATCH', body: { answers: { [paper.questions[0].id]: 'A' } } });
  const removed = await request(`/api/attempts/${draft.id}`, { method: 'PATCH', body: { answers: { [paper.questions[0].id]: null } } });
  assert.deepEqual(removed.body.answers, {});
});

test('progress, annotations and real listening time survive a database restart', async t => {
  const { request, paper, restart } = await setup(t);
  await request(`/api/progress/${paper.id}`, { method: 'PUT', body: { position: 17.5, rate: 0.9, sentenceId: paper.passages[1].sentences[0].id, loopMode: 'sentence' } });
  await request('/api/annotations/note-1', { method: 'PUT', body: { paperId: paper.id, sentenceId: paper.passages[0].sentences[0].id, text: '连读需要重听', favorite: true, reason: '连读没听清' } });
  await request('/api/listening', { method: 'POST', body: { paperId: paper.id, seconds: 12.2 } });
  assert.equal((await request('/api/listening', { method: 'POST', body: { paperId: paper.id, seconds: 16 } })).status, 400);
  assert.equal((await request(`/api/progress/${paper.id}`, { method: 'PUT', body: { position: 90, rate: 1 } })).status, 400);
  await restart();
  assert.equal((await request('/api/progress')).body[0].position, 17.5);
  assert.equal((await request('/api/annotations')).body[0].text, '连读需要重听');
  assert.equal((await request('/api/stats')).body.listeningSeconds, 12.2);
});

test('record export restores into an empty installation, merges idempotently and backs up first', async t => {
  const source = await setup(t), destination = await setup(t, { fixture: false });
  const { request, paper } = source;
  const draft = (await request('/api/attempts', { method: 'POST', body: { paperId: paper.id } })).body;
  await request(`/api/attempts/${draft.id}`, { method: 'PATCH', body: { answers: { [paper.questions[0].id]: 'A' } } });
  await request(`/api/attempts/${draft.id}/submit`, { method: 'POST' });
  await request(`/api/progress/${paper.id}`, { method: 'PUT', body: { position: 15, rate: 1.25 } });
  await request('/api/listening', { method: 'POST', body: { paperId: paper.id, seconds: 5 } });
  const backup = (await request('/api/backup/export')).body;
  assert.equal((await destination.request('/api/backup/import', { method: 'POST', body: backup })).status, 200);
  assert.equal((await destination.request('/api/backup/import', { method: 'POST', body: backup })).status, 200);
  assert.equal((await destination.request('/api/attempts')).body.length, 1);
  assert.equal((await destination.request('/api/progress')).body[0].position, 15);
  assert.equal((await destination.request('/api/stats')).body.listeningSeconds, 5);
  assert.ok((await destination.request('/api/backups')).body.some(file => file.name.startsWith('before-import-')));
  const invalid = structuredClone(backup); invalid.attempts[0].result.correct = 900;
  assert.equal((await destination.request('/api/backup/import', { method: 'POST', body: invalid })).status, 400);
  assert.equal((await destination.request('/api/attempts')).body[0].result.correct, 1);
});

test('daily automatic backups retain the most recent seven dates', t => {
  const directory = mkdtempSync(path.join(TEST_ROOT, 'cet6-backup-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (let day = 1; day <= 10; day++) { const store = createStore({ dataDir: directory, now: () => new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`) }); store.close(); }
  const files = readdirSync(path.join(directory, 'backups'));
  assert.equal(files.length, 7); assert.ok(files.includes('auto-2026-10-04.json')); assert.ok(files.includes('auto-2026-10-10.json'));
});

test('media supports byte ranges, suffixes, HEAD and clean 416 responses', async t => {
  const { request } = await setup(t);
  const segment = await request('/media/sample-audio', { headers: { Range: 'bytes=2-8' }, raw: true });
  assert.equal(segment.status, 206); assert.equal(segment.headers.get('content-range'), `bytes 2-8/${audio.length}`); assert.equal(await segment.text(), '2345678');
  const suffix = await request('/media/sample-audio', { headers: { Range: 'bytes=-3' }, raw: true }); assert.equal(await suffix.text(), 'xyz');
  const head = await request('/media/sample-audio', { method: 'HEAD', raw: true }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), audio.length); assert.equal(await head.text(), '');
  const invalid = await request('/media/sample-audio', { headers: { Range: 'bytes=900-' }, raw: true }); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${audio.length}`);
  assert.throws(() => parseRange('bytes=0-2,4-7', audio.length), { status: 416 });
});

test('media rejects traversal paths, arbitrary files, untrusted hosts and foreign origins', async t => {
  const { request, directory } = await setup(t);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'assets.json'), 'utf8'));
  manifest.escape = { path: 'media/../../private.txt' }; manifest.database = { path: 'learning.sqlite' }; atomicJson(path.join(directory, 'assets.json'), manifest);
  assert.ok([400, 403].includes((await request('/media/escape')).status));
  assert.equal((await request('/media/database')).status, 403);
  assert.equal((await request('/api/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/health', { headers: { Origin: 'http://localhost:5173' } })).status, 200);
  assert.equal((await request('/api/health', { headers: { Host: 'evil.example' } })).status, 403);
});

test('timing editing validates bounds and order, keeps sentence identities, and backs up the original', async t => {
  const { request, paper, directory } = await setup(t);
  paper.passages[0].sentences[0].sourceParagraphId = 'original-paragraph-1';
  atomicJson(path.join(directory, 'papers', `${paper.id}.json`), paper);
  const payload = { passages: structuredClone(paper.passages), markVerified: true };
  delete payload.passages[0].sentences[0].sourceParagraphId;
  payload.passages[0].sentences[0].start = 3;
  const response = await request(`/api/papers/${paper.id}/timing`, { method: 'PUT', body: payload });
  assert.equal(response.status, 200); assert.equal(response.body.quality.timing, 'verified');
  assert.equal(response.body.passages[0].sentences[0].sourceParagraphId, 'original-paragraph-1', 'Proofreading preserves source paragraph translation linkage');
  assert.equal(readdirSync(path.join(directory, 'paper-backups')).length, 1);
  const invalid = structuredClone(payload); invalid.passages[0].sentences[0].end = 99;
  assert.equal((await request(`/api/papers/${paper.id}/timing`, { method: 'PUT', body: invalid })).status, 400);
  const unreviewed = structuredClone(payload); unreviewed.passages[0].sentences[0].reviewed = false;
  assert.equal((await request(`/api/papers/${paper.id}/timing`, { method: 'PUT', body: unreviewed })).status, 400);
  const removed = structuredClone(payload); removed.passages[0].sentences = [];
  assert.equal((await request(`/api/papers/${paper.id}/timing`, { method: 'PUT', body: removed })).status, 400);
  const changed = (await request(`/api/papers/${paper.id}`)).body;
  assert.equal(changed.passages[0].sentences[0].start, 3);
});

test('import deduplicates audio and preserves existing answers and notes', async t => {
  const { request, paper, directory } = await setup(t);
  const draft = (await request('/api/attempts', { method: 'POST', body: { paperId: paper.id } })).body;
  await request(`/api/attempts/${draft.id}`, { method: 'PATCH', body: { answers: { [paper.questions[0].id]: 'A' } } });
  const payload = { paper, audioBase64: audio.toString('base64'), audioName: 'same-audio.mp3' };
  assert.equal((await request('/api/import', { method: 'POST', body: payload })).status, 201);
  assert.equal((await request('/api/import', { method: 'POST', body: payload })).status, 201);
  assert.equal(readdirSync(path.join(directory, 'media')).length, 1);
  assert.equal((await request('/api/attempts')).body[0].answers[paper.questions[0].id], 'A');
  const destructive = structuredClone(paper); destructive.questions[0].id = 'new-unknown-question';
  assert.equal((await request('/api/import', { method: 'POST', body: { paper: destructive } })).status, 409);
});

test('complete ZIP includes records, papers and audio, and has valid stored-file CRCs', async t => {
  const { request, paper } = await setup(t);
  const response = await request('/api/backup/full', { raw: true });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await response.arrayBuffer());
  assert.equal(zip.length, Number(response.headers.get('content-length')));
  let offset = 0; const entries = new Map();
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const crc = zip.readUInt32LE(offset + 14), size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), extra = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extra, content = zip.subarray(start, start + size);
    assert.equal(crc32(content), crc); entries.set(name, content); offset = start + size;
  }
  assert.ok(entries.has('learning-records.json')); assert.ok(entries.has(`data/papers/${paper.id}.json`)); assert.deepEqual(entries.get('data/media/sample.mp3'), audio);
  assert.ok(![...entries.keys()].some(name => name.includes('sqlite')));
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});

test('UI compound annotation IDs support save, restore and deletion', async t => {
  const source = await setup(t), destination = await setup(t);
  const { paper } = source, sentenceId = paper.passages[0].sentences[0].id;
  const id = `${paper.id}:s:${sentenceId}`, encoded = encodeURIComponent(id);
  const result = await source.request(`/api/annotations/${encoded}`, { method: 'PUT', body: { paperId: paper.id, sentenceId, text: 'Needs another listen', favorite: true } });
  assert.equal(result.status, 200); assert.equal(result.body.id, id);
  const backup = (await source.request('/api/backup/export')).body;
  assert.equal((await destination.request('/api/backup/import', { method: 'POST', body: backup })).status, 200);
  assert.equal((await destination.request('/api/annotations')).body[0].id, id);
  assert.equal((await destination.request(`/api/annotations/${encoded}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await destination.request('/api/annotations')).body, []);
});

test('explicit complete proofreading verifies transcript and timing together, never unchecked sentences', async t => {
  const { request, paper, directory } = await setup(t);
  paper.quality.transcript = 'candidate'; paper.quality.timing = 'candidate';
  paper.passages.forEach(passage => passage.sentences.forEach(sentence => { sentence.reviewed = false; }));
  atomicJson(path.join(directory, 'papers', `${paper.id}.json`), paper);
  const payload = { passages: structuredClone(paper.passages), markVerified: true };
  assert.equal((await request(`/api/papers/${paper.id}/timing`, { method: 'PUT', body: payload })).status, 400);
  assert.equal((await request(`/api/papers/${paper.id}`)).body.quality.transcript, 'candidate');
  payload.passages.forEach(passage => passage.sentences.forEach(sentence => { sentence.reviewed = true; }));
  const checked = await request(`/api/papers/${paper.id}/timing`, { method: 'PUT', body: payload });
  assert.equal(checked.status, 200); assert.equal(checked.body.quality.transcript, 'verified'); assert.equal(checked.body.quality.timing, 'verified');
  const edited = await request(`/api/papers/${paper.id}/timing`, { method: 'PUT', body: { passages: payload.passages, markVerified: false } });
  assert.equal(edited.body.quality.transcript, 'candidate'); assert.equal(edited.body.quality.timing, 'candidate');
});

test('audio larger than twelve megabytes imports without regexp stack overflow', async t => {
  const { request, paper } = await setup(t);
  const audioBytes = Buffer.alloc(13 * 1024 * 1024, 0x55); audioBytes.write('ID3');
  const response = await request('/api/import', { method: 'POST', body: { paper, audioName: 'large-file.mp3', audioBase64: audioBytes.toString('base64') } });
  assert.equal(response.status, 201);
  const current = (await request(`/api/papers/${paper.id}`)).body;
  assert.equal(current.quality.timing, 'candidate', 'A different audio version invalidates the old timing review');
  assert.ok(current.passages.every(passage => passage.sentences.every(sentence => !sentence.reviewed)));
  const head = await request(`/media/${current.audioAssetId}`, { method: 'HEAD', raw: true });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), audioBytes.length);
});

test('all 27 collected real papers satisfy the import and candidate timing schema', localFixture('data/papers/cet6-2025-12-1.json'), () => {
  const corpusDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'papers');
  const files = readdirSync(corpusDirectory).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 27, 'Six complete target years plus 2026 supplement must stay present');
  for (const file of files) {
    const paper = JSON.parse(readFileSync(path.join(corpusDirectory, file), 'utf8'));
    assert.doesNotThrow(() => validatePaper(paper), file);
    assert.equal(paper.questions.length, 25, file);
    assert.equal(paper.passages.length, 7, file);
  }
});
