import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,sha256,stripHtml} from './corpus.mjs';
import {runAudit} from './audit-acoustic.mjs';
import {alignPassage,recognizedWords,words} from '../align.mjs';
const root=path.resolve('.');
const acousticAudit=runAudit({root,output:path.join(root,'data/references/missing-acoustic-source-audit.json')});
const comparison=await readJson('data/references/independent-transcript-comparison.json',{allSentenceResults:[],papers:[]});
const pdf=await readJson('data/references/independent-pdf-transcript-comparison.json',{allSentenceResults:[],papers:[]});
const ledger=await readJson('data/references/transcript-text-adjudication-ledger.json',{items:[]});
const assets=await readJson('data/assets.json');const sourceCache=new Map();
function extractOccurrences(text,query){
 const indexed=[...text.matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g)].map(m=>({word:words(m[0])[0],from:m.index,to:m.index+m[0].length}));
 const expected=words(query);const occurrences=[];
 for(let i=0;i<=indexed.length-expected.length;i++)if(indexed.slice(i,i+expected.length).every((w,j)=>w.word===expected[j])){
  const start=indexed[i].from,end=indexed[i+expected.length-1].to;occurrences.push({matchedText:text.slice(start,end),context:text.slice(indexed[Math.max(0,i-9)].from,indexed[Math.min(indexed.length-1,i+expected.length+8)].to),characterRange:{start,end}});
 }
 return {expectedWords:expected.length,exactTokenOccurrences:occurrences.length,occurrences:occurrences.slice(0,3)};
}
async function secondSource(paper,passage,sentence){
 const result=comparison.allSentenceResults.find(r=>r.sentenceId===sentence.id);
 const pdfResult=pdf.allSentenceResults.find(r=>r.sentenceId===sentence.id);
 const detailed=ledger.items.find(r=>r.sentenceId===sentence.id);
 if(result?.sourceHtml){
  if(!sourceCache.has(result.sourceHtml)){const bytes=await fs.readFile(result.sourceHtml);const text=[...bytes.toString().matchAll(/<span[^>]*class="transcript-english"[^>]*>([\s\S]*?)<\/span>/g)].map(m=>stripHtml(m[1])).join(' ');sourceCache.set(result.sourceHtml,{sha256:sha256(bytes),text});}
  const source=sourceCache.get(result.sourceHtml);
  return {kind:'public-html',url:result.sourceUrl,file:result.sourceHtml,sha256:source.sha256,expectedSha256:result.sourceHash,hashMatches:source.sha256===result.sourceHash,
   comparisonState:result.state,comparisonSnapshotText:result.text,comparisonSnapshotMatchesCurrent:result.text===sentence.text,
   ...extractOccurrences(source.text,sentence.text),closestIndependentSentence:detailed?.source?.text||null,canonicalDiagnosticSpan:result.referenceSpan,
   timingPolicy:'仅对照文字，不采用来源网页不同音频版本的data-time。'};
 }
 if(pdfResult){
  const source=pdf.papers.find(p=>p.paperId===paper.id);const text=source?.passages.find(p=>p.passageId===passage.id)?.sourceText||'';
  const bytes=await fs.readFile(pdfResult.sourcePdf);
  return {kind:'public-pdf',url:source?.source.publicDirectory,file:pdfResult.sourcePdf,sha256:sha256(bytes),expectedSha256:pdfResult.sourcePdfSha256,hashMatches:sha256(bytes)===pdfResult.sourcePdfSha256,
   sourcePages:pdfResult.sourcePages,comparisonState:pdfResult.state,comparisonSnapshotText:pdfResult.localText,comparisonSnapshotMatchesCurrent:pdfResult.localText===sentence.text,
   ...extractOccurrences(text,sentence.text),canonicalDiagnosticSpan:pdfResult.referenceDiagnosticSpan,sourcePassageTextWhenNotExact:extractOccurrences(text,sentence.text).exactTokenOccurrences?undefined:text};
 }
 return {kind:'unavailable',note:'当前未取得可定位的第二原文，不以ASR替代源稿。'};
}
const report={generatedAt:new Date().toISOString(),readOnly:true,scope:'当前48处guard拒绝时间（0/0）的逐句候选证据；不会补值、放宽strict门槛或勾选reviewed。CTC和Whisper均为模型证据。',
 totals:{missingSentences:0,strictlySupported:0,notStrictlySupported:0,completePassageEvidence:0,staleOrPendingPassageEvidence:0,secondSourceHashValid:0},classifications:{},items:[]};
