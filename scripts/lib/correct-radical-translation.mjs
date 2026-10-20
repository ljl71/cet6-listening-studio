import fs from 'node:fs/promises';
import {readJson,writeJson} from './corpus.mjs';
import {validatePaper} from '../../server/validation.mjs';
const paperId='cet6-2020-09-1',file=`data/papers/${paperId}.json`;
const paper=await readJson(file);const passage=paper.passages.find(p=>p.order===5);
const sentence=passage.sentences.find(s=>s.id===`${paperId}-p-16-6-s1`);
if(!sentence.text.includes('preventing the rise'))throw new Error('Corrected English evidence is missing');
const paragraph=passage.sourceParagraphs.find(p=>p.sourceId==='p-16-6');
const from='这一切都归结于维护掌权者的权力，以及阻止无权者获得权利。';
const to='这一切都归结于维护掌权者的权力，以及阻止无权者崛起。';
if(paragraph.translation.startsWith(to)){console.log('Translation correction already applied.');process.exit(0);}
if(!paragraph.translation.startsWith(from))throw new Error('Unexpected current translation');
const previousTranslation=paragraph.translation;const sourceSnapshot=paragraph.text;
paragraph.translation=to+paragraph.translation.slice(from.length);
paragraph.translationCorrection={previousTranslation,translation:paragraph.translation,changedFrom:from,changedTo:to,checkedAt:new Date().toISOString(),origin:'developer-translated-from-corrected-english',basisReport:'references/radical-transcript-corrections.json',basisSentenceId:sentence.id,note:'开发代理据已校正英文 rise 修订的辅助译文；并非新增官方译文。'};
if(paragraph.text!==sourceSnapshot)throw new Error('Raw source paragraph changed');validatePaper(paper);
const folder='data/references/before-radical-translation-correction';await fs.mkdir(folder,{recursive:true});try{await fs.writeFile(`${folder}/${paperId}.json`,await fs.readFile(file),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
await writeJson(file,paper);await writeJson('data/references/radical-translation-correction.json',{paperId,passageId:passage.id,sourceParagraphId:paragraph.sourceId,...paragraph.translationCorrection,rawEnglishSourceSnapshotChanged:false,otherParagraphsChanged:false});
console.log(JSON.stringify({paperId,sourceParagraphId:paragraph.sourceId,changedFrom:from,changedTo:to,origin:paragraph.translationCorrection.origin}));
