import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import assert from 'node:assert/strict';
import { createServer, safeFile } from './index.mjs';
import { crc32 } from './zip.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RECORD_KEYS = ['format', 'schemaVersion', 'attempts', 'progress', 'annotations', 'stats'];
const comparableRecords = records => ({ ...Object.fromEntries(RECORD_KEYS.map(key => [key, records[key]])), sentenceAliasMigrations: records.sentenceAliasMigrations || [] });

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length); let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error('ZIP 意外结束'); offset += bytesRead;
  }
  return buffer;
}

/** Inspect local headers, the complete central directory and EOCD without
 * reading multi-gigabyte entry bodies. Full extraction separately checks CRC. */
export async function inspectStoredZip(zipFile) {
  const handle = await fs.open(zipFile, 'r');
  try {
    const bytes = (await handle.stat()).size;
    assert.ok(bytes >= 22, 'ZIP has an end record');
    const eocd = await readExactly(handle, 22, bytes - 22);
    assert.equal(eocd.readUInt32LE(), 0x06054b50, 'ZIP end record');
    assert.equal(eocd.readUInt16LE(4), 0, 'Single-disk ZIP');
    assert.equal(eocd.readUInt16LE(6), 0, 'Single central-directory disk');
    assert.equal(eocd.readUInt16LE(8), eocd.readUInt16LE(10), 'Entry counts agree');
    assert.equal(eocd.readUInt16LE(20), 0, 'No trailing ZIP comment');
    const count = eocd.readUInt16LE(10), centralSize = eocd.readUInt32LE(12), centralOffset = eocd.readUInt32LE(16);
    assert.equal(centralOffset + centralSize, bytes - 22, 'Central directory ends at EOCD');
    const names = new Set(), entries = []; let position = centralOffset, nextLocal = 0;
    for (let index = 0; index < count; index++) {
      const header = await readExactly(handle, 46, position);
      assert.equal(header.readUInt32LE(), 0x02014b50, 'Central-directory signature');
      const nameLength = header.readUInt16LE(28), extraLength = header.readUInt16LE(30), commentLength = header.readUInt16LE(32);
      const nameBytes = await readExactly(handle, nameLength, position + 46), name = nameBytes.toString('utf8');
      assert.ok(name && !name.includes('\\') && !name.startsWith('/') && !name.includes('\0') && !name.split('/').includes('..') && !/^[A-Za-z]:/.test(name), 'Safe ZIP entry name');
      assert.ok(!names.has(name), 'Unique ZIP entry names'); names.add(name);
      const size = header.readUInt32LE(24), checksum = header.readUInt32LE(16), localOffset = header.readUInt32LE(42);
      assert.equal(header.readUInt16LE(10), 0, 'Stored entry');
      assert.equal(header.readUInt16LE(8) & 8, 0, 'Known entry size');
      assert.equal(header.readUInt32LE(20), size, 'Stored entry sizes agree');
      assert.equal(localOffset, nextLocal, 'Local entries contiguous and in central-directory order');
      const local = await readExactly(handle, 30, localOffset);
      assert.equal(local.readUInt32LE(), 0x04034b50, 'Local-file header');
      assert.equal(local.readUInt16LE(8), 0, 'Stored local entry');
      assert.equal(local.readUInt32LE(14), checksum, 'Local and central CRC agree');
      assert.equal(local.readUInt32LE(18), size); assert.equal(local.readUInt32LE(22), size);
      assert.equal(local.readUInt16LE(26), nameLength);
      assert.deepEqual(await readExactly(handle, nameLength, localOffset + 30), nameBytes, 'Local and central names agree');
      nextLocal = localOffset + 30 + nameLength + local.readUInt16LE(28) + size;
      assert.ok(nextLocal <= centralOffset, 'Entry body remains before central directory');
      entries.push({ name, size, crc32: checksum });
      position += 46 + nameLength + extraLength + commentLength;
    }
    assert.equal(position, bytes - 22, 'Entire central directory consumed');
    assert.equal(nextLocal, centralOffset, 'No unexplained bytes before central directory');
    return { bytes, entries: count, uncompressedBytes: entries.reduce((sum, entry) => sum + entry.size, 0), centralOffset, centralSize,
      entryIndexSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), files: entries };
  } finally { await handle.close(); }
}

