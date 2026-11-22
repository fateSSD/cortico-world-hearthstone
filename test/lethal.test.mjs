/**
 * 斩杀规划:过墙、圣盾、buff、场攻重复。
 *
 * 每一项都对应一次真实算错的可能:算多了她会喊「够了」而其实打不出来,
 * 算少了会让他在能赢的回合不敢上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planLethal, breachTaunts, heroSwing, swingsOf, buffsInHand, worstCaseFaceAttack, detectSweep } from '../src/lethal.ts';

const minion = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 0, health: 1, maxHealth: 1,
  taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false, canAttack: true, ...o,
});

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 20, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 6, manaMax: 6, overload: 0, handCount: 0, handCards: [], coinCount: 0, deckCount: 20, secrets: 0,
  minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe, extra = {}) => ({
  startedAt: '', turn: 8, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 }, ...extra,
});

test('英雄攻击力和武器攻击力不重复计算', () => {
  // 实测踩过:英雄 ATK=3、武器 ATK=3 时被算成 6
  const withWeapon = side({ heroAttack: 3, weapon: { name: '锤', atk: 3, durability: 2 } });
  assert.equal(heroSwing(withWeapon), 3);
  const weaponOnly = side({ heroAttack: 0, weapon: { name: '锤', atk: 3, durability: 2 } });
  assert.equal(heroSwing(weaponOnly), 3);
  const bare = side({ heroAttack: 0 });
  assert.equal(heroSwing(bare), 0);
});

test('风怒随从算两次攻击', () => {
  assert.deepEqual(swingsOf(side({ minions: [minion({ atk: 4, windfury: true })] })), [4, 4]);
  assert.deepEqual(swingsOf(side({ minions: [minion({ atk: 4 })] })), [4]);
});

test('没墙时场攻全额打到脸', () => {
  const plan = planLethal(snap(
    side({ minions: [minion({ atk: 3 }), minion({ id: 2, atk: 4 })] }),
    side({ isLocal: false, health: 20 }),
  ));
  assert.equal(plan.faceAtk, 7);
  assert.equal(plan.total, 7);
});

test('嘲讽会吃掉攻击力,而且算上过量浪费', () => {
  // 9 攻打 2 血嘲讽:剩下 0,不是 7
  const r = breachTaunts([9], [minion({ id: 9, name: '小墙', atk: 1, health: 2, taunt: true })]);
  assert.equal(r.cleared, true);
  assert.equal(r.spent, 9);
  assert.equal(r.leftover, 0, '一次攻击就没了,过量伤害不该算成剩余');
});

test('圣盾嘲讽要两次攻击才解得掉', () => {
  const taunt = minion({ id: 9, name: '盾墙', atk: 2, health: 4, taunt: true, divineShield: true });
  const two = breachTaunts([4, 4], [taunt]);
  assert.equal(two.cleared, true);
  assert.equal(two.leftover, 0, '两次都被墙吃掉');
  assert.ok(two.steps.some((s) => s.includes('破')), '应该有一条破盾记录');

  // 只有一个随从 → 破盾用掉就没了,解不掉
  const one = breachTaunts([8], [taunt]);
  assert.equal(one.cleared, false);
});

test('攻击力不够过墙时,脸伤算 0 而不是硬算', () => {
  const plan = planLethal(snap(
    side({ minions: [minion({ atk: 2 })] }),
    side({ isLocal: false, health: 20, minions: [minion({ id: 9, name: '大墙', atk: 3, health: 9, taunt: true })] }),
  ));
  assert.equal(plan.wall.cleared, false);
  assert.equal(plan.faceAtk, 0);
  assert.equal(plan.total, 0);
});

test('buff 牌按水晶加进斩杀,没有随从接时不算', () => {
  const withMinion = planLethal(snap(
    side({ mana: 1, handCards: [{ id: 5, cardId: 'CS2_087', cost: 1 }], minions: [minion({ atk: 5 })] }),
    side({ isLocal: false, health: 20 }),
  ));
  assert.equal(withMinion.buffDamage, 3, '力量祝福 +3 攻');
  assert.equal(withMinion.total, 8);

  const noMinion = planLethal(snap(
    side({ mana: 1, handCards: [{ id: 5, cardId: 'CS2_087', cost: 1 }], minions: [] }),
    side({ isLocal: false, health: 20 }),
  ));
  assert.equal(noMinion.buffDamage, 0, '场上没人能接 buff');
});

test('直伤和 buff 抢同一份水晶,按性价比分配', () => {
  // 6 水晶:火球术(4费6伤) + 力量祝福(1费3攻) → 都打得下,共 9
  const plan = planLethal(snap(
    side({
      mana: 6,
      handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }, { id: 2, cardId: 'CS2_087', cost: 1 }],
      minions: [minion({ atk: 2 })],
    }),
    side({ isLocal: false, health: 20 }),
  ));
  assert.equal(plan.spellDamage, 6);
  assert.equal(plan.buffDamage, 3);
  assert.equal(plan.total, 2 + 6 + 3);
});

test('认得出力量祝福,且不把只加生命值的牌当 buff', () => {
  const buffs = buffsInHand([{ cardId: 'CS2_087' }, { cardId: 'AV_136t' }]);
  assert.equal(buffs.length, 1, `只该认出力量祝福,实际:${buffs.map((b) => b.name).join(',')}`);
  assert.equal(buffs[0].atk, 3);
});

test('剧毒随从过墙:一刀解掉任意血量的嘲讽,省下的攻击力打脸', () => {
  // 1/2 剧毒 + 5/5 对付 8 血嘲讽:原来要凑 8 点(凑不出来,脸伤 0),
  // 现在剧毒一刀,剩下 5 点全打脸
  const plan = planLethal(snap(
    side({ minions: [
      { ...minion({ id: 11, name: '毒蜘蛛', atk: 1, health: 2 }), poisonous: true },
      minion({ id: 12, name: '大怪', atk: 5, health: 5 }),
    ] }),
    side({ isLocal: false, health: 10, minions: [minion({ id: 21, name: '巨墙', atk: 3, health: 8, taunt: true })] }),
  ));
  assert.equal(plan.faceAtk, 5);
  assert.match(plan.wall.steps.join(' '), /剧毒/);
});

test('硬币算进斩杀预算', () => {
  // 3 水晶打不出 4 费火球;手上有硬币就够 —— 硬币换的 1 点水晶必须计入预算,
  // 否则「差 1 费就能斩杀」会被报成「打不出来」。
  const poor = planLethal(snap(
    side({ mana: 3, coinCount: 0, handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }] }),
    side({ isLocal: false, health: 30 }),
  ));
  assert.equal(poor.spellDamage, 0, '3 水晶打不出 4 费火球');

  const withCoin = planLethal(snap(
    side({ mana: 3, coinCount: 1, handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }] }),
    side({ isLocal: false, health: 30 }),
  ));
  assert.equal(withCoin.spellDamage, 6, '多一个硬币就够 4 费了');
});

/* ---------- 2026-10-24 「下回合斩杀没算对面能交换我的随从」 ---------- */

