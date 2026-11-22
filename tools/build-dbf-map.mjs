/**
 * 从 HearthstoneJSON 生成 `dbfId -> cardId` 映射表，供暴雪卡组代码（Deckstring）解码使用。
 *
 *   node tools/build-dbf-map.mjs <cards.json> src/data/dbf-map.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('用法: node tools/build-dbf-map.mjs <cards.json> <out.json>');
  process.exit(1);
}

const cards = JSON.parse(readFileSync(src, 'utf8'));

const DEAD_SET = new Set([
  'LETTUCE', 'BATTLEGROUNDS', 'BATTLEGROUNDS_EVENT', 'TB',
  'VANILLA', 'VANILLA_RELIC',
]);

const map = {};
let count = 0;

for (const c of cards) {
  if (!c || !c.id || !Number.isFinite(c.dbfId) || c.dbfId <= 0) continue;
  if (DEAD_SET.has(c.set)) continue;
  const isPlayerHero = c.type === 'HERO' && (c.collectible || /^HERO_\d{2}/i.test(c.id));
  if (!c.collectible && !isPlayerHero) continue;
  if (c.set === 'HERO_SKINS' && !isPlayerHero) continue;
  map[String(c.dbfId)] = c.id;
  count += 1;
}

const payload = {
  source: 'HearthstoneJSON zhCN',
  note: 'dbfId 到 cardId 的映射，用于卡组代码（Deckstring）解码。',
  cards: map,
};

const json = JSON.stringify(payload);
writeFileSync(out, json, 'utf8');
console.log(`生成 dbfId 映射 ${count} 条 | ${(json.length / 1024).toFixed(0)} KB → ${out}`);
