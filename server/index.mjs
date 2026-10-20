import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, mkdirSync, copyFileSync, writeFileSync, createReadStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createStore, atomicJson } from './store.mjs';
import { MERGED_NOTE_LIMIT, MERGED_REASON_LIMIT } from './sentence-aliases.mjs';
import { writeZip } from './zip.mjs';
import { HttpError, fail, identifier, annotationIdentifier, isObject, number, text, types, qualityKeys, validatePaper, validateTimings, validateAnswers } from './validation.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = '0.1.0';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'audio/mp4' };

function send(response, status, value, headers = {}) {
  const data = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
  response.end(data);
}
function secureLocalRequest(request) {
  let host;
  try { host = new URL(`http://${request.headers.host || ''}`); } catch { fail('主机地址无效', 403); }
  if (!LOCAL_HOSTS.has(host.hostname)) fail('服务仅供本机访问', 403);
  const origin = request.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { fail('来源地址无效', 403); }
    if (!LOCAL_HOSTS.has(parsed.hostname) || !['http:', 'https:'].includes(parsed.protocol)) fail('拒绝来自外部网站的请求', 403);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    if (port !== host.port && port !== '5173') fail('来源端口不受信任', 403);
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') fail('拒绝跨站请求', 403);
}
async function jsonBody(request, limit = 2 * 1024 * 1024) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > limit) fail('请求内容过大', 413);
  const type = request.headers['content-type'] || '';
  if (declared > 0 && !/^application\/json(?:;|$)/i.test(type)) fail('请使用 JSON 格式', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail('请求内容过大', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!isObject(value)) fail('请求必须是 JSON 对象'); return value; } catch (error) { if (error instanceof HttpError) throw error; fail('JSON 格式不正确'); }
}
function inside(root, resolved) {
  const relative = path.relative(root, resolved);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Resolve existing files only, reject absolute paths, traversal, and symlinks escaping root. */
export function safeFile(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || /(^|[\\/])\.\.([\\/]|$)/.test(relative) || /^[a-z]:/i.test(relative)) fail('文件路径无效', 400);
  const resolved = path.resolve(root, relative);
  if (!inside(path.resolve(root), resolved)) fail('文件路径超出资料目录', 403);
  if (!existsSync(resolved)) fail('文件不存在', 404);
  const realRoot = realpathSync(root), realFile = realpathSync(resolved);
  if (!inside(realRoot, realFile) || !statSync(realFile).isFile()) fail('文件不可访问', 403);
  return realFile;
}
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) fail('请求的音频范围无效', 416);
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) fail('请求的音频范围无效', 416); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) fail('请求的音频范围无效', 416);
  return { start, end: Math.min(end, size - 1) };
}
function streamFile(request, response, file, mime, { range = false } = {}) {
  const size = statSync(file).size;
  let segment;
  try { segment = range ? parseRange(request.headers.range, size) : null; }
  catch (error) { if (error.status === 416) { send(response, 416, { error: error.message }, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }); return; } throw error; }
  const headers = { 'Content-Type': mime, 'Content-Length': segment ? segment.end - segment.start + 1 : size, 'Cache-Control': range ? 'private, max-age=3600' : 'no-cache' };
  if (range) headers['Accept-Ranges'] = 'bytes';
  if (segment) headers['Content-Range'] = `bytes ${segment.start}-${segment.end}/${size}`;
  response.writeHead(segment ? 206 : 200, headers);
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(file, segment || {});
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy()); stream.pipe(response);
}

