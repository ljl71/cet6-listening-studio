// Preparation is read-only. --run --user-authorized is deliberately required
// before this script launches or controls an installed browser outside cua_repl.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer, safeFile } from './index.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PLAYWRIGHT_ROOT = process.env.CET6_PLAYWRIGHT_ROOT || path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright');
const BROWSER_PATHS = {
  edge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')],
};
const QUESTIONS = ['A', 'B', 'C', 'D'];
const dateStamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function poll(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await sleep(80);
  }
  throw new Error(`等待超时：${label}${last instanceof Error ? ` (${last.message})` : ''}`);
}
async function api(base, route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}
export async function discover() {
  const browsers = {};
  for (const [name, candidates] of Object.entries(BROWSER_PATHS)) browsers[name] = candidates.find(existsSync) || null;
  let playwrightVersion = null;
  try { playwrightVersion = (await json(path.join(PLAYWRIGHT_ROOT, 'package.json'))).version; } catch { /* Report missing dependency instead of downloading a browser. */ }
  return { browsers, playwrightModule: path.join(PLAYWRIGHT_ROOT, 'index.mjs'), playwrightVersion, browserLaunchPerformed: false };
}
export async function prepareData(destination) {
  const production = path.join(ROOT, 'data');
  await fs.mkdir(path.join(destination, 'papers'), { recursive: true });
  await fs.mkdir(path.join(destination, 'media'), { recursive: true });
  const paperFiles = (await fs.readdir(path.join(production, 'papers'))).filter(name => name.endsWith('.json'));
  for (const name of paperFiles) await fs.copyFile(path.join(production, 'papers', name), path.join(destination, 'papers', name));
  const assets = await json(path.join(production, 'assets.json'));
  await fs.copyFile(path.join(production, 'assets.json'), path.join(destination, 'assets.json'));
  for (const asset of Object.values(assets)) {
    const source = safeFile(production, asset.path), output = path.join(destination, asset.path);
    await fs.mkdir(path.dirname(output), { recursive: true });
    // Media is served read-only and never imported/edited by these tests. A hard
    // link avoids copying hundreds of megabytes; SQLite and papers are independent.
    try { await fs.link(source, output); } catch { await fs.copyFile(source, output); }
  }
  return { papers: paperFiles.length, assets: Object.keys(assets).length };
}
export async function openService(dataDir, port = 0) {
  const server = createServer({ dataDir, distDir: path.join(ROOT, 'dist') });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}
const closeService = server => new Promise(resolve => server.close(resolve));
const audioState = page => page.locator('audio').evaluate(audio => ({ paused: audio.paused, currentTime: audio.currentTime, readyState: audio.readyState, src: audio.currentSrc, duration: audio.duration }));
const waitAudio = (page, assetId) => page.waitForFunction(assetId => { const audio = document.querySelector('audio'); return audio && audio.readyState >= 1 && audio.duration > 0 && audio.currentSrc.endsWith(`/media/${encodeURIComponent(assetId)}`); }, assetId, { timeout: 30000 });
const nav = async (page, label) => { await page.locator('.nav-item').filter({ hasText: label }).click(); };
export async function openPaper(page, paper) {
  await nav(page, '真题库');
  await page.getByRole('button', { name: `打开${paper.title}`, exact: true }).click();
  await page.getByRole('heading', { name: paper.title, exact: true }).waitFor();
  await waitAudio(page, paper.audioAssetId);
}

export async function launchContext(chromium, executablePath, userDataDir, base, events, { acceptDownloads = false, downloadDirectory } = {}) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    viewport: { width: 1440, height: 1000 },
    chromiumSandbox: true,
    acceptDownloads,
    ...(downloadDirectory ? { downloadsPath: downloadDirectory } : {}),
    serviceWorkers: 'block',
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--disable-features=MediaRouter,OptimizationHints,Translate'],
  });
  const allowedOrigin = new URL(base).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === allowedOrigin || ['data:', 'blob:', 'about:'].includes(url.protocol)) return route.continue();
    events.blockedRequests.push({ url: url.href, resourceType: route.request().resourceType(), at: new Date().toISOString() });
    return route.abort('internetdisconnected');
  });
  await context.routeWebSocket(/.*/, socket => {
    const url = new URL(socket.url());
    if (url.hostname === '127.0.0.1' && url.port === new URL(base).port) socket.connectToServer();
    else { events.blockedWebSockets.push(url.href); void socket.close({ code: 1008, reason: 'Browser acceptance: external network is disabled' }); }
  });
  context.on('page', page => page.on('pageerror', error => events.pageErrors.push(error.message)));
  return context;
}

