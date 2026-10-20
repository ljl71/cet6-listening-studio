import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, atomicJson } from '../server/store.mjs';
import { createServer } from '../server/index.mjs';
import { localFixture } from './local-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/.test-temp');
mkdirSync(ROOT, { recursive: true });
const now = () => new Date('2026-10-20T12:00:00Z');
const paperId = 'paper-one', oldId = 'sentence-old', keptId = 'sentence-kept';
const oldAnnotationId = `${paperId}:s:${oldId}`, keptAnnotationId = `${paperId}:s:${keptId}`;
const annotation = (id, sentenceId, text, favorite = false, reason = '') => ({ id, paperId, sentenceId, text, favorite, reason, updatedAt: '2026-10-19T12:00:00Z' });
const progress = () => ({ paperId, position: 17.125, rate: 0.9, sentenceId: oldId, loopMode: 'sentence', updatedAt: '2026-10-19T12:00:00Z' });
const ownedDirectories = [];
after(() => {
  for (const result of ownedDirectories) {
    const resolved = path.resolve(result);
    assert.ok(resolved.startsWith(ROOT + path.sep) && path.basename(resolved).startsWith('cet6-alias-'));
    rmSync(resolved, { recursive: true, force: true });
  }
});
function directory(t) {
  const result = mkdtempSync(path.join(ROOT, 'cet6-alias-'));
  ownedDirectories.push(result);
  return result;
}
function aliases(dir, extra = []) {
  atomicJson(path.join(dir, 'sentence-aliases.json'), { format: 'cet6-sentence-aliases', schemaVersion: 1,
    aliases: [{ paperId, fromSentenceId: oldId, toSentenceId: keptId }, ...extra] });
}
function backupInput(annotations = [], playProgress = []) {
  return { format: 'cet6-listening-studio', schemaVersion: 1, exportedAt: now().toISOString(), attempts: [],
    progress: playProgress, annotations, stats: { listeningSeconds: 0, byPaper: {} } };
}

test('startup backs up original records, merges both notes and reasons, and only changes the progress sentence', t => {
  const dir = directory(t);
  let store = createStore({ dataDir: dir, now, automaticBackup: false });
  const first = annotation(oldAnnotationId, oldId, '旧句：连读需要重听', true, '连读没听清');
  const second = annotation(keptAnnotationId, keptId, '保留句：补充词义', false, '词汇不认识');
  const unaffected = annotation('unrelated-note', 'sentence-other', '完全不改动的记录', false, '定位错误');
  store.put('annotation', first.id, first); store.put('annotation', second.id, second); store.put('annotation', unaffected.id, unaffected);
  store.put('progress', paperId, progress()); store.addListening(paperId, 13.5); store.close();
  aliases(dir);
  store = createStore({ dataDir: dir, now, automaticBackup: false });
  const merged = store.get('annotation', keptAnnotationId);
  assert.equal(store.list('annotation').length, 2);
  assert.equal(store.get('annotation', oldAnnotationId), null);
  assert.ok(merged.text.includes('历史合并'));
  assert.deepEqual(new Set(merged.sentenceAliasMerge.noteTexts), new Set([first.text, second.text]));
  assert.equal(merged.favorite, true);
  assert.ok(merged.reason.includes(first.reason) && merged.reason.includes(second.reason));
  assert.deepEqual(store.get('annotation', unaffected.id), unaffected);
  assert.deepEqual(store.get('progress', paperId), { ...progress(), sentenceId: keptId });
  assert.equal(store.stats().listeningSeconds, 13.5);
  const snapshots = readdirSync(store.backupDir).filter(name => name.startsWith('before-sentence-alias-migration-'));
  assert.equal(snapshots.length, 1);
  const original = JSON.parse(readFileSync(path.join(store.backupDir, snapshots[0]), 'utf8'));
  assert.ok(original.annotations.some(row => row.id === oldAnnotationId && row.text === first.text));
  assert.deepEqual(original.progress[0], progress());
  assert.equal(store.exportRecords().sentenceAliasMigrations.length, 1);
  assert.equal(store.migrateSentenceAliases().changed, false);
  const records = store.exportRecords(); store.close();
  store = createStore({ dataDir: dir, now, automaticBackup: false });
  assert.deepEqual(store.exportRecords(), records);
  assert.equal(readdirSync(store.backupDir).length, 1);
  store.close();
});

test('old backup import preserves a newer destination note and stays idempotent across repeated restoration', t => {
  const dir = directory(t); aliases(dir);
  const store = createStore({ dataDir: dir, now, automaticBackup: false }); t.after(() => store.close());
  const current = { ...annotation(keptAnnotationId, keptId, '现在已有的新句笔记', false, '理解错误'), updatedAt: '2026-10-20T11:00:00Z' };
  store.put('annotation', current.id, current);
  const legacy = backupInput([annotation(oldAnnotationId, oldId, '旧备份的句子笔记', true, '定位错误'),
    annotation('another-old-id', oldId, '旧备份的句子笔记', false, '定位错误')], [progress()]);
  store.importRecords(legacy);
  let merged = store.get('annotation', keptAnnotationId);
  assert.equal(store.list('annotation').length, 1);
  assert.equal(merged.sentenceAliasMerge.noteTexts.length, 2);
  assert.equal(merged.favorite, true);
  assert.equal(merged.sentenceAliasMerge.reasons.length, 2);
  assert.equal(merged.sentenceAliasMerge.sourceAnnotations.length, 3);
  const exported = store.exportRecords();
  store.importRecords(legacy); store.migrateSentenceAliases();
  assert.deepEqual(store.exportRecords(), exported);
  const before = readdirSync(store.backupDir).filter(name => name.startsWith('before-import-')).map(name => JSON.parse(readFileSync(path.join(store.backupDir, name), 'utf8')));
  assert.ok(before.some(snapshot => snapshot.annotations.length === 1 && snapshot.annotations[0].text === current.text));
  assert.deepEqual(store.get('progress', paperId), { ...progress(), sentenceId: keptId });
  merged = store.get('annotation', keptAnnotationId);
  assert.equal(merged.text.match(/旧备份的句子笔记/g).length, 1);
});