export function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(PROJECT_ROOT, 'data'));
  const distDir = path.resolve(options.distDir || path.join(PROJECT_ROOT, 'dist'));
  const store = createStore({ dataDir, now: options.now, automaticBackup: options.automaticBackup !== false });
  const paperDirectory = path.join(dataDir, 'papers');
  const assetManifest = path.join(dataDir, 'assets.json');
  const readAssets = () => {
    if (!existsSync(assetManifest)) return {};
    try { const assets = JSON.parse(readFileSync(assetManifest, 'utf8')); if (!isObject(assets)) throw new Error(); return assets; } catch { fail('音频索引损坏，请恢复资料备份', 500); }
  };
  const papers = () => {
    if (!existsSync(paperDirectory)) return [];
    return readdirSync(paperDirectory).filter(name => name.endsWith('.json')).flatMap(name => {
      try { const paper = JSON.parse(readFileSync(safeFile(paperDirectory, name), 'utf8')); if (!isObject(paper) || !Array.isArray(paper.questions) || !Array.isArray(paper.passages)) return []; return [paper]; } catch { return []; }
    }).sort((a, b) => b.year - a.year || b.month - a.month || String(a.variant).localeCompare(String(b.variant), 'zh-CN'));
  };
  const paperById = id => {
    identifier(id, '试卷');
    const file = safeFile(paperDirectory, `${id}.json`);
    try { const paper = JSON.parse(readFileSync(file, 'utf8')); if (paper.id !== id || !Array.isArray(paper.questions) || !Array.isArray(paper.passages)) throw new Error(); return paper; } catch { fail('试卷资料损坏，请重新导入', 500); }
  };
  const usableAudio = paper => {
    if (!paper.audioAssetId) return false;
    const asset = readAssets()[paper.audioAssetId];
    if (!asset?.path || !/^media[\\/]/.test(asset.path)) return false;
    try { return statSync(safeFile(dataDir, asset.path)).size > 0; } catch { return false; }
  };
  const ready = paper => {
    if (!qualityKeys.every(key => paper.quality?.[key] === 'verified') || paper.questions.length !== 25 || paper.passages.length !== 7 || !usableAudio(paper)) return false;
    try { validatePaper(paper); return true; } catch { return false; }
  };
  const summary = paper => {
    const { passages, questions, ...rest } = paper;
    return { ...rest, passageCount: passages.length, questionCount: questions.length, ready: ready(paper) };
  };
  const getAttempt = id => { identifier(id, '练习'); const record = store.get('attempt', id); if (!record) fail('练习记录不存在', 404); return record; };
  const getBodyPaper = id => paperById(id);
  function submitAttempt(attempt) {
    if (attempt.status === 'submitted') return attempt;
    const paper = paperById(attempt.paperId);
    if (paper.quality?.answers !== 'verified' || paper.questions.length !== 25 || paper.questions.some(q => !['A', 'B', 'C', 'D'].includes(q.answer))) fail('答案尚未完成核验，已保留草稿', 409);
    const byType = Object.fromEntries(types.map(type => [type, { correct: 0, total: 0 }]));
    const passageTypes = new Map(paper.passages.map(p => [p.id, p.type]));
    let correct = 0, unanswered = 0;
    for (const q of paper.questions) {
      const type = passageTypes.get(q.passageId);
      if (!byType[type]) fail('试卷题目与篇章对应关系无效', 409);
      byType[type].total++;
      if (!attempt.answers[q.id]) unanswered++;
      if (attempt.answers[q.id] === q.answer) { correct++; byType[type].correct++; }
    }
    return store.put('attempt', attempt.id, { ...attempt, status: 'submitted', submittedAt: store.iso(), result: { correct, total: paper.questions.length, unanswered, byType } });
  }
  function walkFiles(directory, prefix = '') {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (entry.isSymbolicLink()) return [];
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && ['backups', 'learning.sqlite', 'learning.sqlite-wal', 'learning.sqlite-shm'].includes(entry.name)) return [];
      if (entry.isDirectory()) return walkFiles(path.join(directory, entry.name), relative);
      if (!entry.isFile() || entry.name.endsWith('.part') || entry.name.endsWith('.tmp')) return [];
      return [{ name: `data/${relative}`, path: path.join(directory, entry.name) }];
    });
  }
  async function api(request, response, url) {
    const method = request.method, route = url.pathname;
    if (method === 'GET' && route === '/api/health') {
      const values = papers(), required = values.filter(p => p.required), available = values.filter(ready);
      return send(response, 200, { app: 'cet6-listening-studio', version: VERSION, ready: required.length > 0 && required.every(ready), corpus: { total: values.length, ready: available.length, missing: values.length - available.length, years: [...new Set(values.map(p => p.year))].sort() } });
    }
    if (method === 'GET' && route === '/api/papers') return send(response, 200, papers().map(summary));
    let match = /^\/api\/papers\/([^/]+)$/.exec(route);
    if (method === 'GET' && match) return send(response, 200, paperById(decodeURIComponent(match[1])));
    if (method === 'GET' && route === '/api/attempts') return send(response, 200, store.list('attempt'));
    if (method === 'POST' && route === '/api/attempts') {
      const body = await jsonBody(request), paper = getBodyPaper(body.paperId);
      if (body.mode !== undefined && !['first', 'review'].includes(body.mode)) fail('练习模式无效');
      const previous = store.list('attempt').filter(a => a.paperId === paper.id);
      const draft = previous.find(a => a.status === 'draft');
      if (draft) return send(response, 200, draft);
      const mode = previous.some(a => a.status === 'submitted') || body.mode === 'review' ? 'review' : 'first';
      const attempt = { id: randomUUID(), paperId: paper.id, mode, status: 'draft', answers: {}, assisted: false, createdAt: store.iso() };
      return send(response, 201, store.put('attempt', attempt.id, attempt));
    }
    match = /^\/api\/attempts\/([^/]+)(\/submit)?$/.exec(route);
    if (match && method === 'PATCH' && !match[2]) {
      const attempt = getAttempt(decodeURIComponent(match[1]));
      if (attempt.status === 'submitted') fail('已提交的练习不能修改，请开始复习练习', 409);
      const body = await jsonBody(request), paper = paperById(attempt.paperId);
      if (body.answers !== undefined) {
        validateAnswers(body.answers, paper);
        for (const [id, answer] of Object.entries(body.answers)) { if (answer === null) delete attempt.answers[id]; else attempt.answers[id] = answer; }
      }
      if (body.assisted !== undefined) {
        if (typeof body.assisted !== 'boolean') fail('辅助练习标记无效');
        attempt.assisted = attempt.assisted || body.assisted;
      }
      return send(response, 200, store.put('attempt', attempt.id, attempt));
    }
    if (match && method === 'POST' && match[2]) return send(response, 200, submitAttempt(getAttempt(decodeURIComponent(match[1]))));
    if (method === 'GET' && route === '/api/progress') return send(response, 200, store.list('progress'));
    match = /^\/api\/progress\/([^/]+)$/.exec(route);
    if (method === 'PUT' && match) {
      const paperId = decodeURIComponent(match[1]), paper = paperById(paperId), body = await jsonBody(request);
      number(body.position, '播放位置', 0, paper.duration || 14400); number(body.rate, '倍速', 0.25, 4);
      const sentenceId = store.sentenceAliases.resolve(paperId, body.sentenceId);
      if (sentenceId !== undefined && sentenceId !== null && !paper.passages.some(p => p.sentences.some(s => s.id === sentenceId))) fail('当前句不存在');
      if (body.loopMode !== undefined && !['off', 'sentence', 'ab', 'all'].includes(body.loopMode)) fail('循环模式无效');
      const progress = { paperId, position: body.position, rate: body.rate, loopMode: body.loopMode || 'off', updatedAt: store.iso() };
      if (sentenceId) progress.sentenceId = sentenceId;
      return send(response, 200, store.put('progress', paperId, progress));
    }
    if (method === 'GET' && route === '/api/stats') return send(response, 200, store.stats());
    if (method === 'POST' && route === '/api/listening') {
      const body = await jsonBody(request); paperById(body.paperId); number(body.seconds, '实际播放秒数', 0, 15);
      return send(response, 200, store.addListening(body.paperId, body.seconds));
    }
    if (method === 'GET' && route === '/api/annotations') return send(response, 200, store.list('annotation'));
    match = /^\/api\/annotations\/([^/]+)$/.exec(route);
    if (match && method === 'PUT') {
      const id = annotationIdentifier(decodeURIComponent(match[1])), body = await jsonBody(request), paper = paperById(body.paperId);
      text(body.text, '笔记', MERGED_NOTE_LIMIT); if (typeof body.favorite !== 'boolean') fail('收藏状态无效');
      const sentenceId = store.sentenceAliases.resolve(paper.id, body.sentenceId);
      if (body.sentenceId !== undefined && !paper.passages.some(p => p.sentences.some(s => s.id === sentenceId))) fail('关联句子不存在');
      if (body.questionId !== undefined && !paper.questions.some(q => q.id === body.questionId)) fail('关联题目不存在');
      if (body.reason !== undefined) text(body.reason, '错因', MERGED_REASON_LIMIT);
      const annotation = { id, paperId: paper.id, text: body.text, favorite: body.favorite, updatedAt: store.iso() };
      for (const key of ['sentenceId', 'questionId', 'reason']) if (body[key] !== undefined) annotation[key] = body[key];
      return send(response, 200, store.saveAnnotation(annotation));
    }
    if (match && method === 'DELETE') { const id = annotationIdentifier(decodeURIComponent(match[1])); store.remove('annotation', store.resolveAnnotationId(id)); return send(response, 200, { ok: true }); }
    if (method === 'GET' && route === '/api/backup/export') return send(response, 200, store.exportRecords(), { 'Content-Disposition': 'attachment; filename="cet6-learning-backup.json"' });
    if (method === 'POST' && route === '/api/backup/import') return send(response, 200, store.importRecords(await jsonBody(request, 32 * 1024 * 1024)));
    if (method === 'GET' && route === '/api/backups') {
      const items = readdirSync(store.backupDir).filter(name => name.endsWith('.json')).sort().reverse().map(name => ({ name, size: statSync(path.join(store.backupDir, name)).size, createdAt: statSync(path.join(store.backupDir, name)).mtime.toISOString() }));
      return send(response, 200, items);
    }
    if (method === 'GET' && route === '/api/backup/full') {
      // Copy the records into an immutable buffer before the ZIP preflight.
      const entries = [{ name: 'learning-records.json', data: Buffer.from(JSON.stringify(store.exportRecords(), null, 2), 'utf8') }, ...walkFiles(dataDir)];
      return writeZip(response, entries);
    }
    match = /^\/api\/papers\/([^/]+)\/timing$/.exec(route);
    if (method === 'PUT' && match) {
      const id = decodeURIComponent(match[1]), paper = paperById(id), body = await jsonBody(request, 8 * 1024 * 1024);
      if (!Array.isArray(body.passages) || body.passages.length !== paper.passages.length) fail('必须提交与试卷一致的全部篇章');
      if (body.markVerified !== undefined && typeof body.markVerified !== 'boolean') fail('校对完成标记无效');
      const passages = paper.passages.map((old, index) => {
        const updated = body.passages[index];
        if (updated?.id !== old.id || !Array.isArray(updated.sentences)) fail('篇章顺序或编号与试卷不一致');
        if (old.sentences.length !== updated.sentences.length || old.sentences.some((sentence, i) => sentence.id !== updated.sentences[i]?.id)) fail('时间校对不能改变稳定句子编号或数量');
        return { ...old, start: updated.start, end: updated.end, sentences: updated.sentences.map((s, sentenceIndex) => ({ ...old.sentences[sentenceIndex], id: s.id, start: s.start, end: s.end, text: s.text, ...(s.translation !== undefined ? { translation: s.translation } : {}), reviewed: s.reviewed })) };
      });
      // A manual confirmation covers both transcript wording and its timestamps.
      // Requiring a previously verified transcript here would make first-time
      // proofreading impossible because this is the only proofreading endpoint.
      const changed = { ...paper, passages, quality: { ...paper.quality, transcript: body.markVerified ? 'verified' : 'candidate', timing: body.markVerified ? 'verified' : 'candidate' } };
      if (body.markVerified && (['audio', 'questions', 'answers'].some(key => changed.quality[key] !== 'verified') || changed.questions.length !== 25 || changed.passages.length !== 7 || !usableAudio(changed))) fail('音频、试题、答案必须核验完成且音频可用，才能完成人工原文和时间轴核验', 409);
      validateTimings(changed, passages, { strict: !!body.markVerified }); validatePaper(changed);
      const paperFile = safeFile(paperDirectory, `${id}.json`);
      const backupDirectory = path.join(dataDir, 'paper-backups'); mkdirSync(backupDirectory, { recursive: true });
      copyFileSync(paperFile, path.join(backupDirectory, `${id}-${Date.now()}-${randomUUID().slice(0, 6)}.json`));
      atomicJson(paperFile, changed);
      return send(response, 200, changed);
    }
    if (method === 'POST' && route === '/api/import') {
      const body = await jsonBody(request, 140 * 1024 * 1024);
      let paper = validatePaper(body.paper);
      const assets = readAssets();
      if (body.audioBase64 !== undefined) {
        // Avoid a repeated multi-character regular-expression group: V8 can
        // exhaust its regexp stack on normal 12+ MB audio files.
        const encoded = body.audioBase64;
        const padding = typeof encoded === 'string' ? (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) : 0;
        if (typeof encoded !== 'string' || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding))) fail('音频 Base64 格式无效');
        const audio = Buffer.from(body.audioBase64, 'base64');
        if (!audio.length || audio.length > 100 * 1024 * 1024) fail('音频文件必须大于 0 且不超过 100 MB', 413);
        if (typeof body.audioName !== 'string') fail('请提供音频文件名');
        const extension = path.extname(body.audioName).toLowerCase();
        if (!['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.mp4'].includes(extension)) fail('不支持该音频格式');
        const hash = createHash('sha256').update(audio).digest('hex');
        const existing = Object.entries(assets).find(([, value]) => value.sha256 === hash);
        const assetId = existing ? existing[0] : hash;
        const relative = existing ? existing[1].path : `media/${hash}${extension}`;
        if (existing) safeFile(dataDir, relative);
        else {
          mkdirSync(path.join(dataDir, 'media'), { recursive: true });
          writeFileSync(path.join(dataDir, relative), audio, { flag: 'wx' });
          assets[assetId] = { path: relative, mime: MIME[extension], size: audio.length, sha256: hash, duration: paper.duration };
        }
        paper = { ...paper, audioAssetId: assetId };
      }
      if (paper.audioAssetId && !assets[paper.audioAssetId]) fail('音频索引不存在，请同时导入音频');
      if (paper.quality.audio === 'verified' && !paper.audioAssetId) fail('已核验音频必须关联真实文件');
      if (paper.audioAssetId) {
        const asset = assets[paper.audioAssetId];
        if (!/^media[\\/]/.test(asset.path)) fail('音频文件必须位于 media 目录');
        if (statSync(safeFile(dataDir, asset.path)).size === 0) fail('音频文件为空');
      }
      mkdirSync(paperDirectory, { recursive: true });
      const paperFile = path.join(paperDirectory, `${paper.id}.json`);
      if (existsSync(paperFile)) {
        const current = paperById(paper.id);
        if (current.audioAssetId && current.audioAssetId !== paper.audioAssetId) {
          paper.quality.timing = 'candidate';
          paper.passages = paper.passages.map(passage => ({ ...passage, sentences: passage.sentences.map(sentence => ({ ...sentence, reviewed: false })) }));
        }
        // Stable identities prevent a re-import from silently pointing old answers at different text.
        const currentIds = new Set(current.questions.map(q => q.id));
        const replacementIds = new Set(paper.questions.map(q => q.id));
        const usedQuestions = new Set(store.list('attempt').filter(a => a.paperId === paper.id).flatMap(a => Object.keys(a.answers)));
        const usedSentences = new Set(store.list('annotation').filter(a => a.paperId === paper.id && a.sentenceId).map(a => a.sentenceId));
        const replacementSentenceIds = new Set(paper.passages.flatMap(p => p.sentences).map(s => s.id));
        if ([...usedQuestions].some(id => currentIds.has(id) && !replacementIds.has(id)) || [...usedSentences].some(id => !replacementSentenceIds.has(id))) fail('重新导入会失去已使用的稳定题目或句子编号，请先统一编号', 409);
        const backupDirectory = path.join(dataDir, 'paper-backups'); mkdirSync(backupDirectory, { recursive: true });
        copyFileSync(paperFile, path.join(backupDirectory, `${paper.id}-${Date.now()}-${randomUUID().slice(0, 6)}.json`));
      }
      atomicJson(assetManifest, assets); atomicJson(paperFile, paper);
      return send(response, 201, { ok: true, paper: summary(paper) });
    }
    fail('接口不存在', 404);
  }
  const handler = async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      secureLocalRequest(request);
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname.startsWith('/api/')) return await api(request, response, url);
      const mediaMatch = /^\/media\/([^/]+)$/.exec(url.pathname);
      if (mediaMatch && ['GET', 'HEAD'].includes(request.method)) {
        const assetId = identifier(decodeURIComponent(mediaMatch[1]), '音频'), asset = readAssets()[assetId];
        if (!asset || typeof asset.path !== 'string') fail('音频尚未导入', 404);
        if (!/^media[\\/]/.test(asset.path)) fail('音频路径无效', 403);
        const file = safeFile(dataDir, asset.path);
        return streamFile(request, response, file, typeof asset.mime === 'string' && /^audio\/[a-z0-9.+-]+$/i.test(asset.mime) ? asset.mime : (MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'), { range: true });
      }
      if (!['GET', 'HEAD'].includes(request.method)) fail('不支持的请求方法', 405);
      if (!existsSync(distDir)) {
        if (url.pathname !== '/') fail('页面不存在', 404);
        const html = Buffer.from('<!doctype html><meta charset="utf-8"><title>六级听力工作室</title><h1>六级听力服务已启动</h1><p>请先构建网页，或在开发模式打开 http://127.0.0.1:5173。</p>');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length }); response.end(request.method === 'HEAD' ? undefined : html); return;
      }
      let relative;
      try { relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'; } catch { fail('页面地址无效'); }
      let file;
      try { file = safeFile(distDir, relative); } catch (error) { if (error.status !== 404 || path.extname(relative)) throw error; file = safeFile(distDir, 'index.html'); }
      streamFile(request, response, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (!error.status) console.error('[local-server]', error);
      send(response, error.status || 500, { error: error.status ? error.message : '本地服务处理失败，请检查资料或重启服务' });
    }
  };
  handler.store = store; handler.dataDir = dataDir; handler.close = () => store.close();
  return handler;
}

export function createServer(options = {}) {
  const app = createApp(options);
  const server = http.createServer({ requestTimeout: 120000, headersTimeout: 15000 }, app);
  server.app = app;
  server.on('close', () => app.close());
  return server;
}
export async function startServer(options = {}) {
  const port = options.port ?? Number(process.env.CET6_PORT || 3260);
  const server = createServer(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = `http://127.0.0.1:${server.address().port}`;
  console.log(`六级听力工作室已启动：${address}`);
  if (options.open) {
    const opener = process.platform === 'win32' ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', address], { detached: true, stdio: 'ignore', windowsHide: true }) : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [address], { detached: true, stdio: 'ignore' });
    opener.on('error', () => console.log(`请在浏览器打开 ${address}`)); opener.unref();
  }
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer({ open: process.argv.includes('--open') }).then(server => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  }).catch(error => { console.error(error.code === 'EADDRINUSE' ? '端口 3260 已被占用。如服务已运行，请直接打开 http://127.0.0.1:3260。' : error.message); process.exitCode = 1; });
}
