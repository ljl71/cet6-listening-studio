// A decoded passage's sourceRange stays unchanged. Only its first physical
// sentence may keep up to 300 ms of audio from the original complete asset.
export const sentenceTimingLowerBound=(passage,index)=>index===0?Math.max(0,passage.start-0.3):passage.start;
export function previousTimedSentenceEnd(paper,passage){
 let end=0;
 for(const current of paper.passages||[]){
  if(current.id===passage.id)break;
  for(const s of current.sentences||[])if(Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start)end=Math.max(end,s.end);
 }
 return end;
}
