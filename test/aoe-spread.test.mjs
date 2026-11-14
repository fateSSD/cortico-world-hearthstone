/**
 * 「伤害 N 群随机随从」不能当成「每只各吃 N 点」。
 *
 * 起源经过(2026-10-29 第 15 回合,圣骑士对术士,实况日志
 * `E:\Hearthstone\Logs\Hearthstone_2026_10_29_20_19_24\Power.log`):
 *
 *   建议[determined]:危险:对面场攻 15,我 8 有效血,不解就死。
 *   用 起源大厅 清场,能削 15 点、回 8 血(我 8→16),对面剩 0 点场攻,死不了。
 *
 * 而真实局面是对面 4 只随从合计 20 血,起源大厅只造成 **8 点**、且**随机分配**
 * (`吸血 伤害8群随机随从 召唤`)。8 点伤害杀不掉 20 血,更不可能把 15 点场攻清零。
 * 他照这条当成活路打完,第 16 回合就被打死了。
 *
 * 根因:`clears` 用 `血量 <= damage` 筛,这个判据对「每只各吃一份」成立,
 * 对「总量随机分配」不成立。`spreads` 当时只用来算回血,没用在场攻削减上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { advise, aoeOptions, briefAdvice } from '../src/advice.ts';

const minion = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 0, health: 1, maxHealth: 1,
  taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false,
  canAttack: true, cantAttack: false, ...o,
});

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 20, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 0, handCards: [], coinCount: 0, deckCount: 20, secrets: 0,
  minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe) => ({
  startedAt: '', turn: 15, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 },
});

/** 复刻第 15 回合:我 8 血 9 水晶,手握起源大厅,对面 4 只合计攻 15 / 血 20。 */
const originHallTurn = () => snap(
  side({
    health: 8, mana: 9, manaMax: 8,
    handCards: [{ id: 90, cardId: 'BE_183', cost: 8 }],   // 起源大厅
    handCount: 1,
  }),
  side({
    playerId: 2, isLocal: false, heroClass: '术士', health: 24,
    minions: [
      minion({ id: 201, atk: 2, health: 2, maxHealth: 2 }),
      minion({ id: 202, atk: 4, health: 4, maxHealth: 4 }),
      minion({ id: 203, atk: 5, health: 6, maxHealth: 6 }),
      minion({ id: 204, atk: 4, health: 8, maxHealth: 8 }),
    ],
  }),
);

test('随机分配的群伤:最多清掉多少是上界,保证值是 0', () => {
  const [aoe] = aoeOptions(originHallTurn());
  assert.ok(aoe, '起源大厅应该被识别成群体伤害');
  assert.equal(aoe.spreads, true, '「随机」必须被认出来');
  assert.equal(aoe.damage, 8, '总伤害是 8 点');
  // 20 血装不下 8 点伤害,所以无论怎么随机都不可能全清 → 保证值必须是 0
  assert.equal(aoe.cutMin, 0, '随机分配的下界是 0,不能拿上界判生死');
  assert.ok(aoe.cutMax <= 8, `上界也不该超过伤害总量,实际 ${aoe.cutMax}`);
  assert.ok(aoe.clears.length < 4, '4 只合计 20 血,8 点伤害不可能全清');
});

test('第 15 回合那句「死不了」不许再出现', () => {
  const text = briefAdvice(originHallTurn()).text;
  assert.ok(!/剩 0 点场攻/.test(text), `不许再报「对面剩 0 点场攻」:${text}`);
  assert.ok(!/死不了/.test(text), `8 血对 15 场攻 + 只能随机削几张,不许说「死不了」:${text}`);
  // 上界必须标明是上界,否则「最多削 8」和「还差 15」摆在一起又是自相矛盾
  assert.ok(/最多/.test(text), `报上界时必须带「最多」:${text}`);
});

test('伤害装得下全部血量时,随机牌才敢算全清', () => {
  // 3 只合计 6 血,8 点随机伤害 → 无论怎么分配都全清,这时保证值等于上界
  const s = snap(
    side({ health: 20, mana: 9, manaMax: 8, handCards: [{ id: 90, cardId: 'BE_183', cost: 8 }], handCount: 1 }),
    side({
      playerId: 2, isLocal: false, heroClass: '术士', health: 24,
      minions: [
        minion({ id: 201, atk: 1, health: 2, maxHealth: 2 }),
        minion({ id: 202, atk: 1, health: 2, maxHealth: 2 }),
        minion({ id: 203, atk: 1, health: 2, maxHealth: 2 }),
      ],
    }),
  );
  const [aoe] = aoeOptions(s);
  assert.equal(aoe.cutMin, aoe.cutMax, '伤害总量覆盖全部血量时,下界应等于上界');
  assert.equal(aoe.clears.length, 3);
});

test('非随机的群伤仍是「每只各吃一份」,判据不能被改坏', () => {
  // 3 只各 2 血,「伤害2群随从」= 每只各吃 2 点 → 全清(这个语义必须保留)
  const s = snap(
    side({ health: 20, mana: 3, manaMax: 3, handCards: [{ id: 91, cardId: 'CFM_065', cost: 3 }], handCount: 1 }),
    side({
      playerId: 2, isLocal: false, heroClass: '术士', health: 24,
      minions: [
        minion({ id: 201, atk: 1, health: 2, maxHealth: 2 }),
        minion({ id: 202, atk: 1, health: 2, maxHealth: 2 }),
        minion({ id: 203, atk: 1, health: 2, maxHealth: 2 }),
      ],
    }),
  );
  const opts = aoeOptions(s);
  const hit = opts.find((x) => x.name === '火山药水');
  assert.ok(hit, `应该识别出 火山药水(伤害2群随从),实际 ${opts.map((x) => x.name).join('/') || '空'}`);
  assert.equal(hit.spreads, false);
  assert.equal(hit.clears.length, 3);
  assert.equal(hit.cutMin, hit.cutMax, '非随机牌没有不确定性');
});

test('「按费打」的第二张不能拿清场牌填剩下的费用', () => {
  // 实测 2026-10-29 第 12 回合原文:
  //   按费打:坚韧的托雷斯(5费 3/4 嘲讽 圣盾)、阳炎清算(2费 伤害1群随从)
  // 6 水晶 + 1 币,5+2 刚好装得下,于是那张留着清场的群伤被当成填充推了出去。
  const s = snap(
    side({
      health: 26, mana: 6, manaMax: 6, coinCount: 1,
      handCards: [
        { id: 1, cardId: 'EDR_258', cost: 5 },   // 坚韧的托雷斯 5费 3/4 嘲讽 圣盾
        { id: 2, cardId: 'BE_153', cost: 2 },    // 阳炎清算 2费 伤害1群随从
      ],
      handCount: 2,
    }),
    side({
      playerId: 2, isLocal: false, heroClass: '死亡骑士', health: 35, manaMax: 8,
      minions: [
        minion({ id: 201, atk: 3, health: 4, maxHealth: 4 }),
        minion({ id: 202, atk: 2, health: 3, maxHealth: 3 }),
        minion({ id: 203, atk: 4, health: 3, maxHealth: 3 }),
      ],
    }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /托雷斯/, `首选该是那只嘲讽:${text}`);
  assert.doesNotMatch(text, /按费打:[^。]*阳炎清算/, `清场牌被当成填费用的第二张:${text}`);
});
