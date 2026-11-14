/**
 * 拿真实对局日志,走到指定回合后打一份「这回合怎么打」。
 *
 *   node test/advice-real.mjs <Power.log> [目标回合]
 *
 * 存在的意义:手牌卡名是这张表唯一真正的验收点 —— 手造数据里我用的都是火球术、
 * 力量祝福这种我自己挑的 id,认得出不算本事;真实对局的卡 id 才是考题。
 */
import { readFileSync } from 'node:fs';
import { PowerLogParser } from '../src/parser.ts';
import { advise, renderAdvice } from '../src/advice.ts';

const [logPath, rawTurn] = process.argv.slice(2);
const wantTurn = Number(rawTurn) || 8;

const lines = readFileSync(logPath, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
const parser = new PowerLogParser(() => new Date().toISOString());
parser.setHistoryLimit(200);

outer: for (let i = 0; i < lines.length; i += 60) {
  parser.feed(lines.slice(i, i + 60));
  const s = parser.snapshot();
  if (s && s.turn >= wantTurn && !s.ended) break outer;
}

const s = parser.snapshot();
if (!s) {
  console.log('日志里没有进行中的对局。');
  process.exit(0);
}

console.log(renderAdvice(advise(s), s));
console.log('\n--- 手牌识别率 ---');
const hand = s.me.handCards ?? [];
const named = hand.filter((c) => /^[^#]/.test(c.cardId));
console.log('手牌张数:', hand.length, '| 有 cardId:', named.length);
