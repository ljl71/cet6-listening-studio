import fs from 'node:fs/promises';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {words,recognizedWords} from '../align.mjs';
import {validatePaper} from '../../server/validation.mjs';
const paperId='cet6-2026-06-1',sentenceId=`${paperId}-p-9-3-s1`;
const from='cause of the differences',to='cause for the differences';
const source=(await readJson('data/references/independent-transcript-2026-pdf-manifest.json')).find(r=>r.file.includes(`${paperId}-`));
if(!source||sha256(await fs.readFile(source.file))!==source.sha256)throw new Error('PDF source checksum does not match');
const reportFile='data/references/short-window-asr/disputed-window-results.json';const bytes=await fs.readFile(reportFile);const evidence=JSON.parse(bytes);const window=evidence.windows.find(w=>w.sentenceId===sentenceId);
if(!window||sha256(await fs.readFile(window.recognition.file))!==window.recognition.sha256||!words(window.recognition.text).join(' ').includes(words(to).join(' ')))throw new Error('Base short-window proof is missing or different');
const tinyFile=`data/alignment/${paperId}/passage-3.json`;const tiny=await fs.readFile(tinyFile);if(!recognizedWords(JSON.parse(tiny)).map(w=>w.word).join(' ').includes(words(to).join(' ')))throw new Error('Tiny word evidence does not support for');
const file=`data/papers/${paperId}.json`,original=await fs.readFile(file),paper=JSON.parse(original),passage=paper.passages.find(p=>p.order===3),sentence=passage.sentences.find(s=>s.id===sentenceId);
if(sentence.text.includes(to)&&!sentence.text.includes(from)){console.log('Correction already applied');process.exit(0);}
if(sentence.text!==window.oldLocalText||!sentence.text.includes(from)||paper.audioAssetId!==window.sourceAudio.assetId)throw new Error('Source sentence/audio no longer matches approved evidence');
const before=structuredClone(sentence);sentence.text=sentence.text.replace(from,to);const checkedAt=new Date().toISOString();
sentence.textCorrection={previousText:before.text,text:sentence.text,url:source.publicDirectory,sourceSha256:source.sha256,checkedAt,reason:'根代理核对第二来源PDF、整篇tiny和短窗base三项实词证据后批准，仅将cause of改为cause for；新词CTC分数尚待重放。',report:'references/cause-preposition-correction.json',shortWindowEvidenceSha256:sha256(bytes)};
const explanationCorrections=[];
for(const q of paper.questions.filter(q=>q.passageId===passage.id)){
 const old=q.explanation||'',count=old.split(from).length-1;if(!count)continue;q.explanation=old.replaceAll(from,to);
 const correction={checkedAt,basisSentenceId:sentenceId,previousExplanation:old,explanation:q.explanation,changedFrom:from,changedTo:to,exactOccurrences:count,origin:'developer-corrected-English-quote-from-adjudicated-transcript',basisReport:'references/cause-preposition-correction.json',originalSourcePreserved:true};
 (q.explanationCorrections??=[]).push(correction);explanationCorrections.push({questionId:q.id,...correction});
}
validatePaper(paper);const folder='data/references/before-cause-preposition-correction';await fs.mkdir(folder,{recursive:true});try{await fs.writeFile(`${folder}/${paperId}.json`,original,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await writeJson(file,paper);await writeJson('data/references/cause-preposition-correction.json',{checkedAt,paperId,passageId:passage.id,sentenceId,before,after:sentence,source,
 evidence:{shortWindowReport:reportFile,sha256:sha256(bytes),window,tinyFile,tinySha256:sha256(tiny)},explanationCorrections,timingChanged:false,reviewFlagsChanged:false,newWordCTCScoreClaimed:false,humanListeningClaimed:false});
console.log(JSON.stringify({sentenceId,from,to,explanationCorrections:explanationCorrections.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),timingChanged:false}));
