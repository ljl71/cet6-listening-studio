import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripHtml, readJson, writeJson } from './lib/corpus.mjs';

export function parseReference(html) {
  const starts = [...html.matchAll(/<div\b[^>]*\bdata-question-id="q(\d+)"/g)];
  return starts.map((match, index) => {
    const number = Number(match[1]);
    const chunk = html.slice(match.index, starts[index + 1]?.index || html.length);
    const options = {};
    let answer;
    for (const label of chunk.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
      const key = label[1].match(/\bvalue="([ABCD])"/)?.[1];
      const text = label[1].match(/<span class="whitespace-pre-wrap break-words">([\s\S]*?)<\/span>/)?.[1];
      if (key && text !== undefined) options[key] = stripHtml(text);
      if (key && /正确答案/.test(label[1])) answer = key;
    }
    return { number, options, answer };
  }).filter(q => q.number >= 1 && q.number <= 25 && q.answer && Object.keys(q.options).length === 4);
}

export const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

export function compareAnswers(paper, reference) {
  const results = paper.questions.map(question => {
    const other = reference.find(q => q.number === question.number);
    if (!other) return { number: question.number, optionsMatch: false, agrees: false, issue: 'reference-missing' };
    const mapping = Object.fromEntries(Object.entries(question.options).map(([key, text]) => [key, Object.entries(other.options).find(([, candidate]) => normalize(candidate) === normalize(text))?.[0]]));
    const optionsMatch = Object.values(mapping).every(Boolean) && new Set(Object.values(mapping)).size === 4;
    const mappedAnswer = Object.keys(mapping).find(key => mapping[key] === other.answer);
    return { number: question.number, optionsMatch, agrees: optionsMatch && mappedAnswer === question.answer, localAnswer: question.answer, referenceAnswer: other.answer, mappedAnswer, issue: !optionsMatch ? 'options-differ' : mappedAnswer !== question.answer ? 'answer-conflict' : null };
  });
  return { paperId: paper.id, count: results.length, matchedQuestions: results.filter(x => x.optionsMatch).length, matchedAnswers: results.filter(x => x.agrees).length, verified: results.length === 25 && results.every(x => x.agrees), results };
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = path.join(root, 'data', 'references');
  await fs.mkdir(directory, { recursive: true });
  const robotsUrl = 'https://www.guojiya.cn/robots.txt';
  const robots = await fetch(robotsUrl, { signal: AbortSignal.timeout(30000) });
  const robotsText = await robots.text();
  await fs.writeFile(path.join(directory, 'guojiya-robots.txt'), robotsText);
  if (robots.ok && /Disallow:\s*\/exam\b/i.test(robotsText)) throw new Error('Reference source disallows /exam; stop automatic access.');
  const summaries = [];
  const files = (await fs.readdir(path.join(root, 'data', 'papers'))).filter(x => x.endsWith('.json')).sort();
  for (const file of files) {
    const paper = await readJson(path.join(root, 'data', 'papers', file));
    const key = paper.id.replace('cet6-', 'cet6_').replaceAll('-', '_');
    const url = `https://www.guojiya.cn/exam/${key}/answers`;
    const localFile = path.join(directory, `${paper.id}-reference.html`);
    let html;
    try { html = await fs.readFile(localFile, 'utf8'); } catch {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(40000), headers: { 'User-Agent': 'CET6-Local-Study/0.1' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        html = await response.text();
        await fs.writeFile(localFile, html);
      } catch (error) { summaries.push({ paperId: paper.id, url, error: error.message, verified: false }); console.log(`${paper.id}: ${error.message}`); continue; }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    const reference = parseReference(html);
    const result = { ...compareAnswers(paper, reference), url, checkedAt: new Date().toISOString(), method: 'Cross-source comparison of all 100 option texts and 25 selected answers; letter order mapped by option text.' };
    summaries.push(result);
    console.log(`${paper.id}: options ${result.matchedQuestions}/25, answers ${result.matchedAnswers}/25${result.verified ? ' ✓' : ' 待处理'}`);
    if (process.argv.includes('--apply') && result.verified) {
      paper.quality.questions = 'verified';
      paper.quality.answers = 'verified';
      if (!paper.sources.some(s => s.url === url && s.kind === 'answers')) paper.sources.push({ url, label: '过级鸭公开真题答案 · 逐题选项交叉核对', kind: 'answers', fetchedAt: result.checkedAt });
      paper.notes = (paper.notes || []).filter(n => !n.includes('尚待独立来源核对'));
      paper.notes.push('试题选项和答案已与第二公开来源逐题匹配；这是参考答案交叉核验，不是考试机构官方发布声明。');
      await writeJson(path.join(root, 'data', 'papers', file), paper);
    }
  }
  await writeJson(path.join(directory, 'answer-verification.json'), { checkedAt: new Date().toISOString(), total: summaries.length, verified: summaries.filter(x => x.verified).length, summaries });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
