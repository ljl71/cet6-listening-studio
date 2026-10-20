import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const THRESHOLDS = Object.freeze({ firstAndLastWordScore: 0.8, meanWordScore: 0.85,
  minimumWordScore: 0.4, independentExactWordFraction: 0.85, maxIndependentWordErrorRate: 0.15, boundaryAnchorWords: 2,
  maxWordGapSeconds: 1.5, maxWordDurationSeconds: 1.5, minWordDurationSeconds: 0.02,
  maxOverlapSeconds: 0.03, boundaryDriftSeconds: 0.3, largeBoundaryDriftSeconds: 2 });

function numberWords(value) {
  const small = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
  const tens = 'zero ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
  const n = Number(value);
  if (n < 20) return [small[n]];
  if (n < 100) return [tens[Math.floor(n / 10)], ...(n % 10 ? numberWords(n % 10) : [])];
  if (n < 1000) return [small[Math.floor(n / 100)], 'hundred', ...(n % 100 ? numberWords(n % 100) : [])];
  if (n < 1e6) return [...numberWords(Math.floor(n / 1000)), 'thousand', ...(n % 1000 ? numberWords(n % 1000) : [])];
  return String(value).split('').map(c => small[Number(c)]);
}

function numberReading(value, hint) {
  const canonical = numberWords(value), n = Number(value), variants = [canonical];
  if (n >= 1000 && n < 2100) {
    if (n % 100 === 0) variants.push([...numberWords(Math.floor(n / 100)), 'hundred']);
    else if (n < 2000 || n >= 2010) variants.push([...numberWords(Math.floor(n / 100)), ...(n % 100 < 10 ? ['oh'] : []), ...numberWords(n % 100)]);
    if (n > 2000 && n < 2010) variants.push(['two', 'thousand', 'and', ...numberWords(n % 1000)]);
  }
  return variants.find(words => ` ${hint.toUpperCase()} `.includes(` ${words.join(' ').toUpperCase()} `)) ?? canonical;
}

// Same lexical normalization as acoustic-review.py; source spelling is retained in the report.
export function spokenWords(value, options = {}) {
  if (typeof options === 'string') options = { hint: options, version: 2 };
  const { version = 1, hint = '', normalizations = [] } = options;
  const substitutions = { MR: 'MISTER', MRS: 'MISSUS', MS: 'MISS', DR: 'DOCTOR', PROF: 'PROFESSOR', OK: 'OKAY' };
  let text = String(value ?? '').replace(/^[WM]:\s*/i, '').replaceAll('’', "'").replace(/[\u2010-\u2015\u2026]/g, ' ')
    .replace(/(?<=\d),(?=\d)/g, '').replaceAll('%', ' percent ');
  if (version >= 3) {
    if (` ${hint.toUpperCase()} `.includes(' A HUNDRED ')) text = text.replace(/\ba\s+100(?=[-\s]|$)/gi, source => {
      normalizations.push({ type: 'numeric-spoken-rendering-normalization', kind: 'article-a-hundred-reading', source,
        spoken: 'a hundred', basis: 'The source article A plus 100 equals A HUNDRED, observed as a strict phrase in independent greedy ASR.' });
      return 'a hundred';
    });
    text = text.replace(/(?<![A-Za-z])mph\s*\(\s*miles\s+per\s+hour\s*\)/gi, source => {
      normalizations.push({ type: 'abbreviation-spoken-rendering-normalization', kind: 'mph-parenthetical-deduplication', source, spoken: 'miles per hour', expansionCount: 1 });
      return ' miles per hour ';
    });
    text = text.replace(/(?<![A-Za-z])mph(?![A-Za-z])/gi, source => {
      normalizations.push({ type: 'abbreviation-spoken-rendering-normalization', kind: 'mph-expansion', source, spoken: 'miles per hour', expansionCount: 1 });
      return ' miles per hour ';
    });
  }
  for (const [symbol, unit] of [['$', 'dollars'], ['£', 'pounds'], ['€', 'euros']]) {
    if (version >= 2) text = text.replace(new RegExp(`\\${symbol}\\s*(\\d+(?:\\.\\d+)?)(\\s+(?:million|billion|thousand))?`, 'gi'), (source, amount, scale = '') => {
      const spoken = `${amount}${scale} ${unit}`;
      if (scale) normalizations.push({ type: 'numeric-spoken-rendering-normalization', kind: 'currency-scale-unit-order', source, spoken });
      return spoken;
    });
    else text = text.replace(new RegExp(`\\${symbol}\\s*(\\d+(?:\\.\\d+)?)`, 'g'), `$1 ${unit}`);
  }
  text = text.normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
  return [...text.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?/g)].flatMap(([part]) => {
    if (!/^\d/.test(part)) return [substitutions[part.toUpperCase()] ?? part.toUpperCase()];
    const [integer, decimal] = part.split('.');
    const canonical = numberWords(integer), selected = version >= 2 ? numberReading(integer, hint) : canonical;
    if (selected.join(' ') !== canonical.join(' ')) normalizations.push({ type: 'numeric-spoken-rendering-normalization', kind: 'equal-valued-year-or-hundreds-reading',
      source: integer, canonical: canonical.join(' ').toUpperCase(), spoken: selected.join(' ').toUpperCase(), basis: 'Strict whole phrase occurs in independent greedy ASR.' });
    return [...selected, ...(decimal === undefined ? [] : ['point', ...[...decimal].flatMap(numberWords)])].map(w => w.toUpperCase());
  });
}

