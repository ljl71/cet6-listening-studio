import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discover, prepareData, openService, openPaper, launchContext, measureAB } from './browser-acceptance.mjs';
import { validatePaper } from './validation.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function poll(check, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await sleep(50); }
  throw new Error('Player condition timed out');
}
const get = async (base, route) => { const r = await fetch(base + route); assert.equal(r.status, 200); return r.json(); };

async function measurePreroll(page, fixture) {
  await page.evaluate(() => {
    const audio = document.querySelector('audio'), events = [];
    window.__cet6PrerollEvents = events;
    const capture = event => events.push({ type: event.type, position: audio.currentTime, at: performance.now() });
    audio.addEventListener('seeking', capture); audio.addEventListener('playing', capture);
    window.__cet6StopPreroll = () => { audio.removeEventListener('seeking', capture); audio.removeEventListener('playing', capture); };
  });
  const entries = [];
  async function observeEntry(label, action, plays) {
    const from = await page.evaluate(() => window.__cet6PrerollEvents.length);
    await action();
    await page.waitForFunction(({ from, plays }) => window.__cet6PrerollEvents.slice(from).some(e => e.type === (plays ? 'playing' : 'seeking')), { from, plays });
    const events = await page.evaluate(from => window.__cet6PrerollEvents.slice(from), from);
    const start = events.find(e => e.type === 'seeking') || events.find(e => e.type === 'playing');
    assert.ok(start, label + ' has an observed actual media entry');
    assert.ok(Math.abs(start.position - fixture.playbackStart) < .03, `${label}: actual ${start.position}, requested ${fixture.playbackStart}`);
    assert.ok(start.position < fixture.nominalStart - .05, label + ' retains the explicit 120ms pre-roll instead of clipping at nominal passage start');
    entries.push({ label, events, observedStart: start.position });
    if (plays) await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  }
  await observeEntry('sidebar-select-seek', () => page.locator('.passage-item').first().click(), false);
  await observeEntry('sidebar-play-icon', () => page.locator('.passage-item').first().locator('.passage-play').click(), true);
  await observeEntry('question-full-passage-replay', () => page.getByRole('button', { name: '整篇回听', exact: true }).first().click(), true);
  await page.evaluate(() => window.__cet6StopPreroll());
  return { fixture, entries, measurement: 'Read-only native seeking/playing events from the real App audio; all three entry requests are actual UI clicks. Only a copied QA paper has its first start moved by 120ms.' };
}

async function measureSentence(page, sentence) {
  await page.getByRole('button', { name: '显示英文原文', exact: true }).click();
  await page.locator('.sentence-content').filter({ hasText: sentence.text }).click();
  await page.locator('.loop-button').click();
  await page.getByLabel(/^单句播放次数/).selectOption('3');
  await page.getByLabel(/^句间停顿/).selectOption('2');
  await page.evaluate(() => {
    const audio = document.querySelector('audio'), metrics = { plays: [], pauses: [], armedAt: performance.now() };
    window.__cet6SentenceMetrics = metrics;
    const playing = () => metrics.plays.push({ time: audio.currentTime, at: performance.now() });
    const pause = () => metrics.pauses.push({ time: audio.currentTime, at: performance.now() });
    audio.addEventListener('playing', playing); audio.addEventListener('pause', pause);
    window.__cet6StopSentenceMetrics = () => { audio.removeEventListener('playing', playing); audio.removeEventListener('pause', pause); };
  });
  await page.locator('.loop-modes').getByRole('button', { name: '单句复读', exact: true }).click();
  await page.waitForFunction(() => window.__cet6SentenceMetrics.pauses.length === 1);
  await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  await sleep(250);
  await page.getByRole('button', { name: '播放听力', exact: true }).click();
  await page.waitForFunction(() => window.__cet6SentenceMetrics.plays.length === 2);
  const resumed = await page.evaluate(() => window.__cet6SentenceMetrics.plays[1]);
  assert.ok(Math.abs(resumed.time - sentence.start) < .15, 'Resume during a sentence gap starts the next full playback');
  await page.waitForFunction(() => window.__cet6SentenceMetrics.pauses.length >= 3 && document.querySelector('audio').paused && document.querySelector('.loop-modes button.active')?.textContent === '顺序播放', null, { timeout: 25000 });
  await sleep(250);
  const metrics = await page.evaluate(() => { window.__cet6StopSentenceMetrics(); return window.__cet6SentenceMetrics; });
  assert.equal(metrics.plays.length, 3, 'Exactly three real full playback starts'); assert.equal(metrics.pauses.length, 3, 'Exactly three real ends; no gap counted as a playback');
  for (const play of metrics.plays) assert.ok(Math.abs(play.time - sentence.start) <= .3);
  for (const pause of metrics.pauses) assert.ok(Math.abs(pause.time - sentence.end) <= .3);
  const naturalGapSeconds = (metrics.plays[2].at - metrics.pauses[1].at) / 1000;
  assert.ok(Math.abs(naturalGapSeconds - 2) <= .3, `Natural sentence gap ${naturalGapSeconds}`);
  await page.getByRole('button', { name: '关闭复读控制', exact: true }).click();
  return { sentenceId: sentence.id, start: sentence.start, end: sentence.end, repeatCount: 3, gapSeconds: 2, pausedAndResumedInFirstGap: true,
    observed: metrics, naturalGapSeconds, measurement: 'Read-only native playing/pause events of the App audio, with the pause/resume buttons exercised during its first gap.' };
}

