import fs from 'node:fs/promises';
import {readJson,writeJson} from './corpus.mjs';
import {words} from '../align.mjs';

function compare(reference,hypothesis){
 const a=words(reference),b=words(hypothesis);const width=b.length+1,table=new Uint16Array((a.length+1)*width);
 for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)table[i*width+j]=a[i-1]===b[j-1]?table[(i-1)*width+j-1]+1:Math.max(table[(i-1)*width+j],table[i*width+j-1]);
 let i=a.length,j=b.length;const matched=new Set();while(i&&j){if(a[i-1]===b[j-1]){matched.add(i-1);i--;j--;}else if(table[(i-1)*width+j]>=table[i*width+j-1])i--;else j--;}
 return {quoteWords:a.length,evidenceWords:b.length,matchedQuoteWords:matched.size,quoteRecall:a.length?+(matched.size/a.length).toFixed(4):null,
  unmatchedQuoteWords:a.flatMap((word,index)=>matched.has(index)?[]:[{word,index}])};
}
const report={generatedAt:new Date().toISOString(),readOnly:true,method:'核对全部题目既有依据ID的存在性和同篇关系；以解释首个英文段落作为主要原文引文，按原文顺序LCS比较归一化词。召回率<0.85为低匹配；已纠正文稿关联的非完全引文另列。中文解析及其英文术语不当作正式逐字引文。只报告，不改引用ID、试题、原文或解释。',threshold:0.85,
 totals:{papers:0,questions:0,evidenceReferences:0,missingReferences:0,crossPassageReferences:0,questionsWithoutEvidence:0,questionsWithoutLeadingEnglishQuote:0,leadingQuotesCompared:0,exactQuoteMatches:0,nonExactQuoteMatches:0,lowQuoteMatches:0,correctedSentenceQuoteDisagreements:0},issues:[],suspicious:[],questions:[]};
for(const file of(await fs.readdir('data/papers')).filter(f=>f.endsWith('.json')).sort()){
 const paper=await readJson(`data/papers/${file}`);report.totals.papers++;
 const sentences=new Map(paper.passages.flatMap(p=>p.sentences.map((s,index)=>[s.id,{...s,passageId:p.id,index}])));
 for(const q of paper.questions){
  report.totals.questions++;const ids=q.evidenceSentenceIds||[];const missing=ids.filter(id=>!sentences.has(id)),cross=ids.filter(id=>sentences.has(id)&&sentences.get(id).passageId!==q.passageId);
  report.totals.evidenceReferences+=ids.length;report.totals.missingReferences+=missing.length;report.totals.crossPassageReferences+=cross.length;if(!ids.length)report.totals.questionsWithoutEvidence++;
  const leading=(q.explanation||'').split(/\n\s*\n/)[0].trim();const isEnglish=words(leading).length>=2&&!/[\u3400-\u9fff]/.test(leading);
  const linked=ids.filter(id=>sentences.has(id)).map(id=>sentences.get(id)).sort((a,b)=>a.index-b.index);
  const quotedText=linked.map(s=>s.text).join(' ');const metrics=isEnglish?compare(leading,quotedText):null;
  const reasons=[];if(missing.length)reasons.push('evidence-sentence-id-missing');if(cross.length)reasons.push('evidence-sentence-in-other-passage');if(!ids.length)reasons.push('question-has-no-evidence');
  if(!isEnglish){report.totals.questionsWithoutLeadingEnglishQuote++;reasons.push('leading-English-quote-unavailable');}
  else{report.totals.leadingQuotesCompared++;if(metrics.quoteRecall===1)report.totals.exactQuoteMatches++;else report.totals.nonExactQuoteMatches++;
   if(metrics.quoteRecall<report.threshold){report.totals.lowQuoteMatches++;reasons.push('low-leading-quote-match');}
   if(linked.some(s=>s.textCorrection)&&metrics.quoteRecall<1){report.totals.correctedSentenceQuoteDisagreements++;reasons.push('quote-differs-from-corrected-sentence');}
  }
  const row={paperId:paper.id,questionId:q.id,number:q.number,passageId:q.passageId,evidenceSentenceIds:ids,missingReferences:missing,crossPassageReferences:cross,leadingEnglishQuote:isEnglish?leading:null,linkedSentenceTexts:linked.map(s=>({id:s.id,text:s.text,hasTextCorrection:!!s.textCorrection})),metrics,reasons};
  if(reasons.length){const passage=paper.passages.find(p=>p.id===q.passageId);row.wholePassageDiagnostic=isEnglish&&passage?compare(leading,passage.sentences.map(s=>s.text).join(' ')):null;report.suspicious.push(row);}
  if(missing.length||cross.length)report.issues.push({questionId:q.id,missingReferences:missing,crossPassageReferences:cross});
  report.questions.push(row);
 }
}
await writeJson('data/references/question-evidence-audit.json',report);console.log(JSON.stringify({totals:report.totals,issues:report.issues,suspicious:report.suspicious.map(r=>({questionId:r.questionId,reasons:r.reasons,quoteRecall:r.metrics?.quoteRecall,wholePassageRecall:r.wholePassageDiagnostic?.quoteRecall}))},null,2));if(report.issues.length)process.exitCode=1;
