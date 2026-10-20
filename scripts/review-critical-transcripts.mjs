import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit, spokenWords } from './lib/audit-acoustic.mjs';
import { stripHtml } from './lib/corpus.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), data = join(root, 'data');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rel = file => relative(root, file).replaceAll('\\', '/');
const manual = {
  'cet6-2021-06-2-p-12-3-s3': {
    source: 'It scaled an altitude of only 12 meters.', includeAfterEquivalent: true,
    category: 'adjacent-word-division-false-negation-resolved',
    rationale: 'The old critical NONE insertion belongs to the following NONETHELESS, independently rendered NONE THE LESS by CTC. Both sites and tiny retain this current sentence and the subsequent Nonetheless. Explicit adverb word-division normalization removes that false boundary flag; no negation is added or deleted.' },
  'cet6-2021-06-2-p-12-3-s4': {
    source: 'Nonetheless, it was a milestone in rocket science.', includeAfterEquivalent: true, criticalWords: ['NONETHELESS'],
    category: 'explicit-adverb-word-division-equivalence',
    rationale: 'NONE THE LESS and NONETHELESS are the same adverb in this context. Source HTML, WordCram and tiny corroborate Nonetheless. The comparison explicitly joins this full three-word idiom; it does not whitelist standalone NONE or alter the forced-alignment reference words/scores.' },
  'cet6-2021-12-1-p-1-7-s1': {
    source: 'W: No, what a complete catastrophe!',
    category: 'unresolved-source-and-asr-disagreement',
    rationale: 'Lazynote and New Oriental print No, whereas content-matched WordCram and tiny print Now and CTC greedy also writes NOW. The forced NO score is high (0.99978), but this is not an independent transcription verdict. NO and NOW are not equivalent orthography, so retain current source and require direct audio adjudication.' },
  'cet6-2022-06-1-p-5-10-s1': {
    source: 'W: No.',
    category: 'likely-ctc-vowel-decoding-error',
    rationale: 'The context is the question about seeing a gap in the market. Tiny and both saved sites answer No followed by When I started university; CTC writes NOW. The forced NO score is 0.99992, but NO/NOW are not equivalent. Keep the source and critical gate pending human listening.' },
  'cet6-2022-06-1-p-5-10-s5': {
    source: 'And before I knew it, I was an entrepreneur.',
    category: 'likely-ctc-word-segmentation-error',
    rationale: 'Tiny, Lazynote and WordCram all retain the positive I was an entrepreneur. CTC merges WAS AN into WASN’T and garbles ENTREPRENEUR; source AN has score only 0.03886 and the final word 0.49981. This is not safe spelling equivalence and remains blocked; no source negation is added.' },
  'cet6-2022-06-1-p-12-2-s6': {
    source: 'These are mostly harmless lies, but lies nonetheless.', includeAfterEquivalent: true, criticalWords: ['NONETHELESS'],
    category: 'explicit-adverb-word-division-equivalence',
    rationale: 'Both saved sites and tiny retain nonetheless; CTC writes the identical full adverb NONE THE LESS. Comparison joins only that complete idiom and retains all acoustic-score/boundary gates. It does not drop a genuine standalone NONE.' },
  'cet6-2020-12-2-p-19-1-s2': {
    source: "He wasn't alone in experiencing the extreme physical effects of the game.", includeAfterEquivalent: true, criticalWords: ["WASN'T"],
    category: 'explicit-apostrophe-only-equivalence',
    rationale: "WASNT preserves the exact negative contraction WASN’T with only its apostrophe omitted; saved Lazynote, WordCram and tiny ASR corroborate wasn’t. The comparison layer records this one explicit equivalence. GAME→GAY A remains a separate lexical disagreement and last-word score is only 0.49983, so the sentence still cannot pass the strict candidate gate." },
  'cet6-2021-12-1-p-5-4-s1': {
    source: "W: I'd say it's a major departure as it's not just a work of fiction.",
    category: 'likely-ctc-character-decoding-error',
    rationale: 'CTC greedy writes NI at NOT. Tiny and base both retain not just; saved Lazynote, content-matched WordCram (published as 2021-12-2), and New Oriental all contain the negation. NI is not an equivalent spelling of NOT and is not whitelisted.' },
  'cet6-2022-09-1-p-12-4-s2': {
    source: 'Critics often attack the motives of people who protect the environment, donate money, or work too hard.',
    category: 'likely-ctc-word-segmentation-error',
    rationale: "Greedy DON’T ATE appears at DONATE. Original saved source, content-matched WordCram, and tiny ASR say donate money. This is not a source negation omission and DON’T ATE must not become a general equivalence for DONATE. Base recognition for this clip is not saved." },
  'cet6-2023-12-1-p-19-1-s5': {
    source: "If a person is infected with a virus or bacteria, for example, their odor will be abnormal, and dogs are able to smell that change even if the human can't, because dogs have a much more powerful sense of smell than humans.",
    category: 'likely-ctc-character-decoding-error',
    rationale: "Greedy CARRENT substitutes CAN’T; tiny ASR retains human can’t, and both saved transcript sites preserve negative ability. WordCram uses a human rather than the human, a separate article difference. CARRENT is not an equivalent orthography of CAN’T or CANNOT. No saved base clip or matching PDF is available." },
  'cet6-2023-12-1-p-19-3-s4': {
    source: "Humans send out lots of cues, but whether dogs know some of these cues mean illness isn't clear.",
    category: 'likely-ctc-homophone-decoding-error',
    rationale: "Greedy NO substitutes KNOW. Tiny ASR and both saved transcript sites retain dogs know; the actual source negation isn’t clear is also present in greedy. KNOW and NO are homophones with different meanings, so they must not be whitelisted as semantic equivalents. No saved base clip or matching PDF is available." }
};

