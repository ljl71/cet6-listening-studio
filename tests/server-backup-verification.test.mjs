import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { writeZip } from '../server/zip.mjs';
import { inspectStoredZip } from '../server/verify-full-backup.mjs';

const TEMP = fileURLToPath(new URL('../server/.test-temp/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(TEMP, { recursive: true });
  const directory = await fs.mkdtemp(path.join(TEMP, 'zip-inspection-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory), parent = await fs.realpath(TEMP);
    assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^zip-inspection-[A-Za-z0-9]+$/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const chunks = [], sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  sink.writeHead = status => assert.equal(status, 200);
  const finished = once(sink, 'finish');
  await writeZip(sink, [{ name: 'learning-records.json', data: Buffer.from('{"attempts":[]}') }, { name: 'data/中文/empty.txt', data: Buffer.alloc(0) }]);
  await finished;
  const bytes = Buffer.concat(chunks), file = path.join(directory, 'sample.zip'); await fs.writeFile(file, bytes);
  return { file, bytes };
}

test('large-export inspector reads native stored ZIP structure including empty and Chinese entries', async t => {
  const { file, bytes } = await fixture(t), result = await inspectStoredZip(file);
  assert.equal(result.bytes, bytes.length); assert.equal(result.entries, 2);
  assert.deepEqual(result.files.map(({ name, size }) => ({ name, size })), [
    { name: 'learning-records.json', size: 15 }, { name: 'data/中文/empty.txt', size: 0 },
  ]);
  assert.match(result.entryIndexSha256, /^[a-f0-9]{64}$/);
});

test('ZIP structural inspection rejects a truncated native download and mismatched directory metadata', async t => {
  const { file, bytes } = await fixture(t);
  await fs.writeFile(file, bytes.subarray(0, bytes.length - 1));
  await assert.rejects(inspectStoredZip(file), /ZIP end record/);
  const changed = Buffer.from(bytes), central = changed.readUInt32LE(changed.length - 22 + 16);
  changed.writeUInt32LE(changed.readUInt32LE(central + 16) ^ 1, central + 16);
  await fs.writeFile(file, changed);
  await assert.rejects(inspectStoredZip(file), /Local and central CRC agree/);
});