function lexicalEquivalences(words, normalizations) {
  const result = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === 'NONE' && words[i + 1] === 'THE' && words[i + 2] === 'LESS') {
      normalizations.push({ type: 'explicit-word-division-equivalence', source: 'NONE THE LESS', comparedAs: 'NONETHELESS',
        basis: '2021-06-2 and 2022-06-1 saved source/WordCram/tiny retain the same adverb, not a separate negative clause.' });
      result.push('NONETHELESS'); i += 2;
    } else if (words[i] === 'PER' && words[i + 1] === 'CENT') {
      normalizations.push({ type: 'explicit-lexical-equivalence', source: 'PER CENT', comparedAs: 'PERCENT' });
      result.push('PERCENT'); i++;
    } else if (words[i] === 'WASNT') {
      normalizations.push({ type: 'explicit-contraction-apostrophe-equivalence', source: 'WASNT', comparedAs: "WASN'T",
        basis: '2020-12-2 passage 6: saved source, WordCram and tiny ASR retain the identical negative contraction.' });
      result.push("WASN'T");
    } else result.push(words[i]);
  }
  return result;
}
const NEGATIONS = new Set(['NO', 'NOT', 'NEVER', 'NONE', 'NEITHER', 'NOR', 'NOBODY', 'NOTHING', 'NOWHERE', 'CANNOT', 'WITHOUT', 'HARDLY', 'BARELY', 'SCARCELY']);
const negation = word => /N'T$/.test(word || '') || NEGATIONS.has(word);
const directionOrQuantity = word => /^(?:MORE|LESS|INCREASE\w*|DECREASE\w*|BEFORE|AFTER|FIRST|LAST|ONLY|ALL|SOME|EVERY|ALWAYS|LOWER|HIGHER|MOST|LEAST)$/.test(word || '');

// Global ordered edit alignment: repeated words cannot match arbitrary distant substrings.
// Questions participate as context, so a final source word cannot borrow a question word freely.
export function alignWords(reference, hypothesis) {
  const width = hypothesis.length + 1;
  const operations = new Uint8Array((reference.length + 1) * width);
  let previous = Uint32Array.from({ length: width }, (_, i) => i);
  for (let j = 1; j < width; j++) operations[j] = 3;
  for (let i = 1; i <= reference.length; i++) {
    const row = new Uint32Array(width); row[0] = i; operations[i * width] = 2;
    for (let j = 1; j < width; j++) {
      const diagonal = previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      const deletion = previous[j] + 1, insertion = row[j - 1] + 1;
      row[j] = Math.min(diagonal, deletion, insertion);
      // An equal-cost insertion after an exact match must not move that match
      // to a later repeated word in an omitted question-number introduction.
      operations[i * width + j] = reference[i - 1] === hypothesis[j - 1] && row[j] === insertion ? 3 : row[j] === diagonal ? 1 : row[j] === deletion ? 2 : 3;
    }
    previous = row;
  }
  const mapping = Array(reference.length).fill(null), edits = [];
  let i = reference.length, j = hypothesis.length, substitutions = 0, deletions = 0, insertions = 0;
  while (i || j) {
    const op = operations[i * width + j];
    if (op === 1) {
      --i; --j; const exact = reference[i] === hypothesis[j]; mapping[i] = { hypothesisIndex: j, exact };
      if (!exact) { substitutions++; edits.push({ type: 'substitution', referenceIndex: i, hypothesisIndex: j, source: reference[i], greedy: hypothesis[j] }); }
    } else if (op === 2) {
      --i; deletions++; edits.push({ type: 'deletion', referenceIndex: i, source: reference[i] });
    } else if (op === 3) {
      --j; insertions++; edits.push({ type: 'insertion', referenceIndex: i, hypothesisIndex: j, greedy: hypothesis[j] });
    } else throw new Error('Invalid edit-alignment backtrace');
  }
  return { mapping, edits: edits.reverse(), substitutions, deletions, insertions,
    referenceWords: reference.length, greedyWords: hypothesis.length,
    wordErrorRate: reference.length ? (substitutions + deletions + insertions) / reference.length : null };
}