for(const file of(await fs.readdir('data/papers')).filter(f=>f.endsWith('.json')).sort()){
 const paper=await readJson(`data/papers/${file}`);
 for(const passage of paper.passages){
  const missing=passage.sentences.filter(s=>s.start===0&&s.end===0);if(!missing.length)continue;
  const audit=acousticAudit.passages.find(p=>p.passageId===passage.id);
  const ctcFile=`data/acoustic-review/${paper.id}/passage-${passage.order}.json`;let ctc=null,ctcHash=null;try{const bytes=await fs.readFile(ctcFile);ctc=JSON.parse(bytes);ctcHash=sha256(bytes);}catch(error){if(error.code!=='ENOENT')throw error;}
  const variants=[];
  for(const suffix of ['', '-base']){
   const file=`data/alignment/${paper.id}/passage-${passage.order}${suffix}.json`;try{const bytes=await fs.readFile(file);const raw=JSON.parse(bytes);variants.push({file,sha256:sha256(bytes),model:raw.params?.model,raw,recognized:recognizedWords(raw),aligned:alignPassage(paper,passage,raw,{includeEvidence:true,rejectTimingRisks:false})});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  for(const sentence of missing){
   const row=audit?.sentences.find(s=>s.id===sentence.id);const ctcSentence=ctc?.sentences.find(s=>s.id===sentence.id);const modelWords=ctcSentence?.words||[];
   const whisper=variants.map(variant=>{
    const aligned=variant.aligned.find(s=>s.id===sentence.id);const matched=aligned.wordEvidence;const first=matched[0],last=matched.at(-1);
    const context=first?variant.recognized.slice(Math.max(0,first.recognitionWordIndex-4),last.recognitionWordIndex+5).map(w=>({...w,start:+(passage.start+w.start).toFixed(3),end:+(passage.start+w.end).toFixed(3)})):[];
    return {file:variant.file,sha256:variant.sha256,model:variant.model,coverage:aligned.coverage,expectedWords:aligned.expectedWords,
     expectedFirstWords:words(sentence.text).slice(0,2),expectedLastWords:words(sentence.text).slice(-2),firstSourceWordMatched:!!first&&first.sourceWordIndex===0,lastSourceWordMatched:!!last&&last.sourceWordIndex===aligned.expectedWords-1,
     firstMatchedWords:matched.slice(0,2),lastMatchedWords:matched.slice(-2),timingWarnings:aligned.timingWarnings,unmatchedPrefix:aligned.unmatchedPrefix,unmatchedSuffix:aligned.unmatchedSuffix,
     contextText:context.map(w=>w.word).join(' '),contextWordTimes:context,timeBasis:'absolute original full-audio seconds',caution:'匹配首末词不等于整句已听校；缺首/尾词或词级跨度异常必须另查。'};
   });
   const source=await secondSource(paper,passage,sentence);
   const item={paperId:paper.id,passageId:passage.id,passageOrder:passage.order,sentenceId:sentence.id,text:sentence.text,current:{start:sentence.start,end:sentence.end,reviewed:sentence.reviewed},audioAssetId:paper.audioAssetId,mediaSha256:assets[paper.audioAssetId]?.sha256,sourceRange:{start:passage.start,end:passage.end},
    ctc:{file:ctcFile,sha256:ctcHash,passageStatus:audit?.status||'pending',issues:audit?.issues||[],provenanceGaps:audit?.provenanceGaps||[],
     rawSentenceMatchesCurrent:ctcSentence?.text===sentence.text,rawAudioMatchesCurrent:ctc?.audioAssetId===paper.audioAssetId&&ctc?.mediaSha256===assets[paper.audioAssetId]?.sha256,
     classification:row?.classification||'pending',supportedCandidate:!!row?.supportedCandidate,requiresListeningBeforeApplication:row?.requiresListeningBeforeApplication??true,
     acoustic:ctcSentence?{start:ctcSentence.acousticStart,end:ctcSentence.acousticEnd}:null,firstWords:modelWords.slice(0,2),lastWords:modelWords.slice(-2),
     lowestScoreWords:[...modelWords].sort((a,b)=>a.score-b.score).slice(0,3),score:row?.score||null,greedy:row?.independentTranscript||null,anomalies:row?.anomalies||[],tags:row?.tags||[],
     evidenceFreshForApplication:audit?.status==='completed'&&!!row?.supportedCandidate},whisper,secondSource:source};
   report.items.push(item);report.totals.missingSentences++;if(item.ctc.supportedCandidate)report.totals.strictlySupported++;else report.totals.notStrictlySupported++;
   if(audit?.status==='completed')report.totals.completePassageEvidence++;else report.totals.staleOrPendingPassageEvidence++;if(source.hashMatches)report.totals.secondSourceHashValid++;
   report.classifications[item.ctc.classification]=(report.classifications[item.ctc.classification]||0)+1;
  }
 }
}
await writeJson('data/references/missing-acoustic-evidence.json',report);console.log(JSON.stringify({totals:report.totals,classifications:report.classifications,notStrictlySupported:report.items.filter(i=>!i.ctc.supportedCandidate).map(i=>({sentenceId:i.sentenceId,text:i.text,state:i.ctc.classification,passageStatus:i.ctc.passageStatus}))},null,2));
