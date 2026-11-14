/**
 * 探针：换牌阶段那一刻，解析器手上到底有什么、扩展会说什么。
 *
 * 目的只有一个 —— 确认「起手手牌」在这段日志里真的读得到，以及留换建议在真实数据上
 * 是不是正常人话。读得到，才有资格推事件给模型。
 *
 * 用法: node --import tsx tools/probe-mulligan.mjs <Power.log>
 */
import { readFileSync } from 'node:fs';
import { PowerLogParser } from '../src/parser.ts';
import { isMulliganOpen, mulliganPlan, mulliganText } from '../src/mulligan.ts';

const logPath = process.argv[2];
if (!logPath) {
  console.error('用法: node tools/probe-mulligan.mjs <Power.log>');
  process.exit(1);
}
const lines = readFileSync(logPath, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
const parser = new PowerLogParser(() => new Date().toISOString());

// 核心牌名单也能一起验：改完配置想确认「填了到底变不变」，用它跑一遍就够，
// 不必真开一局。用法: KEEP_CARDS=阿米图特 node ... probe-mulligan.mjs <log>
const keepCards = process.env.KEEP_CARDS || '';
if (keepCards) console.log(`核心牌: ${keepCards}`);

const BATCH = 50;
let seen = 0;
let lastKey = '';
for (let i = 0; i < lines.length; i += BATCH) {
  parser.feed(lines.slice(i, i + BATCH));
  const s = parser.snapshot();
  if (!s || s.turn > 1 || !isMulliganOpen(s)) continue;
  const hand = s.me.handCards.map((c) => c.cardId).join(',');
  if (hand === lastKey) continue;
  lastKey = hand;
  seen++;
  console.log(`\n=== #${seen} 批${i / BATCH} mulligan=${s.me.mulliganState || '(空)'} step=${s.step || '(空)'} 手牌 ${s.me.handCards.length} 张 ===`);
  // 先后手是判断"留不留高费"的依据，判错整个建议就反了。把它和它的来源一起打出来。
  console.log(`我=playerId ${s.me.playerId} / 对手=${s.opponent.playerId} / 先手=${s.firstPlayerId === null ? '(未知)' : s.firstPlayerId} / 当前行动=${s.activePlayerId}`);
  console.log('事实:', mulliganText(s) || '(空)');
  const plan = mulliganPlan(s, { keepCards });
  console.log('建议:', plan.text || '(空)');
  if (seen >= 12) break;
}
if (!seen) console.log('没抓到任何换牌窗口');
