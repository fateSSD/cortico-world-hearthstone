/**
 * 风怒：能打两次的东西，别按一次算。
 *
 * 2026-10-30 实测的真 bug：风怒武器让英雄连砍两刀（seq 91、92 都是「女伯爵莉亚德琳 攻击 伯瓦尔」），
 * 但 `heroSwing` 只返回单次攻击力，`swingsOf` 只 push 一次 —— 于是她说
 * 「这回合只凑出 3 点，他还剩 6」，实际两刀正好 6 点够斩。
 *
 * 同一个洞在随从那边也在：`泰坦猛击者 6/6 风怒` 放在场上，场攻只记 6。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heroSwing, swingsOf } from '../src/lethal.ts';

/** 只造 swingsOf / heroSwing 真正会读的字段，别为了凑类型把它写成一坨。 */
const side = (over = {}) => ({
  heroAttack: 0,
  heroWindfury: false,
  minions: [],
  weapon: null,
  ...over,
});

const minion = (atk, over = {}) => ({
  id: 1, cardId: '', name: '随从', atk, health: 5,
  canAttack: true, cantAttack: false, windfury: false,
  taunt: false, poisonous: false, ...over,
});

test('武器 + 风怒：英雄能砍两刀，swingsOf 要 push 两次', () => {
  const s = side({
    heroAttack: 3,
    heroWindfury: true,
    weapon: { cardId: '', name: '毁灭之锤', atk: 3, durability: 8, windfury: true, hitsHero: true },
  });
  assert.equal(heroSwing(s), 3, '单次还是 3');
  assert.deepEqual(swingsOf(s), [3, 3], '两次 3 点，不是一次');
});

test('武器无风怒：只有一刀', () => {
  const s = side({
    heroAttack: 4,
    weapon: { cardId: '', name: '真银圣剑', atk: 4, durability: 2, windfury: false, hitsHero: true },
  });
  assert.deepEqual(swingsOf(s), [4]);
});

test('风怒随从算两次（这条之前也在漏）', () => {
  const s = side({ minions: [minion(6, { windfury: true })] });
  assert.deepEqual(swingsOf(s), [6, 6], '泰坦猛击者 6/6 风怒是 12 点，不是 6');
});

test('普通随从仍是一次', () => {
  const s = side({ minions: [minion(4), minion(3)] });
  assert.deepEqual(swingsOf(s), [4, 3]);
});

test('召唤失调的随从不算 —— 风怒也不例外', () => {
  const s = side({ minions: [minion(6, { windfury: true, canAttack: false })] });
  assert.deepEqual(swingsOf(s), []);
});

test('无法攻击英雄的武器：一刀都不算，风怒也不翻倍', () => {
  const s = side({
    heroAttack: 4,
    heroWindfury: true,
    weapon: { cardId: '', name: '无穷之手', atk: 4, durability: 2, windfury: true, hitsHero: false },
  });
  assert.deepEqual(swingsOf(s), [], '它砍不到脸，一次都不该有');
});

test('英雄 0 攻但有风怒：不该凭空多出攻击', () => {
  const s = side({ heroWindfury: true });
  assert.deepEqual(swingsOf(s), [], 'heroSwing 是 0，风怒不改变这一点');
});

test('混场：风怒随从 + 武器风怒，总数对得上', () => {
  const s = side({
    heroAttack: 3,
    heroWindfury: true,
    weapon: { cardId: '', name: '毁灭之锤', atk: 3, durability: 8, windfury: true, hitsHero: true },
    minions: [minion(6, { windfury: true }), minion(2)],
  });
  // 3+3(英雄两刀) + 6+6(风怒随从两刀) + 2 = 20
  assert.equal(swingsOf(s).reduce((a, b) => a + b, 0), 20);
});

test('没有任何东西时返回空数组，不是 [0]', () => {
  assert.deepEqual(swingsOf(side()), [], '0 攻不该被当成一次攻击');
});
