const year=process.argv.find(s=>s.startsWith('--years='))?.slice(8);
process.send({type:'catalog',entries:[{id:'fixture-paper',title:'自制测试条目'}]});
process.send({type:'entry',id:'fixture-paper',status:'running',message:'测试获取'});
const timer=setTimeout(()=>{
 if(year==='2021'){process.send({type:'entry',id:'fixture-paper',status:'failed',message:'模拟来源失效'});process.send({type:'done',failed:1});}
 else {process.send({type:'entry',id:'fixture-paper',status:'completed',message:'测试完成'});process.send({type:'done',failed:0});}
 process.disconnect();
},year==='2022'?10000:100);
process.on('message',event=>{if(event.type==='cancel'){clearTimeout(timer);process.send({type:'cancelled',message:'已取消'});process.disconnect();}});
