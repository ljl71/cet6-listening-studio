import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
async function readJson(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function writeJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(`${file}.tmp`,JSON.stringify(value,null,2)+'\n');await fs.rename(`${file}.tmp`,file);}

// Dates checked against NEEA notices; exceptional sessions additionally use
// the administering examination authority or the actual university notice.
export const examDates={
 '2020-07':{actualDate:'2020-07-11',originalPeriod:'2020 年上半年延期考试',url:'https://www.neea.edu.cn/html1/report/20053/4021-1.htm'},
 '2020-09':{actualDate:'2020-09-19',originalPeriod:'2020 年上半年延期考试',url:'https://www.neea.edu.cn/html1/report/20053/4021-1.htm'},
 '2020-12':{actualDate:'2020-12-12',url:'https://www.neea.edu.cn/html1/report/20091/5906-1.htm'},
 '2021-06':{actualDate:'2021-06-12',url:'https://www.neea.edu.cn/html1/report/21031/4511-1.htm'},
 '2021-12':{actualDate:'2021-12-18',url:'https://www.neea.edu.cn/html1/report/21091/8099-1.htm'},
 '2022-06':{actualDate:'2022-06-11',url:'https://www.neea.edu.cn/html1/report/22031/2900-1.htm'},
 '2022-09':{actualDate:'2022-09-17',originalPeriod:'2022 年上半年第二次考试',url:'https://jiaowu.ruc.edu.cn/xsym/ksycjxs/tzgg/a5403a622ba54fe0b88417bc90d6e59e.htm'},
 '2022-12':{actualDate:'2022-12-10',url:'https://www.neea.edu.cn/html1/report/2209/180-1.htm'},
 '2023-03':{actualDate:'2023-03-12',originalPeriod:'2022 年下半年加考',url:'https://www.sceea.cn/Html/202303/Newsdetail_3026.html'},
 '2023-06':{actualDate:'2023-06-17',url:'https://www.neea.edu.cn/html1/report/2303/329-1.htm'},
 '2023-12':{actualDate:'2023-12-16',url:'https://cet.neea.edu.cn/html1/report/2309/7-1.htm'},
 '2024-06':{actualDate:'2024-06-15',url:'https://www.neea.edu.cn/html1/report/2403/75-1.htm'},
 '2024-12':{actualDate:'2024-12-14',url:'https://www.neea.edu.cn/html1/report/2409/8-1.htm'},
 '2025-06':{actualDate:'2025-06-14',url:'https://www.neea.edu.cn/html1/report/2503/19-1.htm'},
 '2025-12':{actualDate:'2025-12-13',url:'https://www.neea.edu.cn/html1/report/2509/26-1.htm'},
 '2026-06':{actualDate:'2026-06-13',url:'https://www.neea.edu.cn/html1/report/2603/2-1.htm'}
};
export function addExamDate(paper){
 const date=examDates[`${paper.year}-${String(paper.month).padStart(2,'0')}`];if(!date)return paper;
 paper.actualDate=date.actualDate;if(date.originalPeriod)paper.originalPeriod=date.originalPeriod;
 const source={url:date.url,label:'考试日期公告（教育考试机构 / 考点通知）',kind:'catalog'};
 paper.sources=[...new Map([...paper.sources,source].map(s=>[`${s.kind}:${s.url}`,s])).values()];return paper;
}
const invoked=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invoked){
 const root=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));const data=path.resolve(process.env.CET6_DATA_DIR||path.join(root,'data'));
 await writeJson(path.join(data,'references','exam-dates.json'),{checkedAt:new Date().toISOString(),entries:examDates});
 if(process.argv.includes('--apply')){let count=0;for(const name of await fs.readdir(path.join(data,'papers'))){if(!name.endsWith('.json'))continue;const file=path.join(data,'papers',name);const paper=await readJson(file,null);if(!paper)continue;await writeJson(file,addExamDate(paper));count++;}console.log(`Exam dates applied to ${count} papers; learning data untouched.`);}else console.log('Date reference written. Use --apply after collection to update paper metadata.');
}
