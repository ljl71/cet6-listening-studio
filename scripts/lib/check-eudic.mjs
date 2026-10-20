import fs from 'node:fs/promises';
import {decodeEntities} from './corpus.mjs';
const urls=['https://dict.eudic.net/robots.txt','https://ai.eudic.net/robots.txt','https://ai.eudic.net/ting/article?id=88c8460d-0b5c-11ea-89b8-00505686c5e6&parentlink=%2Fting%2F'];
for(const [i,url]of urls.entries()){
 const r=await fetch(url,{signal:AbortSignal.timeout(30000)});const t=await r.text();
 console.log(url,r.status,t.length);
 await fs.writeFile(new URL(`../../data/raw/eudic-${i}.txt`,import.meta.url),t);
 if(i<2)console.log(t.slice(0,8000));else{
 console.log('LINKS',JSON.stringify([...t.matchAll(/(?:href|src)="([^"]*)"/g)].map(m=>m[1]).filter(h=>/article|sound|audio|caption|subtitle|script|\.js/.test(h)).slice(-100),null,2));
 console.log('TIMING',JSON.stringify(t.match(/.{0,180}(?:\.mp3|\.lrc|\.srt|subtitle|caption|sentence|articleid|ArticleId|2025年12月).{0,300}/gi)?.slice(-35),null,2));
 }
 if(r.status===401||r.status===403||r.status===429)break;
}
const catalog=await fs.readFile(new URL('../../data/raw/eudic-2.txt',import.meta.url),'utf8');
const link=catalog.match(/<a href="([^"]+)" title="2025年12月六级听力真题（第1套）/);
if(link){
 const url=new URL(decodeEntities(link[1]),'https://ai.eudic.net');
 const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(30000)});console.log('PUBLIC PLAYER',response.status,'REDIRECT',response.headers.get('location'));
 if(response.ok){const html=await response.text();await fs.writeFile(new URL('../../data/raw/eudic-player.html',import.meta.url),html);console.log('PLAYER MATCHES',JSON.stringify(html.match(/.{0,150}(?:\.lrc|\.srt|\.mp3|subtitle|caption|sentence|SubTitle|Subtitle|登录|会员|LogIn).{0,250}/gi)?.slice(-50),null,2));console.log('PLAYER SCRIPTS',JSON.stringify([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m=>m[1]),null,2));}
}
