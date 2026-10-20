// This audit never edits papers. Every non-exact option pairing is an explicit,
// reviewed exception. It is not a fuzzy-match acceptance rule.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseReference, normalize } from './verify-answers.mjs';
import { stripHtml, writeJson } from './lib/corpus.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REFERENCE_SWAPS = { 'cet6-2021-12-1': 'cet6-2021-12-2', 'cet6-2021-12-2': 'cet6-2021-12-1' };
const annotations = [
  ['2020-07-1', 15, 'A', 'A', 'The worsening of natural environment.', 'The worsening of the natural environment.', '冠词 the 的有无，不改变含义'],
  ['2020-07-1', 20, 'B', 'B', 'Some natural disaster killed a whole herd of dinosaurs in the area.', 'Some natural disasters killed a whole herd of dinosaurs in the area.', 'disaster/disasters 单复数差异，选项描述同一原因'],
  ['2020-07-1', 24, 'A', 'A', 'People in many parts of the world preferred small-sized families.', 'People in many parts of the world preferred small-size families.', 'small-sized/small-size 拼写差异'],
  ['2020-12-1', 5, 'A', 'D', 'They work in different fields of AI technology.', 'They work in different fields of Al technology.', 'AI 被参考源误录为 Al；按文本重新映射选项顺序'],
  ['2020-12-1', 5, 'B', 'C', 'They disagree about the future of AI technology.', 'They disagree about the future of Al technology.', 'AI 被参考源误录为 Al；正确项由本地 B 映射参考 C'],
  ['2020-12-1', 6, 'A', 'B', 'Simply writing AI software.', 'Simply writing Al software.', 'AI/Al 录入差异；其余选项按文本映射'],
  ['2021-06-2', 23, 'D', 'D', 'They find their voice go unheeded.', 'They find their voice goes unheeded.', 'go/goes 语法差异；正确项不受影响'],
  ['2021-12-1', 3, 'C', 'C', 'Ask the manufacturer for repairs.', 'Ask the manufacturer for repair.', 'repair/repairs 单复数；参考套号已交叉映射'],
  ['2021-12-1', 23, 'D', 'D', 'Understating their previous achievements.', 'Understanding their previous achievements.', 'understating/understanding 为实质不同的干扰项，正确项 A 在两源一致', false],
  ['2022-09-1', 6, 'B', 'B', 'Tranquillity.', 'Tranquility.', '英美拼写差异'],
  ['2022-09-1', 17, 'A', 'A', 'Competing for position.', 'Competing for a position.', '冠词 a 差异；其余选项按文本重新映射'],
  ['2022-12-1', 12, 'A', 'A', "Placing their own interests over their staff's.", 'Placing their own interests over their staff.', '参考源省略所有格，干扰项仍可明确配对'],
  ['2022-12-2', 1, 'D', 'D', 'Consuming more only when earning more.', 'Consuming more only when earning', '参考源干扰项截断；正确项 A 完全一致，保留完整本地选项并标记题目待校对', false],
  ['2023-03-1', 23, 'C', 'A', 'Travel round the world.', 'Travel around the world.', 'round/around 同义表达；正确项本地 B 映射参考 D'],
  ['2023-12-1', 20, 'B', 'B', 'They can easily tell what bacteria cause odor change.', 'They can easily tell what bacteria cause odour change.', 'odor/odour 英美拼写'],
  ['2023-12-1', 24, 'C', 'C', 'Forty percent of them earn less than ￡25,000 a year.', 'Forty percent of them earn less than E25,000 a year.', '参考源将英镑符号误录为 E，数字及含义一致'],
  ['2024-06-1', 7, 'A', 'A', 'blur.', 'A blur.', '冠词 a 差异'],
  ['2024-06-2', 7, 'A', 'A', 'All the properties in Berkton were designed by the same architect.', 'The people in Berkton were in a harmonious atmosphere.', '两源 A 为实质不同干扰项，正确项 D 完全一致；题目内容继续待校对', false],
  ['2024-06-2', 7, 'B', 'B', 'The majority of residents lived in harmony with their neighbours.', 'The majority of residents lived in harmony with their neighbors.', 'neighbours/neighbors 英美拼写'],
  ['2024-06-2', 18, 'B', 'B', "They don't reflect the change of view on physical punishment.", "They don't reflect the changes of view on physical punishment.", 'change/changes 单复数差异'],
  ['2024-06-2', 22, 'A', 'A', 'A) Add to indoor toxic pollutants.', 'Add to indoor toxic pollutants.', '本地多余选项标签 A)，属于采集格式差异'],
  ['2024-06-2', 23, 'A', 'A', 'NASA did experiments in sealed containers resembling the super insulated offices of 1970s.', 'NASA did experiments in sealed containers resembling the super-insulated offices of the 1970s.', '连字符及冠词差异'],
  ['2024-12-1', 13, 'B', 'B', 'Design personalised training programmes.', 'Design personalized training programmes.', 'personalised/personalized 英美拼写'],
  ['2024-12-1', 23, 'B', 'B', "Their influence on people's life varies with social contexts.", "Their influence on people's lives varies with social contexts.", 'life/lives 单复数差异'],
  ['2025-06-1', 1, 'C', 'C', "Called the man's company.", "Call the man's company.", 'Call/Called 时态差异，双方正确项均指致电该公司'],
  ['2025-06-1', 1, 'D', 'D', 'Visited Alpha Maintenance.', 'Visit Alpha Maintenance.', 'Visit/Visited 时态差异'],
  ['2025-06-1', 4, 'A', 'A', 'Whether the contents have been backed up.', 'Whether the content has been backed up.', 'content/contents 及谓语单复数差异，均指内容是否备份'],
  ['2025-06-1', 4, 'B', 'B', 'Whether they can find help somewhere else.', 'Whether they can find someone else.', '干扰项实质存在用词差异；正确项 A 语义一致，题目继续待校对', false],
  ['2025-06-1', 12, 'A', 'A', 'They are actually proud of the goods and services they produce.', 'They are actually proud of the work and admire the people behind.', '两源 A 为实质不同干扰项；正确项 C 完全一致，题目继续待校对', false],
  ['2025-06-1', 12, 'D', 'D', 'They are longing to share the profits made from their work.', 'They are longing to share the profit made from their work.', 'profit/profits 单复数差异'],
  ['2025-06-2', 5, 'A', 'A', 'The private label "L\'Orange".', 'The private label "L Drang".', '参考源品牌专名误录；正确项 B 完全一致'],
  ['2025-06-2', 7, 'A', 'A', 'Merge styles often at opposite ends of the fashion spectrum.', 'Merge styles of often opposite ends of the fashion spectrum.', '介词 at/of 录入差异，均指融合风格两极'],
  ['2025-12-2', 10, 'B', 'B', 'By observing the eating behavior of strict vegetarians.', 'By observing the eating behaviour of strict vegetarians.', 'behavior/behaviour 英美拼写'],
  ['2025-12-2', 16, 'B', 'B', 'It reflects distinct traits in animal behavior.', 'It reflects distinct traits in animal behaviour.', 'behavior/behaviour 英美拼写'],
  ['2025-12-2', 16, 'C', 'C', "It demonstrates animals' ability to recognize themselves.", "It demonstrates animals' ability to recognise themselves.", 'recognize/recognise 英美拼写'],
  ['2025-12-2', 17, 'A', 'A', 'It meets few of the behavioral criteria set in the mirror test.', 'It meets few of the behavioural criteria set in the mirror test.', 'behavioral/behavioural 英美拼写'],
].map(([id, number, localKey, referenceKey, localText, referenceText, reason, equivalent = true]) => ({ paperId: `cet6-${id}`, number, localKey, referenceKey, localText, referenceText, reason, equivalent }));

