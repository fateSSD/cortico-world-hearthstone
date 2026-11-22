/**
 * 暴雪卡组代码（Deckstring）编解码测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDeckString, encodeDeckString } from '../src/deck-code.ts';

test('编码后再解码：正确识别赛制、英雄职业、单双卡与总数', () => {
  const code = encodeDeckString({
    format: 2,
    heroes: [637], // HERO_08 法师
    cards: [
      { dbfId: 315, count: 1 }, // 火球术 CS2_029
      { dbfId: 1004, count: 2 }, // 烈焰风暴 CS2_032
    ],
  });
  const res = decodeDeckString(code);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deck.format, 'standard');
  assert.equal(res.deck.formatZh, '标准');
  assert.equal(res.deck.heroClass, '法师');
  assert.equal(res.deck.totalCards, 3);
  const fireball = res.deck.cards.find((c) => c.cardId === 'CS2_029');
  const flamestrike = res.deck.cards.find((c) => c.cardId === 'CS2_032');
  assert.equal(fireball?.count, 1);
  assert.equal(fireball?.name, '火球术');
  assert.equal(flamestrike?.count, 2);
  assert.equal(flamestrike?.name, '烈焰风暴');
});

test('支持带 ### 套牌名 与 # 职业注释的游戏内分享全文', () => {
  const code = encodeDeckString({
    format: 1,
    heroes: [930], // HERO_03 潜行者
    cards: [
      { dbfId: 904, count: 2 }, // 刺骨 EX1_124
      { dbfId: 1117, count: 3 }, // 军情七处特工 EX1_134（多于2张）
    ],
  });
  const text = [
    '### 节奏刺客',
    '# 职业：潜行者',
    '# 模式：狂野模式',
    '#',
    `# 2x (2) 刺骨`,
    `# 3x (3) 军情七处特工`,
    '#',
    code,
    '#',
    '# 想要使用这副套牌，请先复制到剪贴板，然后在游戏中点击“新套牌”进行制作。',
  ].join('\n');

  const res = decodeDeckString(text);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.deck.name, '节奏刺客');
  assert.equal(res.deck.format, 'wild');
  assert.equal(res.deck.heroClass, '潜行者');
  assert.equal(res.deck.totalCards, 5);
  assert.equal(res.deck.cards.find((c) => c.cardId === 'EX1_134')?.count, 3);
});

test('未知 dbfId 宽容降级并记入 unknownDbfIds，不崩溃', () => {
  const code = encodeDeckString({
    format: 2,
    heroes: [671], // HERO_04 圣骑士
    cards: [
      { dbfId: 476, count: 1 }, // 奉献 CS2_093
      { dbfId: 9999999, count: 2 }, // 不存在的 dbfId
    ],
  });
  const res = decodeDeckString(code);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.deck.unknownDbfIds, [9999999]);
  assert.equal(res.deck.heroClass, '圣骑士');
  assert.equal(res.deck.totalCards, 3);
});

test('空串、非 Base64 与坏头部返回明确报错', () => {
  assert.equal(decodeDeckString('').ok, false);
  assert.equal(decodeDeckString('hello-world-not-deck').ok, false);
  const badHeader = Buffer.from([1, 1, 2, 1, 1]).toString('base64');
  assert.equal(decodeDeckString(badHeader).ok, false);
});
