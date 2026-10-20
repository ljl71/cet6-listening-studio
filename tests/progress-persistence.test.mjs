import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressPersistence } from '../src/progressPersistence.ts';

const progress = (overrides = {}) => ({ paperId: 'paper-a', position: 17.125, rate: 1.25, sentenceId: 'sentence-a', loopMode: 'off', updatedAt: '2026-10-20T00:00:00.000Z', ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('confirmed progress skips timestamp-only writes while preserving exact position precision and normalized empty fields', async () => {
  const sent = [], manager = createProgressPersistence(async row => { sent.push(row); }, error => { throw error; });
  manager.initialize([progress({ sentenceId: undefined, loopMode: undefined })]);
  await manager.save(progress({ sentenceId: null, updatedAt: '2026-10-20T01:00:00.000Z' }));
  assert.equal(sent.length, 0);
  await manager.save(progress({ sentenceId: undefined, position: 17.125000001 }));
  assert.equal(sent.length, 1); assert.equal(sent[0].position, 17.125000001);
});

test('queued saves compare only after the prior real send succeeds, collapsing duplicate pause/ticker writes', async () => {
  const gate = deferred(), started = deferred(), sent = [], failures = [];
  const manager = createProgressPersistence(async row => { sent.push(row); if (sent.length === 1) { started.resolve(); await gate.promise; } }, error => failures.push(error));
  const row = progress(), first = manager.save(row); await started.promise;
  const duplicate = manager.save({ ...row, updatedAt: '2026-10-20T01:00:00.000Z' });
  const later = manager.save(progress({ position: 19, rate: .9 }));
  row.position = 999;
  assert.equal(sent.length, 1); gate.resolve(); await Promise.all([first, duplicate, later]);
  assert.deepEqual(sent.map(row => [row.position, row.rate]), [[17.125, 1.25], [19, .9]]);
  assert.deepEqual(failures, []);
});

test('a failed send is never marked successful and an already queued duplicate retries it', async () => {
  const gate = deferred(), started = deferred(), sent = [], failures = [];
  const manager = createProgressPersistence(async row => {
    sent.push(row); if (sent.length === 1) { started.resolve(); await gate.promise; throw new Error('offline'); }
  }, error => failures.push(error.message));
  const first = manager.save(progress()); await started.promise;
  const retry = manager.save(progress({ updatedAt: '2026-10-20T01:00:00.000Z' })); gate.resolve();
  await Promise.all([first, retry]); await manager.save(progress());
  assert.equal(sent.length, 2); assert.deepEqual(failures, ['offline']);
});

test('later stale props cannot replace a successful key, while an explicit restore resets it and pagehide keeps prompt flush', async () => {
  const sent = [], manager = createProgressPersistence(async (row, immediate) => sent.push({ ...row, immediate }), error => { throw error; });
  manager.initialize([progress({ position: 1 })]); await manager.save(progress({ position: 2 }));
  manager.initialize([progress({ position: 1 })]); await manager.save(progress({ position: 2 }));
  assert.equal(sent.length, 1);
  manager.reset([progress({ position: 9 })]); await manager.save(progress({ position: 9 })); assert.equal(sent.length, 1);
  await manager.save(progress({ position: 10 }), true); assert.equal(sent.length, 2); assert.equal(sent[1].immediate, true);
  await manager.save(progress({ position: 10 }), true); assert.equal(sent.length, 2);
  await manager.save(progress({ paperId: 'paper-b', position: 10 })); assert.equal(sent.length, 3);
});
