import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const [review,ledger,timing,browser,loops,focused,backup,restore,release]=await Promise.all([
 read('docs/remaining-review-acceptance.json'),read('data/references/transcript-audit-final-state.json'),read('data/references/alignment-summary.json'),
 read('docs/browser-acceptance.json'),read('docs/player-loop-acceptance.json'),read('docs/remaining-boundary-browser-acceptance.json'),read('docs/full-backup-ui-acceptance.json'),read('docs/full-backup-check.json'),read('data/audit-report.json')]);
const {root}=await read('runtime/remaining-review-location.json'),application=await read(`${root}/joint-boundary-application.json`);
for(const r of [browser,loops,focused,backup,restore]){assert.equal(r.status,'passed');assert.ok(r.startedAt>'2026-10-20T12:28:49.393Z','A prior run cannot certify the final corpus');}
assert.equal(review.issues.length,0);assert.equal(review.counts.adjudicatedText,69);assert.equal(timing.totals.missingTime,0);
const testLog=await fs.readFile('runtime/remaining-tests-authorized.log','utf8');assert.match(testLog,/pass 90/);assert.match(testLog,/fail 0/);
const conservative=r=>r.checks.consecutive20AB.conservativeBoundaryError;
const loopErrors=loops.results.map(r=>`${r.browser} ${conservative(r).toFixed(4)} 秒`).join('；');
const bytes=backup.results[0].download.bytes,entries=backup.results[0].zipStructure.entries;
const text=`# 本机校对版验收记录

检查日期：2026-10-20。运行地址：<http://127.0.0.1:3260>。保留已确认的字体大小。

**本轮指定的69项原文分歧均已作出有证据的编辑决定，26句时间轴缺口已补齐。功能验收通过；仍未达到规划的正式内容交付标准。** 全库逐句人工听校确认仍为0，正式就绪为${release.ready}/27套；没有把编辑决定或机器对齐批量标成已核验。

## 本轮实际变更

| 项目 | 当前结果 |
|---|---|
| 原文69项 | 44句最小纠错，25句保留；每项有旧文、异文、理由和文件校验值 |
| 独立录音核对 | 92个原始录音窗口；另对1个漏识别短窗扩大上下文重查，不提供预期原文给模型 |
| 补充来源 | 原作者文章、作家采访、词典和原版教师资料；PDF对应页已检查并留图 |
| 时间轴26处缺口 | 全部补齐；另调整49处邻句边界，并为1条已改文字的旧边界更新证据 |
| 当前时间结构 | 4,138/4,138句有效候选时间；缺时、越界、非法时间、重叠、缩写碎片均为0 |
| 原先7句 | 保存时间完全不变，后续应用未覆盖 |
| 当前证据保护 | 1,812条严格候选证据、5条旧边界证据、${review.counts.jointBoundaryProofs}条新联合证据全部通过哈希及当前内容核查 |
| 编号与记录 | 句子/题目编号、题目选项、答案、依据句和既有学习记录未被本轮改写 |

全库累计126句保留最小纠错记录。新时间并非按字数分配：先对照完整CTC字词边界，再核查独立Whisper录音窗口，联合调整旧邻句拖后的空白。更早邻句仅调整尾部的项目没有宣称其原有开头已经通过听校。低分词和模型分歧仍保存在证据中；没有降低原严格检查阈值。

原文改动后，重新生成全部189篇的当前声学证据，重绑319条受影响的既有证据，未保留失效的文字校验值。当前3,072句通过严格候选规则，其余1,066句仍有机器识别分歧、低分或异常标签；其中31句的机器边界与当前保存边界差距超过2秒，正式听校须重点复查。上述数量与“有合法候选时间”不同，不能据候选覆盖率100%宣称全库逐句精度已达标。

同音姓名、effect/affect、语气词和部分弱读采用逐项说明的编辑方案，保留来源或模型的不同写法。独立书面来源能完整或按规范等价定位4,028句，109句为差异/正字裁定，另1句Hmm在第二来源漏记；这1句没有伪造第二原文。

详细记录：[69项处理决定与时间状态](原文与时间轴待核清单.md)、[当前整库变更审计](remaining-review-acceptance.json)、[原文证据](../data/references/remaining-transcript-decisions.json)、[联合时间证据](../${root}/joint-boundary-approval.json)、[当前声学审计](../data/references/acoustic-review-summary.json)。全部修改前文件保存在本轮证据目录中，可追溯和恢复。

## 真实浏览器和离线验收

沿用用户已授权的Playwright独立真实Edge、Chrome测试窗口，使用独立浏览器资料和数据库，不操作日常窗口或正式学习记录。

| 验收项 | Edge 155.0.4283.62 | Chrome 155.0.8059.85 |
|---|---|---|
| 新补26句逐一点击定位、实际音频开始播放 | 通过26/26 | 通过26/26 |
| 首次隐藏原文/答案、作答草稿、批改及未答统计 | 通过 | 通过 |
| 收藏、中文笔记、输入时快捷键保护 | 通过 | 通过 |
| 全站连续播放、切套题、播放进度恢复 | 通过 | 通过 |
| 外网隔离后启动、播放、答题、批改与复习 | 通过 | 通过 |
| 干净浏览器资料及本地服务重启后恢复 | 通过 | 通过 |
| 连续20次前台A-B循环 | 通过 | 通过 |
| 媒体末尾A-B、单句3次/停顿2秒及停顿内暂停恢复 | 通过 | 通过 |
| 窗口缩放及中文目录 | 通过 | 通过 |

最新循环测试保守误差上界：${loopErrors}，均低于0.3秒。记录全部回跳与采样间隔；这是播放器控制验收，不能替代4,138句实际首尾词的逐句听校。新补26句的页面测试验证了真实跳转和播放开始，同样不冒称人工听过每个首尾音。

离线验收在独立浏览器中阻断全部外部HTTP(S)及WebSocket，并以外站请求验证阻断；允许本机服务。没有关闭Windows网络适配器，不把它写作整台电脑已物理断网。正常练习无需外部字体、音频链接或付费AI服务。

报告：[本轮26句页面验收](remaining-boundary-browser-acceptance.json)、[完整浏览器流程](browser-acceptance.json)、[播放回归](player-loop-acceptance.json)。字体和布局仍使用已确认的生产构建 index-B4nDe5tO.js / index-CLtLwOAq.css。

## 完整备份和恢复

资料定版后，Edge、Chrome均从设置面板实际下载完整ZIP：各${bytes.toLocaleString('en-US')}字节，${entries.toLocaleString('en-US')}项。对实际收到的包逐文件校验CRC，在空目录恢复，27套全部原文和时间、27个音频SHA-256及分段播放、24条旧句映射一致。

使用非空隔离记录验证作答、草稿、播放进度、中文笔记、收藏、错因、合并历史及真实播放时长恢复一致；只排除导出时间，不排除进度时间戳。备份不能把候选标记升级为正式核验。报告：[浏览器原生完整下载](full-backup-ui-acceptance.json)、[空目录恢复核查](full-backup-check.json)。启动与恢复方式见[使用说明](../README.md)。

## 正式交付门槛

- 生产构建通过，自动测试90项全部通过；回环访问受限导致的初次测试失败日志保留，获准在本机隔离环境重跑后90/90通过。
- 27套独立音频、675题及已核对答案齐全；所有目标年份条目可本地播放，全部候选时间合法。
- 正式检查实际返回1：逐句听校0句，原文/时间轴正式核验0套，ready=0。此项**未通过**。
- 尚需逐句对照完整录音，核实原文及首尾词，优先复查1,066句机器风险项及31处大边界差距；确认后再逐套核验并重跑正式检查。未完成前版本继续标为校对版。

刷新当前网页即可加载本轮原文和时间更新；不要清除学习记录。
`;
await fs.writeFile('docs/验收记录.md',text);
await fs.writeFile('docs/final-validation.json',JSON.stringify({generatedAt:new Date().toISOString(),scope:'Final corpus after 69 transcript decisions and 26 missing timing completions',corpus:review.counts,structural:timing.totals,tests:{passed:90,failed:0,log:'runtime/remaining-tests-authorized.log'},browser:browser.status,loops:loops.status,boundary26:focused.status,backup:backup.status,restore:restore.status,formalReleasePassed:false,ready:release.ready,humanReviewedSentences:release.reviewedSentences,learningRecordsOverwritten:false,build:{javascript:'index-B4nDe5tO.js',css:'index-CLtLwOAq.css'},sourceReports:{browser:'docs/browser-acceptance.json',loops:'docs/player-loop-acceptance.json',backup:'docs/full-backup-ui-acceptance.json',restore:'docs/full-backup-check.json',release:'data/audit-report.json'},application},null,2)+'\n');
console.log(JSON.stringify({report:'docs/验收记录.md',candidateTextHandled:69,filledMissing:26,validTimes:4138,formalReady:release.ready,backupBytes:bytes}));
