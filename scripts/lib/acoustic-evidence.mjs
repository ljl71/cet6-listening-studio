import fs from 'node:fs/promises';
import path from 'node:path';
import {sha256} from './corpus.mjs';
import {sentenceTimingLowerBound,previousTimedSentenceEnd} from './sentence-timing-bounds.mjs';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
export const sentenceTextHash=sentence=>sha256(Buffer.from(sentence.text));
export const passageTextHash=passage=>sha256(Buffer.from(passage.sentences.map(s=>`${s.id}\t${s.text}`).join('\n')));
export function acousticEvidenceMatches(sentence,paper,passage,asset){
 const e=sentence.acousticEvidence;
 const index=passage.sentences.findIndex(s=>s.id===sentence.id);
 return !!(e&&e.schemaVersion===1&&e.supportedCandidate===true&&e.sentenceId===sentence.id&&
  e.audioAssetId===paper.audioAssetId&&e.mediaSha256===asset?.sha256&&
  e.sentenceTextSha256===sentenceTextHash(sentence)&&
  e.referenceTextSha256===passageTextHash(passage)&&
  e.sourceRange?.start===passage.start&&e.sourceRange?.end===passage.end&&
  e.appliedTiming?.start===sentence.start&&e.appliedTiming?.end===sentence.end&&
  finite(e.acousticStart)&&finite(e.acousticEnd)&&e.acousticEnd>e.acousticStart&&
  sentence.start<=e.acousticStart&&sentence.end>=e.acousticEnd&&
  index>=0&&sentence.start>=sentenceTimingLowerBound(passage,index)-0.000001&&sentence.start>=previousTimedSentenceEnd(paper,passage)-0.000001&&sentence.end<=passage.end&&
  sentence.start>=e.acousticStart-0.120001&&sentence.end<=e.acousticEnd+0.160001&&
  typeof e.report==='string'&&/^[a-f0-9]{64}$/.test(e.reportSha256));
}
export async function verifyCurrentAcousticEvidence(sentence,paper,passage,asset,dataRoot,cache=new Map()){
 if(!acousticEvidenceMatches(sentence,paper,passage,asset))return false;
 const e=sentence.acousticEvidence;const file=path.resolve(dataRoot,e.report);
 if(!file.startsWith(path.resolve(dataRoot)+path.sep))return false;
 const key=`${file}:${e.reportSha256}`;
 if(!cache.has(key)){
  try{const bytes=await fs.readFile(file);cache.set(key,sha256(bytes)===e.reportSha256?JSON.parse(bytes):null);}catch{cache.set(key,null);}
 }
 const report=cache.get(key);const row=report?.sentences?.find(s=>s.id===sentence.id);
 return !!(report&&report.audioAssetId===paper.audioAssetId&&report.mediaSha256===asset.sha256&&
  report.sourceRange?.start===passage.start&&report.sourceRange?.end===passage.end&&
  row?.text===sentence.text&&row.acousticStart===e.acousticStart&&row.acousticEnd===e.acousticEnd);
}
