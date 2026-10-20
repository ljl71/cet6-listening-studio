import fs from 'node:fs/promises';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const proofFile='data/references/tension-window-asr/disputed-window-results.json',proofBytes=await fs.readFile(proofFile),proofSha256=sha256(proofBytes);
if(proofSha256!=='598ec64384b24fc5cb2321d5830abb1d6dda433f41da84551988e68adef39e57')throw new Error('Disputed-noun evidence differs from root-adjudicated frozen bytes');
const proof=JSON.parse(proofBytes),window=proof.windows[0],pdf=proof.pdfEvidence,pdfManifest=await readJson('data/references/independent-transcript-2025-12-pdf-manifest.json');
if(proof.windows.length!==1||window.sentenceId!=='cet6-2025-12-1-p-1-10-s5'||sha256(await fs.readFile(pdf.file))!==pdf.sha256)throw new Error('Unexpected target or PDF source hash changed');
if(sha256(await fs.readFile(window.recognition.file))!==window.recognition.sha256||sha256(await fs.readFile(window.wav.file))!==window.wav.sha256)throw new Error('Original disputed ASR bytes changed');
const folder='data/references/transcript-adjudication-snapshots';await fs.mkdir(folder,{recursive:true});
async function freeze(file,expected){const bytes=await fs.readFile(file),hash=sha256(bytes);if(expected&&hash!==expected)throw new Error('Expected source bytes changed');const snapshot=`${folder}/${hash}.json`;await fs.writeFile(snapshot,bytes);return {file,sha256:hash,snapshot};}
const proofSnapshot=(await freeze(proofFile,proofSha256)).snapshot,shortWindow=await freeze(window.recognition.file,window.recognition.sha256);
const fullWhisper=await freeze('data/alignment/cet6-2025-12-1/passage-1.json'),whisper=await readJson(fullWhisper.snapshot);
const ctc=await freeze('data/acoustic-review/cet6-2025-12-1/passage-1.json'),ctcReport=await readJson(ctc.snapshot);
const paperId=window.paperId,file=`data/papers/${paperId}.json`,original=await fs.readFile(file),originalSha256=sha256(original),paper=JSON.parse(original),passage=paper.passages.find(p=>p.id===window.passageId),sentence=passage.sentences.find(s=>s.id===window.sentenceId);
const from='defusing attention',to='defusing tension',newText=window.oldLocalText.replace(from,to);
if(sentence.text===newText){console.log('Diplomacy noun correction already applied');process.exit(0);}
if(sentence.text!==window.oldLocalText||sentence.text.split(from).length!==2||ctcReport.sentences.find(s=>s.id===sentence.id)?.text!==sentence.text)throw new Error('Current sentence or archived CTC text changed after adjudication');
const checkedAt=new Date().toISOString(),before=structuredClone(sentence);if(sentence.textCorrection)(sentence.textCorrectionHistory??=[]).push(sentence.textCorrection);
sentence.text=newText;sentence.textCorrection={previousText:before.text,text:newText,url:pdfManifest.publicDirectory,sourceSha256:pdf.sha256,checkedAt,
 reason:'开发代理依据公开学习资料PDF物理第2页明确的tension及外交语境，裁决仅attention→tension；与ASR attention/ATTENSION存在分歧，不代表模型多数支持或人耳听核。保留本地defusing，不随PDF的同音拼写改为diffusing。',report:'references/diplomacy-tension-correction.json',proofSnapshot,proofSha256};
const explanationCorrections=[],relatedQuestionChecks=[];for(const q of paper.questions.filter(q=>q.passageId===passage.id)){
 const previous=q.explanation||'',count=previous.split(from).length-1;relatedQuestionChecks.push({questionId:q.id,exactOldPhrase:from,exactMatches:count,evidenceLinked:q.evidenceSentenceIds?.includes(sentence.id)||false});
 if(!count)continue;q.explanation=previous.replaceAll(from,to);const correction={checkedAt,basisSentenceId:sentence.id,previousExplanation:previous,explanation:q.explanation,changedFrom:from,changedTo:to,exactOccurrences:count,origin:'developer-adjudicated-English-quote-from-PDF-and-context',basisReport:'references/diplomacy-tension-correction.json',originalSourcePreserved:true};(q.explanationCorrections??=[]).push(correction);explanationCorrections.push({questionId:q.id,...correction});
}
validatePaper(paper);if(sha256(await fs.readFile(file))!==originalSha256)throw new Error('Concurrent paper change detected');const backup='data/references/before-diplomacy-tension-correction';await fs.mkdir(backup,{recursive:true});try{await fs.writeFile(`${backup}/${paperId}.json`,original,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await writeJson(file,paper);await writeJson('data/references/diplomacy-tension-correction.json',{checkedAt,paperId,passageId:passage.id,sentenceId:sentence.id,before,after:sentence,proofFile,proofSha256,proofSnapshot,
 source:{...pdf,url:pdfManifest.publicDirectory,imageSha256:sha256(await fs.readFile(pdf.image)),inspectionAttribution:'Frontend development agent visually inspected the complete rendered PDF page; this script does not claim human listening.'},
 conflictingEvidence:{fullPassageWhisper:{...fullWhisper,model:whisper.model.type,recognition:whisper.transcription.map(t=>t.text).join('').match(/.{0,70}attention.{0,70}/i)?.[0]||null},shortWindow:{...shortWindow,model:window.recognition.model,text:window.recognition.text,wav:window.wav},ctc:{...ctc,referenceSentence:ctcReport.sentences.find(s=>s.id===sentence.id),greedyContext:ctcReport.greedyTranscript.match(/.{0,80}ATTENSION.{0,80}/)?.[0]||null}},
 adjudication:{reviewer:'coding-agent evidence adjudication explicitly approved by root',basis:'PDF noun spelling plus diplomatic context',asrConsensusSupportsReplacement:false,independentModelsClaimed:false,retainedDefusing:true,homophoneDiffusingNotApplied:true,newForcedScoreClaimed:false},relatedQuestionChecks,explanationCorrections,timingChanged:false,reviewFlagsChanged:false,qualityChanged:false,humanListeningClaimed:false});
console.log(JSON.stringify({sentenceId:sentence.id,change:'defusing attention → defusing tension',preservedDefusing:true,asrConflictRetained:true,explanationCorrections:explanationCorrections.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),timingChanged:false},null,2));