test('migration uses one transaction and retains the original backup if a database write fails', t => {
  const dir = directory(t); aliases(dir);
  const store = createStore({ dataDir: dir, now, automaticBackup: false }); t.after(() => store.close());
  const original = annotation(oldAnnotationId, oldId, '回滚后仍保留', true, '定位错误');
  store.put('annotation', original.id, original); store.put('progress', paperId, progress());
  store.db.exec("CREATE TRIGGER reject_alias_audit BEFORE INSERT ON records WHEN NEW.kind='sentence-alias-migration' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END;");
  assert.throws(() => store.migrateSentenceAliases(), /simulated audit failure/);
  assert.deepEqual(store.get('annotation', oldAnnotationId), original);
  assert.equal(store.get('annotation', keptAnnotationId), null);
  assert.deepEqual(store.get('progress', paperId), progress());
  assert.equal(store.exportRecords().sentenceAliasMigrations.length, 0);
  assert.ok(readdirSync(store.backupDir).some(name => name.startsWith('before-sentence-alias-migration-')));
});

test('unmapped records remain untouched and alias chains resolve to the final sentence', t => {
  const dir = directory(t);
  const store = createStore({ dataDir: dir, now, automaticBackup: false });
  const original = annotation(oldAnnotationId, oldId, '没有别名就不迁移', false, '定位错误');
  store.put('annotation', original.id, original); store.put('progress', paperId, progress());
  assert.equal(store.migrateSentenceAliases().changed, false);
  assert.deepEqual(store.get('annotation', original.id), original);
  assert.equal(readdirSync(store.backupDir).length, 0); store.close();
  aliases(dir, [{ paperId, fromSentenceId: keptId, toSentenceId: 'sentence-final' }]);
  const migrated = createStore({ dataDir: dir, now, automaticBackup: false });
  assert.equal(migrated.list('annotation')[0].sentenceId, 'sentence-final');
  assert.equal(migrated.get('progress', paperId).sentenceId, 'sentence-final'); migrated.close();
  aliases(dir, [{ paperId, fromSentenceId: keptId, toSentenceId: oldId }]);
  assert.throws(() => createStore({ dataDir: dir, now, automaticBackup: false }), /循环/);
});

test('legacy API writes resolve aliases, preserve merged history during edits, and support the old deletion key', async t => {
  const dir = directory(t); aliases(dir);
  atomicJson(path.join(dir, 'papers', `${paperId}.json`), { id: paperId, duration: 80, passages: [{ id: 'passage', sentences: [{ id: keptId }] }], questions: [] });
  const server = createServer({ dataDir: dir, automaticBackup: false, now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (route, body, method = 'PUT') => { const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  const played = await send(`/api/progress/${paperId}`, progress());
  assert.equal(played.status, 200); assert.equal(played.data.sentenceId, keptId); assert.equal(played.data.position, progress().position);
  const saved = await send(`/api/annotations/${encodeURIComponent(oldAnnotationId)}`, annotation(oldAnnotationId, oldId, '旧窗口刚保存的笔记', true));
  assert.equal(saved.status, 200); assert.equal(saved.data.id, keptAnnotationId); assert.equal(saved.data.sentenceId, keptId);
  const edited = await send(`/api/annotations/${encodeURIComponent(keptAnnotationId)}`, { ...saved.data, text: '后来主动编辑的笔记' });
  assert.equal(edited.data.text, '后来主动编辑的笔记');
  assert.deepEqual(edited.data.sentenceAliasMerge, saved.data.sentenceAliasMerge);
  assert.equal((await send(`/api/annotations/${encodeURIComponent(oldAnnotationId)}`, undefined, 'DELETE')).status, 200);
  assert.deepEqual(server.app.store.list('annotation'), []);
});

test('all published sentence aliases point to existing sentences in the correct real paper', localFixture('data/sentence-aliases.json', 'data/papers'), () => {
  const dataDir = path.resolve(ROOT, '../../data');
  const manifest = JSON.parse(readFileSync(path.join(dataDir, 'sentence-aliases.json'), 'utf8'));
  assert.equal(manifest.aliases.length, 24);
  for (const entry of manifest.aliases) {
    const paper = JSON.parse(readFileSync(path.join(dataDir, 'papers', `${entry.paperId}.json`), 'utf8'));
    const ids = new Set(paper.passages.flatMap(p => p.sentences.map(s => s.id)));
    assert.ok(ids.has(entry.toSentenceId)); assert.ok(!ids.has(entry.fromSentenceId));
  }
});
