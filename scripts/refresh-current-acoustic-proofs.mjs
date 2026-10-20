import fs from 'node:fs/promises';
import {writeJson,sha256} from './lib/corpus.mjs';
import {passageTextHash,sentenceTextHash,verifyCurrentAcousticEvidence} from './lib/acoustic-evidence.mjs';
import {auditPassage} from './lib/audit-acoustic.mjs';
import path from 'node:path';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const {root}=await read('runtime/remaining-review-location.json'),assets=await read('data/assets.json'),cache=new Map(),changes=[];
for(const file of(await fs.readdir('data/papers')).filter(f=>f.endsWith('.json'))){
 const full=`data/papers/${file}`,bytes=await fs.readFile(full),paper=JSON.parse(bytes);let changed=false;
 for(const passage of paper.passages){
  const ctcFile=`data/acoustic-review/${paper.id}/passage-${passage.order}.json`,ctcBytes=await fs.readFile(ctcFile),ctc=JSON.parse(ctcBytes);
  if(ctc.referenceTextSha256!==passageTextHash(passage))throw Error('New CTC evidence stale');
  const audit=auditPassage(paper,passage,ctc,assets[paper.audioAssetId]),hash=sha256(ctcBytes),archive=`references/acoustic-evidence/${hash}.json`;
  await fs.writeFile('data/'+archive,ctcBytes);
  for(const s of passage.sentences){
   if(!s.acousticEvidence||await verifyCurrentAcousticEvidence(s,paper,passage,assets[paper.audioAssetId],path.resolve('data'),cache))continue;
   const previous=s.acousticEvidence,raw=ctc.sentences.find(r=>r.id===s.id),a=audit.sentences.find(r=>r.id===s.id);
   (s.acousticEvidenceHistory??=[]).push(previous);
   const fits=raw&&s.start<=raw.acousticStart&&s.end>=raw.acousticEnd&&s.start>=raw.acousticStart-.120001&&s.end<=raw.acousticEnd+.160001;
   if(a?.supportedCandidate&&fits){s.acousticEvidence={...previous,report:archive,reportSha256:hash,referenceTextSha256:passageTextHash(passage),sentenceTextSha256:sentenceTextHash(s),acousticStart:raw.acousticStart,acousticEnd:raw.acousticEnd,scores:a.score,independentGreedy:a.independentTranscript,refreshedAfterExplicitTextReview:true};
    if(!await verifyCurrentAcousticEvidence(s,paper,passage,assets[paper.audioAssetId],path.resolve('data'),new Map()))throw Error('Refreshed proof invalid');
    changes.push({sentenceId:s.id,action:'rebound-to-current-complete-evidence',previousReport:previous.report,newReport:archive});
   }else{delete s.acousticEvidence;changes.push({sentenceId:s.id,action:'retired-stale-strict-claim-preserved-as-candidate',previousReport:previous.report,strictCurrent:a?.supportedCandidate||false,timingFits:fits});}
   changed=true;
  }
 }
 if(changed){if(sha256(await fs.readFile(full))!==sha256(bytes))throw Error('Concurrent paper mutation');await fs.mkdir(`${root}/before-proof-refresh`,{recursive:true});await fs.writeFile(`${root}/before-proof-refresh/${file}`,bytes);await writeJson(full,paper);}
}
await writeJson(`${root}/current-proof-refresh.json`,{generatedAt:new Date().toISOString(),changes,timingsChanged:false,qualityChanged:false,reviewedChanged:false});
console.log(JSON.stringify({rebound:changes.filter(x=>x.action.startsWith('rebound')).length,retired:changes.filter(x=>x.action.startsWith('retired')).length}));
