// Only the documented public source hosts are supported. A scraped URL must
// never turn this local service into a downloader for arbitrary/private hosts.
export function publicSourceUrl(value) {
 const url=new URL(value);
 if(url.protocol!=='https:'||url.port||url.username||url.password||!['english-exam.lazynote.cn','listening.lazynote.cn'].includes(url.hostname))throw Object.assign(new Error('来源地址不在支持的公开资料站范围内'),{restricted:true});
 const pathname=decodeURIComponent(url.pathname);
 if(/\/(?:downloads?|login|signin|auth|pay)(?:\/|$)/i.test(pathname)||pathname.includes('\\'))throw Object.assign(new Error('来源路径需要人工处理，停止自动获取'),{restricted:true});
 return url;
}

export function robotsAllows(text,value,agent='CET6LocalStudy') {
 const url=new URL(value),groups=[];let group=null,hasRules=false;
 for(const line of text.split(/\r?\n/)){
  const clean=line.split('#')[0].trim(),match=clean.match(/^([\w-]+)\s*:\s*(.*)$/);if(!match)continue;
  const key=match[1].toLowerCase(),value=match[2].trim();
  if(key==='user-agent'){if(!group||hasRules){group={agents:[],rules:[]};groups.push(group);hasRules=false;}group.agents.push(value.toLowerCase());}
  else if(group&&['allow','disallow'].includes(key)){group.rules.push({allow:key==='allow',path:value});hasRules=true;}
 }
 const specific=groups.filter(g=>g.agents.some(a=>a!=='*'&&agent.toLowerCase().includes(a)));
 const chosen=specific.length?specific:groups.filter(g=>g.agents.includes('*'));
 let best=null;
 for(const rule of chosen.flatMap(g=>g.rules)){
  if(!rule.path)continue;
  const pattern=rule.path.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*').replace(/\\\$$/,'$');
  if(!new RegExp('^'+pattern).test(url.pathname+url.search))continue;
  const weight=rule.path.replaceAll('*','').replace(/\$$/,'').length;
  if(!best||weight>best.weight||(weight===best.weight&&rule.allow))best={...rule,weight};
 }
 return !best||best.allow;
}
