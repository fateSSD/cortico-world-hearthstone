/**
 * 「按费打」的排序：什么该排在前面。
 *
 * 这一组全部来自 2026-11-03 那 8 局（20:35–21:28，光环骑，6 胜 2 负）的 advised vs played 对比。
 * 49 个可比回合里只有 9 个他照做了 —— 但其中**大部分不是建议错了**，是排序把
 * 「能站场的」压在了「不产场面的」后面：
 *
 *   加速光环 → 正义保护者   ×3
 *   誓缚光环 → 警戒哨卫     ×3
 *   生而平等 → 龙鳞军备     ×2
 *   投身战争 → 各种随从     ×8（只打了一次）
 *
 * 这几张的共同点：牌面上什么都换不来。系统当时把它们的档位和随从放在一起，
 * 同档同费时谁前谁后看手牌顺序 —— 纯资源牌就这么反复挤掉了场面牌。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { briefAdvice, drawShouldYield, plainSpellNote, readHand } from '../src/advice.ts';

const minion = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 0, health: 1, maxHealth: 1,
  taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false,
  canAttack: true, cantAttack: false, ...o,
});

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 30, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 0, handCards: [], coinCount: 0,
  deckCount: 20, secrets: 0, minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe) => ({
  startedAt: '', turn: 3, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 },
});

test('纯资源法术认得出，产场面的法术不算', () => {
  assert.equal(plainSpellNote({ type: '法术', note: '在你的回合开始时 获得一个临时的法力水晶 持续 3回合' }), true, '加速光环');
  assert.equal(plainSpellNote({ type: '法术', note: '召唤' }), true, '誓缚光环/投身战争');
  assert.equal(plainSpellNote({ type: '法术', note: '抽取你套牌中和套牌之外的法术牌各一张' }), false, '抽牌是场面');
  assert.equal(plainSpellNote({ type: '法术', note: '伤害1群随从' }), false, '伤害是场面');
  assert.equal(plainSpellNote({ type: '随从', note: '2/3 嘲讽' }), false, '随从永远不是资源法术');
});

test('T3 真实：2 水晶，加速光环 vs 正义保护者 —— 推随从', () => {
  const s = snap(
    side({ mana: 2, manaMax: 2, handCount: 2, handCards: [
      { id: 1, cardId: 'END_011', cost: 2 },   // 加速光环
      { id: 2, cardId: 'ICC_038', cost: 1 },   // 正义保护者 1/1 嘲讽 圣盾
    ] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '幽灵', atk: 2, health: 2 })] }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /正义保护者/, '空场下 1 费嘲讽随从是站场，比 ramp 实在');
  assert.doesNotMatch(text, /^.*按费打:加速光环/, '别拿纯资源牌打头');
});

test('T5 真实：3 水晶，誓缚光环 vs 警戒哨卫 —— 同费时随从优先', () => {
  const s = snap(
    side({ mana: 3, manaMax: 3, handCount: 2, handCards: [
      { id: 1, cardId: 'BE_146', cost: 3 },     // 誓缚光环（光环，不产随从）
      { id: 2, cardId: 'JAIL_035', cost: 3 },   // 警戒哨卫 2/3 嘲讽
    ] }),
    side({ isLocal: false, minions: [
      minion({ id: 21, name: '幽灵甲', atk: 1, health: 2 }),
      minion({ id: 22, name: '幽灵乙', atk: 1, health: 2 }),
    ] }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /警戒哨卫/);
  assert.doesNotMatch(text, /按费打:誓缚光环/);
});

test('对面空场时，低费嘲讽随从不再被当成白板', () => {
  const s = snap(
    side({ mana: 2, manaMax: 2, handCount: 2, handCards: [
      { id: 1, cardId: 'END_011', cost: 2 },   // 加速光环
      { id: 2, cardId: 'ICC_038', cost: 1 },   // 正义保护者
    ] }),
    side({ isLocal: false }),
  );
  const text = briefAdvice(s).text;
  assert.doesNotMatch(text, /宁可空过|不值得当普通牌打/, '1 费曲线在空场照样该下');
  assert.match(text, /正义保护者|加速光环/, '两张都能打，至少得推出来一张');
});

test('生而平等这种「把全场改身材」的牌不当填充', () => {
  const s = snap(
    side({ mana: 2, manaMax: 2, handCount: 2, handCards: [
      { id: 1, cardId: 'EX1_619', cost: 2 },   // 生而平等
      { id: 2, cardId: 'EDR_251', cost: 1 },   // 龙鳞军备（抽牌）
    ] }),
    side({ isLocal: false, minions: [
      minion({ id: 21, name: '甲', atk: 1, health: 2 }),
      minion({ id: 22, name: '乙', atk: 2, health: 2 }),
    ] }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /龙鳞军备/, '抽牌是场面，可以打');
  assert.doesNotMatch(text, /按费打:生而平等/, '它自己的场面也被压成 1 血，不是这回合的填充');
});

test('只剩资源牌可打时照推，但要标出「·资源牌」', () => {
  const s = snap(
    side({ mana: 2, manaMax: 2, handCount: 1, handCards: [{ id: 1, cardId: 'END_011', cost: 2 }] }),
    side({ isLocal: false }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /加速光环/);
  assert.match(text, /资源牌/, '要让她知道这一手不产场面，别当场面牌念');
});

test('抽牌法术不会被当成资源牌压掉', () => {
  const hand = readHand(side({ mana: 3, handCards: [
    { id: 1, cardId: 'EDR_251', cost: 1 },
    { id: 2, cardId: 'END_011', cost: 2 },
  ] }));
  const draw = hand.find((c) => c.cardId === 'EDR_251');
  assert.equal(plainSpellNote(draw), false, '龙鳞军备是抽牌，产资源也产节奏');
});

/* ---------- 抽牌什么时候让位（2026-11-09） ---------- */