export async function measureAB(page, { start = 30, end = 30.7, targetCycles = 20 } = {}) {
  await page.locator('.loop-button').click();
  await page.getByLabel('A点秒数', { exact: true }).fill(String(start));
  await page.getByLabel('B点秒数', { exact: true }).fill(String(end));
  await page.evaluate(({ start, end, targetCycles }) => {
    const audio = document.querySelector('audio');
    const metrics = { start, end, targetCycles, cycles: [], visibilityChanges: [], outOfRange: [], maximumFrameGapMs: 0, startedAt: 0, done: false, stopped: false, armed: false, playbackRate: audio.playbackRate };
    window.__cet6ABMetrics = metrics;
    let previousTime = audio.currentTime, previousWall = performance.now();
    audio.addEventListener('playing', () => { metrics.armed = true; metrics.startedAt = previousWall = performance.now(); previousTime = audio.currentTime; }, { once: true });
    const observe = now => {
      if (metrics.stopped || metrics.done) return;
      if (!metrics.armed) { requestAnimationFrame(observe); return; }
      metrics.maximumFrameGapMs = Math.max(metrics.maximumFrameGapMs, now - previousWall);
      if (document.visibilityState !== 'visible') metrics.visibilityChanges.push({ at: now, state: document.visibilityState });
      const time = audio.currentTime;
      if (time > end + .3 || time < start - .3) metrics.outOfRange.push({ time, at: now });
      // Every backward jump is retained, including a very late one. A bad wrap
      // cannot be filtered out and replaced by twenty later successful wraps.
      if (time < previousTime - .04) {
        metrics.cycles.push({ number: metrics.cycles.length + 1, observedEnd: previousTime, observedRestart: time, boundaryAbsoluteError: Math.abs(previousTime - end), restartAbsoluteError: Math.abs(time - start), wallMs: now - metrics.startedAt });
      }
      previousTime = time; previousWall = now;
      if (metrics.cycles.length >= targetCycles) metrics.done = true; else requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  }, { start, end, targetCycles });
  await page.getByRole('button', { name: '播放 A–B 区间', exact: true }).click();
  await page.waitForFunction(() => window.__cet6ABMetrics?.done, null, { timeout: 60000 });
  await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  const metrics = await page.evaluate(() => { window.__cet6ABMetrics.stopped = true; return window.__cet6ABMetrics; });
  await page.getByRole('button', { name: '顺序播放', exact: true }).click();
  await page.getByRole('button', { name: '关闭复读控制', exact: true }).click();
  try {
  assert.equal(metrics.cycles.length, targetCycles, 'Consecutive actual playback wraps, not simulated seeking');
  assert.equal(metrics.visibilityChanges.length, 0, 'A-B measurement stays in foreground');
  assert.equal(metrics.outOfRange.length, 0, 'No out-of-range sample is hidden');
  const samplingBound = metrics.maximumFrameGapMs / 1000 * metrics.playbackRate;
  assert.ok(samplingBound <= .15, 'Sampling resolution must bound an unobserved seek, not hide long animation-frame stalls');
  const maximumBoundaryError = Math.max(...metrics.cycles.map(cycle => cycle.boundaryAbsoluteError));
  const maximumRestartError = Math.max(...metrics.cycles.map(cycle => cycle.restartAbsoluteError));
  assert.ok(maximumBoundaryError <= .3, `Maximum observed boundary error ${maximumBoundaryError}`);
  assert.ok(maximumRestartError <= .3, `Maximum restart error ${maximumRestartError}`);
  assert.ok(maximumBoundaryError + samplingBound <= .3, 'Observed boundary error plus worst sample interval stays within the target');
  const expectedCycleMs = (end - start) / metrics.playbackRate * 1000;
  let previousCycleMs = 0;
  for (const cycle of metrics.cycles) {
    cycle.intervalMs = cycle.wallMs - previousCycleMs; previousCycleMs = cycle.wallMs;
    assert.ok(Math.abs(cycle.intervalMs - expectedCycleMs) <= 300, 'Each cycle has the expected uninterrupted cadence; missed wraps cannot be discarded');
  }
  return { ...metrics, maximumBoundaryError, maximumRestartError, samplingBound, conservativeBoundaryError: maximumBoundaryError + samplingBound,
    measurement: 'Read-only frame samples; every backward jump retained, no endpoint filter, cadence and maximum sample interval bounded. Every seek is performed by the App.' };
  } catch (error) { error.measurement = metrics; throw error; }
}

async function runBrowser(name, executablePath, chromium, runRoot, evidenceRoot) {
  const dataDir = path.join(runRoot, name, 'data'), profile = path.join(runRoot, name, 'profile');
  const evidence = path.join(evidenceRoot, name); await fs.mkdir(evidence, { recursive: true });
  const result = { name, executablePath, dataDir, profile, startedAt: new Date().toISOString(), checks: [], screenshots: [], status: 'running', events: { blockedRequests: [], blockedWebSockets: [], pageErrors: [] } };
  let context, service, page;
  const check = async (label, work) => {
    console.log(`[${name}] ${label}`);
    const started = Date.now();
    try { const details = await work(); result.checks.push({ name: label, status: 'passed', milliseconds: Date.now() - started, details }); return details; }
    catch (error) { result.checks.push({ name: label, status: 'failed', milliseconds: Date.now() - started, error: error.message }); throw error; }
  };
  const screenshot = async label => { const file = path.join(evidence, `${label}.png`); await page.screenshot({ path: file, fullPage: true }); result.screenshots.push(file); };
  try {
    result.fixture = await prepareData(dataDir); service = await openService(dataDir); result.qaUrl = service.url;
    context = await launchContext(chromium, executablePath, profile, service.url, result.events);
    result.browserVersion = context.browser().version();
    page = await context.newPage(); await page.bringToFront();
    await page.goto(service.url, { waitUntil: 'networkidle' });
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    result.initialWindow = await page.evaluate(() => ({ innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio }));
    const summaries = await api(service.url, '/api/papers');
    const paper = await api(service.url, '/api/papers/cet6-2025-12-1');
    const otherPaper = await api(service.url, '/api/papers/cet6-2020-07-1');
    await check('offline-network-isolation-and-local-startup', async () => {
      assert.equal(summaries.length, 27);
      const probes = await page.evaluate(async () => {
        const results = [];
        for (const url of ['https://example.com/cet6-offline-probe', 'https://www.baidu.com/cet6-offline-probe']) {
          try { const response = await fetch(url, { signal: AbortSignal.timeout(5000) }); results.push({ url, blocked: false, status: response.status }); }
          catch (error) { results.push({ url, blocked: true, error: error.message }); }
        }
        const local = await fetch('/api/health').then(response => response.json());
        return { results, local, resources: performance.getEntriesByType('resource').map(entry => entry.name) };
      });
      assert.ok(probes.results.every(probe => probe.blocked));
      for (const probe of probes.results) assert.ok(result.events.blockedRequests.some(request => request.url === probe.url), 'External request was actually denied by the test policy, not merely a CORS error');
      assert.equal(probes.local.corpus.total, 27);
      return { isolation: 'All non-QA-origin HTTP(S) requests and WebSockets are aborted in this independent browser context. OS networking is unchanged; background networking/sync disabled for the dedicated test process.', probes };
    });
    await screenshot('01-library-offline');
    await openPaper(page, paper);
    await check('first-attempt-hides-prompts-transcript-and-answers', async () => {
      assert.equal(await page.locator('.question-card').count(), 25);
      assert.equal(await page.locator('.question-prompt, .explanation, .transcript-scroll').count(), 0);
      return { paperId: paper.id, questions: 25, hiddenAnswerElements: true };
    });
    await check('actual-audio-playback-keyboard-and-cross-page-continuity', async () => {
      await page.getByRole('heading', { name: paper.title, exact: true }).click();
      await page.keyboard.press('Space');
      await poll(async () => { const audio = await audioState(page); return !audio.paused && audio.currentTime > .2 && audio; }, 'Space starts audio');
      const before = await audioState(page);
      await nav(page, '学习记录');
      await poll(async () => { const audio = await audioState(page); return !audio.paused && audio.src === before.src && audio.currentTime > before.currentTime + .15; }, 'Audio continues on records page');
      await nav(page, '听力工作台');
      await page.getByRole('heading', { name: paper.title, exact: true }).click();
      await page.keyboard.press('Space');
      await poll(async () => (await audioState(page)).paused, 'Space pauses audio');
      const paused = await audioState(page); await page.keyboard.press('ArrowRight');
      await poll(async () => Math.abs((await audioState(page)).currentTime - paused.currentTime - 5) < .2, 'Right seeks five seconds');
      await page.keyboard.press('ArrowLeft');
      await poll(async () => Math.abs((await audioState(page)).currentTime - paused.currentTime) < .2, 'Left seeks five seconds');
      return { before, after: await audioState(page), keyboard: ['Space play', 'Space pause', 'ArrowRight +5s', 'ArrowLeft -5s'], crossPageContinues: true };
    });
    result.abLoop = await check('foreground-real-audio-20-ab-loops-and-0.3s-boundary', () => measureAB(page));
    await check('auto-save-grade-unanswered-and-review', async () => {
      const wrong = QUESTIONS.find(option => option !== paper.questions[0].answer);
      await page.locator('.question-card').nth(0).locator('.answer-option').nth(QUESTIONS.indexOf(wrong)).click();
      await page.locator('.question-card').nth(1).locator('.answer-option').nth(QUESTIONS.indexOf(paper.questions[1].answer)).click();
      await poll(async () => { const attempts = await api(service.url, '/api/attempts'); return attempts.find(attempt => attempt.paperId === paper.id && Object.keys(attempt.answers).length === 2); }, 'Two selected answers persisted');
      await page.getByRole('button', { name: '交卷批改', exact: true }).click();
      await page.locator('.result-banner').waitFor();
      const submitted = (await api(service.url, '/api/attempts')).find(attempt => attempt.paperId === paper.id && attempt.status === 'submitted');
      assert.equal(submitted.result.correct, 1); assert.equal(submitted.result.total, 25); assert.equal(submitted.result.unanswered, 23); assert.equal(submitted.assisted, false);
      await nav(page, '错题与收藏'); await page.locator('.review-card').first().waitFor();
      assert.equal(await page.locator('.review-card').count(), 24);
      await page.locator('.review-card').first().getByRole('button', { name: '回到原文', exact: true }).click();
      await page.locator('.transcript-scroll').waitFor();
      return { attemptId: submitted.id, result: submitted.result, assisted: submitted.assisted, wrongQuestions: 24 };
    });
    await screenshot('02-graded-workspace');
    const noteText = `${name}: independent browser acceptance note ${randomUUID()}`;
    await check('favorite-notes-and-keyboard-input-guard', async () => {
      await page.locator('.sentence-content').first().click();
      await page.locator('.sentence').first().getByRole('button', { name: '收藏这句话', exact: true }).click();
      await poll(async () => (await api(service.url, '/api/annotations')).some(annotation => annotation.favorite), 'Favorite flag persisted before editing the note');
      const editor = page.locator('.note-editor textarea'); await editor.fill(noteText);
      const audioBefore = await audioState(page); await editor.press('Space'); await editor.press('ArrowLeft');
      assert.equal((await audioState(page)).paused, audioBefore.paused, 'Typing Space in notes does not toggle the player');
      assert.ok(Math.abs((await audioState(page)).currentTime - audioBefore.currentTime) < .1, 'ArrowLeft in notes does not seek');
      await page.locator('.note-editor').getByRole('button', { name: '保存笔记', exact: false }).click();
      const annotations = await poll(async () => { const values = await api(service.url, '/api/annotations'); return values.some(annotation => annotation.text.includes(noteText) && annotation.favorite) && values; }, 'Favorite note saved');
      return { annotations: annotations.length, inputGuard: true };
    });
    await check('switch-paper-restores-the-newest-progress', async () => {
      await page.getByRole('button', { name: '快进5秒', exact: true }).click();
      const target = (await audioState(page)).currentTime;
      await poll(async () => (await api(service.url, '/api/progress')).some(progress => progress.paperId === paper.id && Math.abs(progress.position - target) < .15), 'Latest progress saved');
      await openPaper(page, otherPaper); const otherSrc = (await audioState(page)).src;
      await openPaper(page, paper);
      const returned = await audioState(page); assert.notEqual(returned.src, otherSrc); assert.ok(Math.abs(returned.currentTime - target) < .3, 'Switching back uses the newly saved position');
      return { expected: target, actual: returned.currentTime };
    });
    await check('desktop-and-narrow-window-layouts', async () => {
      const viewports = [];
      for (const size of [{ width: 1440, height: 1000 }, { width: 960, height: 800 }, { width: 520, height: 800 }]) {
        await page.setViewportSize(size);
        const dimensions = await page.evaluate(() => ({ innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }));
        assert.equal(dimensions.horizontalOverflow, false, `No horizontal overflow at ${size.width}px`);
        assert.equal(await page.locator('.nav-item:visible').count(), 4, 'Four navigation entries remain available');
        viewports.push(dimensions); await screenshot(`03-viewport-${size.width}`);
      }
      await page.setViewportSize({ width: 1440, height: 1000 }); return viewports;
    });
    const beforeRestart = await api(service.url, '/api/backup/export');
    const port = service.port;
    await context.close(); context = null; await closeService(service.server); service = null;
    service = await openService(dataDir, port);
    const restartedEvents = result.events;
    context = await launchContext(chromium, executablePath, `${profile}-fresh-after-restart`, service.url, restartedEvents);
    page = await context.newPage(); await page.bringToFront(); await page.goto(service.url, { waitUntil: 'networkidle' });
    await check('service-and-browser-restart-preserves-data-with-a-clean-profile', async () => {
      const after = await api(service.url, '/api/backup/export');
      for (const key of ['attempts', 'annotations', 'stats']) assert.deepEqual(after[key], beforeRestart[key], `Restart retains ${key}`);
      const normalized = records => records.progress.map(({ updatedAt, ...value }) => value).sort((a, b) => a.paperId.localeCompare(b.paperId));
      assert.deepEqual(normalized(after), normalized(beforeRestart));
      assert.ok(after.annotations.some(annotation => annotation.text.includes(noteText) && annotation.favorite));
      assert.ok(after.stats.listeningSeconds > 0);
      await openPaper(page, paper); const state = await audioState(page); assert.equal(state.paused, true, 'Restart must not automatically play');
      const saved = after.progress.find(progress => progress.paperId === paper.id); assert.ok(Math.abs(state.currentTime - saved.position) < .3);
      return { cleanBrowserProfile: true, attempts: after.attempts.length, annotations: after.annotations.length, progress: after.progress.length, listeningSeconds: after.stats.listeningSeconds, autoPlayed: false };
    });
    await screenshot('04-after-restart');
    assert.deepEqual(result.events.pageErrors, [], 'No uncaught application JavaScript errors');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = { message: error.message, stack: error.stack };
    if (page && !page.isClosed()) await screenshot('failure').catch(() => undefined);
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (service) await closeService(service.server);
    result.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

async function main() {
  const available = await discover();
  if (!process.argv.includes('--run')) {
    console.log(JSON.stringify({ ...available, mode: 'preparation-only', approvalRequired: 'Only run after the user explicitly authorizes Playwright control of separate real Edge/Chrome test windows.', commandAfterAuthorization: 'node server/browser-acceptance.mjs --run --user-authorized --browser=all', expectedChecks: ['independent QA data and fresh user profile', 'external HTTP(S)/WebSocket denial while local app works', 'actual audio, keyboard and cross-page continuity', '20 foreground A-B loops with measured <=0.3s error', 'blind attempt, unanswered grading and review', 'notes, favorites and typing keyboard guard', 'latest progress survives changing papers', '1440/960/520 layouts and screenshots', 'SQLite persistence across server/browser restart with clean browser profile'] }, null, 2));
    return;
  }
  if (!process.argv.includes('--user-authorized')) throw new Error('Missing explicit user authorization. Preparation does not grant permission to control browsers outside cua_repl.');
  if (!available.playwrightVersion) throw new Error('Bundled Playwright unavailable; no browser or package is downloaded automatically.');
  const requested = process.argv.find(value => value.startsWith('--browser='))?.split('=')[1] || 'all';
  if (!['all', 'edge', 'chrome'].includes(requested)) throw new Error('Use --browser=all, --browser=edge or --browser=chrome');
  const { chromium } = await import(pathToFileURL(available.playwrightModule).href);
  const stamp = dateStamp(), runRoot = path.join(ROOT, 'runtime', `browser-acceptance-${stamp}`), evidenceRoot = path.join(ROOT, 'docs', `browser-acceptance-${stamp}`);
  await fs.mkdir(runRoot, { recursive: true }); await fs.mkdir(evidenceRoot, { recursive: true });
  const { browserLaunchPerformed: _discoveryOnlyFlag, ...availability } = available;
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), authorization: 'Explicit user authorization required by caller; --user-authorized supplied', available: availability, browserLaunchPerformed: false, runRoot, evidenceRoot, productionWrites: false, headless: false, results: [] };
  for (const name of requested === 'all' ? ['edge', 'chrome'] : [requested]) {
    if (!available.browsers[name]) { report.results.push({ name, status: 'blocked', error: 'Installed browser executable not found' }); continue; }
    report.results.push(await runBrowser(name, available.browsers[name], chromium, runRoot, evidenceRoot));
  }
  report.browserLaunchPerformed = report.results.some(result => !!result.browserVersion);
  report.finishedAt = new Date().toISOString(); report.status = report.results.length > 0 && report.results.every(result => result.status === 'passed') ? 'passed' : 'failed';
  await fs.writeFile(path.join(ROOT, 'docs', 'browser-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(ROOT, 'docs', 'browser-acceptance.json'), browsers: report.results.map(({ name, browserVersion, status, error, checks }) => ({ name, browserVersion, status, error: error?.message || error, checks: checks?.map(({ name, status }) => ({ name, status })) })) }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