/**
 * 第 19 回合真实局面(10:11 那局):
 *   我 19 血,场上六只、场攻 17;对面 25 血,只有诺兹多姆 8/8 + 治疗图腾 0/2。
 *
 * 按 17 算「下回合差 8 点就能收」是错的 —— 对面两个能动手的(诺兹多姆 + 英雄),
 * 最坏情况把我最贵的两只(6/8 和 5/5)换掉,轮到我只剩 6 点场攻。
 * 「现在场攻 17」和「下回合场攻 6」是两句话。
 */
test('最坏情况下还能留多少场攻:对面每个随从只能咬一个', () => {
  const me = side({
    health: 19,
    minions: [
      minion({ id: 1, atk: 6, health: 8 }),
      minion({ id: 2, atk: 3, health: 1 }),
      minion({ id: 3, atk: 1, health: 1 }),
      minion({ id: 4, atk: 1, health: 1 }),
      minion({ id: 5, atk: 1, health: 2 }),
      minion({ id: 6, atk: 5, health: 5 }),
    ],
  });
  const foe = side({ isLocal: false, health: 25, minions: [
    minion({ id: 21, atk: 8, health: 8 }),
    minion({ id: 22, atk: 0, health: 2 }),
  ] });
  // 他只有一个能打的随从(图腾 0 攻不算),外加英雄没武器 —— 那只换掉我最贵的 6/8
  assert.equal(worstCaseFaceAttack(me, foe), 11, '扣掉最贵的 6 攻,剩 11');

  // 他多了把武器(英雄也能打一刀)就再多换掉一个
  const armed = { ...foe, weapon: { atk: 3, durability: 2 } };
  assert.equal(worstCaseFaceAttack(me, armed), 6, '英雄一刀也算一次,再扣掉 5/5');
});

