/**
 * 斩杀规划:过墙、圣盾、buff、场攻重复。
 *
 * 每一项都对应一次真实算错的可能:算多了她会喊「够了」而其实打不出来,
 * 算少了会让他在能赢的回合不敢上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planLethal, breachTaunts, heroSwing, swingsOf, buffsInHand, worstCaseFaceAttack } from '../src/lethal.ts';

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