const THIRD_SOURCE = {
  paperId: 'cet6-2023-12-2', number: 16,
  url: 'https://cet6.koolearn.com/20231216/881799.html',
  label: '新东方在线教师整理 · 2023年12月六级听力第二套',
  selectedText: 'To argue about the value of a college degree.',
  reason: '过级鸭 Q16 误选了“解释男性就业下降”；新东方教师整理的正确选项内容为“争论大学学位价值”，与本地 A 及 ritual 后的不定式直接对应。字母顺序不同，按选项内容核对，保留本地 A。',
};
const CORRECTION_SOURCE = {
  paperId: 'cet6-2021-06-2', number: 23,
  url: 'https://m.hujiang.com/en_yingxiangli/p1348590/',
  label: '星火英语 · 2021年6月12日听力答案（沪江转载）',
  selectedText: 'They are not satisfied with the management.',
  previousAnswer: 'C', correctedAnswer: 'B',
  reason: '本地来源误选 C。过级鸭参考答案与考试当日星火英语答案均选择 B；录音列举对流程的宗旨、投入、耗时及效果不认同，概括为对管理不满意，没有说明为避免损失。',
  explanation: '经两个独立参考答案来源核对，正确项为 B：They are not satisfied with the management。录音列举员工故意违背规程的原因：时间压力、对规程精神及其投入、耗时和有效性不认同，或出于固执。B 是这些不满的概括；C 所说避免不必要损失不是录音明确给出的原因。原采集站选 C 的解析已列为纠错项。',
};