test('对面一个能打的都没有时,场攻全保得住', () => {
  const me = side({ minions: [minion({ id: 1, atk: 4, health: 4 }), minion({ id: 2, atk: 3, health: 3 })] });
  const foe = side({ isLocal: false, minions: [minion({ id: 21, atk: 0, health: 5, taunt: true })] });
  assert.equal(worstCaseFaceAttack(me, foe), 7);
});

test('冻结的随从不能咬人,不该算进「能换掉我几只」', () => {
  const me = side({ minions: [minion({ id: 1, atk: 6, health: 6 }), minion({ id: 2, atk: 4, health: 4 })] });
  const foe = side({ isLocal: false, minions: [minion({ id: 21, atk: 7, health: 7, frozen: true })] });
  assert.equal(worstCaseFaceAttack(me, foe), 10, '冻结的那只不算,两只都保得住');
});

test('空场就是 0', () => {
  assert.equal(worstCaseFaceAttack(side({ minions: [] }), side({ isLocal: false })), 0);
});

test('奥丁在场要点名 —— 护甲变攻击力那部分没算进总数', () => {
  /*
   * 2026-11-14：报障提到「战士的奥丁（之后获得甲都会加攻）」。
   *
   * 奥丁给的是**英雄攻击力**，走 heroSwing（max(heroAttack, weapon.atk)），
   * 所以打出护甲法术等于白送一份打脸攻击。但护甲法术和直伤共享水晶，
   * 要算进 total 就得重排整条费用分配 —— 算错一次比说少一次糟。
   * 所以只点名、不改数，让它自己判断。
   */
  const s = {
    startedAt: '', turn: 9, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
    me: side({
      mana: 3,
      minions: [minion({ id: 5, cardId: 'TTN_811', name: '首席管理官奥丁', atk: 8, health: 8 })],
      // 盾牌格挡：3 费 +5 甲
      handCards: [{ id: 1, cardId: 'CS2_102', cost: 3, name: '盾牌格挡' }],
    }),
    opponent: side({ playerId: 2, isLocal: false }),
    boardAttack: { mine: 0, theirs: 0 },
  };
  const plan = planLethal(s);
  const said = plan.caveats.join(' | ');
  assert.match(said, /奥丁/, 'caveats 里没点名奥丁');
  assert.match(said, /护甲/, '没说明护甲会变攻击力');
});

test('没有奥丁时不该冒出奥丁那句', () => {
  const s = {
    startedAt: '', turn: 9, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
    me: side({ mana: 3, minions: [minion({ id: 5, atk: 3, health: 3 })], handCards: [] }),
    opponent: side({ playerId: 2, isLocal: false }),
    boardAttack: { mine: 0, theirs: 0 },
  };
  assert.doesNotMatch(planLethal(s).caveats.join(' | '), /奥丁/, '空场也报了奥丁');
});

test('场上其他持续效果也要点名（不只奥丁）', () => {
  /*
   * 2026-11-14：奥丁单独处理了，但「你的图腾拥有+2攻击力」这类
   * 同样影响这回合能打多少 —— 图腾在场上就白多 2 点场攻。
   *
   * 不去建模每张光环（哪些算图腾、机械是不是这回合下的），
   * 而是在 caveats 里点名。这条链的规矩是宁可说少。
   */
  const s = {
    startedAt: '', turn: 9, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
    me: side({
      mana: 2,
      minions: [minion({ id: 7, cardId: 'CORE_REV_921', name: '锻石师', atk: 5, health: 4 })],
      handCards: [],
    }),
    opponent: side({ playerId: 2, isLocal: false }),
    boardAttack: { mine: 0, theirs: 0 },
  };
  const said = planLethal(s).caveats.join(' | ');
  assert.match(said, /锻石师/, '没点名锻石师');
  assert.match(said, /图腾/, '没说出它的效果');
});

