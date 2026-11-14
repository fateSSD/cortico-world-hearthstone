/**
 * 硬币被加费之后，它就不再是「白送 1 点水晶」了。
 *
 * 2026-10-29 20:56:59 实测（`E:\Hearthstone\Logs\Hearthstone_2026_10_29_20_19_24\Power.log`）：
 * 同一毫秒里两条 `tag=COST` 变化 ——
 *
 *   加速光环(END_011)  COST 2 → 3
 *   幸运币(ETC_COIN1)  COST 0 → 1
 *
 * 也就是那个「手牌费用 +1」的光环照到了硬币自己。于是：
 *
 *   第 4 回合(2/2 水晶)：建议「加速光环(3费·要打硬币)」
 *     —— 可那枚硬币要花 1 水晶才换回 1 水晶，打完还是 2 点，3 费的牌照样上不去。
 *   第 6 回合(3/3 水晶)：「按费打:加速光环(3费)、幸运币(1费)」
 *     —— 3+1 = 4 > 3，两张一起打根本打不出；而且硬币还被当成了正经牌推荐。
 *
 * 根因：`coinCount`（几枚）一直当作「多几点水晶」用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { briefAdvice, manaBudget, readHand } from '../src/advice.ts';

const minion = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 0, health: 1, maxHealth: 1,
  taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false,
  canAttack: true, cantAttack: false, ...o,
});

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '圣骑士', heroName: '', heroCardId: '',
  health: 30, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 0, handCards: [], coinCount: 0, coinMana: 0,
  deckCount: 20, secrets: 0, minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe) => ({
  startedAt: '', turn: 4, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 },
});

const foeEmpty = () => side({ playerId: 2, isLocal: false, heroClass: '法师', health: 30, manaMax: 4 });

/** 被光环照过的硬币：0 费变 1 费。 */
const taxedCoin = { id: 2, cardId: 'ETC_COIN1', cost: 1 };

test('硬币被加价后，预算不再多算那 1 点', () => {
  const s = side({ mana: 2, coinCount: 1, coinMana: 0 });
  assert.equal(manaBudget(s), 2, '硬币换不到水晶时,预算就是水晶本身');
  // 正常硬币仍然值 1 点 —— 别把功能改坏
  assert.equal(manaBudget(side({ mana: 2, coinCount: 1, coinMana: 1 })), 3);
  // 两枚都被加价 → 一点都不多
  assert.equal(manaBudget(side({ mana: 3, coinCount: 2, coinMana: 0 })), 3);
});

test('第 4 回合那句「要打硬币」不许再出现', () => {
  // 2/2 水晶，加速光环被照成 3 费，手上那枚硬币也被照成 1 费
  const b = briefAdvice(snap(
    side({ mana: 2, manaMax: 2, coinCount: 1, coinMana: 0, handCards: [
      { id: 1, cardId: 'END_011', cost: 3 },   // 加速光环 2费 → 被照成 3费
      taxedCoin,
    ] }),
    foeEmpty(),
  ));
  assert.doesNotMatch(b.text, /要打硬币/, `那枚硬币换不到水晶,不许说打个硬币就能上:${b.text}`);
  assert.doesNotMatch(b.text, /按费打:[^。]*加速光环/, `3 费牌 2 水晶本来就打不出:${b.text}`);
});

test('硬币永远不进「按费打」，哪怕它被加价成 1 费', () => {
  // 3/3 水晶、加速光环 3 费 —— 正好能打，硬币不该跟着被推荐
  const b = briefAdvice(snap(
    side({ mana: 3, manaMax: 3, coinCount: 1, coinMana: 0, handCards: [
      { id: 1, cardId: 'END_011', cost: 3 },
      taxedCoin,
    ] }),
    foeEmpty(),
  ));
  assert.doesNotMatch(b.text, /幸运币/, `硬币被当成正经牌推了:${b.text}`);
  assert.match(b.text, /加速光环/, `该给的是那张 3 费牌:${b.text}`);
});

test('硬币正常时，靠硬币够到的那张牌照旧能推', () => {
  // 5/5 水晶 + 1 枚 0 费硬币，6 费牌 —— 这是硬币存在的意义，不能被一起改掉
  const b = briefAdvice(snap(
    side({ mana: 5, manaMax: 5, coinCount: 1, coinMana: 1, handCards: [
      { id: 1, cardId: 'EDR_258', cost: 6 },   // 坚韧的托雷斯,这里故意抬到 6 费
      { id: 2, cardId: 'ETC_COIN1', cost: 0 },
    ] }),
    foeEmpty(),
  ));
  assert.match(b.text, /托雷斯/, `打了硬币就够的牌该给出来:${b.text}`);
  assert.match(b.text, /要打硬币/, `该说明要靠硬币:${b.text}`);
});

test('硬币实体被认成硬币，读手牌时标出来', () => {
  const hand = readHand(side({ mana: 3, handCards: [
    { id: 1, cardId: 'ETC_COIN1', cost: 0 },
    { id: 2, cardId: 'GAME_005', cost: 0 },
    { id: 3, cardId: 'END_011', cost: 3 },
  ] }));
  assert.equal(hand.filter((c) => c.isCoin).length, 2, '两种硬币都要认出来');
  assert.equal(hand.find((c) => c.cardId === 'END_011').isCoin, false);
});