const OPTION_PROOFS = [
  { paperId: 'cet6-2021-12-1', numbers: [23], url: 'https://www.yeyulingfeng.com/wendang/74929.html', label: '2021年12月公开原卷 Word 排版预览', filename: 'cet6-2021-12-1-original-preview.html', snippets: ['Understating their previous achievements.'] },
  { paperId: 'cet6-2022-12-2', numbers: [1], url: 'https://www.yeyulingfeng.com/wendang/75034.html', label: '2022年12月原卷公开PDF预览（第1题完整选项）', filename: 'cet6-2022-12-2-original-preview.html', snippets: ['Consuming more only when earning more.'] },
  { paperId: 'cet6-2024-06-2', numbers: [7], url: 'https://xxgcxy.ztbu.edu.cn/attachment/sites/item/2024_11/05_17/48925a74ccee4639.pdf', label: '郑州工商学院公开六级原卷 PDF · 第1页第7题', filename: 'cet6-2024-06-original-university.pdf', reviewedPage: 1, reviewedText: 'All the properties in Berkton were designed by the same architect.', expectedSha256: '0ab68ccf6ec0b1db87ee797737630d1cb1c6d433b1549509e8e18b35ef9e3518' },
  { paperId: 'cet6-2025-06-1', numbers: [4, 12], url: 'https://eol.nju.edu.cn/cet6/papers/202506-1.html', label: '南京大学公开六级自测原卷 · 第4/12题', filename: 'cet6-2025-06-1-original-nju.html', snippets: ['Whether they can find help somewhere else.', 'They are actually proud of the goods and services they produce.'] },
];
async function collectOptionProofs() {
  const results = [];
  for (const proof of OPTION_PROOFS) {
    const file = path.join(ROOT, 'data', 'references', proof.filename);
    try {
      let bytes;
      try { bytes = await fs.readFile(file); }
      catch {
        const response = await fetch(proof.url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}; access restriction respected`);
        bytes = Buffer.from(await response.arrayBuffer()); await fs.writeFile(file, bytes);
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const proven = proof.expectedSha256 ? sha256 === proof.expectedSha256 : proof.snippets.every(snippet => normalize(stripHtml(bytes.toString('utf8'))).includes(normalize(snippet)));
      results.push({ ...proof, proven, sha256 });
    } catch (error) { results.push({ ...proof, proven: false, error: error.message }); }
  }
  return results;
}

async function thirdSourceProof() {
  const file = path.join(ROOT, 'data', 'references', 'cet6-2023-12-2-koolearn.html');
  let html;
  try { html = await fs.readFile(file, 'utf8'); }
  catch {
    const response = await fetch(THIRD_SOURCE.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`第三来源 HTTP ${response.status}`);
    html = await response.text(); await fs.writeFile(file, html, 'utf8');
  }
  const body = stripHtml(html);
  const proven = /16\s*\.\s*B\s*\)\s*To argue about the value of a college degree\s*\./i.test(body);
  return { ...THIRD_SOURCE, downloaded: true, proven, sourceFile: path.basename(file) };
}
async function correctionSourceProof() {
  const file = path.join(ROOT, 'data', 'references', 'cet6-2021-06-2-hujiang-xinghuo.html');
  let html;
  try { html = await fs.readFile(file, 'utf8'); }
  catch {
    const response = await fetch(CORRECTION_SOURCE.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`星火英语参考来源 HTTP ${response.status}`);
    html = await response.text(); await fs.writeFile(file, html, 'utf8');
  }
  const body = stripHtml(html);
  const proven = /23\s*[.．]\s*B\s*[)）]?\s*They are not satisfied with the management\s*\./i.test(body);
  return { ...CORRECTION_SOURCE, downloaded: true, proven, sourceFile: path.basename(file) };
}

export async function reconcile() {
  const directory = path.join(ROOT, 'data', 'references');
  const verification = JSON.parse(await fs.readFile(path.join(directory, 'answer-verification.json'), 'utf8'));
  const proof = await thirdSourceProof();
  const correctionProof = await correctionSourceProof();
  const optionProofs = await collectOptionProofs();
  const summaries = [];
  for (const initial of verification.summaries) {
    const paper = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'papers', `${initial.paperId}.json`), 'utf8'));
    const referenceId = REFERENCE_SWAPS[paper.id] || paper.id;
    const reference = parseReference(await fs.readFile(path.join(directory, `${referenceId}-reference.html`), 'utf8'));
    const issues = [], results = [];
    for (const question of paper.questions) {
      const other = reference.find(q => q.number === question.number), mapping = {}, reviewedExceptions = [];
      if (!other) { results.push({ number: question.number, answersVerified: false, questionsVerified: false, error: 'reference-missing' }); continue; }
      for (const [key, value] of Object.entries(question.options)) {
        const exact = Object.entries(other.options).find(([, candidate]) => normalize(candidate) === normalize(value));
        if (exact) { mapping[key] = exact[0]; continue; }
        const approved = annotations.find(a => a.paperId === paper.id && a.number === question.number && a.localKey === key && normalize(a.localText) === normalize(value) && normalize(a.referenceText) === normalize(other.options[a.referenceKey]));
        if (approved) { mapping[key] = approved.referenceKey; reviewedExceptions.push(approved); }
        else issues.push({ number: question.number, key, local: value, referenceOptions: other.options, issue: 'unreviewed-option-difference' });
      }
      const completeMapping = Object.keys(mapping).length === 4 && new Set(Object.values(mapping)).size === 4;
      const mappedAnswer = Object.keys(mapping).find(key => mapping[key] === other.answer);
      const thirdSourceOverride = paper.id === proof.paperId && question.number === proof.number && proof.proven && normalize(question.options[question.answer]) === normalize(proof.selectedText);
      const answerCorrection = paper.id === correctionProof.paperId && question.number === correctionProof.number && correctionProof.proven && normalize(question.options[correctionProof.correctedAnswer]) === normalize(correctionProof.selectedText) && mappedAnswer === correctionProof.correctedAnswer ? correctionProof : null;
      const answersVerified = completeMapping && (mappedAnswer === question.answer || thirdSourceOverride || !!answerCorrection);
      const additionalProof = optionProofs.find(p => p.paperId === paper.id && p.numbers.includes(question.number) && p.proven);
      const questionsVerified = completeMapping && (reviewedExceptions.every(exception => exception.equivalent) || !!additionalProof);
      const correctionPatch = answerCorrection ? { questionId: question.id, number: question.number, answer: answerCorrection.correctedAnswer, explanation: answerCorrection.explanation, evidenceSentenceIds: paper.passages.find(p => p.id === question.passageId).sentences.filter(s => /At other times, they may disagree with the spirit of the procedure|And every now and then, they just don't want to/.test(s.text)).map(s => s.id) } : null;
      if (correctionPatch && correctionPatch.evidenceSentenceIds.length !== 2) throw new Error('纠错依据句结构发生变化，请重新校对');
      results.push({ number: question.number, localAnswer: question.answer, referenceAnswer: other.answer, mappedAnswer, mapping, answersVerified, questionsVerified, ...(reviewedExceptions.length ? { reviewedExceptions } : {}), ...(additionalProof ? { additionalOptionProof: additionalProof } : {}), ...(thirdSourceOverride ? { thirdSourceOverride: proof } : {}), ...(answerCorrection ? { answerCorrection, correctionPatch } : {}) });
    }
    summaries.push({ paperId: paper.id, referenceId, url: `https://www.guojiya.cn/exam/${referenceId.replace('cet6-', 'cet6_').replaceAll('-', '_')}/answers`, sourceVariantSwapped: referenceId !== paper.id, answersVerified: results.length === 25 && results.every(q => q.answersVerified), questionsVerified: results.length === 25 && results.every(q => q.questionsVerified), verified: results.length === 25 && results.every(q => q.answersVerified), matchedAnswers: results.filter(q => q.answersVerified).length, issues, results });
  }
  const report = { checkedAt: new Date().toISOString(), method: 'Exact normalized option matching plus enumerated spelling/grammar differences checked against saved source text; original option letters preserved. Substantively different distractors require additional original-paper proof. Two answer conflicts resolved with named third sources and transcript: keep 2023-12-2 Q16 A; correct 2021-06-2 Q23 C to B before applying verified status. This source comparison was performed by the coding agent, not a human examiner.', total: summaries.length, answersVerified: summaries.filter(s => s.answersVerified).length, questionsVerified: summaries.filter(s => s.questionsVerified).length, thirdSource: proof, correctionSource: correctionProof, optionProofs, summaries };
  await writeJson(path.join(directory, 'reconciliation.json'), report);
  console.log(JSON.stringify({ total: report.total, answersVerified: report.answersVerified, questionsVerified: report.questionsVerified, remaining: summaries.filter(s => !s.answersVerified).map(s => ({ paperId: s.paperId, matchedAnswers: s.matchedAnswers, issues: s.issues })) }, null, 2));
  return report;
}
export async function applyReconciliation(report) {
  const backupDirectory = path.join(ROOT, 'data', 'references', 'before-reconciliation');
  await fs.mkdir(backupDirectory, { recursive: true });
  let applied = 0;
  for (const summary of report.summaries) {
    if (!summary.answersVerified) continue;
    const file = path.join(ROOT, 'data', 'papers', `${summary.paperId}.json`);
    const original = await fs.readFile(file, 'utf8'), paper = JSON.parse(original);
    for (const row of summary.results) if (row.correctionPatch) {
      const q = paper.questions.find(question => question.id === row.correctionPatch.questionId);
      if (!q || ![row.localAnswer, row.correctionPatch.answer].includes(q.answer)) throw new Error(`${paper.id} Q${row.number} 答案在审核后改变，停止应用`);
      Object.assign(q, row.correctionPatch); delete q.questionId;
    }
    const backupFile = path.join(backupDirectory, `${paper.id}.json`);
    try { await fs.writeFile(backupFile, original, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    paper.quality.answers = 'verified';
    paper.quality.questions = summary.questionsVerified ? 'verified' : 'candidate';
    const addSource = (url, label, kind) => { if (!paper.sources.some(source => source.url === url && source.kind === kind)) paper.sources.push({ url, label, kind, fetchedAt: report.checkedAt }); };
    addSource(summary.url, summary.sourceVariantSwapped ? '过级鸭 · 按25题内容确认跨站套号对换' : '过级鸭 · 逐题选项内容映射核对', 'answers');
    addSource(summary.url, '过级鸭 · 原题选项逐项核对', 'questions');
    for (const row of summary.results) {
      if (row.thirdSourceOverride) addSource(row.thirdSourceOverride.url, row.thirdSourceOverride.label, 'answers');
      if (row.answerCorrection) addSource(row.answerCorrection.url, row.answerCorrection.label, 'answers');
      if (row.additionalOptionProof) addSource(row.additionalOptionProof.url, row.additionalOptionProof.label, 'questions');
    }
    paper.notes = (paper.notes || []).filter(note => !note.includes('尚待独立来源核对'));
    const note = summary.questionsVerified ? '试题选项与答案经第二来源逐题核对；拼写差异及第三来源纠错详见 references/reconciliation.json。' : '答案已经第二来源逐题核对；部分干扰项仍有来源差异，题目质量保留待校对，详见 references/reconciliation.json。';
    if (!paper.notes.includes(note)) paper.notes.push(note);
    await writeJson(file, paper); applied++;
  }
  console.log(`已应用 ${applied} 套答案核验，原资料保存在 data/references/before-reconciliation。`);
  return applied;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await reconcile();
  if (process.argv.includes('--apply')) await applyReconciliation(report);
}
