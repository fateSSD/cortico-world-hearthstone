/**
 * 从 HearthstoneJSON 生成「能直接打脸的直伤法术」表。
 *
 * 判定标准保守:宁可少算,不可多算 —— 多算会让她报出一个打不出来的斩杀线。
 * 排除的情况:
 *   · 只能对随从(文本里提到「随从」)          → 碰不到脸
 *   · 群体(「对所有随从/敌人…」)           → 通常不是斩杀手段
 *   · 随机                                 → 落点不确定
 *   · 多段(「两次」「两遍」「各造成…」)     → 伤害结构不同,不能按单次算
 *
 *   node tools/build-damage-table.mjs .tmp-hs/cards.json src/data/damage-spells.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
const cards = JSON.parse(readFileSync(src, 'utf8'));

const EXCLUDE = /对一个随从|所有|每个|随机|相邻|两次|两遍|各造成|你的英雄|装备一把|召唤|敌方随从|对方随从|一个随从|随从/;
const table = {};
let skipped = 0;

for (const c of cards) {
  if (c.type !== 'SPELL') continue;
  const text = String(c.text ?? '').replace(/<[^>]+>/g, '');
  const m = /造成\s*\$?\s*(\d+)\s*点伤害/.exec(text);
  if (!m) continue;
  if (EXCLUDE.test(text)) { skipped += 1; continue; }
  const damage = Number(m[1]);
  if (!Number.isFinite(damage) || damage <= 0) continue;
  // 非可收集牌里会混进冒险/乱斗的 Boss 牌(「终结将近」0 费 30 伤这种),
  // 它们在正常对局里拿不到,混进来只会让斩杀线虚高。正常量级的衍生物(祈咒之类)留着。
  if (!c.collectible && damage >= 10) { skipped += 1; continue; }
  // [中文名, 费用, 伤害]
  table[c.id] = [c.name, c.cost ?? 0, damage];
}

const payload = {
  source: 'HearthstoneJSON zhCN',
  note: '只收能直接打脸的单次直伤法术;群体、随机、多段、只能打随从的一律不收。',
  cards: table,
};
writeFileSync(out, JSON.stringify(payload, null, 0), 'utf8');
console.log('收录:', Object.keys(table).length, '张 | 排除:', skipped, '张 | 输出字节:', JSON.stringify(payload).length);
