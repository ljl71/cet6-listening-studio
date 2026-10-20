import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { annotationIdentifier, identifier, isObject, text } from './validation.mjs';

export const MERGED_NOTE_LIMIT = 4_000_000;
export const MERGED_REASON_LIMIT = 20_000;
const groupKey = (paperId, sentenceId) => `${paperId}\0${sentenceId}`;
const sameText = value => value.replaceAll('\r\n', '\n').trim();
const distinct = values => [...new Map(values.filter(value => typeof value === 'string' && value.trim()).map(value => [sameText(value), value])).values()];
const distinctObjects = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
export const recordStamp = row => Date.parse(row?.submittedAt || row?.updatedAt || row?.createdAt || '') || 0;

export function loadSentenceAliases(dataDir) {
  const file = path.join(dataDir, 'sentence-aliases.json');
  const source = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const manifest = source ? JSON.parse(source) : { format: 'cet6-sentence-aliases', schemaVersion: 1, aliases: [] };
  if (manifest.format !== 'cet6-sentence-aliases' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.aliases)) throw new Error('句子别名索引格式无效');
  const entries = new Map();
  for (const entry of manifest.aliases) {
    if (!isObject(entry)) throw new Error('句子别名项无效');
    identifier(entry.paperId); identifier(entry.fromSentenceId); identifier(entry.toSentenceId);
    const key = groupKey(entry.paperId, entry.fromSentenceId);
    if (entry.fromSentenceId === entry.toSentenceId || entries.has(key)) throw new Error('句子别名重复或指向自身');
    entries.set(key, { paperId: entry.paperId, fromSentenceId: entry.fromSentenceId, toSentenceId: entry.toSentenceId });
  }
  function resolve(paperId, sentenceId) {
    if (!sentenceId) return sentenceId;
    let current = sentenceId; const visited = new Set();
    while (entries.has(groupKey(paperId, current))) {
      if (visited.has(current)) throw new Error('句子别名形成循环');
      visited.add(current); current = entries.get(groupKey(paperId, current)).toSentenceId;
    }
    return current;
  }
  const targets = new Set([...entries.values()].map(entry => groupKey(entry.paperId, resolve(entry.paperId, entry.toSentenceId))));
  return { file, manifest, entries, revision: source ? createHash('sha256').update(source).digest('hex') : null, resolve,
    related: (paperId, sentenceId) => entries.has(groupKey(paperId, sentenceId)) || targets.has(groupKey(paperId, sentenceId)) };
}

// Metadata keeps the original individual notes, rather than reparsing a rendered
// merge header. Restoring the same old backup therefore cannot nest/duplicate it.
export function validateAliasMerge(value) {
  if (value === undefined) return;
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.noteTexts) || !Array.isArray(value.reasons) ||
      !Array.isArray(value.sourceAnnotations) || !Array.isArray(value.aliasMappings) || !Number.isFinite(Date.parse(value.migratedAt))) throw new Error('历史句子合并信息无效');
  if (value.noteTexts.length > 10000 || value.reasons.length > 10000 || value.sourceAnnotations.length > 10000 || value.aliasMappings.length > 10000) throw new Error('历史句子合并信息过大');
  for (const note of value.noteTexts) text(note, '历史笔记', MERGED_NOTE_LIMIT);
  for (const reason of value.reasons) text(reason, '历史错因', MERGED_REASON_LIMIT);
  text(value.renderedText, '历史笔记', MERGED_NOTE_LIMIT); text(value.renderedReason, '历史错因', MERGED_REASON_LIMIT);
  for (const source of value.sourceAnnotations) {
    if (!isObject(source)) throw new Error('历史笔记来源无效');
    annotationIdentifier(source.id); identifier(source.sentenceId);
    if (!Number.isFinite(Date.parse(source.updatedAt))) throw new Error('历史笔记来源时间无效');
  }
  for (const entry of value.aliasMappings) {
    if (!isObject(entry)) throw new Error('历史句子映射无效');
    identifier(entry.fromSentenceId); identifier(entry.toSentenceId);
  }
}