/*
 * 战吼进斩杀线（2026-11-19，Mr.Q 报障）
 *
 * 那一把：圣骑士 8 费，头上挂着誓缚光环，手上两张时间流具象（各 4 费、战吼 3 伤），
 * 对面术士 6 血、场上一个 3/7 嘲讽。他两张战吼打脸正好 6 点斩杀。
 *
 * 当时的回执写的是「过墙后可打脸 0 + buff 1 = 1 → 差 5」，
 * 外加两条「时间流具象的战吼要『你控制着光环』才有 3 点伤害 —— 这一条我判断不了」。
 *
 * 三处叠加成这一个错：
 *   ① `battlecryState` 只认「装备武器」「没有控制其他随从」，光环 → unknown；
 *   ② `sureBattlecry` 只取伤害最大的**一张**，同名两张不累加；
 *   ③ `planLethal` 的战吼压根不进 total，只在 caveats 里写一句「没算进去」。
 *
 * 修复后这三条都要有测试兜住，否则下次重构还会退回去。
 */
const TIME_019 = '时间流具象'; // 4 费 3/3，战吼 伤害3群，战吼需你控制着光环
const timeFlowCard = (cost = 4) => ({ id: 1, cardId: 'TIME_019', name: TIME_019, cost, prepared: false });

test('两张战吼要累加：8 费双时间流具象 = 6 点，够斩 6 血', () => {
  const s = {
    startedAt: '', turn: 15, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
    me: side({
      mana: 8,
      auras: [{ cardId: 'BE_146', name: '誓缚光环' }],
      handCards: [timeFlowCard(), timeFlowCard()],
      minions: [minion({ id: 5, atk: 4, health: 5 })],
    }),
    // 3/7 嘲讽把 4 点场攻全吃掉 —— 这一局的斩杀完全靠战吼，正是原来漏掉的那条线
    opponent: side({ playerId: 2, isLocal: false, health: 6, minions: [minion({ id: 9, atk: 3, health: 7, taunt: true })] }),
    boardAttack: { mine: 0, theirs: 0 },
  };
  const plan = planLethal(s);
  assert.equal(plan.faceAtk, 0, '场攻应该全被墙吃掉');
  assert.equal(plan.battlecryDamage, 6, '两张战吼各 3 点，必须累加');
  assert.equal(plan.battlecries.length, 2, '同名两张要各记一条');
  assert.ok(plan.total >= 6, `total 应 ≥ 6，实际 ${plan.total}`);
  assert.match(plan.caveats.join(' | '), /战吼已计入 6 点/, 'caveats 要说清已经算进去了');
});

test('没有光环时「战吼需你控制着光环」不算伤害', () => {
  // 同一个局面，只把头上去掉光环 —— 前提不成立就不许算，宁可说少
  const s = {
    startedAt: '', turn: 15, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
    me: side({ mana: 8, auras: [], handCards: [timeFlowCard(), timeFlowCard()] }),
    opponent: side({ playerId: 2, isLocal: false, health: 6 }),
    boardAttack: { mine: 0, theirs: 0 },
  };
  const plan = planLethal(s);
  assert.equal(plan.battlecryDamage, 0, '没有光环就不该给战吼伤害');
  assert.ok(plan.total < 6);
  assert.match(plan.caveats.join(' | '), /没算进上面那个数/, '要说清有一笔没算');
});

test('只能打随从的战吼不算打脸', () => {
  // 受伤的掠夺者 BAR_069：4 费 5/10 嘲讽，战吼「伤害6随从」—— 一点脸伤都没有
  const s = {
    startedAt: '', turn: 8, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
    me: side({ mana: 8, auras: [], handCards: [{ id: 1, cardId: 'BAR_069', name: '受伤的掠夺者', cost: 4, prepared: false }] }),
    opponent: side({ playerId: 2, isLocal: false, health: 20 }),
    boardAttack: { mine: 0, theirs: 0 },
  };
  assert.equal(planLethal(s).battlecryDamage, 0, '只能打随从的战吼不该算成打脸伤害');
});