/** Extract our server's stored ZIP without loading the audio archive into RAM. */
async function extractStoredZip(zipFile, destination) {
  const handle = await fs.open(zipFile, 'r');
  const zipSize = (await handle.stat()).size;
  const entries = []; let position = 0;
  try {
    while (position + 4 <= zipSize) {
      const signature = (await readExactly(handle, 4, position)).readUInt32LE();
      if (signature === 0x02014b50 || signature === 0x06054b50) break;
      assert.equal(signature, 0x04034b50, 'ZIP local-file header');
      const header = await readExactly(handle, 30, position);
      const method = header.readUInt16LE(8), flags = header.readUInt16LE(6);
      assert.equal(method, 0, 'Exported ZIP uses stored files'); assert.equal(flags & 8, 0, 'Known sizes in local header');
      const expectedCrc = header.readUInt32LE(14), compressedSize = header.readUInt32LE(18), size = header.readUInt32LE(22);
      assert.equal(compressedSize, size);
      const nameLength = header.readUInt16LE(26), extraLength = header.readUInt16LE(28);
      const name = (await readExactly(handle, nameLength, position + 30)).toString('utf8');
      if (name.includes('\\') || name.startsWith('/') || name.includes('\0') || name.split('/').some(part => part === '..') || /^[A-Za-z]:/.test(name)) throw new Error(`不安全的 ZIP 路径：${name}`);
      const output = path.resolve(destination, name), relative = path.relative(destination, output);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('ZIP 文件超出测试目录');
      const start = position + 30 + nameLength + extraLength;
      assert.ok(start + size <= zipSize, 'ZIP entry fits archive bounds');
      await fs.mkdir(path.dirname(output), { recursive: true });
      let actualCrc = 0;
      if (size) {
        const checksum = new Transform({ transform(chunk, _encoding, callback) { actualCrc = crc32(chunk, actualCrc); callback(null, chunk); } });
        await pipeline(createReadStream(zipFile, { start, end: start + size - 1 }), checksum, createWriteStream(output, { flags: 'wx' }));
      } else await fs.writeFile(output, Buffer.alloc(0), { flag: 'wx' });
      assert.equal(actualCrc, expectedCrc, `ZIP CRC ${name}`);
      entries.push({ name, size }); position = start + size;
    }
    const eocd = await readExactly(handle, 22, zipSize - 22);
    assert.equal(eocd.readUInt32LE(), 0x06054b50, 'ZIP end record');
    assert.equal(entries.length, eocd.readUInt16LE(10), 'ZIP entry count');
    return entries;
  } finally { await handle.close(); }
}

