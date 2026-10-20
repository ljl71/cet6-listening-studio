import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { readJson, writeJson } from './lib/corpus.mjs';
import { validateTimings } from '../server/validation.mjs';
import { verifyCurrentAcousticEvidence } from './lib/acoustic-evidence.mjs';
import { verifyCurrentBoundaryCandidateEvidence } from './lib/six-boundary-evidence.mjs';
import { verifyJointBoundaryEvidence } from './lib/joint-boundary-evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const words = text => (text.replace(/^[WM]:\s*/i, '').toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) || []).map(x => {const word=x.replace(/[’']/g, '');return word==='okay'?'ok':word;});

export function recognizedWords(result) {
  const items = [];
  for (const segment of result.transcription || []) {
    const start = Number(segment.offsets?.from) / 1000;
    const end = Number(segment.offsets?.to) / 1000;
    const text = words(segment.text || '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text.length || /\[.*\]/.test(segment.text)) continue;
    // The recognizer is configured to emit individual words. Do not invent timings
    // by splitting a long ASR segment into evenly spaced words.
    for (const word of text) items.push({ word, start, end });
  }
  return items;
}

export function alignSentences(sentences, recognized, offset = 0, maximum = Infinity, {includeEvidence=false}={}) {
  const source = sentences.flatMap((sentence, sentenceIndex) => words(sentence.text).map(word => ({ word, sentenceIndex })));
  const m = source.length, n = recognized.length;
  const table = new Uint16Array((m + 1) * (n + 1));
  const width = n + 1;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) table[i * width + j] = source[i - 1].word === recognized[j - 1].word ? table[(i - 1) * width + j - 1] + 1 : Math.max(table[(i - 1) * width + j], table[i * width + j - 1]);
  let i = m, j = n;
  const matches = [];
  while (i && j) {
    if (source[i - 1].word === recognized[j - 1].word) { matches.push({ source: i - 1, recognized: j - 1 }); i--; j--; }
    else if (table[(i - 1) * width + j] >= table[i * width + j - 1]) i--; else j--;
  }
  matches.reverse();
  const result = sentences.map((sentence, sentenceIndex) => {
    const matched = matches.filter(match => source[match.source].sentenceIndex === sentenceIndex);
    const expected = words(sentence.text).length;
    const coverage = expected ? matched.length / expected : 0;
    const first = matched[0] && recognized[matched[0].recognized];
    const last = matched.at(-1) && recognized[matched.at(-1).recognized];
    const start = first ? Math.max(offset, offset + first.start - 0.12) : 0;
    const end = last ? Math.min(maximum, offset + last.end + 0.16) : 0;
    const usable = coverage >= 0.65 && matched.length >= Math.min(2, expected) && end > start;
    const firstSourceIndex=source.findIndex(item=>item.sentenceIndex===sentenceIndex);
    return { id: sentence.id, start: usable ? +start.toFixed(3) : 0, end: usable ? +end.toFixed(3) : 0, coverage: +coverage.toFixed(3), matchedWords: matched.length, expectedWords: expected, reviewed: false, method: 'local-whisper-word-alignment', text: sentence.text, ...(includeEvidence?{wordEvidence:matched.map(match=>({sourceWord:source[match.source].word,sourceWordIndex:match.source-firstSourceIndex,recognizedWord:recognized[match.recognized].word,start:+(offset+recognized[match.recognized].start).toFixed(3),end:+(offset+recognized[match.recognized].end).toFixed(3),recognitionWordIndex:match.recognized}))}:{}) };
  });
  let previous = null;
  for (const sentence of result) {
    if (sentence.end <= sentence.start) continue;
    if (previous && sentence.start < previous.end) {
      const boundary = +((previous.end + sentence.start) / 2).toFixed(3);
      if (boundary > previous.start && boundary < sentence.end) { previous.end = boundary; sentence.start = boundary; }
      else { sentence.start = 0; sentence.end = 0; continue; }
    }
    previous = sentence;
  }
  return result;
}

