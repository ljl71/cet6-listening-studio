// No browser or export runs without all three explicit flags below. This is a
// focused acceptance of native multi-gigabyte UI downloads, not another player test.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discover, launchContext, openPaper } from './browser-acceptance.mjs';
import { createServer } from './index.mjs';
import { inspectStoredZip, verifyFullBackup } from './verify-full-backup.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
async function api(base, route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${route}: HTTP ${response.status} ${response.ok ? '' : await response.text()}`);
  return response.json();
}

async function seedLearningRecords(base, dataDir) {
  const paper = await api(base, '/api/papers/cet6-2025-12-1'), other = await api(base, '/api/papers/cet6-2020-07-1');
  const attempt = await api(base, '/api/attempts', 'POST', { paperId: paper.id });
  const wrong = ['A', 'B', 'C', 'D'].find(option => option !== paper.questions[1].answer);
  await api(base, `/api/attempts/${attempt.id}`, 'PATCH', { answers: { [paper.questions[0].id]: paper.questions[0].answer, [paper.questions[1].id]: wrong } });
  const graded = await api(base, `/api/attempts/${attempt.id}/submit`, 'POST');
  assert.equal(graded.result.correct, 1); assert.equal(graded.result.unanswered, 23);
  const draft = await api(base, '/api/attempts', 'POST', { paperId: other.id });
  await api(base, `/api/attempts/${draft.id}`, 'PATCH', { answers: { [other.questions[0].id]: 'C' } });
  for (const [item, position, rate] of [[paper, 38, 1.25], [other, 75, .9]]) await api(base, `/api/progress/${item.id}`, 'PUT', { position, rate, sentenceId: item.passages[0].sentences[0].id, loopMode: 'off' });
  const sentence = paper.passages[0].sentences[0];
  await api(base, `/api/annotations/${encodeURIComponent(`${paper.id}:s:${sentence.id}`)}`, 'PUT', { paperId: paper.id, sentenceId: sentence.id, text: '完整备份验收：这句的连读需要再听。中文笔记应完整恢复。', favorite: true, reason: '连读没听清' });
  await api(base, `/api/annotations/${encodeURIComponent(`${paper.id}:q:${paper.questions[1].id}`)}`, 'PUT', { paperId: paper.id, questionId: paper.questions[1].id, text: '错题定位笔记：保留整段上下文。', favorite: false, reason: '定位错误' });
  const alias = (await json(path.join(dataDir, 'sentence-aliases.json'))).aliases[0];
  assert.ok(alias, 'Canonical aliases available for history restoration fixture');
  const existing = await api(base, '/api/backup/export'), timestamp = '2026-10-20T08:00:00.000Z';
  const notes = [
    { id: `${alias.paperId}:s:${alias.fromSentenceId}`, paperId: alias.paperId, sentenceId: alias.fromSentenceId, text: '旧句收藏：合并以前的中文笔记。', favorite: true, reason: '词汇不认识', updatedAt: timestamp },
    { id: `${alias.paperId}:s:${alias.toSentenceId}`, paperId: alias.paperId, sentenceId: alias.toSentenceId, text: '保留句笔记：两段历史文字都应在恢复后存在。', favorite: false, reason: '理解错误', updatedAt: timestamp },
  ];
  // Importing an actual legacy shape exercises the production alias migration;
  // do not manufacture its derived provenance fields directly.
  await api(base, '/api/backup/import', 'POST', { ...existing, annotations: [...existing.annotations, ...notes], progress: [...existing.progress,
    { paperId: alias.paperId, sentenceId: alias.fromSentenceId, position: 100, rate: 1.5, loopMode: 'off', updatedAt: timestamp }] });
  const after = await api(base, '/api/backup/export'), merged = after.annotations.find(note => note.paperId === alias.paperId && note.sentenceId === alias.toSentenceId);
  assert.ok(merged?.sentenceAliasMerge?.sourceAnnotations.length >= 2); assert.ok(merged.text.includes('旧句收藏') && merged.text.includes('保留句笔记'));
  assert.ok(after.sentenceAliasMigrations.length > 0);
  return { paperId: paper.id, submittedAttemptId: graded.id, submittedResult: graded.result, draftAttemptId: draft.id,
    aliasFixture: { paperId: alias.paperId, fromSentenceId: alias.fromSentenceId, toSentenceId: alias.toSentenceId, sourceAnnotations: merged.sentenceAliasMerge.sourceAnnotations.length },
    note: 'Only the isolated QA database is seeded. Listening time is added later by observed real audio playback, never synthetic API seconds.' };
}

/** Match the production export's exclusions, but give QA a fresh SQLite DB.
 * JSON/text is copied. Binary artifacts are immutable in this GET-only test,
 * so hard links avoid an unnecessary second multi-gigabyte source copy. */
export async function prepareCompleteData(destination) {
  const source = path.join(ROOT, 'data');
  const fixture = { files: 0, bytes: 0, copiedFiles: 0, linkedFiles: 0, sourceReadOnly: true, database: 'new independent SQLite database' };
  async function copy(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (!prefix && ['backups', 'learning.sqlite', 'learning.sqlite-wal', 'learning.sqlite-shm'].includes(entry.name)) continue;
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const from = path.join(source, relative), to = path.join(destination, relative);
      if (entry.isDirectory()) { await fs.mkdir(to, { recursive: true }); await copy(from, relative); continue; }
      if (!entry.isFile() || entry.name.endsWith('.tmp') || entry.name.endsWith('.part')) continue;
      await fs.mkdir(path.dirname(to), { recursive: true });
      if (/\.(?:json|jsonl|txt|md|csv|html?|vtt|srt|xml)$/i.test(entry.name)) {
        await fs.copyFile(from, to); fixture.copiedFiles++;
      } else {
        try { await fs.link(from, to); fixture.linkedFiles++; }
        catch { await fs.copyFile(from, to); fixture.copiedFiles++; }
      }
      fixture.files++; fixture.bytes += (await fs.stat(to)).size;
    }
  }
  await fs.mkdir(destination, { recursive: true }); await copy(source);
  fixture.paperCount = (await fs.readdir(path.join(destination, 'papers'))).filter(name => name.endsWith('.json')).length;
  fixture.assetCount = Object.keys(await json(path.join(destination, 'assets.json'))).length;
  assert.equal(fixture.paperCount, 27); assert.equal(fixture.assetCount, 27);
  return fixture;
}

async function buildSnapshot() {
  const html = await fs.readFile(path.join(ROOT, 'dist', 'index.html'), 'utf8');
  const jsPaths = [...html.matchAll(/src="([^"]+\.js)"/g)].map(match => match[1]);
  assert.ok(jsPaths.length, 'Built JS bundle exists');
  return Promise.all(jsPaths.map(async url => ({ url, sha256: digest(await fs.readFile(path.join(ROOT, 'dist', url.replace(/^\//, '')))) })));
}

async function runBrowser({ name, executablePath, chromium, runRoot, evidenceRoot, serviceUrl, exportRequests, startExportPhase }) {
  const evidence = path.join(evidenceRoot, name); await fs.mkdir(evidence, { recursive: true });
  const downloadDirectory = path.join(runRoot, name, 'browser-downloads'); await fs.mkdir(downloadDirectory, { recursive: true });
  const archiveFile = path.join(runRoot, `${name}-complete-backup.zip`);
  const result = { name, executablePath, startedAt: new Date().toISOString(), status: 'running', checks: {},
    events: { blockedRequests: [], blockedWebSockets: [], pageErrors: [] }, screenshots: [], archiveFile };
  let context, page;
  try {
    context = await launchContext(chromium, executablePath, path.join(runRoot, name, 'profile'), serviceUrl, result.events,
      { acceptDownloads: true, downloadDirectory });
    result.browserVersion = context.browser().version();
    page = await context.newPage(); page.on('pageerror', error => { if (!result.events.pageErrors.includes(error.message)) result.events.pageErrors.push(error.message); });
    await page.bringToFront(); await page.goto(serviceUrl, { waitUntil: 'networkidle' });
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    result.buildScripts = await page.evaluate(() => [...document.scripts].filter(script => script.src).map(script => new URL(script.src).pathname));
    if (name === 'edge') {
      const paper = await api(serviceUrl, '/api/papers/cet6-2025-12-1'); await openPaper(page, paper);
      const before = await page.locator('audio').evaluate(audio => ({ time: audio.currentTime, rate: audio.playbackRate, paused: audio.paused }));
      await page.getByRole('button', { name: '播放听力', exact: true }).click();
      await page.waitForFunction(before => { const audio = document.querySelector('audio'); return !audio.paused && audio.currentTime >= before.time + before.rate * 3; }, before, { timeout: 15000 });
      await page.getByRole('button', { name: '暂停播放', exact: true }).click();
      const after = await page.locator('audio').evaluate(audio => ({ time: audio.currentTime, rate: audio.playbackRate, paused: audio.paused }));
      const deadline = Date.now() + 10000; let stats;
      do { stats = await api(serviceUrl, '/api/stats'); if (stats.listeningSeconds >= 2) break; await new Promise(resolve => setTimeout(resolve, 80)); } while (Date.now() < deadline);
      assert.ok(stats.listeningSeconds >= 2, 'Non-zero duration comes from real audio advancement');
      result.actualPlaybackSeed = { before, after, persistedStats: stats, measurement: 'UI play/pause and read-only audio observations; application itself posts actual listening duration.' };
      // Reload to restore the last successful position in a paused player.
      // The App may select a paper automatically; identical saves must still
      // be deduplicated rather than suppressed by the acceptance harness.
      await page.reload({ waitUntil: 'networkidle' }); await new Promise(resolve => setTimeout(resolve, 300));
    }
    result.exportAudioState = await page.locator('audio').evaluate(audio => ({ currentSrc: audio.currentSrc, paused: audio.paused, time: audio.currentTime }));
    assert.equal(result.exportAudioState.paused, true, 'The download page has no active playback');
    const beforeIdle = await api(serviceUrl, '/api/progress');
    await new Promise(resolve => setTimeout(resolve, 2300));
    const afterIdle = await api(serviceUrl, '/api/progress');
    assert.deepEqual(afterIdle, beforeIdle, 'Paused player does not rewrite identical progress/updatedAt after its two-second ticker');
    result.checks.pausedProgressDoesNotRewrite = true;
    await startExportPhase();
    await page.getByRole('button', { name: '导入、备份与设置', exact: true }).click();
    const before = exportRequests.length;
    const downloadEvent = page.waitForEvent('download', { timeout: 300000 });
    console.log(`[${name}] 从设置点击原生「导出 ZIP」，等待浏览器接收完整包…`);
    const started = Date.now();
    await page.getByRole('button', { name: '导出 ZIP', exact: true }).click();
    const download = await downloadEvent;
    result.download = { url: download.url(), suggestedFilename: download.suggestedFilename() };
    assert.equal(new URL(download.url()).origin, serviceUrl, 'Download remains on the isolated QA server');
    assert.equal(new URL(download.url()).pathname, '/api/backup/full');
    // saveAs waits for the native download to finish, using disk rather than a
    // page fetch().blob(). It never retrieves the archive a second time.
    await download.saveAs(archiveFile);
    result.download.failure = await download.failure(); assert.equal(result.download.failure, null, 'Browser reports completed download');
    result.download.milliseconds = Date.now() - started;
    result.download.bytes = (await fs.stat(archiveFile)).size;
    const deadline = Date.now() + 10000;
    while (!exportRequests[before]?.finishedAt && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const request = exportRequests[before]; assert.ok(request, 'Observed real HTTP export request');
    assert.equal(exportRequests.length, before + 1, 'Exactly one export HTTP request per UI click');
    assert.equal(request.method, 'GET'); assert.equal(request.status, 200); assert.equal(request.finished, true);
    assert.equal(request.fetchMode, 'navigate', 'Native anchor navigation rather than a fetch/blob request');
    assert.equal(result.download.bytes, request.contentLength, 'Entire advertised ZIP reached browser disk');
    result.download.http = request;
    result.checks.nativeDownloadCompleted = true; result.checks.completeContentLength = true;
    const { files, ...structure } = await inspectStoredZip(archiveFile);
    assert.ok(files.some(file => file.name === 'learning-records.json'));
    assert.equal(files.filter(file => /^data\/papers\/[^/]+\.json$/.test(file.name)).length, 27);
    assert.ok(files.some(file => file.name === 'data/sentence-aliases.json'));
    result.zipStructure = structure; result.checks.fullZipStructure = true;
    assert.deepEqual(result.events.pageErrors, [], 'No uncaught page errors during native download');
    result.checks.noPageErrors = true;
    const screenshot = path.join(evidence, 'native-full-backup-completed.png');
    await page.screenshot({ path: screenshot, fullPage: true }); result.screenshots.push(screenshot);
    result.status = 'passed'; console.log(`[${name}] 完整接收 ${result.download.bytes} bytes，ZIP目录验证通过。`);
  } catch (error) {
    result.status = 'failed'; result.error = { message: error.message, stack: error.stack };
    if (page && !page.isClosed()) {
      const screenshot = path.join(evidence, 'failure.png');
      await page.screenshot({ path: screenshot, fullPage: true }).then(() => result.screenshots.push(screenshot)).catch(() => undefined);
    }
  } finally {
    if (context) await context.close().catch(() => undefined);
    result.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

export async function main() {
  const available = await discover();
  if (!process.argv.includes('--run')) {
    console.log(JSON.stringify({ mode: 'preparation-only', available,
      commandAfterCorpusIsStable: 'node server/full-backup-ui-acceptance.mjs --run --user-authorized --corpus-stable',
      checks: ['fresh full QA data and database; no production writes', 'real Edge and Chrome UI native ZIP download with complete Content-Length', 'ZIP headers, complete central directory and file counts in both browsers', 'one received archive: full CRC extraction, 27 papers/675 questions/text/timing, 27 audio SHA256/Range, exact learning records and alias manifest restore', 'screenshots/build hashes; cleanup only owned and checked runtime directories'] }, null, 2));
    return;
  }
  assert.ok(process.argv.includes('--user-authorized'), 'Explicit authorization for Playwright required');
  assert.ok(process.argv.includes('--corpus-stable'), 'Root must explicitly confirm corpus is stable before export');
  assert.ok(available.playwrightVersion && available.browsers.edge && available.browsers.chrome, 'Bundled Playwright and both installed real browsers required');
  const { chromium } = await import(pathToFileURL(available.playwrightModule).href);
  await fs.mkdir(path.join(ROOT, 'runtime'), { recursive: true });
  const runRoot = await fs.mkdtemp(path.join(ROOT, 'runtime', 'full-backup-ui-check-'));
  const evidenceRoot = path.join(ROOT, 'docs', `full-backup-ui-check-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);
  await fs.mkdir(evidenceRoot, { recursive: true });
  const dataDir = path.join(runRoot, 'data'), exportRequests = [], requests = []; let exportPhase = false;
  const { browserLaunchPerformed: _discoveryOnly, ...availability } = available;
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', productionWrites: false,
    authorization: 'User explicitly authorized separate real Edge/Chrome Playwright windows; root confirmed stable corpus.', runRoot, evidenceRoot,
    available: availability, browserLaunchPerformed: false, results: [], checks: {}, exportRequests };
  let server;
  try {
    report.build = await buildSnapshot();
    console.log('准备全量只读资料的独立 QA 副本与空白数据库…');
    report.fixture = await prepareCompleteData(dataDir);
    server = createServer({ dataDir, distDir: path.join(ROOT, 'dist'), automaticBackup: false });
    server.on('request', (request, response) => {
      requests.push({ method: request.method, path: request.url, exportPhase });
      if (request.url !== '/api/backup/full') return;
      const record = { method: request.method, path: request.url, startedAt: new Date().toISOString(), fetchMode: request.headers['sec-fetch-mode'],
        fetchDestination: request.headers['sec-fetch-dest'], userAgent: request.headers['user-agent'] };
      exportRequests.push(record);
      response.once('finish', () => Object.assign(record, { status: response.statusCode, contentLength: Number(response.getHeader('Content-Length')), finished: response.writableFinished, finishedAt: new Date().toISOString() }));
      response.once('close', () => { if (!response.writableFinished) Object.assign(record, { finished: false, closedAt: new Date().toISOString() }); });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const serviceUrl = `http://127.0.0.1:${server.address().port}`; report.qaUrl = serviceUrl;
    report.learningFixture = await seedLearningRecords(serviceUrl, dataDir);
    const startExportPhase = async () => {
      if (exportPhase) return;
      report.sourceRecords = await api(serviceUrl, '/api/backup/export');
      assert.ok(report.sourceRecords.attempts.some(attempt => attempt.status === 'submitted') && report.sourceRecords.attempts.some(attempt => attempt.status === 'draft'));
      assert.ok(report.sourceRecords.progress.length >= 2 && report.sourceRecords.annotations.length >= 3 && report.sourceRecords.stats.listeningSeconds > 0);
      exportPhase = true;
    };
    for (const name of ['edge', 'chrome']) report.results.push(await runBrowser({ name, executablePath: available.browsers[name], chromium, runRoot, evidenceRoot, serviceUrl, exportRequests, startExportPhase }));
    assert.ok(report.results.every(result => result.status === 'passed'), 'Both real browsers must complete the UI export');
    assert.equal(report.results[0].download.bytes, report.results[1].download.bytes, 'Same stable QA source yields equal archive sizes');
    // learning-records exportedAt changes, so full ZIP/index hashes need not be
    // equal. Both complete structures were independently inspected above.
    const chosen = report.results[0];
    console.log(`[${chosen.name}] 对这一个浏览器原生收到的ZIP逐文件CRC校验并真实恢复…`);
    report.restore = await verifyFullBackup({ productionUrl: serviceUrl, archiveFile: chosen.archiveFile, sourceDataDir: dataDir });
    assert.equal(report.restore.status, 'passed'); report.checks.fullReceivedArchiveRestore = true;
    assert.equal(requests.filter(request => request.exportPhase && !['GET', 'HEAD'].includes(request.method)).length, 0, 'After seed/playback, QA source is read-only during both exports and verification');
    report.checks.qaSourceReadOnlyAfterSeeding = true;
    const recordContent = ({ exportedAt, ...records }) => records;
    assert.deepEqual(recordContent(await api(serviceUrl, '/api/backup/export')), recordContent(report.sourceRecords), 'Every seeded source field remains unchanged throughout both browser exports and restore');
    report.checks.sourceRecordsStable = true;
    const afterBuild = await buildSnapshot(); assert.deepEqual(afterBuild, report.build, 'Production frontend build stayed unchanged during acceptance');
    report.checks.buildStable = true; report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; }
  finally {
    report.browserLaunchPerformed = report.results.some(result => !!result.browserVersion);
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      const runtimeRoot = await fs.realpath(path.join(ROOT, 'runtime')), resolved = await fs.realpath(runRoot);
      assert.equal(path.dirname(resolved), runtimeRoot, 'Cleanup directly under workspace runtime');
      assert.match(path.basename(resolved), /^full-backup-ui-check-[A-Za-z0-9]+$/, 'Cleanup only this exact mkdtemp directory');
      report.cleanup = { runtimeRoot, resolved, pathVerified: true };
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); report.cleanup.removed = true;
    } catch (error) { report.status = 'failed'; report.cleanup = { removed: false, error: error.message }; }
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const reportFile = path.join(ROOT, 'docs', 'full-backup-ui-acceptance.json');
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, reportFile, build: report.build, browsers: report.results.map(({ name, browserVersion, status, download, error }) => ({ name, browserVersion, status, bytes: download?.bytes, error: error?.message })), restore: report.restore?.status, cleanup: report.cleanup }, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
