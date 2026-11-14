/**
 * 直伤表与斩杀估算。
 *
 * 这张表是从 HearthstoneJSON 生成的,风险不在「查不到」而在「查错」——
 * 多收一张打不到脸的法术,斩杀线就会虚高,她会在你打不出来的时候喊「够了」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { affordableBurst, damageSpellsInHand } from '../src/damage.ts';

test('认识最基础的两张:火球术 6 伤 4 费、寒冰箭 3 伤 2 费', () => {
  const spells = damageSpellsInHand([{ cardId: 'CS2_029' }, { cardId: 'CS2_024' }]);
  assert.equal(spells.length, 2);
  const fireball = spells.find((s) => s.cardId === 'CS2_029');
  assert.equal(fireball.name, '火球术');
  assert.equal(fireball.damage, 6);
  assert.equal(fireball.cost, 4);
});

test('CORE_ / VAN_ 前缀的同一张牌也认', () => {
  const spells = damageSpellsInHand([{ cardId: 'CORE_CS2_029' }, { cardId: 'VAN_CS2_029' }]);
  assert.ok(spells.length >= 1, '带前缀的火球术应该能查到');
  assert.equal(spells[0].name, '火球术');
});

test('水晶够就都打得出,不够就只打得出能付的', () => {
  const hand = [{ cardId: 'CS2_029' }, { cardId: 'CS2_024' }];
  const rich = affordableBurst(hand, 6);   // 4+2=6
  assert.equal(rich.total, 9);
  assert.equal(rich.used.length, 2);

  const poor = affordableBurst(hand, 3);   // 只够寒冰箭,或只够火球之一
  assert.ok(poor.total <= 6);
  assert.ok(poor.used.every((s) => s.cost <= 3));
});

test('手牌里没有直伤时返回 0,不瞎猜', () => {
  const none = affordableBurst([{ cardId: 'CS2_120' }, { cardId: 'NOT_A_REAL_CARD' }], 10);
  assert.equal(none.total, 0);
  assert.deepEqual(none.used, []);
});

test('打不到脸的法术不能进表(魔爆术、烈焰风暴、奥术飞弹)', () => {
  // 这几张都是「对所有敌方随从」或「随机」,算进斩杀会虚高
  const spells = damageSpellsInHand([
    { cardId: 'CS2_025' },   // 魔爆术:对所有敌方随从造成 1 点
    { cardId: 'CS2_032' },   // 烈焰风暴:对所有敌方随从造成 4 点
    { cardId: 'CS2_026' },   // 冰霜新星:不造成伤害
  ]);
  assert.equal(spells.length, 0, `这些不该出现在表里:${spells.map((s) => s.name).join(',')}`);
});

test('炎爆术(10 费 10 伤)在表里,冒险 Boss 牌不在', () => {
  const big = damageSpellsInHand([{ cardId: 'EX1_279' }]);
  assert.equal(big.length, 1, '炎爆术是可收集牌,应当保留');
  assert.equal(big[0].damage, 10);

  const boss = damageSpellsInHand([{ cardId: 'THD_103p' }, { cardId: 'ULDA_045' }]);
  assert.equal(boss.length, 0, '0 费 30 伤的乱斗/冒险牌不该进表');
});