const hash = text => createHash('sha256').update(text).digest('hex');
const round = value => Number.isFinite(value) ? Math.round(value * 1e5) / 1e5 : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const summarize = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0] ?? null, p10: sorted[Math.floor((sorted.length - 1) * 0.1)] ?? null,
    median: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? null,
    mean: sorted.length ? round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null, max: sorted.at(-1) ?? null };
};
const increment = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };

function boundaryAnchor(mapping, offset, count, end = false) {
  const required = Math.min(THRESHOLDS.boundaryAnchorWords, count);
  if (!required) return false;
  const begin = offset + (end ? count - required : 0);
  const words = mapping.slice(begin, begin + required);
  return words.every((word, index) => word?.exact && (!index || word.hypothesisIndex === words[index - 1].hypothesisIndex + 1));
}

export function auditPassage(paper, passage, evidence, asset = {}) {
  const issues = [], provenanceGaps = [];
  if (evidence.paperId !== paper.id) issues.push('paper-id-mismatch');
  if (evidence.passageId !== passage.id) issues.push('passage-id-mismatch');
  if (evidence.audioAssetId !== paper.audioAssetId) issues.push('audio-asset-mismatch');
  if (!evidence.mediaSha256) provenanceGaps.push('missing-original-media-sha256');
  else if (evidence.mediaSha256 !== asset.sha256) issues.push('original-media-sha256-mismatch');
  if (!evidence.sourceRange) provenanceGaps.push('missing-decoded-source-range');
  else if (evidence.sourceRange.start !== passage.start || evidence.sourceRange.end !== passage.end) issues.push('decoded-source-range-mismatch');
  const referenceTextSha256 = hash(passage.sentences.map(s => `${s.id}\t${s.text}`).join('\n'));
  if (evidence.referenceTextSha256 && evidence.referenceTextSha256 !== referenceTextSha256) issues.push('reference-text-hash-mismatch');
  if (!evidence.pcmSha256 || !/^[a-f0-9]{64}$/i.test(evidence.pcmSha256)) provenanceGaps.push('missing-decoded-pcm-sha256');
  const observed = Array.isArray(evidence.sentences) ? evidence.sentences : [];
  if (observed.length !== passage.sentences.length) issues.push('sentence-count-mismatch');
  const reference = [], ranges = [], originalSentenceWords = [], sentenceNormalizations = [];
  const normalizationVersion = evidence.lexicalNormalizationVersion ?? 1;
  for (let index = 0; index < passage.sentences.length; index++) {
    const sentence = passage.sentences[index], normalizations = [];
    const sourceWords = spokenWords(sentence.text, { version: normalizationVersion, hint: evidence.greedyTranscript ?? '', normalizations });
    const words = lexicalEquivalences(sourceWords, normalizations);
    originalSentenceWords.push(sourceWords); sentenceNormalizations.push(normalizations);
    ranges.push({ start: reference.length, count: words.length }); reference.push(...words);
    if (observed[index]?.id !== sentence.id) issues.push(`sentence-id-or-order-mismatch:${sentence.id}`);
    if (observed[index]?.text !== sentence.text) issues.push(`sentence-text-mismatch:${sentence.id}`);
  }
  const transcriptWordCount = reference.length;
  for (const q of paper.questions ?? []) if (q.passageId === passage.id && q.prompt) reference.push(...lexicalEquivalences(spokenWords(q.prompt, { version: normalizationVersion, hint: evidence.greedyTranscript ?? '' }), []));
  const greedyNormalizations = [];
  const greedy = lexicalEquivalences(spokenWords(evidence.greedyTranscript, { version: normalizationVersion }), greedyNormalizations);
  const alignment = alignWords(reference, greedy);
  const consistent = issues.length === 0, provenanceComplete = provenanceGaps.length === 0;
  const sentences = passage.sentences.map((source, index) => {
    const item = observed[index], range = ranges[index], tags = [], anomalies = [];
    if (!item || item.id !== source.id || item.text !== source.text) return { id: source.id, text: source.text,
      classification: 'stale-or-missing-evidence', tags: ['stale-or-missing-evidence'], supportedCandidate: false };
    const words = Array.isArray(item.words) ? item.words : [];
    const expectedWords = originalSentenceWords[index];
    if (item.error) anomalies.push({ type: 'alignment-error', detail: item.error });
    if (JSON.stringify(words.map(w => w.text)) !== JSON.stringify(expectedWords)) anomalies.push({ type: 'reference-word-sequence-mismatch' });
    const scores = words.map(w => w.score), first = scores[0], last = scores.at(-1), mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : NaN;
    const minimum = scores.length ? Math.min(...scores) : NaN;
    if (scores.some(v => !finite(v) || v < 0 || v > 1)) anomalies.push({ type: 'invalid-word-score' });
    const metrics = { firstWordScore: first, lastWordScore: last, meanWordScore: mean, minimumWordScore: minimum };
    for (const [key, value] of Object.entries(metrics)) if (!finite(value) || !finite(item[key]) || Math.abs(value - item[key]) > 0.0001) anomalies.push({ type: 'inconsistent-score-summary', field: key });
    let maxGap = 0;
    for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
      const word = words[wordIndex], duration = word.end - word.start, gap = wordIndex ? word.start - words[wordIndex - 1].end : 0;
      maxGap = Math.max(maxGap, gap);
      if (word.sentenceId !== source.id || !finite(word.start) || !finite(word.end) || word.start < passage.start - 0.03 || word.end > passage.end + 0.03 || duration <= 0) anomalies.push({ type: 'invalid-word-boundary', wordIndex, word: word.text });
      else if (duration < THRESHOLDS.minWordDurationSeconds - 0.0001 || duration > THRESHOLDS.maxWordDurationSeconds) anomalies.push({ type: 'word-duration', wordIndex, word: word.text, seconds: round(duration) });
      if (gap > THRESHOLDS.maxWordGapSeconds || gap < -THRESHOLDS.maxOverlapSeconds) anomalies.push({ type: 'word-gap-or-overlap', wordIndex, word: word.text, seconds: round(gap) });
    }
    if (finite(item.maxWordGap) && Math.abs(maxGap - item.maxWordGap) > 0.0011) anomalies.push({ type: 'inconsistent-word-gap-summary' });
    const validBoundary = finite(item.acousticStart) && finite(item.acousticEnd) && item.acousticEnd > item.acousticStart &&
      item.acousticStart >= passage.start - 0.03 && item.acousticEnd <= passage.end + 0.03 &&
      words.length > 0 && Math.abs(item.acousticStart - words[0].start) < 0.0011 && Math.abs(item.acousticEnd - words.at(-1).end) < 0.0011;
    if (!validBoundary) anomalies.push({ type: 'invalid-sentence-boundary' });
    if (index > 0 && item.acousticStart < observed[index - 1]?.acousticEnd - THRESHOLDS.maxOverlapSeconds) anomalies.push({ type: 'sentence-overlap', seconds: round(observed[index - 1].acousticEnd - item.acousticStart) });
    const mapped = alignment.mapping.slice(range.start, range.start + range.count);
    const exactCount = mapped.filter(m => m?.exact).length, exactFraction = range.count ? exactCount / range.count : 0;
    const firstAnchor = boundaryAnchor(alignment.mapping, range.start, range.count), lastAnchor = boundaryAnchor(alignment.mapping, range.start, range.count, true);
    const firstMapped = mapped.find(m => m)?.hypothesisIndex, lastMapped = mapped.findLast(m => m)?.hypothesisIndex;
    const greedyWindow = firstMapped === undefined ? '' : greedy.slice(firstMapped, lastMapped + 1).join(' ');
    const edits = alignment.edits.filter(edit => edit.referenceIndex >= range.start && edit.referenceIndex < range.start + range.count);
    const boundaryAwareEdits = alignment.edits.filter(edit => edit.referenceIndex >= range.start && (edit.type === 'insertion' ? edit.referenceIndex <= range.start + range.count : edit.referenceIndex < range.start + range.count));
    const criticalLexicalEdits = boundaryAwareEdits.filter(edit => negation(edit.source) || negation(edit.greedy));
    const directionOrQuantifierEdits = boundaryAwareEdits.filter(edit => directionOrQuantity(edit.source) || directionOrQuantity(edit.greedy));
    const internalInsertions = alignment.edits.filter(edit => edit.type === 'insertion' && firstMapped !== undefined && edit.hypothesisIndex > firstMapped && edit.hypothesisIndex < lastMapped).length;
    const independentWordErrorRate = range.count ? (range.count - exactCount + internalInsertions) / range.count : 1;
    const scoreSupported = first >= THRESHOLDS.firstAndLastWordScore && last >= THRESHOLDS.firstAndLastWordScore &&
      mean >= THRESHOLDS.meanWordScore && minimum >= THRESHOLDS.minimumWordScore;
    const lexicalSupported = firstAnchor && lastAnchor && exactFraction >= THRESHOLDS.independentExactWordFraction && independentWordErrorRate <= THRESHOLDS.maxIndependentWordErrorRate;
    const currentValid = finite(source.start) && finite(source.end) && source.end > source.start;
    const startDelta = currentValid && validBoundary ? item.acousticStart - source.start : null,
      endDelta = currentValid && validBoundary ? item.acousticEnd - source.end : null;
    const maximumDelta = Math.max(Math.abs(startDelta ?? 0), Math.abs(endDelta ?? 0));
    if (!consistent) tags.push('stale-evidence');
    if (!provenanceComplete) tags.push('incomplete-provenance');
    if (anomalies.length) tags.push('word-or-boundary-anomaly');
    if (!scoreSupported) tags.push('low-acoustic-score');
    if (!lexicalSupported) tags.push('independent-transcript-disagreement');
    if (criticalLexicalEdits.length) tags.push('critical-negation-lexical-edit');
    if (directionOrQuantifierEdits.length) tags.push('direction-or-quantifier-lexical-edit');
    if (!currentValid) tags.push('current-boundary-missing');
    else if (maximumDelta > THRESHOLDS.largeBoundaryDriftSeconds) tags.push('large-current-boundary-difference');
    else if (maximumDelta > THRESHOLDS.boundaryDriftSeconds) tags.push('current-boundary-difference');
    const supportedCandidate = consistent && provenanceComplete && !anomalies.length && scoreSupported && lexicalSupported && !criticalLexicalEdits.length;
    const classification = !consistent ? 'stale-evidence' : !provenanceComplete ? 'incomplete-provenance' : anomalies.length ? 'word-or-boundary-anomaly' :
      !scoreSupported ? 'low-acoustic-score' : criticalLexicalEdits.length ? 'critical-lexical-disagreement' : !lexicalSupported ? 'independent-transcript-disagreement' : 'acoustically-supported-candidate';
    return { id: source.id, text: source.text, classification, tags, supportedCandidate,
      requiresListeningBeforeApplication: !supportedCandidate || !currentValid || maximumDelta > THRESHOLDS.largeBoundaryDriftSeconds || directionOrQuantifierEdits.length > 0,
      score: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, round(value)])),
      wordCount: words.length, maxWordGapSeconds: round(maxGap), maxWordDurationSeconds: round(Math.max(...words.map(w => w.end - w.start))), anomalies,
      independentTranscript: { exactWords: exactCount, referenceWords: range.count, exactWordFraction: round(exactFraction),
        internalInsertions, wordErrorRate: round(independentWordErrorRate),
        firstAnchor, lastAnchor, anchorWordCount: Math.min(THRESHOLDS.boundaryAnchorWords, range.count), greedyWindow, edits,
        criticalLexicalEdits, directionOrQuantifierEdits },
      lexicalNormalizations: sentenceNormalizations[index],
      current: { start: source.start, end: source.end }, acoustic: { start: item.acousticStart, end: item.acousticEnd },
      deltaFromCurrent: { start: round(startDelta), end: round(endDelta), maxAbsolute: round(currentValid ? maximumDelta : null) },
      evidenceBaseline: { start: item.existingStart, end: item.existingEnd }, reviewed: false };
  });
  return { paperId: paper.id, passageId: passage.id, order: passage.order,
    status: !consistent ? 'stale' : !provenanceComplete ? 'incomplete-provenance' : 'completed',
    issues, provenanceGaps, audioAssetId: paper.audioAssetId, mediaSha256: evidence.mediaSha256 ?? null,
    sourceRange: evidence.sourceRange ?? null, referenceTextSha256, recordedReferenceTextSha256: evidence.referenceTextSha256 ?? null,
    recordedFullSentenceSnapshotSha256: evidence.referenceSha256 ?? null,
    method: evidence.method, model: evidence.model, lexicalNormalizationVersion: normalizationVersion, greedyNormalizations, reviewed: false,
    greedyComparison: { sourceWords: reference.length, transcriptWords: transcriptWordCount, questionContextWords: reference.length - transcriptWordCount,
      greedyWords: greedy.length, substitutions: alignment.substitutions, deletions: alignment.deletions, insertions: alignment.insertions,
      wordErrorRate: round(alignment.wordErrorRate), note: 'Whole-clip insertions may include spoken introductions and question numbers omitted from the reference.' }, sentences };
}