function excerptAlignment(reference, hypothesis) {
  const width = hypothesis.length + 1, trace = new Uint8Array((reference.length + 1) * width);
  let row = new Uint32Array(width);
  for (let i = 1; i <= reference.length; i++) {
    const next = new Uint32Array(width); next[0] = i; trace[i * width] = 2;
    for (let j = 1; j < width; j++) {
      const diagonal = row[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1), deletion = row[j] + 1, insertion = next[j - 1] + 1;
      next[j] = Math.min(diagonal, deletion, insertion); trace[i * width + j] = next[j] === diagonal ? 1 : next[j] === deletion ? 2 : 3;
    }
    row = next;
  }
  let j = 0; for (let k = 1; k < width; k++) if (row[k] < row[j]) j = k;
  let i = reference.length; const mapping = Array(i).fill(null), edits = [];
  while (i) {
    const op = trace[i * width + j];
    if (op === 1) {
      --i; --j; const exact = reference[i] === hypothesis[j]; mapping[i] = { hypothesisIndex: j, exact };
      if (!exact) edits.push({ type: 'substitution', source: reference[i], recognized: hypothesis[j] });
    } else if (op === 2) { --i; edits.push({ type: 'deletion', source: reference[i] }); }
    else if (op === 3) { --j; edits.push({ type: 'insertion', hypothesisIndex: j, recognized: hypothesis[j] }); }
    else throw new Error('Invalid local excerpt alignment');
  }
  return { mapping, edits: edits.reverse() };
}

function closestExcerpt(source, target, context = 10) {
  const text = String(source).replace(/\s+/g, ' ').trim(), words = [], spans = [];
  for (const match of text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?|\d+(?:\.\d+)?/g)) {
    for (const word of spokenWords(match[0])) { words.push(word); spans.push({ start: match.index, end: match.index + match[0].length }); }
  }
  const reference = spokenWords(target), aligned = excerptAlignment(reference, words), mapped = aligned.mapping.filter(Boolean).map(m => m.hypothesisIndex);
  if (!mapped.length) return { text: '', context: '', exactWords: 0, sourceWords: reference.length, edits: [] };
  const start = Math.min(...mapped), end = Math.max(...mapped);
  return { text: text.slice(spans[start].start, spans[end].end), context: text.slice(spans[Math.max(0, start - context)].start, spans[Math.min(spans.length - 1, end + context)].end),
    exactWords: aligned.mapping.filter(m => m?.exact).length, sourceWords: reference.length,
    edits: aligned.edits.filter(e => e.type !== 'insertion' || e.hypothesisIndex >= start && e.hypothesisIndex <= end) };
}

