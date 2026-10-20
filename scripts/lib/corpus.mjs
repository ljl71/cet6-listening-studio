import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {addExamDate} from './exam-dates.mjs';

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const decodeEntities = text => text.replace(/&#(x[\da-f]+|\d+);|&(quot|amp|apos|lt|gt|nbsp|ndash|mdash|rsquo|lsquo|rdquo|ldquo);/gi, (_,n,name) => n ? String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n)) : ({quot:'"',amp:'&',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“'}[name.toLowerCase()]));
export const stripHtml = text => decodeEntities(text.replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
export const readJson = async (file, fallback) => { try {return JSON.parse(await fs.readFile(file,'utf8'));} catch(e){ if(e.code==='ENOENT')return fallback; throw e; } };
export async function writeJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const temp=`${file}.tmp`;await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);}

export function mergeCollectedPaper(paper,old){
 if(!old)return paper;
 paper.audioAssetId=old.audioAssetId;paper.duration=old.duration;paper.quality={...old.quality};
 paper.sources=[...old.sources.filter(s=>!s.url.includes('english-exam.lazynote.cn')),...paper.sources];
 // An explicitly verified local correction outranks the unchanged scraped copy.
 // Recollection must never revert a corrected answer while keeping its badge.
 if(old.quality.questions==='verified'||old.quality.answers==='verified')paper.questions=structuredClone(old.questions);
 paper.notes=[...new Set([...(old.notes||[]),...(paper.notes||[]).filter(note=>!(old.quality.answers==='verified'&&note.includes('尚待独立来源核对')))])];
 for(const p of paper.passages){
  const op=old.passages.find(x=>x.id===p.id);if(!op)continue;
  if(old.quality.transcript==='verified'||old.quality.timing==='verified'){
   p.sentences=structuredClone(op.sentences);if(op.sourceParagraphs)p.sourceParagraphs=structuredClone(op.sourceParagraphs);
  }else{
   for(const s of p.sentences){const os=op.sentences.find(x=>x.id===s.id);if(!os)continue;
    // Exact unchanged text can retain its entire candidate object, including a
    // rejected 0/0 alignment and its acoustic warning. Dropping provenance here
    // would make a safe recollection erase the reason a sentence needs review.
    if(os.reviewed||os.textCorrection||os.text===s.text)Object.assign(s,structuredClone(os));
   }
  }
  for(const paragraph of p.sourceParagraphs||[]){
   const oldParagraph=op.sourceParagraphs?.find(x=>x.sourceId===paragraph.sourceId);
   if(oldParagraph?.translationCorrection){paragraph.translation=oldParagraph.translation;paragraph.translationCorrection=structuredClone(oldParagraph.translationCorrection);if(oldParagraph.translationCorrectionHistory)paragraph.translationCorrectionHistory=structuredClone(oldParagraph.translationCorrectionHistory);}
  }
  if(old.quality.timing==='verified'||op.sentences.some(s=>s.reviewed)){p.start=op.start;p.end=op.end;}
 }
 return paper;
}

