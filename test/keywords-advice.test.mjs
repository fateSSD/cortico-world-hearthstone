/**
 * 新词条与打牌/斩杀/清场/记牌联动测试：
 *   1. 战吼单杀提权 & 法术清场（非濒死高价值清场 & 生而平等+奉献清墙斩杀）；
 *   2. 消灭/变形/单伤进危险求生 pickRemoval；
 *   3. 连击（激活算全伤不叠加、未激活优先先打启动牌）；
 *   4. 灌注（已灌注次数前提与灌注牌节奏不降权）；
 *   5. 黑暗之赐（手牌标签、冲锋入斩杀、双倍战吼翻倍）；
 *   6. 磁力加攻贴场上可攻击机械入斩杀；
 *   7. 记牌器反哺宇宙前提与提示摘要。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSweep, planLethal } from '../src/lethal.ts';
import { advise, aoeCombos, aoeOptions, briefAdvice, buildModelPrompt, singleRemovals } from '../src/advice.ts';
import { buildTrackerSnapshot } from '../src/tracker.ts';

const minion = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 2, health: 2, maxHealth: 2,
  taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false,
  poisonous: false, lifesteal: false, reborn: false, cantAttack: false, canAttack: true,
  ...o,
});

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '法师', heroName: '', heroCardId: '',
  health: 25, maxHealth: 30, armor: 0, heroAttack: 0, heroWindfury: false, fatigue: 0,
  mana: 8, manaMax: 8, overload: 0, handCount: 0, handCards: [], coinCount: 0, coinMana: 0,
  deckCount: 20, secrets: 0, spellPower: 0, minions: [], weapon: null, playState: 'PLAYING',
  ...o,
});

const snap = (me, foe, extra = {}) => ({
  startedAt: '', turn: 10, activePlayerId: 1, isMyTurn: true, step: 'MAIN_ACTION',
  ended: false, result: null, me, opponent: foe, boardAttack: { mine: 0, theirs: 0 }, ...extra,
});

test('法术清场 + 非濒死高价值清场直接推荐，且生而平等+奉献也能清墙斩杀', () => {
  // 非濒死（25血 vs 对面 11场攻三只怪），手上有烈焰风暴(7费 打5群随从)能全清
  const clearSnap = snap(
    side({ health: 25, mana: 8, handCards: [{ id: 1, cardId: 'CS2_032', cost: 7 }] }),
    side({
      isLocal: false,
      heroClass: '圣骑士',
      minions: [
        minion({ id: 11, name: '怪A', atk: 4, health: 4 }),
        minion({ id: 12, name: '怪B', atk: 4, health: 5 }),
        minion({ id: 13, name: '怪C', atk: 3, health: 3 }),
      ],
    }),
  );
  const b = briefAdvice(clearSnap);
  assert.match(b.text, /清场:烈焰风暴/, `非濒死面对多怪应直接推出烈焰风暴清场:${b.text}`);

  // 生而平等(2费) + 奉献(3费 伤害2群) 清掉两道大嘲讽让场上 10 攻打脸 + 奉献 2 点 = 12 斩杀
  const eqSnap = snap(
    side({
      mana: 6,
      minions: [minion({ id: 1, name: '大怪', atk: 10, health: 10 })],
      handCards: [
        { id: 2, cardId: 'CORE_EX1_619', cost: 2 }, // 生而平等
        { id: 3, cardId: 'CS2_093', cost: 3 },      // 奉献
      ],
    }),
    side({
      isLocal: false,
      health: 12,
      minions: [minion({ id: 21, name: '高墙', atk: 6, health: 8, taunt: true })],
    }),
  );
  const sweep = detectSweep(eqSnap.me, eqSnap.opponent, 6);
  assert.equal(sweep?.sweeperKind, 'spell');
  const p = planLethal(eqSnap);
  assert.equal(p.viaClear, true);
  assert.equal(p.faceAtk, 10);
  assert.equal(p.spellDamage, 2);
  assert.equal(p.total, 12);
});

test('战吼单杀在安全局提权到普通牌前，危险局变形/消灭单解救命', () => {
  // 火元素(6费 6/5 战吼伤害4) 能直接点掉敌方 4血随从，应排在纯白板随从前
  const fireSnap = snap(
    side({
      health: 28,
      mana: 7,
      handCards: [
        { id: 1, cardId: 'AT_090', cost: 5 },  // 穆克拉的勇士(5/3)
        { id: 2, cardId: 'CS2_042', cost: 6 }, // 火元素(战吼打4)
      ],
    }),
    side({
      isLocal: false,
      minions: [minion({ id: 10, name: '靶子', atk: 3, health: 4 })],
    }),
  );
  const b1 = briefAdvice(fireSnap);
  assert.match(b1.text, /按费打:火元素/, `火元素点杀应优先:${b1.text}`);

  // 危险局：我 10 血，对面站着一只 12/12（没别的随从），手上有变形术(4费)
  const polySnap = snap(
    side({ health: 10, mana: 5, handCards: [{ id: 1, cardId: 'CS2_022', cost: 4 }] }),
    side({ isLocal: false, minions: [minion({ id: 20, name: '死翼', atk: 12, health: 12 })] }),
  );
  const srs = singleRemovals(polySnap);
  assert.equal(srs[0]?.kind, 'transform');
  assert.equal(srs[0]?.cutSafe, 12);
  const b2 = briefAdvice(polySnap);
  assert.match(b2.text, /变形.*死不了/, `变形掉 12/12 应当保命:${b2.text}`);
});

test('连击激活算进斩杀且不叠加；未激活时把启动牌挪在连击牌前面', () => {
  // 未激活连击：军情七处特工(3费 连击打3) 与 2费白板同时入选按费打，应先把启动牌放第一
  const uncomboSnap = snap(
    side({
      heroClass: '潜行者',
      mana: 6,
      comboActive: false,
      handCards: [
        { id: 1, cardId: 'EX1_134', cost: 3 }, // 军七
        { id: 2, cardId: 'EDR_226', cost: 2 }, // 奇异训犬师(2费)
      ],
    }),
    side({ isLocal: false, health: 25 }),
  );
  const b = briefAdvice(uncomboSnap);
  assert.match(b.text, /按费打:奇异训犬师.*军情七处特工/, `应先打非连击牌启动连击:${b.text}`);

  // 激活连击：刺骨(4伤, 原表2) + 军七(3伤) = 7 伤斩杀 7 血，绝不变成 2+4+3=9
  const comboLethal = snap(
    side({
      heroClass: '潜行者',
      mana: 5,
      comboActive: true,
      handCards: [
        { id: 1, cardId: 'EX1_124', cost: 2 },
        { id: 2, cardId: 'EX1_134', cost: 3 },
      ],
    }),
    side({ isLocal: false, health: 7 }),
  );
  const p = planLethal(comboLethal);
  assert.equal(p.spellDamage, 4);
  assert.equal(p.battlecryDamage, 3);
  assert.equal(p.total, 7);
});

test('灌注次数决定战吼条件 & 灌注法术不被当空法术降权', () => {
  // 明耀织梦者 EDR_860：战吼 伤害4 战吼需已灌注2次
  const noImbue = planLethal(snap(
    side({ imbueCount: 1, mana: 5, handCards: [{ id: 1, cardId: 'EDR_860', cost: 4 }] }),
    side({ isLocal: false, health: 4 }),
  ));
  assert.equal(noImbue.battlecryDamage, 0);

  const readyImbue = planLethal(snap(
    side({ imbueCount: 2, mana: 5, handCards: [{ id: 1, cardId: 'EDR_860', cost: 4 }] }),
    side({ isLocal: false, health: 4 }),
  ));
  assert.equal(readyImbue.battlecryDamage, 4);
  assert.equal(readyImbue.total, 4);

  // 最终定局 END_003 (3费法术 抽亡灵+灌注两次) 对面有怪时不被普通白板随从 AT_090 抢先
  const spellImbue = snap(
    side({
      mana: 3,
      handCards: [
        { id: 1, cardId: 'END_003', cost: 3 }, // 灌注法术
        { id: 2, cardId: 'AT_090', cost: 3 },  // 穆克拉的勇士（假设减到3费的普通怪）
      ],
    }),
    side({ isLocal: false, health: 30, minions: [minion({ id: 9, atk: 2, health: 3 })] }),
  );
  assert.match(briefAdvice(spellImbue).text, /最终定局/);
});

test('黑暗之赐（冲锋 / 双倍战吼）进入 handNote 与斩杀核算', () => {
  const s = snap(
    side({
      mana: 10,
      auras: [{ cardId: 'BE_146', name: '誓缚光环' }],
      handCards: [
        {
          id: 1, cardId: 'EDR_856', cost: 4, // 梦魇之王萨维斯 4/4 带冲锋黑暗之赐
          darkGift: { cardId: 'EDR_100t6', name: '梦境行者', note: '冲锋' },
        },
        {
          id: 2, cardId: 'CS2_042', cost: 6, // 火元素 战吼打4 带双倍战吼黑暗之赐 = 8点
          darkGift: { cardId: 'EDR_100t7', name: '粗暴唤醒', note: '本随从的战吼会触发两次' },
        },
      ],
    }),
    side({ isLocal: false, health: 12 }),
  );
  const a = advise(s);
  assert.ok(a.hand.some((c) => /〔黑暗之赐:.*冲锋〕/.test(c.note)));
  assert.ok(a.hand.some((c) => /〔黑暗之赐:.*双倍战吼〕/.test(c.note)));
  assert.equal(a.lethal.chargeDamage, 4);
  assert.equal(a.lethal.battlecryDamage, 8);
  assert.equal(a.lethal.total, 12);
  assert.equal(briefAdvice(s).kind, 'lethal');
});

test('磁力加攻贴场上可攻击机械计入斩杀', () => {
  const s = snap(
    side({
      mana: 6,
      minions: [minion({ id: 1, name: '吵吵机器人', atk: 1, health: 2, race: 'MECHANICAL', canAttack: true })],
      handCards: [
        { id: 2, cardId: 'BOT_906', cost: 1 }, // 格洛顿 1/3 磁力
        { id: 3, cardId: 'BOT_548', cost: 5 }, // 奇利亚斯 3/2 磁力
      ],
    }),
    side({ isLocal: false, health: 5 }),
  );
  const p = planLethal(s);
  assert.equal(p.faceAtk, 1);
  assert.equal(p.buffDamage, 4); // 1 + 3
  assert.equal(p.total, 5);
});

test('记牌器反哺宇宙前提（雷诺/LOE_011）并进入建议与模型提示词', () => {
  const s = snap(
    side({
      mana: 6,
      handCards: [{ id: 1, cardId: 'LOE_011', cost: 6 }],
    }),
    side({ isLocal: false, health: 20 }),
  );
  const arenaFull = [
    'CS2_029', 'CS2_032', 'CS2_093', 'CORE_EX1_619', 'EX1_124',
    'EX1_134', 'CS2_073', 'CS2_022', 'CS2_076', 'EX1_116',
    'BOT_906', 'BOT_548', 'TIME_019', 'EDR_226', 'END_003',
  ];
  const trackerWithNoDup = buildTrackerSnapshot({
    turn: 6,
    localPlayerId: 1,
    meta: { gameType: 'GT_UNDERGROUND_ARENA', formatType: 'FT_WILD', scenarioId: 2 },
    me: { heroClass: '法师', deckCount: 15, drawnFromDeck: [], playedCards: [], graveyardCards: [], knownInDeck: [], handCards: [] },
    opponent: { heroClass: '战士', deckCount: 18, playedCards: [], graveyardMinions: [], graveyardSpells: [], secrets: [], revealedSecrets: [], handCards: [] },
  }, { arenaDeck: arenaFull });
  assert.equal(trackerWithNoDup.me.hasDuplicates, false);

  const a = advise(s, { tracker: trackerWithNoDup, matchupHint: '对手推测：疑似【奥丁战】' });
  assert.ok(a.candidates.some((c) => /宇宙前提就绪/.test(c)));
  assert.ok(a.candidates.some((c) => /奥丁战/.test(c)));
  const prompt = buildModelPrompt(s, { tracker: trackerWithNoDup, matchupHint: '对手推测：疑似【奥丁战】' });
  assert.match(prompt, /宇宙可用/);
  assert.match(prompt, /奥丁战/);
});

test('P0-① 清场自伤提示与自杀拦截：地狱烈焰明示伤己英雄3血，3血不推自杀，不烧光己方大场面', () => {
  // 场景 A：审查报告构造局 —— 我 5 血、对面两只 5/2、手握地狱烈焰
  const s5 = snap(
    side({ health: 5, mana: 4, handCards: [{ id: 1, cardId: 'CS2_062', cost: 3 }] }),
    side({
      isLocal: false,
      minions: [
        minion({ id: 11, name: '敌A', atk: 5, health: 2 }),
        minion({ id: 12, name: '敌B', atk: 5, health: 2 }),
      ],
    }),
  );
  const opts = aoeOptions(s5);
  assert.equal(opts[0]?.selfHeroDamage, 3);
  assert.match(opts[0]?.text ?? '', /伤己英雄3血/);
  const b5 = briefAdvice(s5);
  assert.match(b5.text, /自伤 3 血\(我 5→2\)/, `必须提示自伤后血量变化:${b5.text}`);

  // 场景 B：我 3 血，地狱烈焰会把自己烧死 —— 绝不推地狱烈焰「死不了」
  const s3 = snap(
    side({ health: 3, mana: 4, handCards: [{ id: 1, cardId: 'CS2_062', cost: 3 }] }),
    side({
      isLocal: false,
      minions: [
        minion({ id: 11, name: '敌A', atk: 5, health: 2 }),
        minion({ id: 12, name: '敌B', atk: 5, health: 2 }),
      ],
    }),
  );
  const opts3 = aoeOptions(s3);
  assert.match(opts3[0]?.text ?? '', /会烧死自己/);
  const b3 = briefAdvice(s3);
  assert.doesNotMatch(b3.text, /用 地狱烈焰 清场/, `3血放地狱烈焰直接自杀，不能推荐:${b3.text}`);
  assert.doesNotMatch(b3.text, /死不了/);

  // 场景 C：非濒死 18 血，但我自己场上站着两只 6/2 随从（12 场攻 > 对面 6 场攻），不抢推地狱烈焰全烧光
  const sOwn = snap(
    side({
      health: 18, mana: 4,
      minions: [
        minion({ id: 1, name: '己A', atk: 6, health: 2 }),
        minion({ id: 2, name: '己B', atk: 6, health: 2 }),
      ],
      handCards: [{ id: 3, cardId: 'CS2_062', cost: 3 }],
    }),
    side({
      isLocal: false,
      minions: [
        minion({ id: 11, name: '敌A', atk: 3, health: 2 }),
        minion({ id: 12, name: '敌B', atk: 3, health: 2 }),
      ],
    }),
  );
  const optsOwn = aoeOptions(sOwn);
  assert.equal(optsOwn[0]?.ownLostAtk, 12);
  assert.match(optsOwn[0]?.text ?? '', /会连带烧死我方/);
  assert.doesNotMatch(briefAdvice(sOwn).text, /^清场:地狱烈焰/);
});

test('P0-② openersInHand 识别卡表「抽1/抽2」简写（不含「牌」字）', () => {
  // 14 血 vs 对面 5 场攻（余量 9 <= 10，进入「先换」），手上有 AV_266 冷风（摘要「抽1 冻结」）
  const s = snap(
    side({
      heroClass: '萨满',
      health: 14,
      mana: 4,
      minions: [minion({ id: 1, name: '己怪', atk: 4, health: 5 })],
      handCards: [{ id: 2, cardId: 'AV_266', cost: 1 }],
    }),
    side({
      isLocal: false,
      minions: [
        minion({ id: 11, name: '敌墙', atk: 3, health: 4, taunt: true }),
        minion({ id: 12, name: '旁观', atk: 2, health: 5 }),
      ],
    }),
  );
  const b = briefAdvice(s);
  assert.equal(b.kind, 'trade');
  assert.match(b.text, /冷风/, `先换末尾应把「抽1」过牌钥匙点出来:${b.text}`);
});

test('P1-③ HeroPowerView.note 填充灌注效果描述，且非灌注局不误报', async () => {
  const { PowerLogParser } = await import('../src/parser.ts');
  const p = new PowerLogParser(() => '2026-11-22T18:00:00Z');
  const baseLines = [
    'D 18:00:00.0000000 GameState.DebugPrintPower() - CREATE_GAME',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - GameEntity EntityID=1',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=1]',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - Player EntityID=3 PlayerID=2 GameAccountId=[hi=2 lo=2]',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=68 CardID=HERO_04',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=1',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=HERO',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CLASS value=PALADIN',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=HEALTH value=30',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=2 tag=HERO_ENTITY value=68',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=69 CardID=CS2_101',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=1',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=HERO_POWER',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=ZONE value=PLAY',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=COST value=2',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=70 CardID=HERO_08',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=2',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=HERO',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CLASS value=MAGE',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=HEALTH value=30',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=3 tag=HERO_ENTITY value=70',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=1 tag=TURN value=1',
  ];
  p.feed(baseLines);
  p.setLocalPlayerId(1);
  // 未灌注：即便英雄技能有 note 也不该误报「已灌注 0 次」
  const snap0 = p.snapshot();
  assert.ok(snap0);
  assert.equal(typeof snap0.me.heroPower?.note, 'string');
  assert.ok(!advise(snap0).candidates.some((c) => /已灌注 0 次/.test(c)), '未灌注局绝不能报已灌注 0 次');

  // 替换为骑士灌注英雄技能 EDR_445p (2阶)
  p.feed([
    'D 18:01:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=100 CardID=EDR_445p',
    'D 18:01:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=1',
    'D 18:01:00.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=HERO_POWER',
    'D 18:01:00.0000000 GameState.DebugPrintPower() -     tag=ZONE value=PLAY',
    'D 18:01:00.0000000 GameState.DebugPrintPower() -     tag=COST value=1',
    'D 18:01:00.0000000 GameState.DebugPrintPower() -     tag=TAG_SCRIPT_DATA_NUM_1 value=2',
  ]);
  const snapImbue = p.snapshot();
  assert.ok(snapImbue?.me.heroPower?.note && /2费翡翠传送门/.test(snapImbue.me.heroPower.note));
  assert.equal(snapImbue?.me.heroPower?.name, '巨龙的祝福');
  const aImbue = advise(snapImbue);
  assert.ok(aImbue.candidates.some((c) => /已灌注 2 次.*巨龙的祝福.*2费翡翠传送门/.test(c)));
});

test('P2-⑧ aoeCombos 共用变形牌判据识别「生而平等+奉献」，且过滤自杀「生而平等+地狱烈焰」', () => {
  const sSafe = snap(
    side({
      heroClass: '圣骑士',
      health: 20,
      mana: 6,
      handCards: [
        { id: 1, cardId: 'CORE_EX1_619', cost: 2 }, // 生而平等
        { id: 2, cardId: 'CS2_093', cost: 3 },      // 奉献
      ],
    }),
    side({
      isLocal: false,
      minions: [
        minion({ id: 11, name: '高墙A', atk: 6, health: 12, taunt: true }),
        minion({ id: 12, name: '高墙B', atk: 5, health: 9 }),
      ],
    }),
  );
  const safeCombos = aoeCombos(sSafe);
  assert.ok(safeCombos.some((c) => /生而平等 \+ 奉献/.test(c.text) && c.cut === 11 && c.clearsTaunt));

  // 我方只有 3 血：生而平等+地狱烈焰会把自己烧死，绝不进 combos
  const sSuicide = snap(
    side({
      health: 3,
      mana: 5,
      handCards: [
        { id: 1, cardId: 'CORE_EX1_619', cost: 2 },
        { id: 2, cardId: 'CS2_062', cost: 3 }, // 地狱烈焰
      ],
    }),
    side({
      isLocal: false,
      minions: [minion({ id: 11, name: '高墙A', atk: 6, health: 12, taunt: true })],
    }),
  );
  const suicideCombos = aoeCombos(sSuicide);
  assert.equal(suicideCombos.length, 0, '3血放地狱烈焰自杀，aoeCombos 必须过滤掉');
});

test('空格修复的大地亡魂(BAR_750)可入 aoeOptions，且血帆袭击者+审判摘要含完整正文', () => {
  const s = snap(
    side({
      heroClass: '萨满',
      mana: 4,
      handCards: [
        { id: 1, cardId: 'BAR_750', cost: 4 },       // 大地亡魂：战吼 伤害1群随从
        { id: 2, cardId: 'CORE_NEW1_018', cost: 2 }, // 血帆袭击者
        { id: 3, cardId: 'JAIL_326', cost: 1 },      // 审判
      ],
    }),
    side({
      isLocal: false,
      minions: [minion({ id: 11, name: '小兵', atk: 2, health: 1 })],
    }),
  );
  const aoes = aoeOptions(s);
  assert.ok(aoes.some((x) => x.name === '大地亡魂' && x.damage === 1), '大地亡魂应被识别为 1 伤战吼群伤');
  const a = advise(s);
  const raider = a.hand.find((c) => c.cardId === 'CORE_NEW1_018');
  const judge = a.hand.find((c) => c.cardId === 'JAIL_326');
  assert.match(raider?.note ?? '', /武器攻击力/);
  assert.match(judge?.note ?? '', /属性值变为与该随从相同/);
});