test('随机落点的战吼不算打脸伤害', () => {
  /*
   * 「伤害1随机」(火焰杂耍者 AT_094)的落点由随机器决定,可能打自己随从、也可能打自己脸 ——
   * 下界是 0 点。拿它算斩杀是在赌,和 damage.ts 收直伤法术的口径一致:随机的一律不收。
   */
  const s = {
    startedAt: '', turn: 5, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
    me: side({ mana: 5, auras: [], handCards: [{ id: 1, cardId: 'AT_094', name: '火焰杂耍者', cost: 2, prepared: false }] }),
    opponent: side({ playerId: 2, isLocal: false, health: 3 }),
    boardAttack: { mine: 0, theirs: 0 },
  };
  assert.equal(planLethal(s).battlecryDamage, 0, '随机落点的战吼不该算成打脸');
});

/* ---------- 清场组合：生而平等 + 群伤（2026-11-20） -------------------- */

const EQ = { id: 71, cardId: 'CORE_EX1_619', cost: 2 };      // 生而平等：所有随从变 1 血
const TIME = { id: 72, cardId: 'TIME_019', cost: 4 };         // 时间流具象：战吼 3 伤打敌方全体，需光环
const AURA = [{ cardId: 'BE_146', name: '誓缚光环' }];

/** 2026-11-20 那局第 17 回合的真实场面。 */
const t17 = (meOver = {}, foeMinions = null) => snap(
  side({
    health: 30, mana: 9, manaMax: 9,
    auras: AURA,
    handCards: [EQ, TIME],
    minions: [
      minion({ id: 11, name: '时间流具象', atk: 3, health: 2 }),
      minion({ id: 12, name: '灭世信徒', atk: 8, health: 8 }),
      minion({ id: 13, name: '瓦尼尔士兵', atk: 8, health: 8, divineShield: true }),
    ],
    ...meOver,
  }),
  side({
    isLocal: false, health: 15,
    minions: foeMinions ?? [
      minion({ id: 21, name: '女巫的学徒', atk: 5, health: 6, taunt: true }),
      minion({ id: 22, name: '火羽精灵', atk: 4, health: 5 }),
      minion({ id: 23, name: '滑行者巨怪', atk: 6, health: 7, taunt: true }),
      minion({ id: 24, name: '烈焰元素', atk: 6, health: 7 }),
    ],
  }),
);

test('生而平等 + 群伤：两道墙一起清掉，19 点场攻全部能打脸', () => {
  // viaClear 让文案能分清「撞开的」和「扫掉的」
  const p = planLethal(t17());
  assert.equal(p.viaClear, true, '这条路要走清场，不是撞墙');
  assert.equal(p.swingsTotal, 19);
  assert.equal(p.faceAtk, 19, '墙被扫掉了，不该再扣攻击力');
  assert.equal(p.battlecryDamage, 3, '群伤那一下记在战吼账上');
  assert.equal(p.total, 22);
  assert.equal(p.total, p.faceAtk + p.spellDamage + p.buffDamage + p.battlecryDamage, '分项之和必须等于 total');
  assert.match(p.wall.steps.join(' '), /生而平等/);
  assert.ok(p.caveats.some((c) => /圣盾或复生/.test(c)), '保守口径要说出来');
});

test('对面嘲讽带圣盾 → 不走清场组合，退回撞墙', () => {
  const p = planLethal(t17({}, [
    minion({ id: 21, name: '女巫的学徒', atk: 5, health: 6, taunt: true, divineShield: true }),
    minion({ id: 23, name: '滑行者巨怪', atk: 6, health: 7, taunt: true }),
  ]));
  // 群伤是一次伤害实例，圣盾把它整个吃掉 —— 1 血也死不了
  assert.equal(p.faceAtk, 0, '不能装作清得掉');
  assert.ok(p.caveats.some((c) => /带圣盾/.test(c)), '要说清为什么没走这条路');
});

test('对面随从带复生 → 不走清场组合', () => {
  const p = planLethal(t17({}, [
    minion({ id: 21, name: '女巫的学徒', atk: 5, health: 6, taunt: true, reborn: true }),
    minion({ id: 23, name: '滑行者巨怪', atk: 6, health: 7, taunt: true }),
  ]));
  assert.equal(p.faceAtk, 3, '扫完还会以 1 血站起来，墙还在');
  assert.ok(p.caveats.some((c) => /带复生/.test(c)));
});