// 来源：2026-11-09 那批。她连着推「龙鳞军备」（1 费抽两张法术），他每次都改成下随从；
// 她自己在复盘里写的是「早几轮该抢的是场面，不是抽牌」——事后清醒、当下推抽牌。
//
// 和 11-03 那批方向**相反**（那次他打抽牌、系统推别的），所以不能一刀切。
// 判据抽成纯函数单测：靠构造整局去碰这条排序，会先被「危险」分支拦走
// （当场踩过：8 血对场攻 6，两个用例其实都走的 danger，一个过一个挂，过的那个也是撞的）。

const DRAW_NOTE = '抽取你套牌中和套牌之外的法术牌各一张';

test('抽牌让位：被压着打、手上还有牌 → 让', () => {
  assert.equal(drawShouldYield({ note: DRAW_NOTE, enemyAttack: 6, myEffectiveHp: 8, handSize: 5 }), true);
});

test('抽牌让位：没被压（对面打不死我）→ 不让，抽牌照推', () => {
  assert.equal(drawShouldYield({ note: DRAW_NOTE, enemyAttack: 2, myEffectiveHp: 30, handSize: 5 }), false);
});

test('抽牌让位：手牌快空了 → 不让，那是救命', () => {
  assert.equal(drawShouldYield({ note: DRAW_NOTE, enemyAttack: 6, myEffectiveHp: 8, handSize: 2 }), false);
});

test('抽牌让位：边抽边打的不算 —— 它本来就产场面', () => {
  assert.equal(drawShouldYield({ note: '对随从造成伤害2，抽一张牌', enemyAttack: 6, myEffectiveHp: 8, handSize: 5 }), false);
  assert.equal(drawShouldYield({ note: '召唤两个1/1，抽一张', enemyAttack: 6, myEffectiveHp: 8, handSize: 5 }), false);
});

test('抽牌让位：不是抽牌的一律不动', () => {
  assert.equal(drawShouldYield({ note: '在你的回合开始时 获得一个临时的法力水晶 持续 3回合', enemyAttack: 6, myEffectiveHp: 8, handSize: 5 }), false);
});

test('抽牌让位：血量刚好是场攻两倍时也算被压（≥ 不是 >）', () => {
  assert.equal(drawShouldYield({ note: DRAW_NOTE, enemyAttack: 5, myEffectiveHp: 10, handSize: 4 }), true);
});