function astroDecode(value){
 if(Array.isArray(value)&&typeof value[0]==='number') {const [type,payload]=value;return type===1?payload.map(astroDecode):type===0&&payload&&typeof payload==='object'?Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,astroDecode(v)])):payload;}
 return value;
}
export function segmentTranscript(text){
 const raw=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(text)].map((part,index)=>({text:part.segment.trim(),sourceIndex:index+1})).filter(part=>part.text);
 const merged=[];
 for(const part of raw){const previous=merged.at(-1);const title=previous&&/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Rev|Hon|St)\.$/i.test(previous.text);const nameInitial=previous&&/(?:^|\s)(?:[A-Z]\.)+$/.test(previous.text)&&/^[A-Z]/.test(part.text);if(previous&&(title||nameInitial))previous.text+=` ${part.text}`;else merged.push({...part});}
 return merged;
}
export function parseCatalog(html){
 const links=[...html.matchAll(/href="([^"#]*\/cet6\/sections\/listening\/(20\d{2})-(\d{2})-(\d+)\/)"/g)];
 return [...new Map(links.filter(m=>Number(m[2])>=2020&&(Number(m[2])<2026||(Number(m[2])===2026&&Number(m[3])===6))).map(m=>{const slug=`${m[2]}-${m[3]}-${m[4]}`;return [slug,{id:`cet6-${slug}`,slug,year:Number(m[2]),month:Number(m[3]),variant:m[4],url:new URL(m[1],'https://english-exam.lazynote.cn').href}]})).values()];
}
export function parseListeningPage(html,entry){
 const island=[...html.matchAll(/<astro-island\b([^>]+)>/g)].find(m=>m[1].includes('ListeningAudioBar'));
 let audio={};
 if(island){const props=island[1].match(/\bprops="([^"]+)"/);if(props){const parsed=JSON.parse(decodeEntities(props[1]));audio=Object.fromEntries(Object.entries(parsed).map(([k,v])=>[k,astroDecode(v)]));}}
 const paragraphMatches=[...html.matchAll(/<p\b[^>]*id="p-(\d+)-(\d+)"[^>]*class="lt-en"[^>]*>([\s\S]*?)<\/p>\s*(?:<p\b[^>]*class="lt-zh"[^>]*>([\s\S]*?)<\/p>)?/g)];
 const pieceStarts=[...html.matchAll(/<div id="lt-(\d+)" class="lt-piece\b/g)].map(m=>Number(m[1]));
 const passages=pieceStarts.map((first,i)=>{
  const timing=audio.pieces?.[i];const id=`${entry.id}-p${i+1}`;
  const paragraphs=paragraphMatches.filter(m=>Number(m[1])===first).map(m=>({sourceId:`p-${m[1]}-${m[2]}`,text:stripHtml(m[3].replace(/<span\b[^>]*>[\s\S]*?<\/span>/,'')),translation:stripHtml(m[4]||'')}));
  const sentences=paragraphs.flatMap(p=>{
   const split=segmentTranscript(p.text);
   return split.map(({text,sourceIndex})=>({id:`${entry.id}-${p.sourceId}-s${sourceIndex}`,start:0,end:0,text,...(split.length===1&&p.translation?{translation:p.translation}:{}),reviewed:false,sourceParagraphId:p.sourceId}));
  });
  return {id,order:i+1,type:i<2?'conversation':i<4?'passage':'lecture',title:`${i<2?'长对话':i<4?'听力篇章':'讲座 / 讲话'} ${i<2?i+1:i<4?i-1:i-3}`,start:timing?.start||0,end:timing?.end||0,sentences,sourceParagraphs:paragraphs};
 });
 const questionMatches=[...html.matchAll(/<div id="q-(\d+)" class="lqp-unit"/g)];
 const questions=questionMatches.map((m,i)=>{
  const number=Number(m[1]);const chunk=html.slice(m.index,questionMatches[i+1]?.index??html.indexOf('</astro-island>',m.index));
  const options=Object.fromEntries([...chunk.matchAll(/<span data-pdh-letter="([ABCD])"[^>]*>([\s\S]*?)<\/span>/g)].slice(0,4).map(o=>[o[1],stripHtml(o[2])]));
  const answer=chunk.match(/<strong class="rp-ans"[^>]*>\s*([ABCD])\s*<\/strong>/)?.[1];
  const prompt=stripHtml(chunk.match(/<p class="rp-stem-en"[^>]*>([\s\S]*?)<\/p>/)?.[1]||'');
  const locate=stripHtml(chunk.match(/<p class="rp-locate-en"[^>]*>([\s\S]*?)<\/p>/)?.[1]||'');
  const paragraphId=chunk.match(/class="px-pill rp-locate-p" href="#(p-\d+-\d+)"/)?.[1];
  const signal=stripHtml(chunk.match(/<p class="rp-text"[^>]*>([\s\S]*?)<\/p>/)?.[1]||'');
  const pieceIndex=pieceStarts.findLastIndex(first=>number>=first);const passage=passages[pieceIndex];
  const normalize=t=>t.toLowerCase().replace(/[^a-z0-9]/g,'');const normalizedLocate=normalize(locate);
  const locateFragments=locate.split(/…|\.{3}/).map(normalize).filter(t=>t.length>=20);
  const evidenceSentenceIds=(passage?.sentences||[]).filter(s=>s.sourceParagraphId===paragraphId&&(normalizedLocate.includes(normalize(s.text.replace(/^[WM]:\s*/,'')))||normalize(s.text).includes(normalizedLocate)||(locateFragments.length>1&&locateFragments.every(t=>normalize(s.text).includes(t))))&&normalizedLocate.length>0).map(s=>s.id);
  return {id:`${entry.id}-q${number}`,number,passageId:passage?.id,options,...(prompt?{prompt}:{}),...(answer?{answer}:{}),...(locate||signal?{explanation:[locate,signal].filter(Boolean).join('\n\n')}:{}),evidenceSentenceIds};
 });
 if(questions.length!==25||passages.length!==7||questions.some(q=>Object.keys(q.options).length!==4)||passages.some(p=>!p.sentences.length))throw new Error(`Unexpected source structure ${entry.id}: ${questions.length} questions, ${passages.length} passages`);
 const fetchedAt=new Date().toISOString();
 const source=k=>({url:entry.url,label:'懒笔记公开真题整理',kind:k,fetchedAt,licenseNote:'仅用于本机学习；原题版权归考试相关权利人；采集前核查 robots，未访问 /downloads/。'});
 const paper={id:entry.id,title:`${entry.year} 年 ${entry.month} 月 · 第 ${entry.variant} 套`,year:entry.year,month:entry.month,variant:entry.variant,contentId:entry.id,audioAssetId:null,duration:0,required:true,sources:['questions','answers','transcript','timing'].map(source),quality:{audio:'missing',questions:'candidate',answers:'candidate',transcript:'candidate',timing:'candidate'},passages,questions,notes:['题目、答案与英文原文来自公开整理页，尚待独立来源核对。','篇章时间来自原站播放器；句子时间未提供，保留 0/0，须逐句校对后使用单句复读。','逐段中文翻译保留在 sourceParagraphs；多句段落没有自动拆分或伪造逐句译文。']};
 return {paper:addExamDate(paper),mediaUrl:audio.src||null};
}

export function parseHls(text,baseUrl){
 if(!text.startsWith('#EXTM3U')||!text.includes('#EXT-X-ENDLIST'))throw new Error('Only complete public VOD playlists are supported');
 if(/#EXT-X-KEY:(?!METHOD=NONE)/.test(text))throw new Error('Encrypted media is not downloaded');
 const lines=text.split(/\r?\n/);const segments=[];let duration=0;
 for(let i=0;i<lines.length;i++){if(lines[i].startsWith('#EXTINF:')){const seconds=Number(lines[i].slice(8).split(',')[0]);const uri=lines[++i]?.trim();if(!uri||uri.startsWith('#')||!Number.isFinite(seconds)||seconds<=0)throw new Error('Invalid HLS segment');segments.push({url:new URL(uri,baseUrl).href,duration:seconds});duration+=seconds;}}
 if(!segments.length)throw new Error('Empty media playlist');return {segments,duration};
}