test('没光环 → 群伤战吼前提不满足，清场组合不成立', () => {
  const p = planLethal(t17({ auras: [] }));
  assert.equal(p.faceAtk, 3);
  assert.equal(p.battlecryDamage, 0);
  assert.doesNotMatch(p.wall.steps.join(' '), /生而平等/);
});

test('费用不够 → 不走清场组合', () => {
  const p = planLethal(t17({ mana: 5, manaMax: 5 }));
  assert.doesNotMatch(p.wall.steps.join(' '), /生而平等/, '2+4=6 费，5 水晶凑不出来');
  assert.equal(p.faceAtk, 3);
});

test('detectSweep：没墙就不接这条路', () => {
  // 没嘲讽时场攻本来就全通，这条路没有额外价值，硬算只会把简单局面绕复杂
  const me = side({ mana: 9, auras: AURA, handCards: [EQ, TIME] });
  const foe = side({ isLocal: false, minions: [minion({ id: 21, atk: 4, health: 5 })] });
  assert.equal(detectSweep(me, foe, 9), null);
});

test('detectSweep：手上没有变形牌就不接', () => {
  const me = side({ mana: 9, auras: AURA, handCards: [TIME] });
  const foe = side({ isLocal: false, minions: [minion({ id: 21, atk: 4, health: 5, taunt: true })] });
  assert.equal(detectSweep(me, foe, 9), null);
});

test('清场组合比撞墙差时不采纳', () => {
  // 只有一道 1 血嘲讽：直接撞掉只花 3 点，剩 16 打脸 + 战吼 3 = 19；
  // 清场组合要花 6 费换来的还是 19，但占了两张牌 —— 不该被选中
  const p = planLethal(t17({}, [
    minion({ id: 21, name: '小墙', atk: 1, health: 1, taunt: true }),
  ]));
  assert.doesNotMatch(p.wall.steps.join(' '), /生而平等/, '有更便宜的路就不绕');
  assert.equal(p.total, 19);
});

/* ---------- P0-① 敌我全伤 AOE 不准把死掉的我方随从算进斩杀 ---------- */

const HELLFIRE = { id: 73, cardId: 'CS2_062', cost: 3 }; // 地狱烈焰：对所有角色造成 3 点伤害（伤害3群己）

test('生而平等 + 地狱烈焰：我方无圣盾随从全变 1 血后一并烧死，绝不虚报假斩杀', () => {
  // 复现审查报告原局面：我方两只 8/8，生而平等 + 地狱烈焰，对面 15 血一道 10 血大墙
  const s = snap(
    side({
      health: 30, mana: 5, manaMax: 5,
      handCards: [EQ, HELLFIRE],
      minions: [
        minion({ id: 11, name: '灭世A', atk: 8, health: 8 }),
        minion({ id: 12, name: '灭世B', atk: 8, health: 8 }),
      ],
    }),
    side({
      isLocal: false, health: 15,
      minions: [minion({ id: 21, name: '大墙', atk: 5, health: 10, taunt: true })],
    }),
  );
  const sw = detectSweep(s.me, s.opponent, 5);
  assert.ok(sw);
  assert.equal(sw.hitsOwnMinions, true);
  assert.equal(sw.hitsOwnHero, true);
  assert.equal(sw.selfHeroDamage, 3);
  assert.equal(sw.ownLostCount, 2);
  assert.equal(sw.survivingFaceAtk, 0, '两只 8/8 被生而平等变 1 血后都会被地狱烈焰烧死，场攻归 0');

  const p = planLethal(s);
  assert.equal(p.viaClear, false, '烧光自己只剩 3 点打脸，绝不误报 19 点斩杀');
  assert.ok(p.total < 15, `绝不允许虚报达到 15 斩杀线，实际=${p.total}`);
});

test('生而平等 + 地狱烈焰：我方随从全带圣盾且自身血够时才能保住场攻斩杀', () => {
  const s = snap(
    side({
      health: 10, mana: 5, manaMax: 5,
      handCards: [EQ, HELLFIRE],
      minions: [
        minion({ id: 11, name: '圣盾A', atk: 6, health: 8, divineShield: true }),
        minion({ id: 12, name: '圣盾B', atk: 6, health: 8, divineShield: true }),
      ],
    }),
    side({
      isLocal: false, health: 15,
      minions: [minion({ id: 21, name: '大墙', atk: 5, health: 10, taunt: true })],
    }),
  );
  const p = planLethal(s);
  assert.equal(p.viaClear, true);
  assert.equal(p.faceAtk, 12);
  assert.equal(p.spellDamage, 3);
  assert.equal(p.total, 15);
  assert.ok(p.caveats.some((c) => /伤己方英雄 3 血/.test(c)), '自伤 3 血必须在 caveats 明示');
});

