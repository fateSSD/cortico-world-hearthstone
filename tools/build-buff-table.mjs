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
  let hp = 0;
  const pair = /获得\s*\+(\d+)\s*\/\s*\+?(\d+)/.exec(text);
  if (pair) {
    atk = Number(pair[1]);
    /*
     * **血量一起收**（2026-11-14）。
     *
     * 原来只取 `pair[1]`，`+2/+2` 的牌被记成「+2攻」，于是建议贴 buff 时
     * 只会说「变成 5/4」，而实际是「5/6」。斩杀数字不受影响（只算攻击），
     * 但**给她和给人看的描述是错的** —— 他会照着那个数去判断该不该贴。
     */
    hp = Number(pair[2]) || 0;
  } else {
    const single = /获得\s*\+(\d+)\s*攻击力/.exec(text);
    if (single) atk = Number(single[1]);
    // 只加生命的 buff（不加攻）不进这张表，但配在 `+N/+M` 之外的单加生命要认
    const singleHp = /获得\s*\+(\d+)\s*生命值/.exec(text);
    if (singleHp) hp = Number(singleHp[1]);
  }
  if (atk === undefined) continue;
  if (!Number.isFinite(atk) || atk <= 0) continue;
  if (!c.collectible && atk >= 8) { skipped += 1; continue; }   // 冒险/乱斗的特殊牌
  table[c.id] = [c.name, c.cost ?? 0, atk, hp];
}

writeFileSync(out, JSON.stringify({
  source: 'HearthstoneJSON zhCN',
  note: '只收能加给自己随从攻击力的单次 buff;群体、只对敌方、加英雄的不收。字段:[名称, 费用, 攻击力, 生命值]。',
  cards: table,
}, null, 0), 'utf8');
console.log('收录:', Object.keys(table).length, '张 | 排除:', skipped, '张');