export async function verifyFullBackup({ productionUrl = 'http://127.0.0.1:3260', archiveFile, sourceDataDir = path.join(ROOT, 'data') } = {}) {
  await fs.mkdir(path.join(ROOT, 'runtime'), { recursive: true });
  await fs.mkdir(path.join(ROOT, 'docs'), { recursive: true });
  const temporaryRoot = await fs.mkdtemp(path.join(ROOT, 'runtime', 'full-backup-check-'));
  // An existing UI download belongs to the caller. Cleanup only ever removes
  // this helper's separately created extraction directory.
  const zipFile = archiveFile ? path.resolve(archiveFile) : path.join(temporaryRoot, 'complete-backup.zip'), restoredRoot = path.join(temporaryRoot, 'restored');
  await fs.mkdir(restoredRoot);
  const reportFile = path.join(ROOT, 'docs', 'full-backup-check.json');
  const report = { startedAt: new Date().toISOString(), productionUrl, productionMethods: ['GET'], archiveSource: archiveFile ? 'caller-supplied-native-browser-download' : 'HTTP-GET-stream', temporaryRoot, zipFile, restoredDataDir: path.join(restoredRoot, 'data'), checks: {}, status: 'running' };
  let server;
  const getJson = async (url, options) => { const response = await fetch(url, options); if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`); return response.json(); };
  try {
    console.log('读取生产资料目录与学习记录快照（仅读取）…');
    const productionHealth = await getJson(`${productionUrl}/api/health`);
    const productionRecords = await getJson(`${productionUrl}/api/backup/export`);
    let sourceAliasBytes = null;
    try { sourceAliasBytes = await fs.readFile(path.join(sourceDataDir, 'sentence-aliases.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const productionPapers = await getJson(`${productionUrl}/api/papers`), paperSnapshots = new Map();
    for (const summary of productionPapers) paperSnapshots.set(summary.id, await getJson(`${productionUrl}/api/papers/${encodeURIComponent(summary.id)}`));
    report.productionPaperHashes = Object.fromEntries([...paperSnapshots].map(([id, paper]) => [id, createHash('sha256').update(JSON.stringify(paper)).digest('hex')]));
    assert.equal(productionHealth.corpus.total, 27);
    report.productionSnapshot = { corpus: productionHealth.corpus, attempts: productionRecords.attempts.length, annotations: productionRecords.annotations.length, progress: productionRecords.progress.length, listeningSeconds: productionRecords.stats.listeningSeconds };
    if (!archiveFile) {
      console.log('通过完整备份接口下载 ZIP…');
      const response = await fetch(`${productionUrl}/api/backup/full`, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error(`导出完整备份 HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(zipFile, { flags: 'wx' }));
      assert.equal((await fs.stat(zipFile)).size, Number(response.headers.get('content-length')), 'Downloaded ZIP matches advertised size');
    } else console.log('使用浏览器原生下载已完整落盘的 ZIP（不重新下载）…');
    report.zipBytes = (await fs.stat(zipFile)).size; report.zipMegabytes = +(report.zipBytes / 1024 / 1024).toFixed(2);
    const { files: _files, ...structure } = await inspectStoredZip(zipFile);
    report.zipStructure = structure; report.checks.zipStructure = true;
    report.checks.exportDownload = true;
    console.log(`ZIP 下载完成 ${report.zipMegabytes} MiB，解压并逐文件检查 CRC…`);
    const entries = await extractStoredZip(zipFile, restoredRoot);
    report.extractedEntries = entries.length; report.checks.zipCrc = true;
    const archivedRecords = JSON.parse(await fs.readFile(path.join(restoredRoot, 'learning-records.json'), 'utf8'));
    // A live paused browser may update progress.updatedAt while the ZIP is being
    // streamed. Compare the exported archive to its restore exactly, and compare
    // meaningful learning content to the earlier read-only production snapshot.
    const meaningful = records => ({ ...comparableRecords(records), progress: records.progress.map(({ updatedAt, ...progress }) => progress) });
    if (archiveFile) {
      assert.deepEqual(comparableRecords(archivedRecords), comparableRecords(productionRecords), 'Native ZIP and frozen QA source match every record field');
      report.checks.exactSourceLearningRecords = true;
    } else assert.deepEqual(meaningful(archivedRecords), meaningful(productionRecords), 'ZIP contains the same production learning content');
    const dataDir = path.join(restoredRoot, 'data');
    server = createServer({ dataDir, distDir: path.join(ROOT, 'dist'), automaticBackup: false });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const restoredUrl = `http://127.0.0.1:${server.address().port}`;
    report.restoredPort = server.address().port;
    await getJson(`${restoredUrl}/api/backup/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(archivedRecords) });
    const restoredRecords = await getJson(`${restoredUrl}/api/backup/export`);
    assert.deepEqual(comparableRecords(restoredRecords), comparableRecords(archivedRecords), 'Restored records match the ZIP exactly');
    report.checks.recordsRestore = true;
    const summaries = await getJson(`${restoredUrl}/api/papers`), restoredHealth = await getJson(`${restoredUrl}/api/health`);
    assert.equal(summaries.length, 27); assert.equal(summaries.reduce((total, paper) => total + paper.questionCount, 0), 675);
    for (const summary of summaries) assert.deepEqual(await getJson(`${restoredUrl}/api/papers/${encodeURIComponent(summary.id)}`), paperSnapshots.get(summary.id), `Restored complete paper/text/timing matches production ${summary.id}`);
    report.checks.paperContentAndTimingRestore = true;
    assert.deepEqual(restoredHealth.corpus, productionHealth.corpus, 'Restored corpus coverage and quality match production');
    report.corpus = { papers: summaries.length, questions: summaries.reduce((total, paper) => total + paper.questionCount, 0), passages: summaries.reduce((total, paper) => total + paper.passageCount, 0), ready: restoredHealth.corpus.ready };
    report.checks.corpusRestore = true;
    console.log('恢复服务已读取27套675题，核验全部本地音频 SHA-256 与 Range…');
    const assets = JSON.parse(await fs.readFile(path.join(dataDir, 'assets.json'), 'utf8'));
    report.assets = [];
    for (const [assetId, asset] of Object.entries(assets)) {
      const file = safeFile(dataDir, asset.path), hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
      const sha256 = hash.digest('hex'); assert.equal(sha256, asset.sha256, `Audio checksum ${assetId}`); assert.equal(bytes, asset.size, `Audio size ${assetId}`);
      const range = await fetch(`${restoredUrl}/media/${encodeURIComponent(assetId)}`, { headers: { Range: 'bytes=0-31' } });
      assert.equal(range.status, 206, `Restored media Range ${assetId}`); assert.equal((await range.arrayBuffer()).byteLength, 32);
      report.assets.push({ assetId, bytes, sha256, verified: true });
    }
    assert.equal(report.assets.length, 27);
    report.checks.assetSha256 = true; report.checks.restoredMediaRange = true;
    const aliasFile = path.join(dataDir, 'sentence-aliases.json');
    try { const aliases = JSON.parse(await fs.readFile(aliasFile, 'utf8')); report.sentenceAliases = { mappings: aliases.aliases.length,
      sha256: createHash('sha256').update(await fs.readFile(aliasFile)).digest('hex') };
      if (sourceAliasBytes) assert.deepEqual(await fs.readFile(aliasFile), sourceAliasBytes, 'Restored alias manifest exactly matches the source mapping');
      report.checks.sentenceAliasManifestRestore = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; report.sentenceAliases = { mappings: 0, note: 'No sentence alias manifest in this archive.' }; }
    report.learningRecords = { attempts: restoredRecords.attempts.length, progress: restoredRecords.progress.length, annotations: restoredRecords.annotations.length, listeningSeconds: restoredRecords.stats.listeningSeconds, sentenceAliasMigrations: restoredRecords.sentenceAliasMigrations?.length || 0 };
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
  finally {
    if (server) await new Promise(resolve => server.close(resolve));
    // This is the exact directory created by mkdtemp above. Refuse cleanup if
    // either its resolved parent or its unique basename has changed.
    try {
      const runtimeRoot = await fs.realpath(path.join(ROOT, 'runtime'));
      const resolvedTemporaryRoot = await fs.realpath(temporaryRoot);
      assert.equal(path.dirname(resolvedTemporaryRoot), runtimeRoot, 'Cleanup stays directly inside this workspace runtime');
      assert.match(path.basename(resolvedTemporaryRoot), /^full-backup-check-[A-Za-z0-9]+$/, 'Cleanup targets only this run\'s dedicated directory');
      report.cleanup = { resolvedTemporaryRoot, runtimeRoot, pathVerified: true };
      await fs.rm(resolvedTemporaryRoot, { recursive: true, force: true });
      report.cleanup.removed = true;
    } catch (error) { report.cleanup = { removed: false, error: error.message }; report.status = 'failed'; }
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ status: report.status, zipBytes: report.zipBytes, zipMegabytes: report.zipMegabytes, corpus: report.corpus, assets: report.assets?.length, checks: report.checks, reportFile, temporaryRoot }, null, 2));
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await verifyFullBackup();