test('生而平等 + 地狱烈焰：我方只有 3 血时会把自己烧死，直接拦住', () => {
  const s = snap(
    side({
      health: 3, mana: 5, manaMax: 5,
      handCards: [EQ, HELLFIRE],
      minions: [minion({ id: 11, name: '圣盾A', atk: 12, health: 8, divineShield: true })],
    }),
    side({
      isLocal: false, health: 15,
      minions: [minion({ id: 21, name: '大墙', atk: 5, health: 10, taunt: true })],
    }),
  );
  const sw = detectSweep(s.me, s.opponent, 5);
  assert.ok(sw?.blocked && /烧死|先死了|伤自己/.test(sw.blocked));
  const p = planLethal(s);
  assert.equal(p.viaClear, false);
});

/* ---------- 战吼漏网之鱼：无穷攻联动 OTK & 等同于本随从攻击力战吼 ---------- */

test('2026-11-22 第 12 回合原局：无穷之手 + 血帆袭击者 + 审判 直接算进斩杀线', () => {
  const mk = (foeMinions = [], myMinions = null, mana = 6) => snap(
    side({
      health: 25, mana, manaMax: mana,
      minions: myMinions ?? [
        minion({ id: 11, name: '血帆袭击者', atk: 2, health: 3, canAttack: true }),
        minion({ id: 12, name: '奖品商贩', atk: 2, health: 3, canAttack: true }),
      ],
      handCards: [
        { id: 64, cardId: 'END_012', cost: 3 },       // 无穷之手
        { id: 55, cardId: 'CORE_NEW1_018', cost: 2 }, // 血帆袭击者
        { id: 46, cardId: 'JAIL_326', cost: 1 },      // 审判（已预备减到 1 费）
      ],
    }),
    side({ isLocal: false, health: 30, minions: foeMinions }),
  );

  // 空场 30 血 → 6 费直接斩杀
  const p = planLethal(mk());
  assert.ok(p.total >= 30, `6 费应直接算出来斩杀，实际 total=${p.total}`);
  assert.equal(p.total, p.faceAtk + p.spellDamage + p.buffDamage + p.battlecryDamage + p.chargeDamage);
  assert.match(p.wall.steps.join(' '), /无穷之手.*血帆袭击者.*审判/);

  // 反例 1：对面两道嘲讽，我方只有 2 次可攻击（撞完墙没有剩余攻击踢脸）→ 不能报斩杀
  const pBlocked = planLethal(mk([
    minion({ id: 21, name: '墙A', atk: 2, health: 4, taunt: true }),
    minion({ id: 22, name: '墙B', atk: 2, health: 4, taunt: true }),
  ]));
  assert.ok(pBlocked.total < 30, '2 次攻击全拿去撞墙，打不到脸不能报斩杀');

  // 反例 2：场上没有能攻击的随从 → 不能报斩杀
  const pNoSwing = planLethal(mk([], [minion({ id: 11, atk: 2, health: 3, canAttack: false })]));
  assert.ok(pNoSwing.total < 30, '场上没能动的随从不能报斩杀');

  // 反例 3：只有 5 费凑不齐 3+2+1=6 费 → 不能报斩杀
  const pNoMana = planLethal(mk([], null, 5));
  assert.ok(pNoMana.total < 30, '费用不够不能报斩杀');
});

test('战吼造成等同于本随从攻击力的伤害（乌鳞斥候 CATA_552）与空格修复（大地亡魂 BAR_750）', () => {
  const s = snap(
    side({ mana: 6, handCards: [{ id: 1, cardId: 'CATA_552', cost: 6 }] }),
    side({ isLocal: false, health: 4 }),
  );
  const p = planLethal(s);
  assert.equal(p.battlecryDamage, 4, '乌鳞斥候 4/4 战吼应计入 4 点伤害');
  assert.equal(p.total, 4);
});
