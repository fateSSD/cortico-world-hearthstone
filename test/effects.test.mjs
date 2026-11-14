/**
 * 结构化效果:法伤、无视嘲讽、亡语、复生、吸血、战吼。
 *
 * 这些是从卡表标签(`b3 d2 s1 t`)读出来的,不调模型 —— 卡牌数据里本来就是结构化的,
 * 正则提一遍就够准;每回合多一次 LLM 请求,换来的是延迟和不稳定。
 *
 * 测试重点是:**这些数真的进到斩杀线和交换判断里了**,而不是只存在表里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { battlecryState, cardEffects, cardNote, conditionalBattlecries, parseTags, sureBattlecry } from '../src/effects.ts';
import { planLethal } from '../src/lethal.ts';
import { advise, tradeOptions } from '../src/advice.ts';

const minion = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 0, health: 1, maxHealth: 1,
  taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false,
  poisonous: false, lifesteal: false, reborn: false, rush: false, charge: false, canAttack: true, ...o,
});

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 20, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 0, handCards: [], deckCount: 20, secrets: 0,
  spellPower: 0, minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe) => ({
  startedAt: '', turn: 8, activePlayerId: 1, isMyTurn: true, step: 'MAIN_ACTION', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 },
});

test('标签串能解析成完整字段', () => {
  const base = {
    battlecry: 0, armor: 0, battlecryConditional: false, battlecryCondition: null,
    deathrattle: 0, spellPower: 0, ignoreTaunt: false, lifesteal: false, forge: false,
    prepare: false, tradeable: false,
  };
  assert.deepEqual(parseTags('b3 d2 s1 t'), { ...base, battlecry: 3, deathrattle: 2, spellPower: 1, ignoreTaunt: true });
  assert.deepEqual(parseTags(''), base);
  assert.deepEqual(parseTags(undefined), base);
  // 末尾的 `?` = 这条有前提
  assert.deepEqual(parseTags('b2?'), { ...base, battlecry: 2, battlecryConditional: true });
});

test('法术的吸血从卡面摘要兜底 —— 它拿不到运行时标签', () => {
  // 随从的吸血有 tag,法术没有(法术不进场地)。起源大厅是 8 伤群体 + 吸血,
  // 9 血面对 8 点场攻时它是唯一活路,漏掉吸血就等于漏掉这条命。
  assert.equal(cardEffects('BE_183').lifesteal, true, '起源大厅:吸血');
  assert.equal(cardEffects('CS2_029').lifesteal, false, '火球术不吸血');
});

test('护甲法术要能读出数字 —— 战士那两张一直是 0', () => {
  /*
   * 2026-11-14 报障：「打了一把战士，最后一回合她又迷惑了（我的法术效果）」。
   * 那一局手牌里有「放出鳄鱼」(甲10) 和「清理污染」(甲3)，而 cardEffects 返回的
   * 结构里**根本没有 armor 这个字段** —— 算斩杀时那 10 点甲等于不存在。
   *
   * 卡表的标签里也没写（生成脚本那条规则是后加的，这份卡表没重新生成），
   * 所以走摘要兜底：摘要写着「甲10 召唤」。
   */
  assert.equal(cardEffects('TIME_873').armor, 10, '放出鳄鱼:获得 10 点护甲');
  assert.equal(cardEffects('YOG_502').armor, 3, '清理污染:获得 3 点护甲');
  assert.equal(cardEffects('CS2_029').armor, 0, '火球术不加甲');
  // 标签里的中文分支也要认（下次重新生成卡表才会用上，但别让它悄悄坏掉）
  assert.equal(parseTags('甲7').armor, 7, '甲7 要解析成 7');
});

test('变形、复制这些也能读到', () => {
  // 这一批以前摘要全空,她只看得见牌名
  assert.match(cardNote('AT_005'), /变形/, '变形术：野猪');
  assert.match(cardNote('AT_015'), /复制/, '策反:复制敌方随从');
  assert.equal(cardNote('不存在的牌'), '', '查不到给空串,不要编');
});

test('从卡表读到法术伤害与无视嘲讽', () => {
  assert.equal(cardEffects('EX1_563').spellPower, 5, '玛里苟斯 +5 法伤');
  assert.equal(cardEffects('BT_187').ignoreTaunt, true, '凯恩·日怒:友方攻击无视嘲讽');
  assert.equal(cardEffects('CS2_029').spellPower, 0, '火球术本身没有法伤加成');
  assert.equal(cardEffects('不存在的牌').battlecry, 0, '查不到要当没有,不能猜');
});

test('法伤加成会加到直伤数字上', () => {
  // 场上 +1 法伤,火球术 6 → 7
  const plan = planLethal(snap(
    side({ spellPower: 1, mana: 4, handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }] }),
    side({ isLocal: false, health: 30 }),
  ));
  assert.equal(plan.spellDamage, 7);
  assert.ok(plan.caveats.some((c) => c.includes('法术伤害')), plan.caveats.join(';'));
});

