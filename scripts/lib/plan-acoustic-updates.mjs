import {sentenceTimingLowerBound} from './sentence-timing-bounds.mjs';
const round=value=>+value.toFixed(3);
const ceilMillis=value=>Math.max(0,Math.ceil((value-1e-9)*1000)/1000);
const floorMillis=value=>Math.floor((value+1e-9)*1000)/1000;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const valid=s=>finite(s?.start)&&finite(s?.end)&&s.end>s.start;

// This function proposes timings only. It neither changes the paper nor treats
// strong forced-alignment scores as independent proof of a source transcript.
export function planAcousticPassage(passage,audit,evidence,{protectedIds=new Set(),approvedReviewIds=new Set(),includeReviewCandidates=false,previousSentenceEnd=0}={}){
 const observed=new Map((evidence.sentences||[]).map(s=>[s.id,s]));
 const decisions=new Map();const candidates=new Map();
 for(const [index,sentence] of passage.sentences.entries()){
  const row=audit.sentences.find(s=>s.id===sentence.id);const acoustic=observed.get(sentence.id);
  const decision={sentenceId:sentence.id,text:sentence.text,current:{start:sentence.start,end:sentence.end},classification:row?.classification||'unavailable',requiresListening:!!row?.requiresListeningBeforeApplication,reasons:[]};
  decisions.set(sentence.id,decision);
  if(!row?.supportedCandidate)decision.reasons.push('strict-acoustic-audit-not-supported');
  if(sentence.reviewed)decision.reasons.push('human-reviewed-timing-protected');
  if(protectedIds.has(sentence.id))decision.reasons.push('sparse-completion-protected');
  if(row?.requiresListeningBeforeApplication&&!includeReviewCandidates&&!approvedReviewIds.has(sentence.id))decision.reasons.push('requires-listening-approval');
  if(decision.reasons.length)continue;
  const start=ceilMillis(Math.max(sentenceTimingLowerBound(passage,index),acoustic.acousticStart-0.12));
  const end=floorMillis(Math.min(passage.end,acoustic.acousticEnd+0.16));
  if(start>acoustic.acousticStart||end<acoustic.acousticEnd||end<=start){decision.reasons.push('passage-clipping-would-cross-acoustic-word-evidence');continue;}
  if(start<previousSentenceEnd){decision.reasons.push('overlap-with-previous-passage-sentence');continue;}
  candidates.set(sentence.id,{sentenceId:sentence.id,start,end,acousticStart:acoustic.acousticStart,acousticEnd:acoustic.acousticEnd,paddingAdjustments:[],requiresListening:decision.requiresListening});
 }
 const reject=(id,reason,detail)=>{if(!candidates.has(id))return false;candidates.delete(id);decisions.get(id).reasons.push(reason);if(detail)(decisions.get(id).conflicts??=[]).push(detail);return true;};
 // Even a high-score sentence must be in the original, monotonic passage order.
 for(let i=1;i<passage.sentences.length;i++){
  const left=observed.get(passage.sentences[i-1].id),right=observed.get(passage.sentences[i].id);
  if(finite(left?.acousticEnd)&&finite(right?.acousticStart)&&left.acousticEnd>right.acousticStart){
   const detail={leftId:left.id,rightId:right.id,acousticEnd:left.acousticEnd,nextAcousticStart:right.acousticStart};
   reject(left.id,'acoustic-word-evidence-overlap',detail);reject(right.id,'acoustic-word-evidence-overlap',detail);
  }
 }
 let changed=true;let paddingAdjustments=[];
 while(changed){
  changed=false;paddingAdjustments=[];
  const effective=passage.sentences.map(s=>({...s,...(candidates.get(s.id)||{})}));
  let previous=null;
  for(const current of effective){
   if(!valid(current))continue;
   if(previous&&current.start<previous.end){
    const left=candidates.get(previous.id),right=candidates.get(current.id);
    if(left&&right&&left.acousticEnd<=right.acousticStart){
     const lower=Math.max(left.acousticEnd,right.start),upper=Math.min(right.acousticStart,left.end);
     const boundary=round((lower+upper)/2);
     if(boundary<lower||boundary>upper){changed=reject(left.sentenceId,'no-rounded-padding-boundary')||changed;changed=reject(right.sentenceId,'no-rounded-padding-boundary')||changed;}
     else{previous.end=boundary;current.start=boundary;paddingAdjustments.push({leftId:previous.id,rightId:current.id,boundary,acousticEnd:left.acousticEnd,nextAcousticStart:right.acousticStart});}
    }else{
     const detail={leftId:previous.id,rightId:current.id,leftEnd:previous.end,rightStart:current.start};
     if(left)changed=reject(previous.id,'overlap-with-unchanged-or-unsupported-neighbor',detail)||changed;
     if(right)changed=reject(current.id,'overlap-with-unchanged-or-unsupported-neighbor',detail)||changed;
    }
   }
   previous=current;
  }
  if(!changed)for(const current of effective){const candidate=candidates.get(current.id);if(candidate){candidate.start=current.start;candidate.end=current.end;}}
 }
 for(const adjustment of paddingAdjustments){candidates.get(adjustment.leftId)?.paddingAdjustments.push(adjustment);candidates.get(adjustment.rightId)?.paddingAdjustments.push(adjustment);}
 const accepted=[...candidates.values()];
 const deferred=[...decisions.values()].filter(d=>!candidates.has(d.sentenceId));
 return {accepted,deferred,paddingAdjustments};
}
