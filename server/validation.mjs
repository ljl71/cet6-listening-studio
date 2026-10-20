export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const fail = (message, status = 400) => { throw new HttpError(status, message); };
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const clone = value => JSON.parse(JSON.stringify(value));
export const optionSet = new Set(['A', 'B', 'C', 'D']);
export const types = ['conversation', 'passage', 'lecture'];
export const qualityKeys = ['audio', 'questions', 'answers', 'transcript', 'timing'];
export function identifier(value, label = '编号') {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_.-]{1,160}$/u.test(value) || value === '.' || value === '..') fail(`${label}格式无效`);
  return value;
}
// Annotation IDs are logical keys, never filesystem names. The UI composes them
// as paperId:s:sentenceId or paperId:q:questionId to make saves idempotent.
export function annotationIdentifier(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_.:-]{1,500}$/u.test(value) || value === '.' || value === '..') fail('笔记编号格式无效');
  return value;
}
export function text(value, label, max = 100000) {
  if (typeof value !== 'string' || value.length > max) fail(`${label}必须是文本且不超过 ${max} 字符`);
  return value;
}
export function number(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label}超出有效范围`);
  return value;
}
export function array(value, label, max = 10000) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}必须是数组且不超过 ${max} 项`);
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label}编号重复`);
}
export function validateTimings(paper, passages = paper.passages, { strict = false } = {}) {
  let previousPassageEnd = 0;
  let previousRealSentenceEnd = 0;
  const allSentenceIds = [];
  for (const passage of passages) {
    identifier(passage.id, '篇章');
    number(passage.start, '篇章开始', 0, paper.duration);
    number(passage.end, '篇章结束', 0, paper.duration);
    const untimedPassage = passage.start === 0 && passage.end === 0;
    if (strict && (untimedPassage || passage.end <= passage.start)) fail('待核验篇章必须有有效时间');
    if (!untimedPassage && (passage.end <= passage.start || passage.start < previousPassageEnd - 0.001)) fail('篇章时间必须有序且不重叠');
    if (!untimedPassage) previousPassageEnd = passage.end;
    array(passage.sentences, '句子', 3000);
    if (strict && !passage.sentences.length) fail('待核验篇章必须包含句子');
    let previousEnd = passage.start;
    let passageRealSentenceEnd = 0;
    for (const [sentenceIndex, sentence] of passage.sentences.entries()) {
      identifier(sentence.id, '句子'); allSentenceIds.push(sentence.id);
      text(sentence.text, '原文');
      if (!sentence.text.trim()) fail('原文不能为空');
      if (sentence.translation !== undefined) text(sentence.translation, '译文');
      if (typeof sentence.reviewed !== 'boolean') fail('句子校对状态无效');
      number(sentence.start, '句子开始', 0, paper.duration);
      number(sentence.end, '句子结束', 0, paper.duration);
      const untimed = sentence.start === 0 && sentence.end === 0;
      if (strict && (untimed || !sentence.reviewed)) fail('每句都必须完成时间校对并勾选');
      // Only the physical first sentence may retain up to 300 ms of preceding
      // audio. The decoded parent range stays unchanged, and this buffer must
      // never enter an earlier passage's actual spoken sentence.
      const minimumStart = sentenceIndex === 0 ? Math.max(0, passage.start - 0.3, previousRealSentenceEnd) : passage.start;
      if (!untimed && (untimedPassage || sentence.end <= sentence.start ||
          sentenceIndex > 0 && sentence.start < previousEnd - 0.001 ||
          sentence.start < minimumStart - 1e-9 || sentence.end > passage.end + 0.001)) fail('句子时间必须在篇章内有序且不重叠；仅首句允许最多 0.3 秒前置缓冲');
      if (!untimed) { previousEnd = sentence.end; passageRealSentenceEnd = Math.max(passageRealSentenceEnd, sentence.end); }
    }
    previousRealSentenceEnd = Math.max(previousRealSentenceEnd, passageRealSentenceEnd);
  }
  unique(passages.map(p => p.id), '篇章'); unique(allSentenceIds, '句子');
}
export function validatePaper(input) {
  if (!isObject(input)) fail('试卷资料格式无效');
  const paper = clone(input);
  identifier(paper.id, '试卷'); identifier(paper.contentId, '内容');
  text(paper.title, '标题', 500); text(paper.variant, '套号', 100);
  if (!paper.title.trim()) fail('标题不能为空');
  if (!Number.isInteger(paper.year) || paper.year < 2000 || paper.year > 2100) fail('年份无效');
  if (!Number.isInteger(paper.month) || paper.month < 1 || paper.month > 12) fail('月份无效');
  number(paper.duration, '音频时长', 0, 14400);
  if (typeof paper.required !== 'boolean') fail('必需资料标记无效');
  if (paper.audioAssetId !== null) identifier(paper.audioAssetId, '音频');
  if (!isObject(paper.quality) || qualityKeys.some(key => !['missing', 'candidate', 'verified'].includes(paper.quality[key]))) fail('资料质量状态无效');
  array(paper.sources, '来源', 100);
  for (const source of paper.sources) {
    if (!isObject(source)) fail('来源格式无效');
    text(source.url, '来源网址', 4000); text(source.label, '来源名称', 500);
    if (!['audio', 'questions', 'answers', 'transcript', 'timing', 'catalog'].includes(source.kind)) fail('来源类型无效');
    try { if (!['https:', 'http:', 'file:'].includes(new URL(source.url).protocol)) fail('来源网址协议无效'); } catch { fail('来源网址无效'); }
  }
  array(paper.passages, '篇章', 50); array(paper.questions, '题目', 200);
  for (const passage of paper.passages) {
    identifier(passage.id, '篇章'); text(passage.title, '篇章标题', 500);
    if (!types.includes(passage.type) || !Number.isInteger(passage.order) || passage.order < 1) fail('篇章类型或顺序无效');
  }
  unique(paper.passages.map(p => p.order), '篇章顺序');
  const passageIds = new Set(paper.passages.map(p => p.id));
  const sentenceIds = new Set(paper.passages.flatMap(p => p.sentences || []).map(s => s.id));
  for (const q of paper.questions) {
    identifier(q.id, '题目');
    if (!Number.isInteger(q.number) || q.number < 1 || q.number > 200 || !passageIds.has(q.passageId)) fail('题号或关联篇章无效');
    if (!isObject(q.options) || [...optionSet].some(key => typeof q.options[key] !== 'string' || !q.options[key].trim())) fail('每题必须具备 A、B、C、D 四个选项');
    for (const value of Object.values(q.options)) text(value, '选项', 10000);
    if (q.answer !== undefined && !optionSet.has(q.answer)) fail('答案只能为 A、B、C、D');
    if (q.evidenceSentenceIds !== undefined) {
      array(q.evidenceSentenceIds, '依据句', 100);
      if (q.evidenceSentenceIds.some(id => !sentenceIds.has(id))) fail('答案依据句不存在');
    }
  }
  unique(paper.questions.map(q => q.id), '题目'); unique(paper.questions.map(q => q.number), '题号');
  if (paper.quality.answers === 'verified' && paper.questions.some(q => !optionSet.has(q.answer))) fail('已核验答案不能缺失');
  validateTimings(paper, paper.passages, { strict: paper.quality.timing === 'verified' });
  return paper;
}

export function validateAnswers(answers, paper) {
  if (!isObject(answers)) fail('答案必须是题目编号与选项的映射');
  const ids = new Set(paper.questions.map(q => q.id));
  for (const [id, answer] of Object.entries(answers)) {
    if (!ids.has(id) || (!optionSet.has(answer) && answer !== null)) fail('答案包含未知题目或无效选项');
  }
  return answers;
}
