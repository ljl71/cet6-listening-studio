import fs from 'node:fs';
import path from 'node:path';
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const ledger=read('data/references/transcript-review-ledger.json'),rows=ledger.items.filter(s=>s.decision.startsWith('pending-')||s.decision.startsWith('propose-'));
const papers=fs.readdirSync('data/papers').filter(f=>f.endsWith('.json')).map(f=>read('data/papers/'+f));
const timingMissing=papers.flatMap(paper=>paper.passages.flatMap(passage=>passage.sentences.flatMap((sentence,index)=>sentence.end>sentence.start?[]:[{paper,passage,sentence,index}])));
const planFile='data/references/acoustic-application-current-plan.json',plan=fs.existsSync(planFile)?read(planFile):null;
const final=process.argv.includes('--final');
const link=(label,file)=>`[${label}](<../${file.replaceAll('\\','/')}>)`;
const labels={'pending-explicit-root-adjudication':'实词、同音或专名争议，保留单独裁决','pending-model-or-source-disagreement':'不同资料或识别结果未一致','pending-homophone-orthography':'同音词的拼写与语境尚待核定','pending-interjection-transcription':'短语气词写法或漏记，不能因模型省略便删除','pending-secondary-source-omission':'第二来源明确缺句，尚无完整第三来源','pending-ctc-evidence':'声学证据暂缺或未与当前文本一致','propose-source2-correction-two-models':'模型与第二来源支持的纠错尚未批准'};
const explain=s=>{
 if(s.sentenceId==='cet6-2020-07-1-p-1-8-s1')return 'tiny 为 has seen，CTC 为 is seen，第二来源为 is seeing；教师 PDF 本身也写 is seen，额外 base 短窗未成功识别目标，不按多数或语法猜改。';
 if(s.sentenceId==='cet6-2020-07-1-p-9-3-s2')return 'Lynn 的中间缩写 N./M. 未有可靠原作者资料；教师 PDF 的 Lynn and Mark 为明显误断，不能据此定字母。';
 if(s.sentenceId==='cet6-2020-09-1-p-16-6-s3')return 'effect / affect 在此可同音，识别模型的拼写一致不能证明录音意图，需语义与可靠原稿裁决。';
 if(s.sentenceId==='cet6-2021-12-1-p-1-7-s1')return 'No / Now 的弱读近同音；当日教师资料与其它转写不一致，不能只按模型改写语气与标点。';
 if(s.sentenceId==='cet6-2025-12-1-p-22-1-s4')return '独立 PDF 与 tiny 为 tourists，CTC 为 tourist；弱复数词尾尚待单独核定。';
 if(s.decision==='pending-secondary-source-omission')return '原资料中 Hmm 位于已核对的前后句之间；tiny 保留 Hmm，CTC 为 HU，第二来源未记该句。';
 return labels[s.decision]||s.reason;
};
const clauses=s=>s.sentenceId==='cet6-2020-07-1-p-9-3-s2'?'“N.” ↔ “M.”（句末 St. Louis 在二源中被断成相邻句，不计为缺词）':s.disputedWordGroups.map(g=>`“${g.localTokens.join(' ')||'∅'}” ↔ “${g.secondaryTokens.join(' ')||'∅'}”`).join('；');
const title=paperId=>{const[,year,month,version]=paperId.split('-');return `${year} 年 ${Number(month)} 月 · 第 ${version} 套`;};
const counts=ledger.counts;
let out=`# 原文与时间轴待核清单\n\n数据快照：${ledger.generatedAt}。${final?'本清单对应最终交付数据的逐句编号。':'本清单按当前实际句子编号生成，最后数据定版前会更新一次。'}\n\n共 **${counts.sentences} 句**；其中 **${rows.length} 句原文仍有具体争议**，下方逐套列出。${counts.sentences-rows.length} 句已有字面、等价写法、第三来源、已批准纠错或模型交叉证据；这不等于逐句人工听校完成。完整证据见 ${link('逐句审计记录','data/references/transcript-review-ledger.json')} 和 ${link('待核编号及依据','data/references/transcript-pending-ids.json')}。\n\n时间轴另行验收：本次独立声学结果有 **${counts.acousticStates['acoustically-supported-candidate']||0} 句严格支持候选**，其余 **${counts.sentences-(counts.acousticStates['acoustically-supported-candidate']||0)} 句**带有低分、识别差异或边界异常等标签。当前实际资料中 **${counts.sentences-timingMissing.length} 句有有效候选时间，${timingMissing.length} 句尚无有效时间**；缺时项目另列在后文。词分数与模型一致都不代表人工听过，不能自动等同于 0.3 秒精度已验收。当前逐句人工校对标记为 **${papers.reduce((n,p)=>n+p.passages.flatMap(q=>q.sentences).filter(s=>s.reviewed).length,0)}**。\n\n“∅”表示该份资料中未记该词。英语差异统一小写、展开常见缩写；只是用于定位分歧，不是建议整句覆盖。二源来自公开整理或解析，出处和原文件已留存，独立排版资料的出版者及抄本依赖未必可确认。\n`;
for(const paperId of [...new Set(rows.map(s=>s.paperId))]){
 const current=rows.filter(s=>s.paperId===paperId);out+=`\n## ${title(paperId)}（${current.length} 句）\n`;
 for(const s of current){
  const refs=[];if(s.source?.file)refs.push(link(s.source.pages?.length?`第二来源第 ${s.source.pages.join('、')} 页`:'第二来源存档',s.source.file));if(s.thirdSource?.file)refs.push(link('第三来源',s.thirdSource.file));for(const [i,w]of s.whisper.entries())refs.push(link(w.file.includes('-base')?'base 识别':i?'补充识别':'tiny 逐词识别',w.file));if(s.ctc?.report)refs.push(link('独立声学结果',s.ctc.report));
  out+=`\n**${s.sentenceId}**\n\n> ${s.localText.replaceAll('\n',' ')}\n\n分歧：${clauses(s)||'来源未给出完整句子'}。${explain(s)}\n\n证据：${refs.join(' · ')}。\n`;
 }
}
out+=`\n## 尚无有效时间的 ${timingMissing.length} 句\n\n以下项目在实际试卷中仍为无效或 0/0 时间，候选范围仅供定位复核。即使分数较高，也可能与未调整的邻句重叠；没有直接写入的范围不得当作已校对字幕。原因依据 ${link('当前候选采纳计划',planFile)} 与每篇原始声学报告。\n`;
const reasonNames={'strict-acoustic-audit-not-supported':'独立声学检查未满足严格条件','requires-listening-approval':'原缺时或大漂移尚缺逐项复核批准','overlap-with-unchanged-or-unsupported-neighbor':'与未调整或证据不足的邻句发生时间冲突','sparse-completion-protected':'此前补缺受保护，不能被后续自动覆盖'};
const classNames={'acoustically-supported-candidate':'严格声学候选，但仍需检查邻句与真实边界','low-acoustic-score':'部分字词声学分数较低','independent-transcript-disagreement':'独立识别与供给原文有差异','critical-lexical-disagreement':'关键实词或否定存在识别差异','word-or-boundary-anomaly':'单词跨度、间隙或边界异常'};
const neighbor=s=>s?`**${s.id}**（${s.end>s.start?`${s.start.toFixed(3)}–${s.end.toFixed(3)} 秒`:'同样缺时'}）：${s.text}`:'本篇边界，无相邻句。';
for(const {paper,passage,sentence,index}of timingMissing){
 const e=ledger.items.find(r=>r.sentenceId===sentence.id),pp=plan?.papers.find(p=>p.paperId===paper.id)?.passages.find(p=>p.passageId===passage.id),records=pp?[...(pp.afterReviewDeferred||[]),...(pp.selectedDeferred||[]),...(pp.requiresListening||[]),...(pp.normalDeferred||[])]:[],reasons=[...new Set(records.filter(r=>r.sentenceId===sentence.id).flatMap(r=>r.deferredReasons||[]))],ac=e?.ctc?.acoustic,candidate=ac?.end>ac?.start?`${ac.start.toFixed(3)}–${ac.end.toFixed(3)} 秒`:'该报告没有可用的完整句候选范围',warnings=(sentence.timingWarnings||[]).map(w=>w.kind==='oversized-word-span'?'旧词对齐含超长词跨度':w.kind==='non-contiguous-word-match'?'旧词对齐含过长跨词间隙':w.kind).join('；');
 out+=`\n### ${paper.title||title(paper.id)} · ${sentence.id}\n\n试卷：${paper.id}；第 ${passage.order} 篇。\n\n> ${sentence.text}\n\n既有 CTC 候选：**${candidate}**。${classNames[e?.ctc?.classification]||e?.ctc?.classification||'尚无可采纳分类'}。\n\n延后原因：${reasons.map(r=>reasonNames[r]||r).join('；')||'尚未获得满足全部条件的采纳决定'}${warnings?'；'+warnings:''}。\n\n前句：${neighbor(passage.sentences[index-1])}\n\n后句：${neighbor(passage.sentences[index+1])}\n\n证据：${e?.ctc?.report?link('原始声学结果',e.ctc.report):'声学报告缺失'} · ${link('采纳计划',planFile)}${sentence.alignmentEvidence?.report?' · '+link('旧候选来源','data/'+sentence.alignmentEvidence.report):''}。\n`;
}
const explicitlyHandled=ledger.items.filter(s=>s.explicitCandidateReview);
if(explicitlyHandled.length){
 out+=`\n## 本轮已逐项处理的 ${explicitlyHandled.length} 项\n\n以下为有来源和独立录音识别证据的编辑裁定，**不是人工听校通过清单**。同音姓名、语气词和弱读存在明确保留的取舍，不把采用一种展示写法描述为消除全部声学不确定性。每项旧文本、来源、模型异文、修改前文件和校验值保存在 [本轮裁定原件](<../data/references/remaining-transcript-decisions.json>)。\n`;
 for(const s of explicitlyHandled){const r=s.explicitCandidateReview;out+=`\n- **${s.sentenceId}**：${r.changed?r.replacements.map(([a,b])=>`“${a}” → “${b}”`).join('；'):'保留原文'}。${r.reason}\n`;}
}
out+='\n## 复核后如何记录\n\n先核对同一录音版本与句子前后文，再决定保留或最小纠错；短语气词、同音词和姓名应保留具体裁决理由。原文改动后重新生成该篇的候选对齐，保留原始文件、来源校验值和旧记录。时间轴需检查首尾词、逐句切换及反复循环，最终由使用者明确确认，不能将模型输出直接改为人工校对完成。\n';
fs.mkdirSync('docs',{recursive:true});const filename=path.join('docs','原文与时间轴待核清单.md');fs.writeFileSync(filename,out);console.log(JSON.stringify({filename,pending:rows.length,papers:new Set(rows.map(s=>s.paperId)).size,timingMissing:timingMissing.length,bytes:Buffer.byteLength(out)}));