export function alignPassage(paper,passage,recognition,{includeEvidence=false,rejectTimingRisks=true,maxWordDuration=2,maxMatchedWordGap=2}={}){
  // Spoken questions follow the narrative in the same audio. They must take part
  // in sequence matching so common narrative tail words cannot drift into them.
  const guards=paper.questions.filter(q=>q.passageId===passage.id&&q.prompt).sort((a,b)=>a.number-b.number).map(q=>({id:`__oral-question-${q.id}`,text:q.prompt}));
  const aligned=alignSentences([...passage.sentences,...guards],recognizedWords(recognition),passage.start,passage.end,{includeEvidence:true});
  const firstQuestion=aligned.slice(passage.sentences.length).find(s=>s.end>s.start);
  return aligned.slice(0,passage.sentences.length).map(sentence=>{
    const evidence=sentence.wordEvidence;const excessiveWords=evidence.filter(w=>w.end-w.start>maxWordDuration).map(w=>({...w,duration:+(w.end-w.start).toFixed(3)}));
    const largeGaps=evidence.slice(1).flatMap((w,i)=>w.start-evidence[i].end>maxMatchedWordGap?[{previousWord:evidence[i],nextWord:w,gap:+(w.start-evidence[i].end).toFixed(3)}]:[]);
    const timingWarnings=[...(excessiveWords.length?[{kind:'oversized-word-span',threshold:maxWordDuration,words:excessiveWords}]:[]),...(largeGaps.length?[{kind:'non-contiguous-word-match',threshold:maxMatchedWordGap,gaps:largeGaps}]:[])];
    const first=evidence[0],last=evidence.at(-1);const unmatchedPrefix=first?first.sourceWordIndex:sentence.expectedWords;const unmatchedSuffix=last?sentence.expectedWords-last.sourceWordIndex-1:sentence.expectedWords;
    const result={...sentence,method:'question-guarded-local-whisper-word-alignment',virtualQuestionCount:guards.length,questionStart:firstQuestion?.start??null,unmatchedPrefix,unmatchedSuffix,timingWarnings,needsAcousticReview:timingWarnings.length>0};
    if(rejectTimingRisks&&timingWarnings.length){result.rawStart=result.start;result.rawEnd=result.end;result.start=0;result.end=0;}
    if(!includeEvidence)delete result.wordEvidence;return result;
  });
}

