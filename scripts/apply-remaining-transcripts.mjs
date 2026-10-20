import fs from 'node:fs/promises';
import {decisions} from './remaining-transcript-decisions.mjs';
import {sha256,writeJson} from './lib/corpus.mjs';
import {validatePaper} from '../server/validation.mjs';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const {root}=await read('runtime/remaining-review-location.json'),snapshot=await read(`${root}/snapshot.json`);
try{const applied=await read(`${root}/transcript-application.json`);if(sha256(await fs.readFile(applied.document))!==applied.sha256)throw Error('Previously applied immutable transcript evidence changed');console.log(JSON.stringify({alreadyApplied:true,sha256:applied.sha256,changed:applied.changed,retained:applied.retained}));process.exit(0);}catch(e){if(e.code!=='ENOENT')throw e;}
const recognition=await read(`${root}/audio/windows-python.json`);
if(recognition.completed!==recognition.total||recognition.total!==92)throw Error('Independent original-audio review is incomplete');
if(decisions.length!==69||new Set(decisions.map(x=>x.sentenceId)).size!==69||snapshot.pendingText.some(x=>!decisions.some(d=>d.sentenceId===x.sentenceId)))throw Error('Decision scope differs from the exact 69 saved disputes');
const sources=[...(await read(`${root}/sources/manifest.json`)).sources,...(await read(`${root}/sources/additional-manifest.json`)).sources].filter(s=>s.available);
for(const s of sources)if(sha256(await fs.readFile(s.file))!==s.sha256)throw Error('Changed saved source');
const rows=[],papers=new Map(),checkedAt=new Date().toISOString();
for(const d of decisions){
 const old=snapshot.pendingText.find(s=>s.sentenceId===d.sentenceId);
 if(!papers.has(old.paperId)){const file=`data/papers/${old.paperId}.json`,bytes=await fs.readFile(file);papers.set(old.paperId,{file,bytes,hash:sha256(bytes),paper:JSON.parse(bytes)});}
 const target=papers.get(old.paperId),passage=target.paper.passages.find(p=>p.id===old.passageId),sentence=passage.sentences.find(s=>s.id===d.sentenceId);
 if(sentence.text!==old.localText||sentence.reviewed)throw Error('Current text changed or was already human-reviewed');
 let w=recognition.windows.find(w=>w.targets.some(t=>t.kind==='transcript'&&t.sentenceId===d.sentenceId));
 if(!w)throw Error('No independently decoded target window');
 const earlierIncompleteRecognition=d.sentenceId==='cet6-2025-06-1-p-1-5-s1'?structuredClone(w):null;
 if(earlierIncompleteRecognition){const m=await read(`${root}/audio/scheduling-expanded.meta.json`);w={...w,pythonRecognition:`${root}/audio/scheduling-expanded.json`,pythonMetadata:`${root}/audio/scheduling-expanded.meta.json`,sourceRange:m.identity.sourceRange,pythonText:m.text};}
 const meta=await read(w.pythonMetadata),bytes=await fs.readFile(w.pythonRecognition);
 const assets=await read('data/assets.json');
 if(sha256(bytes)!==meta.recognitionSha256||meta.identity.mediaSha256!==assets[target.paper.audioAssetId].sha256||meta.identity.audioAssetId!==target.paper.audioAssetId)throw Error('Recognition provenance mismatch');
 let text=sentence.text;
 for(const [from,to] of d.replacements){if(text.split(from).length!==2)throw Error(`Exact single contextual phrase missing: ${sentence.id}: ${from}`);text=text.replace(from,to);}
 rows.push({...d,paperId:old.paperId,passageId:old.passageId,previousText:sentence.text,text,textSha256:sha256(Buffer.from(text)),changed:text!==sentence.text,
  source:old.source,previousWhisper:old.whisper,previousCtc:old.ctc,earlierIncompleteRecognition,independentRecognition:{file:w.pythonRecognition,sha256:meta.recognitionSha256,metadata:w.pythonMetadata,metadataSha256:sha256(await fs.readFile(w.pythonMetadata)),sourceRange:w.sourceRange,text:w.pythonText,modelSha256:recognition.modelSha256,expectedTranscriptSupplied:false},
  decision:'adjudicated-candidate-'+d.category,reviewed:false,qualityUpgradeAllowed:false});
}
const document={schemaVersion:1,kind:'remaining-69-individually-adjudicated-candidate-transcripts',checkedAt,sourceSnapshot:`${root}/snapshot.json`,sourceSnapshotSha256:sha256(await fs.readFile(`${root}/snapshot.json`)),decisionCodeSha256:sha256(await fs.readFile('scripts/remaining-transcript-decisions.mjs')),sources,
  policy:'逐项原文/录音机器证据裁定；同音专名、语气词为明确标注的编辑展示约定。模型之间的分歧均保留。不是逐句人工听校，不能升级reviewed或verified。',rows};
