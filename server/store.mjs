import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { annotationIdentifier, array, clone, fail, identifier, isObject, number, optionSet, text, types } from './validation.mjs';
import { loadSentenceAliases, planAnnotationAliases, recordStamp, validateAliasMerge, MERGED_NOTE_LIMIT, MERGED_REASON_LIMIT } from './sentence-aliases.mjs';

export function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temporary, file);
}

export function createStore({ dataDir, now = () => new Date(), automaticBackup = true }) {
  mkdirSync(dataDir, { recursive: true });
  const sentenceAliases = loadSentenceAliases(dataDir);
  const backupDir = path.join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'learning.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS listening(paper_id TEXT PRIMARY KEY,seconds REAL NOT NULL); PRAGMA user_version=1;');
  const getStatement = db.prepare('SELECT json FROM records WHERE kind=? AND id=?');
  const listStatement = db.prepare('SELECT json FROM records WHERE kind=? ORDER BY rowid');
  const putStatement = db.prepare('INSERT INTO records(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json');
  const iso = () => now().toISOString();
  const get = (kind, id) => { const row = getStatement.get(kind, id); return row ? JSON.parse(row.json) : null; };
  const list = kind => listStatement.all(kind).map(row => JSON.parse(row.json));
  const put = (kind, id, record) => { putStatement.run(kind, id, JSON.stringify(record)); return record; };
  const remove = (kind, id) => db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  const stats = () => {
    const byPaper = Object.fromEntries(db.prepare('SELECT paper_id,seconds FROM listening ORDER BY paper_id').all().map(row => [row.paper_id, row.seconds]));
    return { listeningSeconds: Object.values(byPaper).reduce((total, seconds) => total + seconds, 0), byPaper };
  };
  const addListening = (paperId, seconds) => {
    db.prepare('INSERT INTO listening(paper_id,seconds) VALUES(?,?) ON CONFLICT(paper_id) DO UPDATE SET seconds=seconds+excluded.seconds').run(paperId, seconds);
    return stats();
  };
  const exportRecords = () => ({ format: 'cet6-listening-studio', schemaVersion: 1, exportedAt: iso(), attempts: list('attempt'), progress: list('progress'), annotations: list('annotation'), stats: stats(), sentenceAliasMigrations: list('sentence-alias-migration') });
  const backup = (prefix = 'manual') => {
    const stamp = iso().replaceAll(':', '-').replaceAll('.', '-');
    const filename = prefix === 'auto' ? `auto-${iso().slice(0, 10)}.json` : `${prefix}-${stamp}-${randomUUID().slice(0, 6)}.json`;
    const file = path.join(backupDir, filename);
    if (!existsSync(file)) atomicJson(file, exportRecords());
    if (prefix === 'auto') {
      const files = readdirSync(backupDir).filter(name => /^auto-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
      for (const old of files.slice(7)) unlinkSync(path.join(backupDir, old));
    }
    return filename;
  };
  function validateBackup(value) {
    if (!isObject(value) || value.format !== 'cet6-listening-studio' || value.schemaVersion !== 1) fail('备份格式或版本不受支持');
    array(value.attempts, '作答记录', 100000); array(value.progress, '播放记录', 100000); array(value.annotations, '笔记', 100000);
    for (const attempt of value.attempts) {
      identifier(attempt.id); identifier(attempt.paperId);
      if (!['first', 'review'].includes(attempt.mode) || !['draft', 'submitted'].includes(attempt.status) || typeof attempt.assisted !== 'boolean' || !isObject(attempt.answers)) fail('备份作答记录无效');
      if (typeof attempt.createdAt !== 'string' || !Number.isFinite(Date.parse(attempt.createdAt))) fail('备份创建时间无效');
      for (const [key, option] of Object.entries(attempt.answers)) { identifier(key); if (!optionSet.has(option)) fail('备份答案无效'); }
      if (attempt.status === 'submitted') {
        if (!Number.isFinite(Date.parse(attempt.submittedAt)) || !isObject(attempt.result)) fail('备份批改结果无效');
        const result = attempt.result;
        number(result.total, '总题数', 0, 200); number(result.correct, '答对数', 0, result.total); number(result.unanswered, '未答数', 0, result.total);
        if (result.correct + result.unanswered > result.total || !isObject(result.byType)) fail('备份批改统计无效');
        let total = 0, correct = 0;
        for (const type of types) { const row = result.byType[type]; if (!isObject(row)) fail('备份题型统计无效'); number(row.total, '题型总数', 0, 200); number(row.correct, '题型正确数', 0, row.total); total += row.total; correct += row.correct; }
        if (total !== result.total || correct !== result.correct) fail('备份题型统计不一致');
      }
    }
    for (const progress of value.progress) {
      identifier(progress.paperId); number(progress.position, '播放位置', 0, 14400); number(progress.rate, '倍速', 0.25, 4);
      if (progress.sentenceId !== undefined && progress.sentenceId !== null) identifier(progress.sentenceId);
      if (progress.loopMode !== undefined && !['off', 'sentence', 'ab', 'all'].includes(progress.loopMode)) fail('备份循环设置无效');
      if (!Number.isFinite(Date.parse(progress.updatedAt))) fail('备份更新时间无效');
    }
    for (const annotation of value.annotations) {
      annotationIdentifier(annotation.id); identifier(annotation.paperId); text(annotation.text, '笔记', MERGED_NOTE_LIMIT);
      if (typeof annotation.favorite !== 'boolean' || !Number.isFinite(Date.parse(annotation.updatedAt))) fail('备份笔记无效');
      if (annotation.sentenceId !== undefined) identifier(annotation.sentenceId);
      if (annotation.questionId !== undefined) identifier(annotation.questionId);
      if (annotation.reason !== undefined) text(annotation.reason, '错因', MERGED_REASON_LIMIT);
      try { validateAliasMerge(annotation.sentenceAliasMerge); } catch (error) { fail(error.message); }
    }
    if (value.sentenceAliasMigrations !== undefined) {
      array(value.sentenceAliasMigrations, '历史句子迁移记录', 100000);
      for (const migration of value.sentenceAliasMigrations) {
        if (!isObject(migration) || !Number.isFinite(Date.parse(migration.createdAt))) fail('历史句子迁移记录无效');
        identifier(migration.id);
      }
    }
    if (!isObject(value.stats) || !isObject(value.stats.byPaper)) fail('备份播放时长无效');
    for (const [paperId, seconds] of Object.entries(value.stats.byPaper)) { identifier(paperId); number(seconds, '播放时长'); }
    return clone(value);
  }
  function applyAliasChanges(annotationPlan, backupName, trigger, importedProgress = []) {
    const annotations = [], progress = [...importedProgress];
    for (const group of annotationPlan) {
      const staleIds = group.ids.filter(id => id !== group.annotation.id && get('annotation', id));
      if (staleIds.length || !isDeepStrictEqual(get('annotation', group.annotation.id), group.annotation)) {
        for (const id of staleIds) remove('annotation', id);
        put('annotation', group.annotation.id, group.annotation);
        annotations.push({ paperId: group.paperId, sourceAnnotationIds: group.ids, targetAnnotationId: group.annotation.id,
          targetSentenceId: group.targetSentenceId, preservedNotes: group.annotation.sentenceAliasMerge.noteTexts.length,
          preservedReasons: group.annotation.sentenceAliasMerge.reasons.length });
      }
    }
    for (const current of list('progress')) {
      const target = sentenceAliases.resolve(current.paperId, current.sentenceId);
      if (target !== current.sentenceId) {
        put('progress', current.paperId, { ...current, sentenceId: target });
        progress.push({ paperId: current.paperId, fromSentenceId: current.sentenceId, toSentenceId: target, position: current.position });
      }
    }
    if (annotations.length || progress.length) {
      const migration = { id: randomUUID(), createdAt: iso(), trigger, aliasRevision: sentenceAliases.revision,
        backup: backupName, annotations, progress };
      put('sentence-alias-migration', migration.id, migration);
      return migration;
    }
    return null;
  }
  const saveAnnotation = record => {
    if (!record.sentenceId || sentenceAliases.resolve(record.paperId, record.sentenceId) === record.sentenceId) {
      return put('annotation', record.id, { ...get('annotation', record.id), ...record });
    }
    const plan = planAnnotationAliases(sentenceAliases, [...list('annotation'), record], iso());
    const backupName = backup('before-sentence-alias-write');
    db.exec('BEGIN IMMEDIATE');
    try {
      applyAliasChanges(plan, backupName, 'legacy-annotation-save'); db.exec('COMMIT');
      return get('annotation', plan.find(group => group.paperId === record.paperId && group.targetSentenceId === sentenceAliases.resolve(record.paperId, record.sentenceId)).annotation.id);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const resolveAnnotationId = id => {
    if (get('annotation', id)) return id;
    const parts = id.split(':s:');
    if (parts.length === 2) return `${parts[0]}:s:${sentenceAliases.resolve(parts[0], parts[1])}`;
    return list('annotation').find(record => record.sentenceAliasMerge?.sourceAnnotations.some(source => source.id === id))?.id || id;
  };
  const migrateSentenceAliases = () => {
    const plan = planAnnotationAliases(sentenceAliases, list('annotation'), iso());
    const progressNeedsMigration = list('progress').some(record => sentenceAliases.resolve(record.paperId, record.sentenceId) !== record.sentenceId);
    if (!plan.length && !progressNeedsMigration) return { changed: false };
    const backupName = backup('before-sentence-alias-migration');
    db.exec('BEGIN IMMEDIATE');
    try {
      const migration = applyAliasChanges(plan, backupName, 'startup'); db.exec('COMMIT');
      return { changed: Boolean(migration), migration };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const importRecords = input => {
    const value = validateBackup(input);
    const backupName = backup('before-import');
    // Plan against BOTH old and new records before a timestamp-based upsert can
    // overwrite a note belonging to a historical sentence or its current target.
    const aliasPlan = planAnnotationAliases(sentenceAliases, [...list('annotation'), ...value.annotations], iso());
    const handledAnnotationIds = new Set(aliasPlan.flatMap(group => group.ids));
    db.exec('BEGIN IMMEDIATE');
    try {
      const importedProgress = [];
      for (const [kind, records, key] of [['attempt', value.attempts, 'id'], ['progress', value.progress, 'paperId'], ['annotation', value.annotations, 'id']]) {
        for (const record of records) {
          if (kind === 'annotation' && handledAnnotationIds.has(record.id)) continue;
          const current = get(kind, record[key]);
          // A submitted attempt is immutable. A stale import cannot turn it into a draft.
          if (kind === 'attempt' && current?.status === 'submitted') continue;
          if (!current || recordStamp(record) >= recordStamp(current)) {
            const target = kind === 'progress' ? sentenceAliases.resolve(record.paperId, record.sentenceId) : record.sentenceId;
            const normalized = kind === 'progress' && target !== record.sentenceId ? { ...record, sentenceId: target } : record;
            if (kind === 'progress' && target !== record.sentenceId && !isDeepStrictEqual(current, normalized)) importedProgress.push({ paperId: record.paperId, fromSentenceId: record.sentenceId, toSentenceId: target, position: record.position });
            put(kind, record[key], normalized);
          }
        }
      }
      for (const migration of value.sentenceAliasMigrations || []) if (!get('sentence-alias-migration', migration.id)) put('sentence-alias-migration', migration.id, migration);
      applyAliasChanges(aliasPlan, backupName, 'backup-import', importedProgress);
      for (const [paperId, seconds] of Object.entries(value.stats.byPaper)) db.prepare('INSERT INTO listening(paper_id,seconds) VALUES(?,?) ON CONFLICT(paper_id) DO UPDATE SET seconds=MAX(seconds,excluded.seconds)').run(paperId, seconds);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { ok: true, imported: { attempts: value.attempts.length, progress: value.progress.length, annotations: value.annotations.length } };
  };
  if (automaticBackup) backup('auto');
  try { migrateSentenceAliases(); } catch (error) { db.close(); throw error; }
  return { db, iso, get, list, put, remove, stats, addListening, exportRecords, importRecords, backup, backupDir,
    sentenceAliases, migrateSentenceAliases, saveAnnotation, resolveAnnotationId, close: () => db.close() };
}
