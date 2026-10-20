import fs from 'node:fs/promises';
import {readJson,writeJson,sha256} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const literal={
 'cet6-2020-09-1-p-9-4-s2':['Europa, show signs','Europa, showed signs'],
 'cet6-2020-09-1-p-19-5-s4':['not a coincidence','not coincidence'],
 'cet6-2020-12-1-p-5-8-s4':['in the simulation','in a simulation'],
 'cet6-2020-12-1-p-12-3-s1':['will looking smarter','would looking smarter'],
 'cet6-2020-12-1-p-22-2-s2':['through the rest of your life','for the rest of your life'],
 'cet6-2020-12-2-p-9-5-s2':['price these products','price those products'],
 'cet6-2021-06-1-p-1-7-s2':['always a chance','always the chance'],
 'cet6-2021-06-1-p-19-6-s1':['industry are creating','industry is creating'],
 'cet6-2021-12-1-p-19-2-s6':['value the effort','value their effort'],
 'cet6-2021-12-2-p-1-6-s1':['people choose to live','people chose to live'],
 'cet6-2021-12-2-p-12-1-s2':['Children who spend more time','Children spending more time'],
 'cet6-2021-12-2-p-16-2-s6':["often you'd have",'often you have'],
 'cet6-2021-12-2-p-16-2-s8':['shoes with pointed or hard parts','shoes with pointy or hard parts'],
 'cet6-2021-12-2-p-19-3-s3':['instinctual responses','instinctive responses'],
 'cet6-2022-06-1-p-12-3-s1':['all these observations','all this observation'],
 'cet6-2022-06-1-p-19-4-s3':['and their members are obliged','and that members are obliged'],
 'cet6-2022-09-1-p-22-3-s2':['and general background','in general, background'],
 'cet6-2022-12-1-p-1-6-s4':['his advice turn me','his advice deter me'],
 'cet6-2022-12-2-p-9-2-s2':['Sometimes the victim','Sometimes a victim'],
 'cet6-2022-12-2-p-9-3-s4':[['taking responsibility','take responsibility'],['then reflecting on','then reflect on']],
 'cet6-2023-03-1-p-9-2-s3':['and then being passionate','and in being passionate'],
 'cet6-2023-03-1-p-16-2-s1':['behind it theorized that','behind it theorize that'],
 'cet6-2024-06-2-p-16-2-s5':['their belief about whether','their belief in whether'],
 'cet6-2024-06-2-p-16-3-s3':['to deduce the initial belief','to deduce their initial belief'],
};
const batchFile='data/references/transcript-proposals-batch-02.json',batchBytes=await fs.readFile(batchFile),batchSha256=sha256(batchBytes);
if(batchSha256!=='ce77ea178d75dfc444a0bc1ff5902cd272e93bfa15d362d7a7938117b064c44b')throw new Error('Batch differs from the root-adjudicated frozen bytes');
const batch=JSON.parse(batchBytes);if(batch.records.length!==24||batch.records.some(r=>!literal[r.sentenceId]))throw new Error('Unexpected batch scope');
const folder='data/references/transcript-adjudication-snapshots';await fs.mkdir(folder,{recursive:true});const batchSnapshot=`${folder}/${batchSha256}.json`;await fs.writeFile(batchSnapshot,batchBytes);
let sourceSnapshot=null;try{const bytes=await fs.readFile(batch.sourceSnapshot.file);if(sha256(bytes)===batch.sourceSnapshot.sha256){sourceSnapshot=`${folder}/${batch.sourceSnapshot.sha256}.json`;await fs.writeFile(sourceSnapshot,bytes);}}catch(error){if(error.code!=='ENOENT')throw error;}
const papers=new Map(),changes=[],relatedQuestionChecks=[],explanationCorrections=[];const checkedAt=new Date().toISOString();
for(const item of batch.records){
 if(sha256(await fs.readFile(item.source.file))!==item.source.sha256||sha256(await fs.readFile(item.ctc.file))!==item.ctc.sha256)throw new Error('Public source or archived CTC checksum changed');
 for(const v of item.whisper)if(sha256(await fs.readFile(v.file))!==v.sha256)throw new Error('Whisper original checksum changed');
 const paperId=item.sentenceId.match(/^(cet6-\d{4}-\d{2}-\d+)/)[1];if(!papers.has(paperId)){const file=`data/papers/${paperId}.json`,bytes=await fs.readFile(file);papers.set(paperId,{file,bytes,sha256:sha256(bytes),paper:JSON.parse(bytes)});}
 const target=papers.get(paperId),paper=target.paper,passage=paper.passages.find(p=>p.sentences.some(s=>s.id===item.sentenceId)),sentence=passage.sentences.find(s=>s.id===item.sentenceId);
 const value=literal[item.sentenceId],replacements=typeof value[0]==='string'?[value]:value;
 let newText=item.oldFullSentence;for(const[from,to]of replacements){if(newText.split(from).length!==2)throw new Error('Approved contextual phrase is not unique');newText=newText.replace(from,to);}
 if(sentence.text===newText)continue;if(sentence.text!==item.oldFullSentence)throw new Error('Current sentence is not the exact root-reviewed old text');
 const before=structuredClone(sentence);sentence.text=newText;if(sentence.textCorrection)(sentence.textCorrectionHistory??=[]).push(sentence.textCorrection);
 sentence.textCorrection={previousText:before.text,text:newText,url:item.source.url,sourceSha256:item.source.sha256,checkedAt,reason:'根代理逐项核读批次02的第二原文和两ASR实际短语后批准的最小改词；保留本地缩约/美式拼写/标签/ID/时间，仅in general后加批准的逗号。',report:'references/transcript-batch-02-corrections.json',batchSha256,batchSnapshot};
 changes.push({paperId,passageId:passage.id,sentenceId:sentence.id,replacements,before,after:structuredClone(sentence),source:item.source,whisper:item.whisper,ctc:item.ctc,newWordForcedScoreClaimed:false});
 for(const q of paper.questions.filter(q=>q.passageId===passage.id))for(const[from,to]of replacements){const previous=q.explanation||'',count=previous.split(from).length-1;
  relatedQuestionChecks.push({questionId:q.id,basisSentenceId:sentence.id,exactOldPhrase:from,exactMatches:count,evidenceLinked:q.evidenceSentenceIds?.includes(sentence.id)||false});
  if(!count)continue;q.explanation=previous.replaceAll(from,to);const correction={checkedAt,basisSentenceId:sentence.id,previousExplanation:previous,explanation:q.explanation,changedFrom:from,changedTo:to,exactOccurrences:count,origin:'developer-corrected-English-quote-from-adjudicated-transcript',basisReport:'references/transcript-batch-02-corrections.json',originalSourcePreserved:true};(q.explanationCorrections??=[]).push(correction);explanationCorrections.push({paperId,questionId:q.id,...correction});
 }
}
for(const p of papers.values())validatePaper(p.paper);
const backup='data/references/before-transcript-batch-02-corrections';await fs.mkdir(backup,{recursive:true});
for(const[paperId,p]of papers){if(!changes.some(c=>c.paperId===paperId))continue;if(sha256(await fs.readFile(p.file))!==p.sha256)throw new Error('Concurrent paper change detected');try{await fs.writeFile(`${backup}/${paperId}.json`,p.bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}await writeJson(p.file,p.paper);}
if(changes.length)await writeJson('data/references/transcript-batch-02-corrections.json',{checkedAt,batchFile,batchSha256,batchSnapshot,sourceSnapshot,sourceSnapshotOriginalBytesAvailable:!!sourceSnapshot,changes,explanationCorrections,relatedQuestionChecks,timingChanged:false,reviewFlagsChanged:false,humanListeningClaimed:false,
 notes:['24个稳定句ID，只应用根代理明确批准的词级替换；不会照搬第二原文整句的标点或缩约。','deduce the initial belief仅改该定位短语的the；you’d按当前真实ASCII撇号you\'d替换为you。','新增词CTC得分尚待重新对齐，归档原件分数均针对旧参考。']});
console.log(JSON.stringify({changedSentences:changes.length,changedExplanations:explanationCorrections.map(c=>({questionId:c.questionId,exactOccurrences:c.exactOccurrences})),affectedPassages:[...new Set(changes.map(c=>c.passageId))],sourceSnapshotOriginalBytesAvailable:!!sourceSnapshot,timingChanged:false},null,2));