export function planAnnotationAliases(aliases, records, now) {
  const groups = new Map();
  for (const record of records) {
    if (!record.sentenceId || !aliases.related(record.paperId, record.sentenceId)) continue;
    const target = aliases.resolve(record.paperId, record.sentenceId), key = groupKey(record.paperId, target);
    if (!groups.has(key)) groups.set(key, { paperId: record.paperId, target, records: [] });
    groups.get(key).records.push(record);
  }
  const changes = [];
  for (const group of groups.values()) {
    const migrated = group.records.some(record => record.sentenceId !== group.target);
    if (!migrated && !(group.records.length > 1 && group.records.some(record => record.sentenceAliasMerge))) continue;
    const id = `${group.paperId}:s:${group.target}`;
    // Never replace an unrelated arbitrary annotation that happens to own the UI key.
    if (records.some(record => record.id === id && (record.paperId !== group.paperId || aliases.resolve(record.paperId, record.sentenceId) !== group.target))) throw new Error('历史笔记目标编号与其他记录冲突，已保留原记录');
    const ordered = group.records.toSorted((a, b) => (a.id === id ? 0 : 1) - (b.id === id ? 0 : 1) || a.id.localeCompare(b.id) || recordStamp(a) - recordStamp(b));
    const notes = [], reasons = [], sources = [], mappings = [], migratedAt = [];
    for (const record of ordered) {
      const metadata = record.sentenceAliasMerge;
      if (metadata) {
        validateAliasMerge(metadata); notes.push(...metadata.noteTexts); reasons.push(...metadata.reasons);
        sources.push(...metadata.sourceAnnotations); mappings.push(...metadata.aliasMappings); migratedAt.push(metadata.migratedAt);
        if (record.text !== metadata.renderedText) notes.push(record.text);
        if ((record.reason || '') !== metadata.renderedReason) reasons.push(record.reason || '');
      } else {
        notes.push(record.text); reasons.push(record.reason || '');
        sources.push({ id: record.id, sentenceId: record.sentenceId, updatedAt: record.updatedAt });
      }
      let oldId = record.sentenceId;
      while (aliases.entries.has(groupKey(group.paperId, oldId))) {
        const next = aliases.entries.get(groupKey(group.paperId, oldId)).toSentenceId;
        mappings.push({ fromSentenceId: oldId, toSentenceId: next }); oldId = next;
      }
    }
    const noteTexts = distinct(notes), allReasons = distinct(reasons);
    const renderedText = noteTexts.length ? `[历史合并 · 保留 ${noteTexts.length} 段笔记]\n${noteTexts.map((note, index) => `【${index + 1}】${note}`).join('\n\n')}` : '';
    const renderedReason = allReasons.length > 1 ? `[历史合并] ${allReasons.join('；')}` : allReasons[0] || '';
    text(renderedText, '合并笔记', MERGED_NOTE_LIMIT); text(renderedReason, '合并错因', MERGED_REASON_LIMIT);
    const newest = ordered.reduce((a, b) => recordStamp(b) > recordStamp(a) ? b : a);
    const annotation = { ...newest, id, paperId: group.paperId, sentenceId: group.target, text: renderedText,
      favorite: ordered.some(record => record.favorite), updatedAt: newest.updatedAt,
      sentenceAliasMerge: { version: 1, aliasRevision: aliases.revision, noteTexts, reasons: allReasons,
        renderedText, renderedReason,
        sourceAnnotations: distinctObjects(sources).sort((a, b) => a.id.localeCompare(b.id) || a.updatedAt.localeCompare(b.updatedAt)),
        aliasMappings: distinctObjects(mappings).sort((a, b) => a.fromSentenceId.localeCompare(b.fromSentenceId)),
        migratedAt: migratedAt.sort()[0] || now } };
    if (renderedReason) annotation.reason = renderedReason; else delete annotation.reason;
    changes.push({ paperId: group.paperId, targetSentenceId: group.target, ids: [...new Set(ordered.map(record => record.id))], annotation });
  }
  return changes;
}
