import fs from 'node:fs';
import path from 'node:path';
import {sha256} from './corpus.mjs';
export const TEXT_REVIEW_SHA='13acc8a306da1585b32b1d12c6c265c1900b9935cf0af8a03707019280566193';
let cached;
export function loadRemainingTranscriptReviews(){
 if(cached)return cached;
 const indexFile='data/references/remaining-transcript-decisions.json';if(!fs.existsSync(indexFile))return new Map();
 const index=JSON.parse(fs.readFileSync(indexFile,'utf8')),file=path.resolve(index.immutableReport);
 if(!file.startsWith(path.resolve('data/references')+path.sep)||index.immutableReportSha256!==TEXT_REVIEW_SHA)throw Error('Unapproved remaining transcript review');
 const bytes=fs.readFileSync(file);if(sha256(bytes)!==TEXT_REVIEW_SHA)throw Error('Frozen transcript review changed');
 const document=JSON.parse(bytes);
 if(document.kind!=='remaining-69-individually-adjudicated-candidate-transcripts'||document.rows.length!==69||new Set(document.rows.map(r=>r.sentenceId)).size!==69)throw Error('Invalid 69-decision scope');
 const checked=(file,hash)=>{if(!path.resolve(file).startsWith(path.resolve('data')+path.sep)||sha256(fs.readFileSync(file))!==hash)throw Error('Changed transcript review source: '+file);};
 for(const source of document.sources)checked(source.file,source.sha256);
 for(const row of document.rows){
  if(row.humanListeningClaimed!==false||row.reviewed!==false||row.qualityUpgradeAllowed!==false||sha256(Buffer.from(row.text))!==row.textSha256)throw Error('Invalid candidate review row');
  const e=row.independentRecognition;checked(e.file,e.sha256);checked(e.metadata,e.metadataSha256);
  const meta=JSON.parse(fs.readFileSync(e.metadata,'utf8'));
  if(meta.expectedTranscriptSupplied!==false||meta.recognitionSha256!==e.sha256||!meta.identity.targets.some(t=>t.kind==='transcript'&&t.sentenceId===row.sentenceId))throw Error('Unrelated recognition evidence');
 }
 cached=new Map(document.rows.map(r=>[r.sentenceId,r]));return cached;
}
export function remainingTranscriptReviewMatches(row,sentence){return !!(row&&row.sentenceId===sentence.id&&row.text===sentence.text&&row.textSha256===sha256(Buffer.from(sentence.text))&&row.humanListeningClaimed===false&&row.qualityUpgradeAllowed===false&&!sentence.reviewed);}