function run(command, args, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd: root });
    let output = '';
    child.stdout.on('data', b => { output += b.toString(); });
    child.stderr.on('data', b => { output += b.toString(); });
    child.on('error', reject);
    child.on('close', async code => { if (log) await fs.writeFile(log, output); code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}: ${output.slice(-1200)}`)); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const selected = args.find(x => x.startsWith('--paper='))?.slice(8);
  const onlyPassage = Number(args.find(x => x.startsWith('--passage='))?.slice(10)) || null;
  const shard = args.find(x => x.startsWith('--shard='))?.slice(8).split('/').map(Number);
  const mediaTools = await readJson(path.join(root, 'runtime', 'media-tools.json'));
  const speech = await readJson(path.join(root, 'runtime', args.includes('--model=tiny') ? 'speech-tools-tiny.json' : 'speech-tools.json'));
  if (!mediaTools || !speech) throw new Error('请先运行 setup-tools.mjs ffmpeg 和 whisper');
  const assets = await readJson(path.join(root, 'data', 'assets.json'), {});
  const acousticEvidenceCache=new Map();
  const sparseCompletion = await readJson(path.join(root, 'data', 'references', 'missing-alignment-completion.json'), {boundaryAdjustments:[]});
  const files = (await fs.readdir(path.join(root, 'data', 'papers'))).filter(x => x.endsWith('.json') && (!selected || x === `${selected}.json`)).sort();
  for (const [fileIndex, file] of files.entries()) {
    if (shard && fileIndex % shard[1] !== shard[0]) continue;
    const paper = await readJson(path.join(root, 'data', 'papers', file));
    if (!paper.audioAssetId || !assets[paper.audioAssetId]) { console.log(`${paper.id}: 尚无本地音频，跳过`); continue; }
    const folder = path.join(root, 'data', 'alignment', paper.id);
    await fs.mkdir(folder, { recursive: true });
    const all = [];
    for (const passage of paper.passages) {
      if (onlyPassage && passage.order !== onlyPassage) continue;
      const stem = path.join(folder, `passage-${passage.order}`);
      const wav = `${stem}.wav`, output = `${stem}.json`;
      let recognition = await readJson(output, null);
      if (!recognition) {
        const started = Date.now();
        await run(mediaTools.ffmpeg, ['-hide_banner','-loglevel','error','-y','-ss',String(passage.start),'-i',path.join(root, 'data', assets[paper.audioAssetId].path),'-t',String(passage.end-passage.start),'-ar','16000','-ac','1','-c:a','pcm_s16le',wav]);
        await run(speech.whisper, ['-m',path.relative(root,speech.model),'-f',path.relative(root,wav),'-l','en','-t','6','-ng','-ml','1','-sow','-bo','1','-bs','1','-nf','-ojf','-of',path.relative(root,stem)], `${stem}.log`);
        recognition = await readJson(output);
        console.log(`${paper.id} 第${passage.order}篇: 识别 ${((Date.now()-started)/1000).toFixed(1)} 秒`);
      }
      let aligned = alignPassage(paper,passage,recognition,{includeEvidence:true});
      const lowCoverage = aligned.filter(s => s.end > s.start).length / Math.max(1, aligned.length) < 0.92 || aligned.reduce((sum,s)=>sum+s.coverage,0)/Math.max(1,aligned.length)<0.87 || (args.includes('--retry-missing') && aligned.some(s => s.end <= s.start));
      if (args.includes('--model=tiny') && lowCoverage && recognition.params?.model?.includes('tiny')) {
        const base = await readJson(path.join(root,'runtime','speech-tools.json'));
        const fallbackStem = `${stem}-base`;
        let fallback = await readJson(`${fallbackStem}.json`, null);
        if (!fallback&&!args.includes('--cached-only')) {
          console.log(`${paper.id} 第${passage.order}篇: 匹配不足，使用较大模型复核`);
          await run(base.whisper, ['-m',path.relative(root,base.model),'-f',path.relative(root,wav),'-l','en','-t','6','-ng','-ml','1','-sow','-bo','1','-bs','1','-nf','-ojf','-of',path.relative(root,fallbackStem)], `${fallbackStem}.log`);
          fallback = await readJson(`${fallbackStem}.json`);
        }
        if(fallback){
          const alternative = alignPassage(paper,passage,fallback,{includeEvidence:true});
          const validCount = values => values.filter(s => s.end > s.start).length;
          const riskCount=values=>values.filter(s=>s.timingWarnings.length).length;
          if (validCount(alternative)>validCount(aligned) || (validCount(alternative)===validCount(aligned) && (riskCount(alternative)<riskCount(aligned)||(riskCount(alternative)===riskCount(aligned)&&alternative.reduce((sum,s)=>sum+s.coverage,0)>aligned.reduce((sum,s)=>sum+s.coverage,0))))) aligned=alternative;
        }
      }
      all.push({ id: passage.id, sentences: aligned });
      console.log(`${paper.id} 第${passage.order}篇: ${aligned.filter(s => s.end>s.start).length}/${aligned.length} 句候选（未人工校对）`);
      await writeJson(path.join(folder, 'candidates.json'), { paperId: paper.id, audioAssetId: paper.audioAssetId, generatedAt: new Date().toISOString(), reviewed: false, passages: all });
    }
    if (args.includes('--apply')) {
      // Reload after the long-running recognition to preserve other metadata changes.
      const current = await readJson(path.join(root, 'data', 'papers', file));
      if (current.audioAssetId !== paper.audioAssetId) throw new Error('音频版本已改变，拒绝应用旧时间轴');
      for (const passage of current.passages) {
        const candidate = all.find(p => p.id === passage.id);
        if (!candidate) continue;
        for (const sentence of passage.sentences) {
          const timing = candidate.sentences.find(s => s.id === sentence.id);
          const protectedEvidence=(sentence.alignmentEvidence?.report==='references/missing-alignment-completion.json'&&sentence.end>sentence.start)||await verifyCurrentAcousticEvidence(sentence,current,passage,assets[current.audioAssetId],path.join(root,'data'),acousticEvidenceCache)||await verifyCurrentBoundaryCandidateEvidence(sentence,current,passage,assets[current.audioAssetId],path.join(root,'data'),acousticEvidenceCache)||await verifyJointBoundaryEvidence(sentence,current,passage,assets[current.audioAssetId],path.join(root,'data'),acousticEvidenceCache);
          if (timing && !sentence.reviewed&&!protectedEvidence) Object.assign(sentence, { start: timing.start, end: timing.end, reviewed: false, alignmentConfidence: timing.coverage, timingWarnings:timing.timingWarnings, alignmentEvidence:{method:timing.method,report:`alignment/${paper.id}/candidates.json`,questionGuarded:true} });
        }
        // A restored short interjection can sit inside padding added by the old
        // full-passage recognizer. Reuse only the documented padding correction
        // when the exact old boundary reappears; never move its speech evidence.
        for(const correction of sparseCompletion.boundaryAdjustments||[]){
          if(correction.paperId!==current.id)continue;
          const sentence=passage.sentences.find(s=>s.id===correction.sentenceId);
          if(sentence&&!sentence.reviewed&&sentence.end>sentence.start&&Math.abs(sentence[correction.field]-correction.before)<0.001&&!await verifyCurrentAcousticEvidence(sentence,current,passage,assets[current.audioAssetId],path.join(root,'data'),acousticEvidenceCache)&&!await verifyCurrentBoundaryCandidateEvidence(sentence,current,passage,assets[current.audioAssetId],path.join(root,'data'),acousticEvidenceCache)&&!await verifyJointBoundaryEvidence(sentence,current,passage,assets[current.audioAssetId],path.join(root,'data'),acousticEvidenceCache)){
            sentence[correction.field]=correction.after;
            sentence.alignmentEvidence={...sentence.alignmentEvidence,boundaryCorrectionReport:'references/missing-alignment-completion.json'};
          }
        }
      }
      current.quality.timing = 'candidate';
      current.notes = [...new Set([...(current.notes||[]).filter(x => !x.includes('保留 0/0')), '句子时间由本机语音识别匹配原文生成，尚未逐句人工校对；未匹配句子不提供自动复读。'])];
      validateTimings(current);
      const guardBackup=path.join(root,'data','references','before-alignment-guards');await fs.mkdir(guardBackup,{recursive:true});try{await fs.writeFile(path.join(guardBackup,file),await fs.readFile(path.join(root,'data','papers',file)),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
      await writeJson(path.join(root, 'data', 'papers', file), current);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