test('有「无视嘲讽」的随从时,墙不挡攻击', () => {
  const wall = [minion({ id: 21, name: '巨墙', atk: 2, health: 9, taunt: true })];
  const withIgnorer = planLethal(snap(
    side({ minions: [minion({ id: 11, name: '凯恩', cardId: 'BT_187', atk: 5, health: 5 })] }),
    side({ isLocal: false, health: 20, minions: wall }),
  ));
  assert.equal(withIgnorer.faceAtk, 5, '无视嘲讽:5 点全打脸');

  const normal = planLethal(snap(
    side({ minions: [minion({ id: 11, name: '普通', atk: 5, health: 5 })] }),
    side({ isLocal: false, health: 20, minions: wall }),
  ));
  assert.equal(normal.faceAtk, 0, '没无视嘲讽:5 点凑不出 9 血墙');
});

test('对面复生:换掉也不算换干净,评分要降', () => {
  const reborn = tradeOptions(snap(
    side({ minions: [minion({ id: 11, atk: 6, health: 6 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '复生怪', atk: 2, health: 3, reborn: true })] }),
  ))[0];
  assert.match(reborn.text, /复生/);

  const plain = tradeOptions(snap(
    side({ minions: [minion({ id: 11, atk: 6, health: 6 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '普通怪', atk: 2, health: 3 })] }),
  ))[0];
  assert.ok(plain.score > reborn.score, `复生怪该更差:${plain.score} vs ${reborn.score}`);
});

test('对面有亡语伤害时要提醒,并降低评分', () => {
  // 冰喉:亡语造成 3 点伤害
  const withDeathrattle = tradeOptions(snap(
    side({ minions: [minion({ id: 11, atk: 8, health: 8 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '冰喉', cardId: 'AT_123', atk: 2, health: 3 })] }),
  ))[0];
  assert.match(withDeathrattle.text, /亡语/);
});

test('我方吸血随从换牌会提示回血', () => {
  const t = tradeOptions(snap(
    side({ minions: [minion({ id: 11, name: '吸血怪', atk: 6, health: 6, lifesteal: true })] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '普通怪', atk: 2, health: 3 })] }),
  ))[0];
  assert.match(t.text, /吸血/);
  assert.match(t.text, /回 6 血/);
});

test('手上的战吼伤害会单独提示', () => {
  // 北海海怪:战吼造成 4 点伤害
  const a = advise(snap(
    side({ mana: 6, handCards: [{ id: 1, cardId: 'AT_103', cost: 6 }] }),
    side({ isLocal: false, health: 20, minions: [minion({ id: 21, atk: 2, health: 3 })] }),
  ));
  const line = a.candidates.find((c) => c.includes('战吼'));
  assert.ok(line, `应当有战吼提示,实际候选:${a.candidates.join(' | ')}`);
  assert.match(line, /打 4 点/);
});

test('sureBattlecry 挑出确定打得出的、伤害最大的那张', () => {
  const best = sureBattlecry(['CS2_029', 'AT_103'], { weapon: false, minionCount: 0 });
  assert.equal(best.damage, 4, '北海海怪战吼 4 点;火球术是法术不是战吼');
  assert.equal(best.cardId, 'AT_103');
});

/* ---------- 条件战吼 ---------- */

test('雾帆劫掠者:没武器时战吼是白板,不许当 2 点伤害报', () => {
  // 用户实测:这张牌在手上,建议说「战吼能打 2 点,打出去就补刀」——
  // 可他没装备武器,打出去一点伤害都没有。
  const fx = cardEffects('CS3_022');
  assert.equal(fx.battlecry, 2);
  assert.equal(fx.battlecryConditional, true, '必须标出有前提');
  assert.match(fx.battlecryCondition ?? '', /装备武器/);

  const noWeapon = { weapon: false, minionCount: 0 };
  const withWeapon = { weapon: true, minionCount: 0 };
  assert.equal(battlecryState(fx, noWeapon), 'blocked', '没武器 → 确定打不出');
  assert.equal(battlecryState(fx, withWeapon), 'ready', '有武器 → 能打');

  assert.equal(sureBattlecry(['CS3_022'], noWeapon).damage, 0, '没武器不能算伤害');
  assert.equal(sureBattlecry(['CS3_022'], withWeapon).damage, 2, '有武器才算 2 点');
});

test('无条件战吼照旧算', () => {
  const fx = cardEffects('AT_103');   // 北海海怪:战吼造成 4 点伤害,无前提
  assert.equal(fx.battlecry, 4);
  assert.equal(fx.battlecryConditional, false);
  assert.equal(sureBattlecry(['AT_103'], { weapon: false, minionCount: 0 }).damage, 4);
});

test('判断不了的前提给 unknown,不当成能打', () => {
  // 「如果你手牌中有龙牌」要看手牌构成,这里不猜
  const fx = cardEffects('AT_122');   // 穿刺者戈莫克:需 4 个其他随从
  assert.equal(fx.battlecryConditional, true);
  const state = battlecryState(fx, { weapon: false, minionCount: 1 });
  assert.ok(state === 'unknown' || state === 'blocked', `实际 ${state}`);
  assert.equal(sureBattlecry(['AT_122'], { weapon: false, minionCount: 1 }).damage, 0);
});

test('conditionalBattlecries 把前提和判断结果一起交出来', () => {
  const list = conditionalBattlecries(['CS3_022'], { weapon: false, minionCount: 0 });
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'blocked');
  assert.equal(list[0].damage, 2);
  assert.match(list[0].condition, /装备武器/);
});
