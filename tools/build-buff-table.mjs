/**
 * 从 HearthstoneJSON 生成「能给自己随从加攻击力」的 buff 法术表。
 *
 * 只收能直接加在己方随从身上的:
 *   · 「使一个随从获得+X攻击力」/「获得+X/+Y」
 *   · 「使一个友方随从获得…」
 * 排除群体、只对敌方、加给英雄的 —— 那些要么算不清楚,要么不是这一路伤害。
 *
 *   node tools/build-buff-table.mjs <cards.json> src/data/buff-spells.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
const cards = JSON.parse(readFileSync(src, 'utf8'));

// 排除:群体、只对敌方、加英雄、以及「攻击力等同于生命值」这类算不出固定值的
const EXCLUDE = /所有|每个|敌方|对手的|你的英雄|装备|召唤|随机|等同于|回合结束时/;
const table = {};
let skipped = 0;

for (const c of cards) {
  if (c.type !== 'SPELL') continue;
  const text = String(c.text ?? '').replace(/<[^>]+>/g, '');
  if (EXCLUDE.test(text)) { skipped += 1; continue; }

  // 「获得+N/+M」攻击力取前一个数;否则只认明确写着「+N攻击力」的。
  // 不能只写 `获得\+(\d+)` —— 那会把「获得+2生命值」当成加 2 点攻击。
  let atk;
  const pair = /获得\s*\+(\d+)\s*\/\s*\+?(\d+)/.exec(text);
  if (pair) atk = Number(pair[1]);
  else {
    const single = /获得\s*\+(\d+)\s*攻击力/.exec(text);
    if (single) atk = Number(single[1]);
  }
  if (atk === undefined) continue;
  if (!Number.isFinite(atk) || atk <= 0) continue;
  if (!c.collectible && atk >= 8) { skipped += 1; continue; }   // 冒险/乱斗的特殊牌
  table[c.id] = [c.name, c.cost ?? 0, atk];
}

writeFileSync(out, JSON.stringify({
  source: 'HearthstoneJSON zhCN',
  note: '只收能加给自己随从攻击力的单次 buff;群体、只对敌方、加英雄的不收。',
  cards: table,
}, null, 0), 'utf8');
console.log('收录:', Object.keys(table).length, '张 | 排除:', skipped, '张');