async function runBrowser(name, executablePath, chromium, runRoot, evidenceRoot, only) {
  const dataDir = path.join(runRoot, name, 'data'), events = { blockedRequests: [], blockedWebSockets: [], pageErrors: [] };
  const result = { browser: name, executablePath, startedAt: new Date().toISOString(), checks: {}, status: 'running', productionWrites: false, events };
  let service, context;
  const folder = path.join(evidenceRoot, name); await fs.mkdir(folder, { recursive: true });
  try {
    await prepareData(dataDir);
    let prerollFixture;
    if (only?.has('preroll')) {
      const qaPaperFile = path.join(dataDir, 'papers/cet6-2025-12-1.json');
      assert.ok(path.resolve(qaPaperFile).startsWith(path.resolve(runRoot) + path.sep), 'Timing fixture writes only to this run QA copy');
      const qaPaper = JSON.parse(await fs.readFile(qaPaperFile, 'utf8')), section = qaPaper.passages[0], first = section.sentences[0];
      assert.ok(section.start > .3 && first.end > section.start);
      first.start = +(section.start - .12).toFixed(3);
      validatePaper(qaPaper);
      prerollFixture = { paperId: qaPaper.id, sentenceId: first.id, nominalStart: section.start, playbackStart: first.start, end: first.end, qualityUnchanged: qaPaper.quality, reviewedUnchanged: first.reviewed };
      await fs.writeFile(qaPaperFile, JSON.stringify(qaPaper, null, 2) + '\n');
    }
    service = await openService(dataDir);
    if (prerollFixture) {
      const draft = await fetch(service.url + '/api/attempts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: prerollFixture.paperId }) }).then(r => r.json());
      const response = await fetch(service.url + `/api/attempts/${draft.id}/submit`, { method: 'POST' });
      assert.equal(response.status, 200, 'Prepare only an isolated submitted QA record to expose full-passage review; no production attempt is created');
    }
    context = await launchContext(chromium, executablePath, path.join(runRoot, name, 'profile'), service.url, events);
    result.browserVersion = context.browser().version();
    const page = await context.newPage(); await page.bringToFront();
    const failedProgress = [], progressRequests = [];
    page.on('response', response => { if (response.url().includes('/api/progress/') && response.status() >= 400) failedProgress.push({ url: response.url(), status: response.status() }); });
    page.on('request', request => { if (request.url().includes('/api/progress/') && request.method() === 'PUT') progressRequests.push(request.postDataJSON()); });
    await page.goto(service.url, { waitUntil: 'networkidle' });
    const paper = await get(service.url, '/api/papers/cet6-2025-12-1'); await openPaper(page, paper);
    if (prerollFixture) result.checks.firstSentencePrerollEntries = await measurePreroll(page, prerollFixture);
    if (!only || only.has('ab')) result.checks.consecutive20AB = await measureAB(page);
    const duration = await page.locator('audio').evaluate(audio => audio.duration);
    if (!only || only.has('media-end')) result.checks.physicalMediaEndAB = await measureAB(page, { start: duration - .7, end: duration, targetCycles: 3 });
    const sentence = paper.passages.flatMap(p => p.sentences).find(s => s.end - s.start >= 1 && s.end - s.start <= 2.5);
    assert.ok(sentence, 'Real short candidate sentence available for playback control test');
    if (!only || only.has('sentence')) result.checks.sentenceCountGapAndResume = await measureSentence(page, sentence);
    if (!only || only.has('switch')) {
    const other = await get(service.url, '/api/papers/cet6-2020-07-1');
    const target = other.passages.flatMap(p => p.sentences).find(s => s.end - s.start > 1).start + .3;
    await page.getByLabel('播放进度', { exact: true }).evaluate((input, target) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, target);
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    }, target);
    await page.getByRole('button', { name: '播放听力', exact: true }).click();
    await sleep(300);
    const beforeSwitch = await page.locator('audio').evaluate(audio => audio.currentTime);
    await openPaper(page, other);
    await poll(async () => { const values = await get(service.url, '/api/progress'); return values.some(p => p.paperId === paper.id && p.position >= beforeSwitch); });
    const oldIds = new Set(paper.passages.flatMap(p => p.sentences.map(s => s.id)));
    assert.ok(progressRequests.filter(r => r.paperId === paper.id && r.sentenceId).every(r => oldIds.has(r.sentenceId)), 'Old-paper saves never contain a new-paper sentence ID');
    assert.equal(failedProgress.length, 0, 'No failed progress write is hidden by a previous successful save');
    result.checks.switchPaperSave = { beforeSwitch, oldPaperId: paper.id, targetPaperId: other.id, failedProgress, requestsExamined: progressRequests.length };
    }
    const screenshot = path.join(folder, 'player-loop-check.png'); await page.screenshot({ path: screenshot, fullPage: true }); result.screenshot = screenshot;
    assert.equal(events.pageErrors.length, 0); result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = { message: error.message, stack: error.stack }; if (error.measurement) result.failureMeasurement = error.measurement; }
  finally {
    if (context) await context.close(); if (service) await new Promise(resolve => service.server.close(resolve));
    result.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(folder, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

async function main() {
  if (!process.argv.includes('--run') || !process.argv.includes('--user-authorized')) throw new Error('Requires --run --user-authorized after the user authorized independent Playwright windows.');
  const available = await discover(), requested = process.argv.find(a => a.startsWith('--browser='))?.slice(10) || 'all';
  const onlyValue = process.argv.find(a => a.startsWith('--only='))?.slice(7), only = onlyValue ? new Set(onlyValue.split(',')) : null;
  if (only) assert.ok([...only].every(value => ['ab', 'media-end', 'sentence', 'switch', 'preroll'].includes(value)));
  assert.ok(['all', 'edge', 'chrome'].includes(requested));
  const { chromium } = await import(pathToFileURL(available.playwrightModule).href);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'), runRoot = path.join(ROOT, 'runtime', `player-loop-check-${stamp}`), evidenceRoot = path.join(ROOT, 'docs', `player-loop-check-${stamp}`);
  const report = { startedAt: new Date().toISOString(), productionWrites: false, scope: only ? [...only] : 'all-loop-regressions', runRoot, evidenceRoot, results: [] };
  for (const name of requested === 'all' ? ['edge', 'chrome'] : [requested]) {
    assert.ok(available.browsers[name]); report.results.push(await runBrowser(name, available.browsers[name], chromium, runRoot, evidenceRoot, only));
  }
  report.status = report.results.every(r => r.status === 'passed') ? 'passed' : 'failed'; report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(ROOT, 'docs/player-loop-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: 'docs/player-loop-acceptance.json', results: report.results.map(r => ({ browser: r.browser, version: r.browserVersion, status: r.status, error: r.error, checks: Object.keys(r.checks) })) }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