const file=`${root}/transcript-decisions.json`;await writeJson(file,document);const bytes=await fs.readFile(file),hash=sha256(bytes);
const approved=process.argv.find(a=>a.startsWith('--approve-sha='))?.slice(14);
// checkedAt is intentionally excluded from the stable digest used for approval.
const stableHash=sha256(Buffer.from(JSON.stringify({...document,checkedAt:null})));
if(!approved){console.log(JSON.stringify({proposal:file,sha256:hash,stableHash,decisions:rows.length,changed:rows.filter(r=>r.changed).length,retained:rows.filter(r=>!r.changed).length}));process.exit(0);}
if(approved!==stableHash)throw Error(`Reviewed decision digest mismatch; stable digest is ${stableHash}`);
for(const row of rows){
 const target=papers.get(row.paperId),sentence=target.paper.passages.flatMap(p=>p.sentences).find(s=>s.id===row.sentenceId);
 sentence.transcriptCandidateReview={kind:row.decision,report:file.slice(5),reportSha256:hash,sentenceTextSha256:row.textSha256,checkedAt,humanListeningClaimed:false};
 if(row.changed){if(sentence.textCorrection)(sentence.textCorrectionHistory??=[]).push(sentence.textCorrection);
  sentence.text=row.text;sentence.textCorrection={previousText:row.previousText,text:row.text,checkedAt,reason:row.reason,report:file.slice(5),reportSha256:hash,sourceSha256:row.source?.sha256||null,humanListeningClaimed:false};
  for(const q of target.paper.questions.filter(q=>q.passageId===row.passageId))for(const [from,to]of row.replacements){if(!q.explanation?.includes(from))continue;const previousExplanation=q.explanation;q.explanation=q.explanation.replaceAll(from,to);(q.explanationCorrections??=[]).push({checkedAt,basisSentenceId:row.sentenceId,previousExplanation,explanation:q.explanation,changedFrom:from,changedTo:to,basisReport:file.slice(5),origin:'adjudicated-exact-English-quote-only',ChineseExplanationChanged:false});}
 }
}
for(const p of papers.values()){validatePaper(p.paper);if(sha256(await fs.readFile(p.file))!==p.hash)throw Error('Concurrent paper mutation');}
for(const p of papers.values())await writeJson(p.file,p.paper);
await writeJson('data/references/remaining-transcript-decisions.json',{...document,immutableReport:file,immutableReportSha256:hash});
await writeJson(`${root}/transcript-application.json`,{checkedAt,document:file,sha256:hash,stableHash,decisions:rows.length,changed:rows.filter(r=>r.changed).length,retained:rows.filter(r=>!r.changed).length,paperHashesBefore:Object.fromEntries([...papers].map(([id,p])=>[id,p.hash])),humanListeningClaimed:false,learningRecordsChanged:false});
console.log(JSON.stringify({applied:true,sha256:hash,stableHash,changed:rows.filter(r=>r.changed).length,retained:rows.filter(r=>!r.changed).length}));
