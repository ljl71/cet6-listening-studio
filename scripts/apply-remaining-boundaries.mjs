import fs from 'node:fs/promises';
import path from 'node:path';
import {sha256,writeJson} from './lib/corpus.mjs';
import {sentenceTextHash,passageTextHash} from './lib/acoustic-evidence.mjs';
import {verifyJointBoundaryEvidence,JOINT_APPROVAL_SHA,jointUpdateIsSafe} from './lib/joint-boundary-evidence.mjs';
import {validatePaper} from '../server/validation.mjs';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const {root}=await read('runtime/remaining-review-location.json'),approvalFile=`${root}/joint-boundary-approval.json`;
try{const applied=await read(`${root}/joint-boundary-application.json`);if(sha256(await fs.readFile(approvalFile))!==applied.approvalSha256||applied.approvalSha256!==JOINT_APPROVAL_SHA)throw Error('Previously applied immutable boundary approval changed');console.log(JSON.stringify({alreadyApplied:true,filledMissing:applied.filledMissing,updates:applied.updatedSentences}));process.exit(0);}catch(e){if(e.code!=='ENOENT')throw e;}
const relative=f=>path.relative('data',f).replaceAll('\\','/');
const reasons={
 'cet6-2020-07-1-p-16-2-s4':'Among至percent完整词链；small.en保留28%、23%，前句overlap结束与目标首词分离。',
 'cet6-2020-09-1-p-19-6-s6':'独立窗口完整包含前句successful friends和And so the story goes on；旧尾部拖入后句。',
 'cet6-2020-12-1-p-16-3-s2':'购买40平米而非60平米及节省200000完整；前句required与By分离，不能使用旧尾词过长匹配。',
 'cet6-2021-06-1-p-5-21-s2':'单词Thanks在末句occasion之后、题目播报之前；采用CTC该词实际跨度，不延入Questions。',
 'cet6-2021-06-2-p-22-4-s4':'They were also asked至helpful完整；前句managers的旧尾部过长，分别退回真实词末。',
 'cet6-2021-12-2-p-22-5-s5':'Calls首词CTC仅.601，small.en拼Caused，故明确为非严格边界候选。其起始辅音与随后by scientists及末词justified在两独立时基有对应，不宣称首词拼写已听辨；保留原文来源Calls。',
 'cet6-2022-06-1-p-9-2-s9':'独立窗口为comes in、Why、To find new drugs，短问句不再被前句padding吞并。',
 'cet6-2022-09-1-p-9-4-s5':'That makes them至advertisements与前句intent均完整，间隔足够容纳首尾余量。',
 'cet6-2022-09-1-p-19-4-s4':'If people至information全句完整，前句irrelevant实际词末早于旧保存时间。',
 'cet6-2022-12-1-p-22-3-s8':'Authorities至magnetic stick完整，34 years数量保留；只移动相邻旧padding，不移动CTC单词。',
 'cet6-2022-12-2-p-5-13-s1':'small.en独立窗口同时确认Gregory\'s guest、So you know her personally及I assume she\'s an eccentric artist；恢复下一句被旧LCS截掉的I assume开头。',
 'cet6-2023-03-1-p-1-10-s2':'small.en确认Now back to the menu及What are you going to have；.315秒真实间隔仍大于两侧.28秒余量，不裁首尾词。',
 'cet6-2023-03-1-p-22-2-s1':'独立窗口辨认Malawi及Before I started；Malawi末分数低于严格阈值，保留非严格标签，使用其实际声学词末与下一句Before分离。',
 'cet6-2023-06-2-p-16-4-s1':'small.en完整识别While we did not directly assess至productivity；cyberloafing等内部拼写不作为强制时间通过证明，作者文章另证语境。',
 'cet6-2023-12-1-p-19-4-s5':'独立窗口包含前句boost mood、Dogs also help至chronic diseases；不延入Questions。',
 'cet6-2024-06-1-p-1-12-s5':'Middle East至departments完整；内部to弱读问题仍留在CTC原报告，不冒充全文严格一致。',
 'cet6-2024-06-1-p-9-2-s2':'authors至LIVE ONLINE完整声学跨度；人名机构拼写差异不用于改变首尾，前句实际词末与authors分离。',
 'cet6-2024-06-1-p-12-3-s2':'In a 2015 study至novel ways完整；人名Zhu低分不被候选边界掩盖，前句实际词末单独退回。',
 'cet6-2024-12-1-p-9-2-s2':'Now a new至phenomenon完整，Aalto为内部专名差异；前句末词以归档原CTC实际词末为准，不用模型幻觉填词。',
 'cet6-2025-06-1-p-19-5-s5':'Calculate transit time至unexpected delays完整；保留10至30分钟，不按旧数字长跨度对齐。',
 'cet6-2025-12-1-p-9-1-s15':'Whenever至constructive decision完整，与前句旧padding分开。',
 'cet6-2025-12-1-p-19-5-s3':'The twist至conversation完整，前句使用归档实际末词，拒绝与旧尾部重叠。',
 'cet6-2025-12-2-p-9-2-s5':'They were given至friends完整，前句实际词末退回后再补目标。',
 'cet6-2025-12-2-p-9-2-s9':'But again至vegetarian dish为完整词链；DISH末分数.775/贪心DESH明确保留非严格标签，不再用漂到问题里的文字匹配作为尾界。',
 'cet6-2026-06-2-p-12-4-s2':'The molecular至coincidence完整，与前句原CTC实际词末边界分离。',
 'cet6-2026-06-2-p-16-2-s2':'As you\'ll see至counterintuitive完整；MASTERING/MUSTERING及末词拆写仅为内部识别差异，候选不等同严格全文通过。',
 'cet6-2025-12-2-p-19-2-s3':'内部that/the在69项中已单独裁定；原已批准边界不移动，用当前原文重新生成的完整CTC和独立small.en窗口替换失效的旧文字校验值，不沿用错误的旧文字证据。',
};
if(!process.argv.includes('--apply')){
 const proposals=await read(`${root}/joint-boundary-proposals.json`),windows=await read(`${root}/audio/windows-python.json`);
 if(windows.completed!==92||proposals.items.filter(i=>i.updates.some(u=>u.before.start===0&&u.before.end===0)).length!==26||proposals.items.some(i=>i.conflicts.length))throw Error('Incomplete or conflicting joint evidence');
 const items=[];
 for(const group of proposals.items){
  const paper=await read(`data/papers/${group.paperId}.json`),passage=paper.passages.find(p=>p.id===group.passageId);
  const ctcBytes=await fs.readFile(group.ctc.file);if(sha256(ctcBytes)!==group.ctc.sha256)throw Error('CTC proposal stale');
  const snapshot=`${root}/ctc-${group.ctc.sha256}.json`;await fs.writeFile(snapshot,ctcBytes);
  const w=windows.windows.find(w=>w.targets.some(t=>t.sentenceId===group.sentenceId)),meta=await read(w.pythonMetadata);
  const item={...group,ctc:{...group.ctc,snapshot:relative(snapshot)},individualReason:reasons[group.sentenceId],strictSupported:false,humanListeningClaimed:false,
   independentRecognition:{file:relative(w.pythonRecognition),sha256:meta.recognitionSha256,metadata:relative(w.pythonMetadata),metadataSha256:sha256(await fs.readFile(w.pythonMetadata)),text:w.pythonText,sourceRange:w.sourceRange},
   updates:group.updates.map(u=>({...u,textSha256:sentenceTextHash(passage.sentences.find(s=>s.id===u.sentenceId))}))};
  if(!item.individualReason)throw Error('Missing individual root decision');
  for(const u of item.updates)if(!jointUpdateIsSafe(u,u.acoustic))throw Error('Proposed boundary clips speech');
  items.push(item);
 }
 const approval={kind:'remaining-explicit-joint-boundary-candidate-approvals',generatedAt:new Date().toISOString(),reviewer:'root agent, evidence adjudication only',humanListeningClaimed:false,preserveReviewedFalse:true,items};
 await writeJson(approvalFile,approval);console.log(JSON.stringify({approvalFile,sha256:sha256(await fs.readFile(approvalFile)),missing:26,updates:items.flatMap(i=>i.updates).length}));process.exit(0);
}
const bytes=await fs.readFile(approvalFile),hash=sha256(bytes),approval=JSON.parse(bytes),approved=process.argv.find(a=>a.startsWith('--approve-sha='))?.slice(14);
if(hash!==approved||hash!==JOINT_APPROVAL_SHA)throw Error('Exact frozen joint approval was not adopted');
const assets=await read('data/assets.json'),prepared=new Map(),cache=new Map();
for(const group of approval.items){
 if(!prepared.has(group.paperId)){const file=`data/papers/${group.paperId}.json`,bytes=await fs.readFile(file);prepared.set(group.paperId,{file,bytes,hash:sha256(bytes),paper:JSON.parse(bytes),updates:[]});}
 const p=prepared.get(group.paperId),passage=p.paper.passages.find(p=>p.id===group.passageId);
 if(p.hash!==group.paperSha256||passageTextHash(passage)!==group.referenceTextSha256)throw Error('Paper changed since joint review');
 for(const u of group.updates){
  const s=passage.sentences.find(s=>s.id===u.sentenceId);if(s.start!==u.before.start||s.end!==u.before.end||s.reviewed||sentenceTextHash(s)!==u.textSha256)throw Error('Sentence changed since boundary review');
  const before=structuredClone(s);Object.assign(s,u.after);
  if(s.acousticEvidence){(s.acousticEvidenceHistory??=[]).push(s.acousticEvidence);delete s.acousticEvidence;}
  if(s.boundaryCandidateEvidence){(s.boundaryCandidateEvidenceHistory??=[]).push(s.boundaryCandidateEvidence);delete s.boundaryCandidateEvidence;}
  s.jointBoundaryEvidence={kind:'individually-adjudicated-joint-boundary-candidate',approval:relative(approvalFile),approvalSha256:hash,sentenceTextSha256:sentenceTextHash(s),referenceTextSha256:passageTextHash(passage),audioAssetId:p.paper.audioAssetId,mediaSha256:assets[p.paper.audioAssetId].sha256,sourceRange:{start:passage.start,end:passage.end},ctcReportSha256:group.ctc.sha256,strictSupported:false,humanListeningClaimed:false,role:u.role};
  p.updates.push({sentenceId:s.id,before,after:structuredClone(s)});
 }
}
for(const p of prepared.values()){
 validatePaper(p.paper);
 for(const u of p.updates){const passage=p.paper.passages.find(p=>p.sentences.some(s=>s.id===u.sentenceId)),s=passage.sentences.find(s=>s.id===u.sentenceId);if(!await verifyJointBoundaryEvidence(s,p.paper,passage,assets[p.paper.audioAssetId],path.resolve('data'),cache))throw Error('Frozen joint evidence failed: '+s.id);}
 if(sha256(await fs.readFile(p.file))!==p.hash)throw Error('Concurrent mutation before joint application');
}
await fs.mkdir(`${root}/before-boundaries`,{recursive:true});
for(const [id,p]of prepared){await fs.writeFile(`${root}/before-boundaries/${id}.json`,p.bytes);await writeJson(p.file,p.paper);}
await writeJson(`${root}/joint-boundary-application.json`,{generatedAt:new Date().toISOString(),approvalFile,approvalSha256:hash,filledMissing:26,updatedSentences:[...prepared.values()].flatMap(p=>p.updates).length,applied:[...prepared].map(([paperId,p])=>({paperId,updates:p.updates})),reviewedChanged:false,qualityChanged:false,humanListeningClaimed:false});
console.log(JSON.stringify({applied:true,filledMissing:26,updates:[...prepared.values()].flatMap(p=>p.updates).length,papers:prepared.size}));