export function runAudit({ root = ROOT, output = join(root, 'data/references/acoustic-review-summary.json') } = {}) {
  const assets = read(join(root, 'data/assets.json')), details = [], expected = { papers: 0, passages: 0, sentences: 0 }, knownReports = new Set();
  const mediaHashChecks = new Map();
  for (const name of readdirSync(join(root, 'data/papers')).filter(name => name.endsWith('.json')).sort()) {
    const paper = read(join(root, 'data/papers', name)); expected.papers++;
    const asset = assets[paper.audioAssetId];
    if (!mediaHashChecks.has(paper.audioAssetId)) {
      const media = asset?.path ? resolve(root, 'data', asset.path) : null;
      const dataRoot = resolve(root, 'data');
      if (!media || !media.startsWith(dataRoot + '\\') && !media.startsWith(dataRoot + '/')) mediaHashChecks.set(paper.audioAssetId, { ok: false, error: 'Missing asset or media path outside data directory' });
      else {
        try { const actual = hash(readFileSync(media)); mediaHashChecks.set(paper.audioAssetId, { ok: actual === asset.sha256, sha256: actual, expected: asset.sha256, size: statSync(media).size }); }
        catch (error) { mediaHashChecks.set(paper.audioAssetId, { ok: false, error: error.message }); }
      }
    }
    for (const passage of paper.passages) {
      expected.passages++; expected.sentences += passage.sentences.length;
      const path = join(root, 'data/acoustic-review', paper.id, `passage-${passage.order}.json`); knownReports.add(resolve(path));
      const base = { paperId: paper.id, passageId: passage.id, order: passage.order, expectedSentences: passage.sentences.length, report: relative(root, path).replaceAll('\\', '/') };
      if (!existsSync(path)) { details.push({ ...base, status: 'pending', sentences: [] }); continue; }
      try {
        const item = auditPassage(paper, passage, read(path), asset);
        if (!mediaHashChecks.get(paper.audioAssetId)?.ok) {
          item.issues.push('local-media-checksum-failed'); item.status = 'stale';
          for (const sentence of item.sentences) { sentence.supportedCandidate = false; sentence.requiresListeningBeforeApplication = true; sentence.tags.push('local-media-checksum-failed'); }
        }
        details.push({ ...base, ...item, reportBytes: statSync(path).size, updatedAt: statSync(path).mtime.toISOString(),
          emissionCacheExists: existsSync(path.replace(/\.json$/, '.npz')) });
      } catch (error) { details.push({ ...base, status: 'unreadable-or-invalid', error: error.message, sentences: [] }); }
    }
  }
  const unmatchedReports = [], evidenceRoot = join(root, 'data/acoustic-review');
  if (existsSync(evidenceRoot)) for (const entry of readdirSync(evidenceRoot, { withFileTypes: true })) if (entry.isDirectory()) {
    for (const file of readdirSync(join(evidenceRoot, entry.name)).filter(file => /^passage-\d+\.json$/.test(file))) {
      const path = resolve(evidenceRoot, entry.name, file);
      if (!knownReports.has(path)) unmatchedReports.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  const sentenceRows = details.flatMap(p => p.sentences), passageStatus = {}, sentenceClassification = {}, tags = {};
  for (const p of details) increment(passageStatus, p.status);
  for (const s of sentenceRows) { increment(sentenceClassification, s.classification); for (const tag of s.tags) increment(tags, tag); }
  const supported = sentenceRows.filter(s => s.supportedCandidate), deltas = sentenceRows.map(s => s.deltaFromCurrent?.maxAbsolute).filter(finite);
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), readOnly: true,
    scope: 'Independent acoustic candidate evidence. No production paper, timing, text, quality or human-reviewed flag is changed.',
    expected, progress: { availableReports: details.filter(p => p.status !== 'pending').length, passageStatus, examinedSentences: sentenceRows.length,
      pendingSentences: details.filter(p => p.status === 'pending').reduce((n, p) => n + p.expectedSentences, 0),
      sentenceClassification, tags, supportedCandidates: supported.length,
      supportedCandidatesRequiringListening: supported.filter(s => s.requiresListeningBeforeApplication).length },
    thresholds: THRESHOLDS,
    interpretation: [
      'A forced-alignment path can be constructed for incorrect reference text. Its existence never verifies transcription.',
      'Word scores are acoustic model scores, not calibrated probabilities of correctness.',
      'Independent greedy ASR is aligned in order against source text plus spoken-question context; first and last two consecutive words (one for a one-word response) and at least 85% of sentence words must match exactly; substitutions/deletions/internal insertions together must not exceed 15%.',
      'The original media file SHA-256 is recomputed in this audit. PCM hashes are recorded provenance only; this Node audit does not recompute FFmpeg decoding or validate the emission cache.',
      'The legacy referenceSha256 includes old timing and is retained as provenance only. Matching audio, decoded source range, sentence IDs/order/text determine freshness.',
      'Greedy ASR shares the acoustic model with forced alignment, so it is independent of supplied text, not an independent human check or independent model.'
    ],
    suggestedApplicationPolicy: { automaticApplicationPerformed: false, marksHumanReviewed: false,
      candidateRequirements: ['Current media checksum, asset ID, decoded source range, sentence order/IDs and exact source text match.',
        'First/last word score >=0.80, mean >=0.85, minimum >=0.40; no invalid score, word duration/gap/overlap or boundary anomaly.',
        'Independent greedy ASR supports both boundary anchors of min(2, sentence words) consecutive words and >=85% of sentence reference words in global order, with <=15% word error including internal insertions.'],
      listeningRequired: ['Any candidate missing a current boundary or changing an edge by more than 2 seconds.',
        'Any direction/quantity lexical difference; negation insertion/deletion/substitution is never an automatically supported candidate, even at low overall word error.',
        'Every low-confidence, incomplete-provenance, stale, anomalous or independent-ASR-disagreement item before adoption.',
        'Before declaring formal delivery complete, a human must listen through each sentence, verify text and both edges, and explicitly mark it reviewed.'],
      boundaryPadding: 'Raw CTC spans are phonetic character extents; review surrounding audio before choosing playback padding so first/last sounds are retained.' },
    distributions: { firstWordScore: summarize(sentenceRows.map(s => s.score?.firstWordScore)), lastWordScore: summarize(sentenceRows.map(s => s.score?.lastWordScore)),
      meanWordScore: summarize(sentenceRows.map(s => s.score?.meanWordScore)), minimumWordScore: summarize(sentenceRows.map(s => s.score?.minimumWordScore)),
      maxWordGapSeconds: summarize(sentenceRows.map(s => s.maxWordGapSeconds)), maxWordDurationSeconds: summarize(sentenceRows.map(s => s.maxWordDurationSeconds)),
      maxCurrentBoundaryDifferenceSeconds: summarize(deltas) },
    mediaHashChecks: Object.fromEntries(mediaHashChecks), unmatchedReports,
    byPaper: [...new Set(details.map(p => p.paperId))].map(paperId => { const passages = details.filter(p => p.paperId === paperId), states = {};
      for (const p of passages) increment(states, p.status);
      return { paperId, passages: passages.length, status: states, supportedCandidates: passages.flatMap(p => p.sentences).filter(s => s.supportedCandidate).length }; }),
    passages: details };
  mkdirSync(dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(report, null, 2) + '\n'); renameSync(temp, output);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFlag = process.argv.find(arg => arg.startsWith('--output='));
  const report = runAudit(outputFlag ? { output: resolve(outputFlag.slice('--output='.length)) } : {});
  console.log(JSON.stringify({ expected: report.expected, progress: report.progress, output: outputFlag?.slice(9) ?? 'data/references/acoustic-review-summary.json' }, null, 2));
}