const comparison = read(join(data, 'references/independent-transcript-comparison.json'));
const refinements = read(join(data, 'references/refinement-sources.json'));
const pdfComparison = read(join(data, 'references/independent-pdf-transcript-comparison.json'));
const audit = runAudit({ root, output: join(data, 'references/critical-review-source-audit.json') });
const items = [];
for (const checkedPassage of audit.passages) {
  const flagged = checkedPassage.sentences.filter(s => s.independentTranscript?.criticalLexicalEdits?.length || manual[s.id]?.includeAfterEquivalent);
  if (!flagged.length) continue;
  const paperFile = join(data, 'papers', `${checkedPassage.paperId}.json`), paperBytes = readFileSync(paperFile), paper = JSON.parse(paperBytes);
  const passage = paper.passages.find(p => p.id === checkedPassage.passageId);
  const acousticFile = join(data, 'acoustic-review', paper.id, `passage-${passage.order}.json`), acousticBytes = readFileSync(acousticFile), evidence = JSON.parse(acousticBytes);
  for (const sentence of flagged) {
    const source = passage.sentences.find(s => s.id === sentence.id), raw = evidence.sentences.find(s => s.id === sentence.id), sources = [], gaps = [];
    const sentenceIndex = passage.sentences.findIndex(s => s.id === source.id);
    const excerptTarget = spokenWords(source.text).length < 4 ? passage.sentences.slice(Math.max(0, sentenceIndex - 1), sentenceIndex + 2).map(s => s.text).join(' ') : source.text;
    const original = join(data, 'raw', `${paper.id.replace(/^cet6-/, '')}.html`);
    if (existsSync(original)) {
      const bytes = readFileSync(original), html = bytes.toString('utf8');
      const text = [...html.matchAll(/<p\b[^>]*id="p-\d+-\d+"[^>]*class="lt-en"[^>]*>([\s\S]*?)<\/p>/g)].map(m => stripHtml(m[1].replace(/<span\b[^>]*>[\s\S]*?<\/span>/, ''))).join(' ');
      sources.push({ kind: 'original-saved-transcript-html', file: rel(original), sha256: sha(bytes), url: paper.sources.find(s => s.kind === 'transcript' && s.url.includes('lazynote'))?.url,
        excerpt: closestExcerpt(text, excerptTarget) });
    } else gaps.push('Original downloaded HTML is unavailable.');
    const matched = comparison.allSentenceResults.find(s => s.sentenceId === source.id);
    if (matched?.sourceHtml && existsSync(join(root, matched.sourceHtml))) {
      const file = join(root, matched.sourceHtml), bytes = readFileSync(file), html = bytes.toString('utf8');
      const text = [...html.matchAll(/<span\b[^>]*class="transcript-english"[^>]*>([\s\S]*?)<\/span>/g)].map(m => stripHtml(m[1])).join(' ');
      sources.push({ kind: 'second-site-content-matched-transcript', file: rel(file), url: matched.sourceUrl, sha256: sha(bytes), matchesRetainedManifestHash: sha(bytes) === matched.sourceHash,
        variantMappingNote: 'Matched by listening content; published set label can differ from the local paper.', excerpt: closestExcerpt(text, excerptTarget) });
    } else gaps.push('No saved content-matched second-site transcript was located.');
    for (const refinement of refinements.entries.filter(s => s.id === paper.id)) {
      const file = join(data, 'references', refinement.filename);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file), text = stripHtml(bytes.toString('utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
      sources.push({ kind: 'third-site-saved-transcript', file: rel(file), url: refinement.url, sha256: sha(bytes), matchesRetainedManifestHash: sha(bytes) === refinement.sha256,
        excerpt: closestExcerpt(text, excerptTarget) });
    }
    const recognized = [];
    for (const suffix of ['', '-base']) {
      const file = join(data, 'alignment', paper.id, `passage-${passage.order}${suffix}.json`);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file), recognition = JSON.parse(bytes);
      recognized.push({ file: rel(file), sha256: sha(bytes), model: recognition.model?.type, params: recognition.params,
        excerpt: closestExcerpt(recognition.transcription.map(t => t.text).join(''), excerptTarget),
        timingLimit: 'Read as raw lexical ASR evidence; cached WAV source offsets are not independently revalidated here.' });
    }
    if (!recognized.some(r => r.model === 'base')) gaps.push('A saved base-model recognition for this exact passage is unavailable.');
    const pdf = pdfComparison.papers.find(p => p.paperId === paper.id);
    const pdfPassage = pdf?.passages.find(p => p.passageId === passage.id);
    if (pdfPassage) sources.push({ kind: 'retained-pdf-ocr-comparison', source: pdf.source, excerpt: closestExcerpt(pdfPassage.sourceText, source.text),
      limitation: 'OCR must be compared with the retained rendered page before any text correction.' });
    else gaps.push('No retained matching PDF transcript is available for this paper/passage; PDFs for other exam sets are not substituted.');
    gaps.push('No human auditory adjudication of this flagged word is recorded by this report.');
    const conclusion = manual[source.id], known = conclusion?.source === source.text;
    const criticalWords = new Set(sentence.independentTranscript.criticalLexicalEdits.flatMap(e => [e.source, e.greedy]).filter(Boolean));
    for (const word of conclusion?.criticalWords || []) criticalWords.add(word);
    items.push({ paperId: paper.id, passageId: passage.id, passageOrder: passage.order, sentenceId: source.id, currentText: source.text,
      excerptTarget, paperSnapshotSha256: sha(paperBytes), audioAssetId: paper.audioAssetId, acousticReport: rel(acousticFile), acousticReportSha256: sha(acousticBytes),
      evidenceCurrent: checkedPassage.status === 'completed', lexicalNormalizationVersion: evidence.lexicalNormalizationVersion ?? 1,
      acoustic: { start: raw.acousticStart, end: raw.acousticEnd, scores: sentence.score,
        criticalWordScores: raw.words.filter(word => criticalWords.has(word.text) || ['DONATE', 'KNOW'].includes(word.text)),
        wordWindow: raw.words.filter((word, index) => raw.words.slice(Math.max(0, index - 2), index + 3).some(w => criticalWords.has(w.text) || ['DONATE', 'KNOW'].includes(w.text))) },
      greedy: sentence.independentTranscript, rawAsr: recognized, textSources: sources,
      adjudication: { category: known ? conclusion.category : 'pending-individual-source-review',
        textRecommendation: known ? 'retain-current-source-text' : 'no-change-pending-review',
        rationale: known ? conclusion.rationale : 'New critical lexical difference: source/ASR excerpts are collected but have not been individually adjudicated.',
        inferenceOnly: true, humanReviewed: false, sourceCorrectionSuggested: null,
        automaticCandidateBlockRetained: !sentence.supportedCandidate, criticalEquivalentApplied: Boolean(known && conclusion.includeAfterEquivalent) }, evidenceGaps: gaps });
  }
}
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), readOnly: true, acousticProgress: audit.progress,
  method: 'Current source text and CTC word evidence are compared with retained raw tiny/base recognition and content-matched saved transcript HTML/PDF material. No source text, timing, quality or human-reviewed status is modified.',
  limitations: ['Cross-site agreement is not proof of independent transcription authorship.',
    'Forced word scores do not prove a reference word was spoken. CTC greedy differs independently of the supplied script but shares its acoustic model.',
    'Homophones and malformed ASR words are not semantic/spelling equivalences. NI→NOT, DON’T ATE→DONATE, CARRENT→CAN’T and NO→KNOW remain blocked.',
    'These conclusions are source/model triangulation inferences. Human listening is still required before unblocking a critical item.'],
  totals: { reviewedItems: items.length, flaggedSentences: items.filter(s => s.greedy.criticalLexicalEdits.length).length,
    sourceEvidenceReviewed: items.filter(s => s.adjudication.category !== 'pending-individual-source-review').length,
    unresolvedSourceOrAsrDisagreements: items.filter(s => s.adjudication.category === 'unresolved-source-and-asr-disagreement').length,
    pendingIndividualReview: items.filter(s => s.adjudication.category === 'pending-individual-source-review').length,
    sourceCorrectionsSuggested: 0, explicitEquivalenceOrAdjacentFalseFlagsResolved: items.filter(s => s.adjudication.criticalEquivalentApplied).length,
    paperOrTimingChangesApplied: 0 }, items };
const output = join(data, 'references/critical-transcript-review.json'), temporary = `${output}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n'); renameSync(temporary, output);
console.log(JSON.stringify({ output: rel(output), totals: report.totals, items: items.map(s => ({ id: s.sentenceId, category: s.adjudication.category, rawModels: s.rawAsr.map(r => r.model), critical: s.greedy.criticalLexicalEdits })) }, null, 2));
