/**
 * 「这回合打什么」的事实层。
 *
 * 这些测试盯的是**会说错的数**,不是排版:
 *   · 交换按同时结算 → 3/4 打 3/3 应该剩 1 血,不是「毫发无伤」
 *   · 圣盾 → 我方的盾吃掉反击;敌方的盾要消耗一次命中
 *   · 手牌费用用日志里的实际值(被减费过),不是牌面基础值
 *   · 对面场攻 ≥ 我的有效血 → 必须报警
 *
 * 这些数错一次,她给的推荐就是错的 —— 而她顶着「我在替你看着」的位置说错话,
 * 比不说话糟得多。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { advise, aoeOptions, briefAdvice, buildModelPrompt, combinedTrades, heroPowerHit, notableThreats, parseKeepCards, playDamage, readHand, renderAdvice, threatInfo, tradeOptions } from '../src/advice.ts';
import { turnText } from '../src/alerts.ts';
import { cardClassZh, cardEffects, cardNote } from '../src/effects.ts';
import { renderSnapshot } from '../src/parser.ts';

/** 威胁评估那段话,只有 briefAdvice 会把它拼出来 —— 借它取文案。 */
const threatTextOf = (snap) => briefAdvice(snap).text;

const minion = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 0, health: 1, maxHealth: 1,
  taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false, canAttack: true, ...o,
});

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 20, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 0, handCards: [], coinCount: 0, deckCount: 20, secrets: 0,
  minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe) => ({
  startedAt: '', turn: 8, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 },
});

test('手牌读成卡名,并按水晶标出打不打得出', () => {
  const hand = readHand(side({
    mana: 3,
    handCards: [
      { id: 1, cardId: 'CS2_029', cost: 4 },   // 火球术
      { id: 2, cardId: 'CS2_024', cost: 2 },   // 寒冰箭
    ],
  }));
  const fireball = hand.find((c) => c.cardId === 'CS2_029');
  const frostbolt = hand.find((c) => c.cardId === 'CS2_024');
  assert.equal(fireball.name, '火球术');
  assert.equal(fireball.type, '法术');
  assert.equal(fireball.playable, false, '4 费法术在 3 水晶下打不出');
  assert.equal(frostbolt.playable, true);
  // 打得出的排前面
  assert.equal(hand[0].cardId, 'CS2_024');
});

test('卡表里没有的牌老实返回 null 卡名,不编一个', () => {
  const hand = readHand(side({ mana: 10, handCards: [{ id: 1, cardId: 'ZZZ_FAKE_999', cost: 1 }] }));
  assert.equal(hand[0].name, null);
  assert.equal(hand[0].type, '未知');
});

test('减费牌按日志里的实际费用算,不是牌面基础费用', () => {
  const [card] = readHand(side({ mana: 3, handCards: [{ id: 1, cardId: 'CS2_029', cost: 3 }] }));
  assert.equal(card.cost, 3);
  assert.equal(card.baseCost, 4);
  assert.equal(card.playable, true, '减成 3 费后 3 水晶打得出');
});

test('交换是同时结算:3/4 打 3/3 换掉它但自己也掉 3 血', () => {
  const t = tradeOptions(snap(
    side({ minions: [minion({ id: 11, atk: 3, health: 4 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, atk: 3, health: 3 })] }),
  ))[0];
  assert.equal(t.kills, true);
  assert.equal(t.survives, true);
  assert.equal(t.myLoss, 3, '对方即使被打死也会把攻击力打出来');
  assert.match(t.text, /剩 1 血/);
});

test('打不死还被反杀的情况要标成负分,不能推荐', () => {
  const t = tradeOptions(snap(
    side({ minions: [minion({ id: 11, atk: 2, health: 2 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, atk: 5, health: 5 })] }),
  ))[0];
  assert.equal(t.kills, false);
  assert.equal(t.survives, false);
  assert.ok(t.score < 0);
  assert.match(t.text, /别这么换/);
});

test('我方随从带圣盾时不吃反击', () => {
  const t = tradeOptions(snap(
    side({ minions: [minion({ id: 11, atk: 3, health: 2, divineShield: true })] }),
    side({ isLocal: false, minions: [minion({ id: 21, atk: 5, health: 3 })] }),
  ))[0];
  assert.equal(t.kills, true);
  assert.equal(t.myLoss, 0);
  assert.equal(t.survives, true);
});

test('对面随从带圣盾:一次命中只破盾,杀不掉', () => {
  const t = tradeOptions(snap(
    side({ minions: [minion({ id: 11, atk: 9, health: 9 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, atk: 1, health: 2, divineShield: true })] }),
  ))[0];
  assert.equal(t.kills, false, '9 点伤害只破盾,血没掉');
  assert.match(t.text, /只破盾/);
});

test('对面场攻够高时报警:下回合就被斩杀', () => {
  const threat = threatInfo(snap(
    side({ health: 8, armor: 0 }),
    side({ isLocal: false, minions: [minion({ id: 21, atk: 5, health: 5 }), minion({ id: 22, atk: 4, health: 4 })] }),
  ));
  assert.equal(threat.enemyAttack, 9);
  assert.equal(threat.myEffectiveHp, 8);
  assert.equal(threat.lethalNextTurn, true);
});

test('护甲算进有效血量,能挡掉「被斩杀」的误报', () => {
  const threat = threatInfo(snap(
    side({ health: 5, armor: 6 }),
    side({ isLocal: false, minions: [minion({ id: 21, atk: 9, health: 9 })] }),
  ));
  assert.equal(threat.lethalNextTurn, false, '5 血 + 6 护甲 = 11,9 点打不死');
});

test('群体伤害只报它能真正清掉的那些随从', () => {
  const aoe = aoeOptions(snap(
    side({ mana: 7, handCards: [{ id: 1, cardId: 'CS2_032', cost: 7 }] }),   // 烈焰风暴 5 伤
    side({ isLocal: false, minions: [
      minion({ id: 21, name: '小怪', atk: 2, health: 3 }),
      minion({ id: 22, name: '大怪', atk: 6, health: 8 }),
      minion({ id: 23, name: '盾怪', atk: 1, health: 2, divineShield: true }),
    ] }),
  ));
  assert.equal(aoe.length, 1);
  assert.deepEqual(aoe[0].clears.map((m) => m.id), [21], '8 血的和带盾的都不该算进去');
});

test('能斩杀时,候选里第一条就是斩杀', () => {
  const a = advise(snap(
    side({ mana: 4, handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }], minions: [minion({ id: 11, atk: 3, health: 5 })] }),
    side({ isLocal: false, health: 8, minions: [] }),
  ));
  assert.ok(a.candidates[0].startsWith('可以斩杀'), a.candidates[0]);
  assert.match(a.candidates[0], /火球术/);
});

test('会被斩杀时,候选里点明危险并给出能削掉多少场攻', () => {
  const a = advise(snap(
    side({ health: 6, minions: [minion({ id: 11, atk: 4, health: 4 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, atk: 7, health: 3 })] }),
  ));
  const danger = a.candidates.find((c) => c.startsWith('危险'));
  assert.ok(danger, '应当有一条危险提示');
  assert.match(danger, /7/);
});

test('渲染出来的建议里,手牌/斩杀/交换/候选四块都在', () => {
  const s = snap(
    side({ mana: 5, handCount: 1, handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }], minions: [minion({ id: 11, atk: 4, health: 4 })] }),
    side({ isLocal: false, health: 12, minions: [minion({ id: 21, atk: 3, health: 2 })] }),
  );
  const text = renderAdvice(advise(s), s);
  for (const section of ['【手牌】', '【斩杀线】', '【能做的交换】', '【机械排出的候选】']) {
    assert.ok(text.includes(section), `缺少 ${section}`);
  }
  assert.match(text, /火球术/);
  assert.match(text, /机械排序|不是最优解/);
});

test('单随从换不掉,但两只合力能解 —— 也要算出来', () => {
  // 真实对局里出现过:3/3圣盾 + 2/3 对上 4/5,一对一都不够
  const combined = combinedTrades(snap(
    side({ minions: [
      minion({ id: 11, name: '坦克机械师', atk: 3, health: 3, divineShield: true }),
      minion({ id: 12, name: '新兵', atk: 2, health: 3 }),
    ] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '大怪', atk: 4, health: 5 })] }),
  ));
  assert.equal(combined.length, 1);
  assert.equal(combined[0].kills, true);
  assert.equal(combined[0].used, 2);
  assert.equal(combined[0].lost, 1, '先手那只靠圣盾活着,补刀那只被反杀');
  assert.match(combined[0].text, /解掉 大怪\(4\/5\)/);
});

test('合力也不够时不给假结论', () => {
  const combined = combinedTrades(snap(
    side({ minions: [minion({ id: 11, atk: 2, health: 2 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, atk: 1, health: 9 })] }),
  ));
  assert.deepEqual(combined, []);
});

test('威胁拆得开:随从多少、武器/英雄多少', () => {
  const t = threatInfo(snap(
    side({ health: 20 }),
    side({ isLocal: false, heroAttack: 3, minions: [minion({ id: 21, atk: 4, health: 4 })] }),
  ));
  assert.equal(t.enemyAttack, 7);
  assert.equal(t.minionAttack, 4);
  assert.equal(t.heroAttack, 3);
});

test('刚下的随从这回合不能攻击,但下回合的威胁要算进去', () => {
  // 真实踩过:对面 4 个刚铺下来的随从 canAttack=false,威胁算成 0,报出「对面空场」
  const threat = threatInfo(snap(
    side({ health: 20 }),
    side({ isLocal: false, minions: [
      minion({ id: 21, atk: 3, health: 5, taunt: true, canAttack: false }),
      minion({ id: 22, atk: 3, health: 5, taunt: true, canAttack: false }),
      minion({ id: 23, atk: 3, health: 2, canAttack: false }),
      minion({ id: 24, atk: 3, health: 2, canAttack: false }),
    ] }),
  ));
  assert.equal(threat.enemyAttack, 12, '召唤失调不影响下回合的攻击力');
});

test('被冻结的随从下回合仍然打不出来,不算进威胁', () => {
  const threat = threatInfo(snap(
    side({ health: 20 }),
    side({ isLocal: false, minions: [
      minion({ id: 21, atk: 5, health: 5, frozen: true }),
      minion({ id: 22, atk: 4, health: 4 }),
    ] }),
  ));
  assert.equal(threat.enemyAttack, 4);
});

test('场上有随从时说「空场」是不允许的', () => {
  const a = advise(snap(
    side({ health: 20 }),
    side({ isLocal: false, minions: [
      minion({ id: 21, atk: 0, health: 4, canAttack: false }),
    ] }),
  ));
  const line = a.candidates.find((c) => c.includes('空场'));
  assert.equal(line, undefined, '有随从就不能说空场');
});

/* ---------- 回合事件里那句自动建议 ---------- */

test('能斩杀时,自动建议只说斩杀,不扯别的', () => {
  const b = briefAdvice(snap(
    side({ mana: 4, handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }], minions: [minion({ id: 11, atk: 3, health: 5 })] }),
    side({ isLocal: false, health: 8, minions: [] }),
  ));
  assert.equal(b.kind, 'lethal');
  assert.match(b.text, /能斩杀/);
  assert.match(b.text, /火球术/);
});

test('会被打死时,建议先解场并算清能削多少', () => {
  const b = briefAdvice(snap(
    side({ health: 6, minions: [minion({ id: 11, name: '大怪', atk: 5, health: 6 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '威胁', atk: 7, health: 5 })] }),
  ));
  assert.equal(b.kind, 'danger');
  assert.match(b.text, /危险/);
  assert.match(b.text, /能削 7 点/);
  assert.match(b.text, /死不了/);
});

test('血不够时先换,并报换完剩多少场攻', () => {
  // 12 血对 3 点场攻(余量 9)—— 不到「马上要死」,但也不该放着不管
  const b = briefAdvice(snap(
    side({ health: 12, minions: [minion({ id: 11, name: '6/7', atk: 6, health: 7 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '3/3', atk: 3, health: 3 })] }),
  ));
  assert.equal(b.kind, 'trade');
  assert.match(b.text, /先换/);
  assert.match(b.text, /场攻剩 0/);
});

test('血还厚的时候不要抢着换 —— 送掉随从就是让出场面', () => {
  // 20 血对 3 点场攻(余量 17)。原来这里会给「先换」,把 6/7 送掉换一个 3/3。
  const noHand = briefAdvice(snap(
    side({ health: 20, minions: [minion({ id: 11, name: '6/7', atk: 6, health: 7 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '3/3', atk: 3, health: 3 })] }),
  ));
  assert.notEqual(noHand.kind, 'trade', `余量 17 还去送随从:${noHand.text}`);

  // 有牌可打时应该去铺场
  const withHand = briefAdvice(snap(
    side({ health: 20, mana: 4, manaMax: 4, handCards: [{ id: 1, cardId: 'WW_391', cost: 2 }],
      minions: [minion({ id: 11, name: '6/7', atk: 6, health: 7 })] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '3/3', atk: 3, health: 3 })] }),
  ));
  assert.equal(withHand.kind, 'develop');
  assert.match(withHand.text, /按费打/);
});

test('对面没什么威胁且有牌可打时,给按费出牌的建议', () => {
  const b = briefAdvice(snap(
    side({ mana: 6, handCards: [
      { id: 1, cardId: 'CS2_186', cost: 6 },        // 作战傀儡 7/7
    ], minions: [] }),
    side({ isLocal: false, health: 30, minions: [] }),
  ));
  assert.equal(b.kind, 'develop');
  assert.match(b.text, /按费打/);
  assert.match(b.text, /作战傀儡/);
});

test('自动建议够短,能直接说出口', () => {
  const cases = [
    snap(side({ mana: 4, handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }], minions: [minion({ id: 11, atk: 3, health: 5 })] }), side({ isLocal: false, health: 8 })),
    snap(side({ health: 6, minions: [minion({ id: 11, atk: 5, health: 6 })] }), side({ isLocal: false, minions: [minion({ id: 21, atk: 7, health: 5 })] })),
    snap(side({ mana: 6, handCards: [{ id: 1, cardId: 'CS2_186', cost: 6 }] }), side({ isLocal: false, minions: [] })),
  ];
  for (const s of cases) {
    const b = briefAdvice(s);
    assert.ok(b.text.length <= 120, `建议太长(${b.text.length} 字):${b.text}`);
  }
});

test('剧毒随从能秒杀大随从,不看血量', () => {
  const t = tradeOptions(snap(
    side({ minions: [{ ...minion({ id: 11, name: '毒蜘蛛', atk: 1, health: 2 }), poisonous: true }] }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '大怪', atk: 2, health: 9 })] }),
  ))[0];
  assert.equal(t.kills, true, '1 攻剧毒也该杀掉 9 血随从');
  assert.match(t.text, /剧毒/);
});

test('被剧毒随从咬到,不管我多少血都会死', () => {
  const t = tradeOptions(snap(
    side({ minions: [minion({ id: 11, name: '巨怪', atk: 9, health: 9 })] }),
    side({ isLocal: false, minions: [{ ...minion({ id: 21, name: '毒虫', atk: 1, health: 2 }), poisonous: true }] }),
  ))[0];
  assert.equal(t.survives, false, '9 血随从被 1 攻剧毒咬一口也是死');
  assert.equal(t.myLoss, 9);
});

/* ---------- 真实对局逼出来的四条 ---------- */

test('差几点就死也算危险,不许说「不足为惧」', () => {
  // 真实一局:第 20 回合我 17 血、对面场攻 14,上一版建议写的是
  // 「对面场攻 14 不足为惧,按费打:...」—— 差 3 点还说不足为惧
  const s = snap(
    side({ health: 17, mana: 10, manaMax: 10, handCards: [{ id: 1, cardId: 'CS2_186', cost: 6 }] }),
    side({ isLocal: false, health: 11, minions: [minion({ id: 21, atk: 7, health: 2 }), minion({ id: 22, atk: 7, health: 7 })] }),
  );
  const t = threatInfo(s);
  assert.equal(t.enemyAttack, 14);
  assert.equal(t.lethalNextTurn, false, '14 < 17,严格算还没到斩杀线');
  assert.equal(t.closeCall, true, '差 3 点必须算贴线');

  const b = briefAdvice(s);
  assert.equal(b.kind, 'danger');
  assert.equal(b.text.includes('不足为惧'), false, `说了「不足为惧」:${b.text}`);
  assert.match(b.text, /只差 3 点/);
});

test('余量够大时才说「压不到我」', () => {
  const b = briefAdvice(snap(
    side({ health: 30, mana: 5, handCards: [{ id: 1, cardId: 'CS2_186', cost: 6 }, { id: 2, cardId: 'CS2_120', cost: 4 }] }),
    side({ isLocal: false, health: 30, minions: [minion({ id: 21, atk: 4, health: 2 })] }),
  ));
  assert.equal(b.kind, 'develop');
  assert.match(b.text, /压不到我/);
});

test('解不掉时必须给出能做的事,不能只报噩耗', () => {
  // 真实第 20 回合:空场、手上最大 3/3、对面 7/7+7/2。
  // 上一版只写「能削 0 点,还差 14」就结束了 —— 等于让他认输。
  const s = snap(
    side({ health: 17, mana: 10, manaMax: 10, minions: [], handCards: [
      { id: 1, cardId: 'TIME_017', cost: 4 },   // 坦克机械师 2/1 圣盾 亡语 召唤
      { id: 2, cardId: 'TTN_907', cost: 4 },    // 星界翔龙 3/3
    ] }),
    side({ isLocal: false, health: 11, minions: [minion({ id: 21, atk: 7, health: 2 }), minion({ id: 22, atk: 7, health: 7 })] }),
  );
  const b = briefAdvice(s);
  assert.equal(b.kind, 'danger');
  // 「能削 0 点」这种话现在被省掉了(削得太少不值得报),重点是**必须给出可做的事**
  //
  // 2026-10-24 改判:坦克机械师是「2/1 圣盾 亡语 召唤」——**没有嘲讽**,
  // 它挡不住任何攻击。旧断言要求点出它「能挡」,那是在替一个错误背书。
  // 现在该说的是「手上没有嘲讽牌」并且指出还能干什么(抢脸 / 削攻击者)。
  assert.match(b.text, /没有嘲讽牌/, `没点明没墙:${b.text}`);
  assert.match(b.text, /抢脸|削/, `没给任何可做的事:${b.text}`);
  assert.doesNotMatch(b.text, /能挡|吃掉/, `还在许诺挡一刀:${b.text}`);
});

test('0 费牌不占「按费打」的推荐位', () => {
  // 真实第 2 回合:1 水晶、手上 6 张,上一版建议是
  // 「按费打:MUDAN_COIN1(0费)」—— 让他打硬币,白扔一张凑费牌
  const b = briefAdvice(snap(
    side({ mana: 1, manaMax: 1, handCards: [
      { id: 1, cardId: 'MUDAN_COIN1', cost: 0 },
      { id: 2, cardId: 'CS2_029', cost: 4 },
    ] }),
    side({ isLocal: false, health: 30 }),
  ));
  assert.equal(b.kind, 'develop');
  assert.equal(/按费打.*MUDAN_COIN1/.test(b.text), false, `把硬币当正餐推荐了:${b.text}`);
  assert.match(b.text, /先手牌|留着/, '该说明它是留给关键回合的');
});


test('群体伤害牌带吸血时,回血要算进「活不活得下来」', () => {
  // 真实第 16 回合:我 9 血、对面场攻 8。起源大厅是 8 伤群体 + 吸血,
  // 清场 + 回血之后是稳活的一手 —— 旧建议只说「能削 8 点」,像在报菜名。
  const s = snap(
    side({ health: 9, mana: 8, manaMax: 8, minions: [], handCards: [{ id: 1, cardId: 'BE_183', cost: 8 }] }),
    side({ isLocal: false, health: 15, minions: [
      minion({ id: 21, atk: 7, health: 4 }),
      minion({ id: 22, atk: 1, health: 1 }),
    ] }),
  );
  const aoes = aoeOptions(s);
  assert.equal(aoes.length, 1, '起源大厅该被认出来');
  assert.ok(aoes[0].heal > 0, `吸血牌要算出回血,实际 ${aoes[0].heal}`);
  assert.match(aoes[0].text, /吸血回/, aoes[0].text);

  const b = briefAdvice(s);
  assert.equal(b.kind, 'danger');
  assert.match(b.text, /回 \d+ 血/, `没提回血:${b.text}`);
  assert.match(b.text, /死不了/, `清场+回血后是活的:${b.text}`);
});

test('只打随从的群体牌要标明,别让人以为能糊脸', () => {
  const s = snap(
    side({ mana: 5, manaMax: 5, handCards: [{ id: 1, cardId: 'CS2_032', cost: 5 }] }),
    side({ isLocal: false, health: 30, minions: [minion({ id: 21, atk: 2, health: 3 })] }),
  );
  const aoe = aoeOptions(s)[0];
  assert.equal(aoe.minionsOnly, true);
  assert.match(aoe.text, /只打随从/);
});

test('条件战吼不满足时,建议里说清前提而不是当伤害报', () => {
  // 真实场景:第 3 回合手上雾帆劫掠者(2 费 2/2,战吼需装备武器),他没有武器
  const s = snap(
    side({ mana: 2, manaMax: 2, weapon: null, handCards: [{ id: 1, cardId: 'CS3_022', cost: 2 }] }),
    side({ isLocal: false, health: 30 }),
  );
  const a = advise(s);
  const line = a.candidates.find((c) => /雾帆劫掠者/.test(c) && /战吼/.test(c));
  assert.ok(line, `候选里该提到这张牌的战吼前提,实际:${a.candidates.join(' | ')}`);
  assert.match(line, /装备武器/, '要写出前提是什么');
  assert.match(line, /不满足|只是个随从/, `要说清现在打不出:${line}`);
  assert.equal(/战吼能打 2 点/.test(a.candidates.join(' ')), false, '不能当成确定伤害');
});

test('装上武器之后,同一张牌就能报出 2 点伤害', () => {
  const s = snap(
    side({ mana: 2, manaMax: 2, weapon: { cardId: '', name: '小刀', atk: 1, durability: 2 }, handCards: [{ id: 1, cardId: 'CS3_022', cost: 2 }] }),
    side({ isLocal: false, health: 30 }),
  );
  const a = advise(s);
  const line = a.candidates.find((c) => /战吼能打 2 点/.test(c));
  assert.ok(line, `有武器时该报能打 2 点,实际:${a.candidates.join(' | ')}`);
});

/* ---------- 硬币也是钱 ---------- */

test('5 水晶 + 1 个硬币,6 费随从打得出来', () => {
  // 真实场景:第 9 回合,5/5 水晶,手上一个硬币和一张 6 费滑行者巨怪。
  // 上一版只按 mana 算,报「差 1 费就能打」—— 其实打硬币就上得去。
  //
  // 用的是**真牌**(BE_204 6 费 6/7 嘲讽),不是拿一张 token 假装 6 费:
  // 2026-11-06 补衍生 token 之后,原来那张 WW_001t16(活体石头,卡表里 2 费)
  // 有了摘要,于是它的 rank 从「普通牌」变成了「墙」,这条测试跟着红了 ——
  // 道具不真实,红的就不是被测的那件事。
  const s = snap(
    side({
      mana: 5, manaMax: 5, coinCount: 1,
      handCards: [
        { id: 1, cardId: 'BE_204', cost: 6 },
        { id: 2, cardId: 'MUDAN_COIN1', cost: 0 },
      ],
    }),
    side({ isLocal: false, health: 30 }),
  );
  const a = advise(s);
  const six = a.hand.find((h) => h.cost === 6);
  assert.ok(six, '6 费牌该在手牌里');
  assert.equal(six.playable, true, '有硬币就该算打得出');
  assert.equal(six.needsCoin, true, '要标出「得花硬币」');

  const b = briefAdvice(s);
  assert.match(b.text, /要打硬币/, `建议该说明代价:${b.text}`);
  // 而且不许说「宁可空过」—— 6/7 站下去就是场面,不是白板
  assert.doesNotMatch(b.text, /宁可空过/, `手上只有一张随从时不该劝他空过:${b.text}`);
});

test('没硬币时,6 费牌就是打不出', () => {
  const s = snap(
    side({ mana: 5, manaMax: 5, coinCount: 0, handCards: [{ id: 1, cardId: 'WW_001t16', cost: 6 }] }),
    side({ isLocal: false, health: 30 }),
  );
  const six = advise(s).hand.find((h) => h.cost === 6);
  assert.equal(six.playable, false);
  assert.equal(six.needsCoin, false, '没硬币就不该标 needsCoin');
});

test('回合文本把「还能多花几点」写出来', () => {
  const s = snap(
    side({ mana: 5, manaMax: 5, coinCount: 1 }),
    side({ isLocal: false, health: 30 }),
  );
  assert.match(turnText(s), /5\/5 水晶\(\+1币\)/);
});

/* ---------- 0 攻不等于没威胁 ---------- */

test('对面 0 攻嘲讽墙要单独说出来', () => {
  // 真实第 3 回合:对面两个 0/3 嘲讽。上一版只说「对面打不到我,按费打:…」——
  // 那是真的,但他也打不进去,而建议里一个字没提这两道墙。
  const s = snap(
    side({ mana: 2, manaMax: 2, handCards: [{ id: 1, cardId: 'CS2_120', cost: 2 }] }),
    side({ isLocal: false, health: 30, minions: [
      minion({ id: 21, name: '墙A', atk: 0, health: 3, taunt: true }),
      minion({ id: 22, name: '墙B', atk: 0, health: 3, taunt: true }),
    ] }),
  );
  const t = threatInfo(s);
  assert.equal(t.enemyAttack, 0, '0 攻确实打不出伤害');
  assert.equal(t.tauntCount, 2);
  assert.equal(t.tauntHealth, 6);

  const b = briefAdvice(s);
  assert.match(b.text, /嘲讽/, `得提到墙:${b.text}`);
  assert.match(b.text, /6 血/, '要说清墙有多厚');
});

test('0 攻但有亡语的随从要点名', () => {
  // 真实第 5 回合:不稳定的原型机 0/1 复生 + 亡语给手牌 +1/+1。
  // 数值上 0 威胁,拖下去就是白送对面一手大牌。
  const s = snap(
    side({ mana: 3, manaMax: 3, handCards: [{ id: 1, cardId: 'CS2_120', cost: 2 }] }),
    side({ isLocal: false, health: 30, minions: [
      minion({ id: 21, name: '不稳定的原型机', cardId: 'BE_207', atk: 0, health: 1 }),
    ] }),
  );
  const notable = notableThreats(s);
  const target = notable.find((n) => n.minion.cardId === 'BE_207');
  assert.ok(target, `该被点名,实际:${JSON.stringify(notable.map((n) => n.minion.name))}`);
  assert.ok(target.reasons.some((r) => /亡语/.test(r)), `要说亡语:${target.reasons}`);
  assert.ok(target.reasons.some((r) => /复生/.test(r)), `要说复生:${target.reasons}`);
});

test('对面全 0 攻但带复生时,建议里会点出来', () => {
  const s = snap(
    side({ mana: 3, manaMax: 3, handCards: [{ id: 1, cardId: 'CS2_120', cost: 2 }] }),
    side({ isLocal: false, health: 30, minions: [
      minion({ id: 21, name: '不稳定的原型机', cardId: 'BE_207', atk: 0, health: 1 }),
    ] }),
  );
  const b = briefAdvice(s);
  assert.match(b.text, /原型机/, `该点名:${b.text}`);
  assert.match(b.text, /复生|亡语/, b.text);
});

test('纯身材随从不进「要留意」名单', () => {
  const s = snap(
    side({ mana: 3, manaMax: 3 }),
    side({ isLocal: false, minions: [minion({ id: 21, name: '白板', atk: 5, health: 5 })] }),
  );
  assert.deepEqual(notableThreats(s), [], '报多了就成了念牌面');
});

/* ---------- 2026-10-23 用户当场质疑的两手 ---------- */

test('英雄技能按职业算:只算当回合就能打到脸的', () => {
  assert.equal(heroPowerHit('死亡骑士'), 1, '食尸鬼冲锋:1/1 带冲锋');
  assert.equal(heroPowerHit('猎人'), 2, '稳固射击:对英雄 2 点');
  assert.equal(heroPowerHit('法师'), 1, '火焰冲击');
  assert.equal(heroPowerHit('潜行者'), 1, '匕首精通:当回合可攻击');
  assert.equal(heroPowerHit('德鲁伊'), 1, '变形:本回合 +1 攻击');
  assert.equal(heroPowerHit('恶魔猎手'), 1, '恶魔之咬:+1 攻击');
  assert.equal(heroPowerHit('圣骑士'), 0, '1/1 白银之手新兵没有冲锋,这回合打不出来');
  assert.equal(heroPowerHit('战士'), 0, '只加护甲');
  assert.equal(heroPowerHit('牧师'), 0, '只治疗');
  assert.equal(heroPowerHit(''), 0, '职业还没读出来就不猜');
  assert.equal(heroPowerHit('Death Knight'), 1, '英文职业名也认');
});

test('对面十费时,威胁里必须算上英雄技能', () => {
  // 用户原话:「对方十费的时候斩杀没算对面的英雄技能」
  const dk = threatInfo(snap(
    side({ health: 22 }),
    side({ isLocal: false, heroClass: '死亡骑士', manaMax: 10, minions: [minion({ id: 21, atk: 4, health: 4 })] }),
  ));
  assert.equal(dk.minionAttack, 4);
  assert.equal(dk.heroPowerDamage, 1, '食尸鬼冲锋的 1/1 带冲锋,当回合就能打脸');
  assert.equal(dk.enemyAttack, 5, '4 场攻 + 1 技能');

  const hunter = threatInfo(snap(
    side({ health: 22 }),
    side({ isLocal: false, heroClass: '猎人', manaMax: 10, minions: [] }),
  ));
  assert.equal(hunter.heroPowerDamage, 2, '稳固射击 2 点——空场也有伤害');
  assert.equal(hunter.enemyAttack, 2);
});

test('漏算那一两点,会让「还撑得住」变成「正好死」', () => {
  // 我 5 血,对面猎人马场攻 3:以前算完说「差 2 点」,加上稳固射击正好 5——斩杀
  const t = threatInfo(snap(
    side({ health: 5 }),
    side({ isLocal: false, heroClass: '猎人', manaMax: 10, minions: [minion({ id: 21, atk: 3, health: 3 })] }),
  ));
  assert.equal(t.enemyAttack, 5);
  assert.equal(t.lethalNextTurn, true, '3 场攻 + 2 稳固射击 = 5,正好死');
  assert.equal(t.margin, 0);
});

test('对面水晶还不够放技能时,不算那一点', () => {
  const early = threatInfo(snap(
    side({ health: 22 }),
    side({ isLocal: false, heroClass: '猎人', manaMax: 0, minions: [] }),
  ));
  assert.equal(early.heroPowerDamage, 0, '第 1 回合的对手下回合也只有 1 水晶');
});

test('对面空场时,突袭随从不该排在法术前面', () => {
  // 2026-10-23 第 3 回合真实一手:我法师 2 费,对面死亡骑士空场,建议写的是
  // 「按费打:红鳃锋颚战士(2费 3/1 突袭)、半稳定的传送门(2费 …)」——
  // 用户当场就问「第一回合让 3/1 站场她对吗」。
  // 突袭只能打随从:对面空场时它就是个等着被换掉的 3/1,而 2 费法术至少是净赚一张牌。
  const b = briefAdvice(snap(
    side({ mana: 2, manaMax: 2, handCards: [
      { id: 1, cardId: 'CS3_038', cost: 2 },   // 红鳃锋颚战士 3/1 突袭
      { id: 2, cardId: 'TIME_000', cost: 2 },  // 半稳定的传送门
    ] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 30, minions: [] }),
  ));
  assert.equal(b.kind, 'develop');
  assert.match(b.text, /按费打/);
  assert.ok(b.text.includes('传送门'), `没推荐传送门:${b.text}`);
  assert.equal(b.text.includes('红鳃'), false, `2 水晶只够一张 2 费,不该把突袭并列进来:${b.text}`);
});

test('对面有随从时,突袭仍然排在前面 —— 那时它真能换东西', () => {
  const b = briefAdvice(snap(
    side({ mana: 2, manaMax: 2, handCards: [
      { id: 1, cardId: 'CS3_038', cost: 2 },
      { id: 2, cardId: 'TIME_000', cost: 2 },
    ] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 30, minions: [minion({ id: 21, atk: 1, health: 2 })] }),
  ));
  assert.equal(b.kind, 'develop');
  assert.ok(b.text.includes('红鳃'), `有随从时该推突袭:${b.text}`);
  assert.equal(b.text.includes('传送门'), false, `2 水晶只够一张 2 费:${b.text}`);
});

test('按费打的几张加起来不能超过水晶 —— 「A、B」读起来是两张都打', () => {
  // 2026-10-23 第 7 回合:4 水晶,原文是「按费打:德雷阿佳丝(3费)、淘金客(2费)」,
  // 3+2=5。用户当场说「4费回合不能上德雷阿佳斯」—— 账根本对不上。
  const b = briefAdvice(snap(
    side({ mana: 4, manaMax: 4, handCards: [
      { id: 1, cardId: 'BE_703', cost: 3 },   // 德雷阿佳丝 6/4 亡语
      { id: 2, cardId: 'WW_391', cost: 2 },   // 掏金客 1/2
      { id: 3, cardId: 'TIME_000', cost: 2 }, // 头等大奖
    ] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [minion({ id: 21, atk: 3, health: 3 })] }),
  ));
  assert.equal(b.kind, 'develop');
  const costs = [...b.text.matchAll(/\((\d+)费/g)].map((m) => Number(m[1]));
  const total = costs.reduce((n, c) => n + c, 0);
  assert.ok(total <= 4, `推荐的水晶合计 ${total} 超过 4:${b.text}`);
});

test('余费够的时候仍然给第二张,并报剩多少', () => {
  const b = briefAdvice(snap(
    side({ mana: 6, manaMax: 6, handCards: [
      { id: 1, cardId: 'BE_703', cost: 3 },
      { id: 2, cardId: 'WW_391', cost: 2 },
    ] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [minion({ id: 21, atk: 3, health: 3 })] }),
  ));
  assert.match(b.text, /剩 1 费/);
  const costs = [...b.text.matchAll(/\((\d+)费/g)].map((m) => Number(m[1]));
  assert.equal(costs.reduce((n, c) => n + c, 0), 5);
});

/* ---------- 2026-10-23 用户点的第三件:卡组核心牌不该被「按费打」推出去 ---------- */

/**
 * 配置项 `keepCards` 的解析。
 *
 * 手写名单的人不会讲究分隔符,中文逗号、顿号、分号、换行都会出现 —— 全部认,
 * 否则他填了「德雷阿佳丝、淘金客」结果整串被当成一个牌名,静默失效。
 */
test('核心牌名单:什么分隔符都认,并且去重', () => {
  assert.deepEqual(
    parseKeepCards('德雷阿佳丝, 淘金客、头等大奖; 红鳃\nBE_703'),
    ['德雷阿佳丝', '淘金客', '头等大奖', '红鳃', 'BE_703'],
  );
  assert.deepEqual(parseKeepCards('BE_703, be_703'), ['BE_703'], '大小写不同是同一张');
  assert.deepEqual(parseKeepCards(''), []);
  assert.deepEqual(parseKeepCards(undefined), []);
  assert.deepEqual(parseKeepCards('  ,  , '), []);
});

test('标成核心牌的牌,不再被「按费打」推出去', () => {
  // 复刻 2026-10-23 第 7 回合:4 水晶,手上德雷阿佳丝(3费)+淘金客(2费)+传送门(2费)
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [
      { id: 1, cardId: 'BE_703', cost: 3 },   // 德雷阿佳丝 6/4 亡语 —— 卡组核心
      { id: 2, cardId: 'WW_391', cost: 2 },   // 淘金客
      { id: 3, cardId: 'TIME_000', cost: 2 }, // 半稳定的传送门
    ] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [minion({ id: 21, atk: 3, health: 3 })] }),
  );

  // 没配之前:它会被当普通 3 费随从推出去 —— 这就是 bug 的样子
  assert.match(briefAdvice(s).text, /按费打:[^;]*德雷阿佳丝/, '不配核心牌时原名确实会被推');

  const b = briefAdvice(s, { keepCards: '德雷阿佳丝' });
  assert.equal(b.kind, 'develop');
  assert.doesNotMatch(b.text, /按费打:[^;]*德雷阿佳丝/, `核心牌又被排进按费打了:${b.text}`);
  assert.ok(b.text.includes('淘金客') || b.text.includes('传送门'), `没给替代牌:${b.text}`);
  assert.ok(b.text.includes('核心牌'), `没提它是核心牌:${b.text}`);
  // 钱的账不能因为换牌就崩:推荐的合计仍然不能超过 4
  const costs = [...b.text.matchAll(/\((\d+)费/g)].map((m) => Number(m[1]));
  assert.ok(costs.reduce((n, c) => n + c, 0) <= 4, `超水晶:${b.text}`);
});

test('能打的只剩核心牌时,不写「按费打」,而是劝他留着', () => {
  // 4 水晶,手上只有一张能打的:德雷阿佳丝(3费),其余都是 6 费打不出
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [
      { id: 1, cardId: 'BE_703', cost: 3 },
      { id: 2, cardId: 'CS2_029', cost: 6 },   // 火球术,这回合打不出
    ] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [] }),
  );
  const b = briefAdvice(s, { keepCards: '德雷阿佳丝' });
  assert.equal(b.kind, 'hold', '只剩核心牌时不叫 develop');
  assert.doesNotMatch(b.text, /按费打/, `还在教他按费打:${b.text}`);
  assert.match(b.text, /别拆|空过/, `没把「留着」说清楚:${b.text}`);
});

test('不传名单时行为一个字都不变 —— 老配置不能被这次改动带偏', () => {
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [{ id: 1, cardId: 'WW_391', cost: 2 }] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [] }),
  );
  assert.deepEqual(briefAdvice(s), briefAdvice(s, {}));
  assert.deepEqual(briefAdvice(s), briefAdvice(s, { keepCards: '' }));
});

test('卡牌 ID 也能标核心牌,不只是中文名', () => {
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [
      { id: 1, cardId: 'BE_703', cost: 3 },
      { id: 2, cardId: 'WW_391', cost: 2 },
    ] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [] }),
  );
  const b = briefAdvice(s, { keepCards: 'be_703' });
  assert.doesNotMatch(b.text, /按费打:[^;]*德雷阿佳丝/);
  assert.ok(b.text.includes('淘金客'), `该推淘金客:${b.text}`);
});

test('hand 里也标出核心牌,她看手牌表时不会当成普通牌', () => {
  const hand = readHand(side({ mana: 5, handCards: [
    { id: 1, cardId: 'BE_703', cost: 3 },
    { id: 2, cardId: 'WW_391', cost: 2 },
  ] }), ['德雷阿佳丝']);
  const keep = hand.find((c) => c.cardId === 'BE_703');
  const normal = hand.find((c) => c.cardId === 'WW_391');
  assert.equal(keep.keep, true);
  assert.equal(normal.keep, false);
  // 手牌清单里核心牌排后面 —— 它的定位不是「这回合用哪个」
  assert.ok(hand.indexOf(normal) < hand.indexOf(keep), '核心牌该排在普通牌后面');
});

/* ---------- 核心牌必须在**所有**输出通道上都标出来 ---------- */

/**
 * 2026-10-24 自查发现的漏洞:核心牌只在 `briefAdvice` 里被摘出去,
 * 另外两条通道没管 —— 而它们才是真正喂给判断的地方:
 *
 *   1. `advice.candidates` → `hearthstone_advice` 回执 + 模型第二意见的输入
 *   2. `buildModelPrompt`  → 模型第二意见的输入
 *
 * 结果是她从工具回执里看见「打得出的牌:德雷阿佳丝(3费)」,理直气壮建议打出去。
 * 修完 brief 只是修了表面。
 */
test('advice.candidates 里,核心牌要带标记并单独说明', () => {
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [
      { id: 1, cardId: 'BE_703', cost: 3 },
      { id: 2, cardId: 'WW_391', cost: 2 },
    ] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [] }),
  );
  const a = advise(s, { keepCards: '德雷阿佳丝' });
  const joined = a.candidates.join('\n');
  assert.match(joined, /德雷阿佳丝\(3费[^)]*核心牌\)/, `清单里没标核心牌:${joined}`);
  assert.match(joined, /核心牌/, '缺少「这是核心牌、别提前打」的说明');
  // 没配名单时这一条不该出现 —— 老配置的输出必须不变
  const plain = advise(s).candidates.join('\n');
  assert.equal(plain.includes('核心牌'), false, '没配名单却冒出核心牌字样');
});

test('喂给模型的对局摘要里,核心牌也不能被当成普通牌', () => {
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [
      { id: 1, cardId: 'BE_703', cost: 3 },
      { id: 2, cardId: 'WW_391', cost: 2 },
    ] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [] }),
  );
  const prompt = buildModelPrompt(s, { keepCards: '德雷阿佳丝' });
  assert.match(prompt, /德雷阿佳丝\(3费[^)]*核心牌\)/, `摘要里没标:${prompt}`);
  assert.match(prompt, /核心牌.*不要建议提前打出去/s, '缺少对模型的明确约束');
  // 手上一张核心牌都没有时,别塞这句噪音
  const noKeepInHand = buildModelPrompt(
    snap(side({ mana: 4, handCards: [{ id: 2, cardId: 'WW_391', cost: 2 }] }), side({ isLocal: false })),
    { keepCards: '德雷阿佳丝' },
  );
  assert.equal(noKeepInHand.includes('核心牌'), false, '手上没核心牌还加提示');
});

test('只剩核心牌、但场上还有攻击力时,不能叫他空过', () => {
  // 4 水晶,手上只有核心牌;场上有两个 3/3 能打 —— 这回合的活是场面的
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [{ id: 1, cardId: 'BE_703', cost: 3 }],
      minions: [minion({ id: 11, atk: 3, health: 3 }), minion({ id: 12, atk: 3, health: 3 })] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [] }),
  );
  const b = briefAdvice(s, { keepCards: '德雷阿佳丝' });
  assert.equal(b.kind, 'hold');
  assert.doesNotMatch(b.text, /宁可空过/, `场上有随从还叫空过:${b.text}`);
  assert.match(b.text, /场上还有 6 点攻击能动/, `没提场面能做多少:${b.text}`);
});

test('只剩核心牌、场面也是空的时候,才说「宁可空过」', () => {
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [{ id: 1, cardId: 'BE_703', cost: 3 }], minions: [] }),
    side({ isLocal: false, heroClass: '死亡骑士', health: 27, minions: [] }),
  );
  const b = briefAdvice(s, { keepCards: '德雷阿佳丝' });
  assert.equal(b.kind, 'hold');
  assert.match(b.text, /宁可空过/);
});

/* ---------- 2026-10-24 用户当场点的两手:吸血没算 + 空场 ---------- */

/**
 * 第 11 回合真实局面(10:11 那局,术士内战):
 *
 *   我 28 血,场上 毁焚火凤 5/3
 *   对面 18 血:破命之龙 7/7 **吸血**、克拉西斯蛮兵 3/5 嘲讽 ×2、不稳定的原型机 0/1 复生
 *
 * 她当时说「先换:5/3 打 不稳定的原型机(0/1)」。两个问题:
 *   1. 对面 13 点场攻里有 7 点是吸血,建议里一个字没提
 *   2. 那个 0/1 是 0 攻 —— 换掉它场攻一点没减,却用掉了这轮唯一的攻击
 */
test('对面场攻里的吸血必须单算出来', () => {
  const s = snap(
    side({ health: 28, mana: 6, manaMax: 6, handCards: [{ id: 1, cardId: 'WW_391', cost: 2 }] }),
    side({ isLocal: false, heroClass: '术士', health: 18, minions: [
      minion({ id: 21, name: '破命之龙', atk: 7, health: 7, lifesteal: true }),
      minion({ id: 22, name: '克拉西斯蛮兵', atk: 3, health: 5, taunt: true }),
      minion({ id: 23, name: '克拉西斯蛮兵', atk: 3, health: 5, taunt: true }),
    ] }),
  );
  const t = threatInfo(s);
  assert.equal(t.enemyAttack, 13);
  assert.equal(t.lifestealAttack, 7, '13 点场攻里有 7 点是破命之龙');
  assert.ok(threatTextOf(s).includes('吸血'), `威胁文案没提吸血:${threatTextOf(s)}`);
});

test('冻结的吸血随从不算 —— 它这回合打不出来', () => {
  const s = snap(
    side({ health: 28, mana: 6, manaMax: 6 }),
    side({ isLocal: false, heroClass: '术士', health: 18, minions: [
      minion({ id: 21, name: '破命之龙', atk: 7, health: 7, lifesteal: true, frozen: true }),
      minion({ id: 22, name: '克拉西斯蛮兵', atk: 3, health: 5 }),
    ] }),
  );
  const t = threatInfo(s);
  assert.equal(t.enemyAttack, 3);
  assert.equal(t.lifestealAttack, 0);
});

test('5/3 不该被推荐去撞 0 攻的复生随从', () => {
  const s = snap(
    side({ health: 22, mana: 6, manaMax: 6, minions: [
      minion({ id: 11, name: '毁焚火凤', atk: 5, health: 3, canAttack: true }),
    ] }),
    side({ isLocal: false, heroClass: '术士', health: 18, minions: [
      minion({ id: 21, name: '破命之龙', atk: 7, health: 7, lifesteal: true }),
      minion({ id: 22, name: '克拉西斯蛮兵', atk: 3, health: 5, taunt: true }),
      minion({ id: 23, name: '克拉西斯蛮兵', atk: 3, health: 5, taunt: true }),
      minion({ id: 24, name: '不稳定的原型机', atk: 0, health: 1, reborn: true }),
    ] }),
  );
  const b = briefAdvice(s);
  // 有值得的交换(同归于尽清一道 3/5 嘲讽)时,该选那个,不是这个 0 攻的
  assert.equal(b.kind, 'trade', `应该给交换建议:${b.text}`);
  assert.doesNotMatch(b.text, /原型机/, `把 5 攻浪费在 0 攻随从上了:${b.text}`);
  assert.match(b.text, /克拉西斯蛮兵/, `该去清嘲讽墙:${b.text}`);
});

test('只有 0 攻随从能换时,宁可不换 —— 那种交换是白给', () => {
  // 同一局面但对面没有嘲讽、只有一个 0/1 复生:没有值得的交换,应该回落「按费打」
  const s = snap(
    side({ health: 28, mana: 6, manaMax: 6, minions: [
      minion({ id: 11, name: '毁焚火凤', atk: 5, health: 3, canAttack: true }),
    ] }),
    side({ isLocal: false, heroClass: '术士', health: 18, minions: [
      minion({ id: 21, name: '破命之龙', atk: 7, health: 7, lifesteal: true }),
      minion({ id: 24, name: '不稳定的原型机', atk: 0, health: 1, reborn: true }),
    ] }),
  );
  const b = briefAdvice(s);
  assert.notEqual(b.kind, 'trade', `不该为了换 0 攻随从放弃这轮攻击:${b.text}`);
  assert.doesNotMatch(b.text, /先换:.*原型机/, `还是推荐打 0 攻随从:${b.text}`);
});

test('换掉吸血随从之后,要报清场攻减了多少', () => {
  const s = snap(
    side({ health: 20, mana: 6, manaMax: 6, minions: [
      minion({ id: 11, name: '大块头', atk: 8, health: 8, canAttack: true }),
    ] }),
    side({ isLocal: false, heroClass: '术士', health: 18, minions: [
      minion({ id: 21, name: '破命之龙', atk: 7, health: 7, lifesteal: true }),
      minion({ id: 22, name: '克拉西斯蛮兵', atk: 3, health: 5 }),
    ] }),
  );
  const b = briefAdvice(s);
  assert.equal(b.kind, 'trade', `该给交换建议:${b.text}`);
  assert.match(b.text, /破命之龙/, `该优先换掉最大的威胁:${b.text}`);
  assert.match(b.text, /场攻剩 3/, `换完场攻没算对:${b.text}`);
});

/* ---------- 2026-10-24 「4费她让我压468但是副作用太大了（没有锻造）」 ---------- */

/**
 * 暗石守卫(DEEP_027):4 费 6/8 嘲讽。抉择:弃两张牌;或摧毁你的一个法力水晶。
 * 锻造之后两个都不需要 —— 但他那局没锻造。
 *
 * 卡表摘要原来只剩「6/8 嘲讽 摧毁」,建议就照着这三个词推:「按费打:暗石守卫」。
 * 代价一个字都没提。
 */
test('要付代价的牌排在有选择的牌后面,而且把代价摆出来', () => {
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [
      { id: 1, cardId: 'DEEP_027', cost: 4 },  // 暗石守卫:抉择弃2张 / 毁1个水晶
      { id: 2, cardId: 'WW_391', cost: 2 },    // 掏金客
      { id: 3, cardId: 'TIME_000', cost: 2 },  // 半稳定的传送门
    ] }),
    side({ isLocal: false, heroClass: '德鲁伊', health: 30, minions: [] }),
  );
  const b = briefAdvice(s);
  assert.equal(b.kind, 'develop');
  // 有便宜牌可铺时,别让 6/8 嘲讽(带代价)抢第一
  assert.doesNotMatch(b.text, /按费打:暗石守卫/, `6/8 嘲讽抢了首选:${b.text}`);
  assert.match(b.text, /淘金客|传送门/, b.text);
});

test('只有这张能打时照给,但必须写明代价', () => {
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [{ id: 1, cardId: 'DEEP_027', cost: 4 }] }),
    side({ isLocal: false, heroClass: '德鲁伊', health: 30, minions: [] }),
  );
  const b = briefAdvice(s);
  assert.equal(b.kind, 'develop');
  assert.match(b.text, /暗石守卫/, `该给这张:${b.text}`);
  assert.match(b.text, /抉择|弃2张牌/, `没把卡面代价带出来:${b.text}`);
  assert.match(b.text, /要付的代价/, `没提醒这是代价:${b.text}`);
});

test('「摧毁对手武器」不算代价 —— 那是好事,别误伤', () => {
  // 酸性沼泽软泥怪 2费 3/2 战吼 摧毁(对手武器)
  const s = snap(
    side({ mana: 2, manaMax: 2, handCards: [
      { id: 1, cardId: 'CORE_EX1_066', cost: 2 },
    ] }),
    side({ isLocal: false, heroClass: '战士', health: 30, minions: [] }),
  );
  const b = briefAdvice(s);
  assert.doesNotMatch(b.text, /要付的代价/, `把摧毁武器当成副作用了:${b.text}`);
});

test('没锻造的暗石守卫,卡面摘要里得有那两个选项', () => {
  // 这条盯的是数据,不是逻辑:摘要缺了选项,上面所有逻辑都无从判断
  const s = snap(
    side({ mana: 4, handCards: [{ id: 1, cardId: 'DEEP_027', cost: 4 }] }),
    side({ isLocal: false }),
  );
  const card = readHand(s.me).find((c) => c.cardId === 'DEEP_027');
  assert.match(card.note, /嘲讽/);
  assert.match(card.note, /抉择/, `摘要丢了抉择:${card.note}`);
  assert.match(card.note, /弃/, `摘要丢了弃牌代价:${card.note}`);
  assert.match(card.note, /水晶/, `摘要丢了毁水晶代价:${card.note}`);
});

test('跳过代价牌时要说明它还在手上 —— 不然建议看着莫名其妙', () => {
  // 4 费:手上有暗石守卫(6/8 嘲讽,要付代价)和一张 2 费普通牌
  const s = snap(
    side({ mana: 4, manaMax: 4, handCards: [
      { id: 1, cardId: 'DEEP_027', cost: 4 },
      { id: 2, cardId: 'WW_391', cost: 2 },
    ] }),
    side({ isLocal: false, heroClass: '德鲁伊', health: 30, minions: [] }),
  );
  const b = briefAdvice(s);
  assert.equal(b.kind, 'develop');
  // 推的是便宜那张,但必须提一句 6/8 也在手上、只是有代价
  assert.match(b.text, /暗石守卫/, `系统像没看见这张牌一样:${b.text}`);
  assert.match(b.text, /付代价/, `没说清为什么没推它:${b.text}`);
});

/* ---------- 2026-10-24 第二轮:文案里的两个真错 ---------- */

test('什么都没削掉时,别在句号后面留一个孤零零的逗号', () => {
  // 我 8 血、手牌空、场上空;对面两只 4/4 → 8 点场攻,正好够打死我。
  // 这一手什么都削不掉(cut=0)、也没有回血 → 「能削 N 点」整段不该出现。
  // 实测旧输出:「危险:对面场攻 8,我 8 有效血,不解就死。,还差 8 点;手上没有能挡的牌…」
  const b = briefAdvice(
    snap(
      side({ health: 8, mana: 0, manaMax: 4, handCards: [], minions: [] }),
      side({ isLocal: false, heroClass: '战士', manaMax: 4, minions: [
        minion({ id: 21, atk: 4, health: 4 }),
        minion({ id: 22, atk: 4, health: 4 }),
      ] }),
    ),
    {},
  );
  assert.equal(b.kind, 'danger');
  assert.doesNotMatch(b.text, /。\s*,/, `句号后面跟了逗号:${b.text}`);
  assert.doesNotMatch(b.text, /还差 \d+ 点/, `什么都没削,却又把场攻抄了一遍:${b.text}`);
  assert.match(b.text, /不解就死/);
});

test('场攻里混了英雄技能就拆开说 —— 数字要和场上对得上', () => {
  // 对面场上只有一只 2/2,法师技能再加 1 → 报「场攻 3」他会去数随从,数出 2,以为她说错
  const b = briefAdvice(
    snap(
      side({ health: 30, mana: 5, manaMax: 5 }),
      side({ isLocal: false, heroClass: '法师', manaMax: 5, minions: [minion({ id: 21, atk: 2, health: 2 })] }),
    ),
  );
  assert.match(b.text, /对面场攻 3\(随从 2 \+ 技能 1\)/, `没把技能拆出来:${b.text}`);
});

test('只有随从时别加括号 —— 那不是补充,是噪音', () => {
  const b = briefAdvice(
    snap(
      side({ health: 30, mana: 5, manaMax: 5 }),
      side({ isLocal: false, heroClass: '战士', manaMax: 5, minions: [minion({ id: 21, atk: 2, health: 2 })] }),
    ),
  );
  assert.match(b.text, /对面场攻 2,/, `纯随从场攻不该展开:${b.text}`);
});

/* ---------- 2026-10-24 第三轮:锻造(卡面词条 + 日志里的 `t` 后缀) ---------- */

/**
 * 这一组盯的是「她能不能分清这张牌锻造过没有」。
 *
 * 两个数据源各管一半,缺一半就判错:
 *   1. **卡面词条**决定「这是不是一张锻造牌」—— 日志里没有这个信息,只有卡牌数据有
 *      (`mechanics: FORGE`,卡表里标成 `f`)。
 *   2. **日志里的 cardId** 决定「锻造过没有」—— 实测锻造那一刻写的是
 *      `CHANGE_ENTITY ... cardId=TTN_458` → `CardID=TTN_458t`,人还在 zone=HAND。
 *
 * 判错的代价很实在:已锻造的暗石守卫就是一张干净的 6/8 嘲讽,
 * 还说「打出去要弃两张牌」等于让她自己算错账。
 */

test('卡面词条:锻造牌认得出,「要求你锻造过」的牌不能算', () => {
  assert.equal(cardEffects('DEEP_027').forge, true, '暗石守卫是锻造牌');
  assert.equal(cardEffects('TTN_458').forge, true, 'XB-488清理机器人是锻造牌');
  assert.equal(cardEffects('YOG_525').forge, true, '健身肌器人是锻造牌');
  // 永恒之火伊格尼斯:牌面写着「战吼需你锻造过卡牌」,但它自己**不是**锻造牌。
  // 按摘要文字猜就会把它算进来,然后提示一个根本不存在的代价。
  assert.equal(cardEffects('TTN_751').forge, false, '伊格尼斯不能被当成锻造牌');
  assert.equal(cardEffects('CS2_029').forge, false, '火球术不是锻造牌');
});

test('锻造牌名单是完整的 20 张 —— 卡表重建时丢了 f 标签会被这条挡住', () => {
  const FORGEABLE = [
    'DEEP_024', 'DEEP_027', 'TTN_039', 'TTN_042', 'TTN_076', 'TTN_302', 'TTN_430',
    'TTN_457', 'TTN_458', 'TTN_477', 'TTN_490', 'TTN_724', 'TTN_730', 'TTN_753',
    'TTN_801', 'TTN_855t', 'TTN_865', 'TTN_951', 'YOG_502', 'YOG_525',
  ];
  const missing = FORGEABLE.filter((id) => !cardEffects(id).forge);
  assert.deepEqual(missing, [], `这些牌丢了锻造词条:${missing.join(', ')}`);
});

test('锻造后的牌(`xxx_t`)要认回原卡:名字、费用、摘要都得在', () => {
  // 不回落的话她只能念「你手上有一张 TTN_458t」—— 没有名字、没有费用、没有摘要
  const hand = readHand(side({
    mana: 6, manaMax: 6,
    handCards: [
      { id: 1, cardId: 'TTN_458', cost: 5 },
      { id: 2, cardId: 'TTN_458t', cost: 5 },
    ],
  }));
  const raw = hand.find((c) => c.cardId === 'TTN_458');
  const forged = hand.find((c) => c.cardId === 'TTN_458t');
  assert.equal(raw.name, 'XB-488清理机器人');
  assert.equal(forged.name, 'XB-488清理机器人');
  assert.equal(forged.baseCost, 5, '费用要从原卡读出来');
  assert.equal(raw.forged, false);
  assert.equal(forged.forged, true, 'id 末尾的 t 就是「已锻造」');
  assert.match(forged.note, /已锻造/, `摘要里要标出已锻造:${forged.note}`);
});

test('已锻造之后不许再提「打出去要付代价」', () => {
  const make = (cardId) => briefAdvice(snap(
    side({ mana: 4, manaMax: 4, handCards: [{ id: 1, cardId, cost: 4 }] }),
    side({ isLocal: false, heroClass: '战士', health: 30, minions: [] }),
  ));

  const raw = make('DEEP_027');
  assert.match(raw.text, /暗石守卫/);
  assert.match(raw.text, /要付的代价/, `没锻造过就该提醒代价:${raw.text}`);
  assert.match(raw.text, /锻造后免/, '未锻造时要说清代价是可以免掉的');

  const forged = make('DEEP_027t');
  assert.match(forged.text, /暗石守卫/, `认不出原卡:${forged.text}`);
  assert.doesNotMatch(forged.text, /要付的代价/, `已锻造还提代价:${forged.text}`);
  assert.doesNotMatch(forged.text, /锻造后免/, `已锻造不该再出现「锻造后免」:${forged.text}`);
  assert.match(forged.text, /已锻造/, `没说清它已经锻造过:${forged.text}`);
});

test('本来就以 t 结尾的独立卡(`TTN_855t` 提尔之涕)不能被当成锻造变体', () => {
  const card = readHand(side({ handCards: [{ id: 1, cardId: 'TTN_855t', cost: 5 }] }))[0];
  assert.equal(card.name, '提尔之涕');
  assert.equal(card.forged, false, '它自己就是一张卡,不是谁的已锻造版本');
  assert.equal(card.forge, true, '它带锻造词条');
});

/* ---------- 2026-10-24 第四轮:预备(Prepare) ---------- */

/**
 * 预备 = 把牌拖进牌库,花掉全部剩余法力,换「等量 + 1」的减费,当回合不能再打。
 *
 * 它和锻造不一样,数据来源也不同:
 *   · 锻造牌在 mechanics 里有 FORGE 标签;预备牌**没有** —— 官方只把「预备」写在牌面文本开头。
 *   · 「锻造过没有」看 cardId 的 t 后缀;「预备过没有」看日志里 `tag=PREPARE value=1`。
 */

test('卡面文本:「使其获得预备」的牌自己不是预备牌', () => {
  // 通缉海报:发现一张随从牌,「使其获得预备」—— 给别人的,它自己打出去没有预备
  assert.equal(cardEffects('CAP_407').prepare, false, '通缉海报不是预备牌');
  // 狱中老鸟:文本不以「预备」开头(前面还有「嘲讽。」),但它自己就是预备牌
  assert.equal(cardEffects('JAIL_453').prepare, true, '狱中老鸟是预备牌');
  assert.equal(cardEffects('JAIL_407').prepare, true);
  assert.equal(cardEffects('CS2_029').prepare, false, '火球术不是预备牌');
});

test('预备牌名单是 19 张 —— 重建卡表时丢了 p 标签会被这条挡住', () => {
  const PREPARE = [
    'CATA_EVENT_400', 'CATA_EVENT_401', 'JAIL_321', 'JAIL_326', 'JAIL_395', 'JAIL_407',
    'JAIL_435', 'JAIL_444', 'JAIL_453', 'JAIL_457', 'JAIL_718', 'JAIL_721', 'JAIL_735',
    'JAIL_890', 'JAIL_906', 'JAIL_909', 'JAIL_912', 'JAIL_913', 'JAIL_998',
  ];
  const missing = PREPARE.filter((id) => !cardEffects(id).prepare);
  assert.deepEqual(missing, [], `这些牌丢了预备词条:${missing.join(', ')}`);
});

test('已经预备过的牌:摘要标出「已预备」,不再挂着那个裸的「预备」', () => {
  const hand = readHand(side({
    mana: 2, manaMax: 5,
    handCards: [{ id: 1, cardId: 'JAIL_407', cost: 2, prepared: true }],
  }));
  assert.match(hand[0].note, /已预备/, `没标出已预备:${hand[0].note}`);
  assert.doesNotMatch(hand[0].note, /(?:^|\s)预备(?:\s|$)/, `还留着裸的「预备」,会让人以为能再预备一次:${hand[0].note}`);

  const raw = readHand(side({ handCards: [{ id: 1, cardId: 'JAIL_407', cost: 7, prepared: false }] }))[0];
  assert.match(raw.note, /预备/, `没预备过的要标出「预备」:${raw.note}`);
});

test('剩水 + 打不出的预备牌 → 提示「换折扣」,而且减费要封顶', () => {
  // 7 费牌、剩 5 水 → 便宜 6 费,降到 1 费
  const big = briefAdvice(snap(
    side({ mana: 5, manaMax: 5, handCards: [{ id: 1, cardId: 'JAIL_407', cost: 7, prepared: false }] }),
    side({ isLocal: false, heroClass: '战士', minions: [] }),
  ));
  assert.match(big.text, /预备掉/, `没给这条建议:${big.text}`);
  assert.match(big.text, /从 7 费降到 1 费/, big.text);

  // 3 费牌、剩 2 水 → 打不出,预备能减 min(2+1, 3)=3,直接 0 费。
  // 若按「便宜 3 费」去念也对,但文案要说的清是「降到 0」——
  // 规则写的是「剩余法力多于降到 0 所需的量时只花到 0」,所以减费必须封顶在牌价。
  const small = briefAdvice(snap(
    side({ mana: 2, manaMax: 5, handCards: [{ id: 1, cardId: 'JAIL_998', cost: 3, prepared: false }] }),
    side({ isLocal: false, heroClass: '战士', minions: [] }),
  ));
  assert.match(small.text, /降到 0 费/, `减费没封顶:${small.text}`);
});

test('这回合打得出就不提预备 —— 预备会把它锁住一回合,那是纯亏', () => {
  // 3 费牌、剩 5 水:打得出,不该劝他预备
  const b = briefAdvice(snap(
    side({ mana: 5, manaMax: 5, handCards: [{ id: 1, cardId: 'JAIL_998', cost: 3, prepared: false }] }),
    side({ isLocal: false, heroClass: '战士', minions: [] }),
  ));
  assert.equal(b.kind, 'develop');
  assert.doesNotMatch(b.text, /预备掉/, `打得出还劝预备:${b.text}`);
});

test('剩水 0 时提不了 —— 规则要求至少 1 点法力', () => {
  const b = briefAdvice(snap(
    side({ mana: 0, manaMax: 5, handCards: [{ id: 1, cardId: 'JAIL_407', cost: 7, prepared: false }] }),
    side({ isLocal: false, heroClass: '战士', minions: [] }),
  ));
  assert.doesNotMatch(b.text, /预备掉/, `0 水晶不可能预备:${b.text}`);
});

test('已预备的牌不该再被劝一次预备', () => {
  const b = briefAdvice(snap(
    side({ mana: 5, manaMax: 5, handCards: [{ id: 1, cardId: 'JAIL_407', cost: 1, prepared: true }] }),
    side({ isLocal: false, heroClass: '战士', minions: [] }),
  ));
  assert.doesNotMatch(b.text, /预备掉/, `已经预备过了还劝:${b.text}`);
});

/* ---------- 2026-10-24 第五轮:可交易 + 补齐其余词条 ---------- */

test('可交易认得出,且摘要里带这个词条', () => {
  assert.equal(cardEffects('CORE_EX1_002').tradeable, true, '黑骑士是可交易');
  assert.equal(cardEffects('CS2_029').tradeable, false, '火球术不可交易');
  const card = readHand(side({ handCards: [{ id: 1, cardId: 'CORE_EX1_002', cost: 4 }] }))[0];
  assert.match(card.note, /可交易/, `摘要里没有可交易:${card.note}`);
});

test('打不出的可交易牌 + 剩水 → 提「花 1 费换一张」', () => {
  // 4 费黑骑士、只剩 3 水 → 打不出;这时 3 点水唯一的用处就是换一张
  const b = briefAdvice(snap(
    side({ mana: 3, manaMax: 5, handCards: [{ id: 1, cardId: 'CORE_EX1_002', cost: 4 }] }),
    side({ isLocal: false, heroClass: '战士', minions: [] }),
  ));
  assert.match(b.text, /交易掉换一张/, `没给这条建议:${b.text}`);
  assert.match(b.text, /1 费/, '要说清代价是 1 费');
});

test('预备优先于可交易 —— 一句里只说一件事', () => {
  const b = briefAdvice(snap(
    side({ mana: 2, manaMax: 5, handCards: [
      { id: 1, cardId: 'JAIL_407', cost: 7, prepared: false },     // 预备牌,打不出
      { id: 2, cardId: 'CORE_EX1_002', cost: 4 },                   // 可交易,也打不出
    ] }),
    side({ isLocal: false, heroClass: '战士', minions: [] }),
  ));
  assert.match(b.text, /预备掉/, b.text);
  assert.doesNotMatch(b.text, /交易掉/, `两件事都提就成播报了:${b.text}`);
});

test('补齐的这批词条都进了摘要 —— 一张都没漏', () => {
  // 每条挑一张代表牌,只验「摘要里认得出这个说法」,不验具体数值
  const cases = [
    ['CORE_MAW_003', /注入/, '注入'],
    ['CORE_EX1_002', /可交易/, '可交易'],
    ['MIS_025', /迷你/, '迷你'],
    ['DEEP_024', /快枪/, '快枪'],
    ['AV_121', /荣誉击杀/, '荣誉击杀'],
    ['BAR_020', /暴怒/, '暴怒'],
    ['AT_011', /过量治疗/, '过量治疗'],
    ['TTN_075', /泰坦/, '泰坦'],
    ['CATA_139', /巨型/, '巨型'],
    ['NX2_018', /探底/, '探底'],
    ['DEEP_007', /发掘/, '发掘'],
    ['BOT_700', /回响/, '回响'],
    ['BOT_020', /磁力/, '磁力'],
    ['NX2_005', /法力渴求/, '法力渴求'],
    ['BAR_328', /流放/, '流放'],
    ['DMF_054', /腐蚀/, '腐蚀'],
    ['DAL_141', /双生法术/, '双生法术'],
    ['GDB_104', /法术爆发/, '法术爆发'],
  ];
  const miss = [];
  for (const [id, re, label] of cases) {
    const note = readHand(side({ handCards: [{ id: 1, cardId: id, cost: 5 }] }))[0].note;
    if (!re.test(note)) miss.push(`${label}(${id})=${note}`);
  }
  assert.deepEqual(miss, [], `这些词条没进摘要:${miss.join(' | ')}`);
});

/* ---------- 2026-10-24:武器挂在英雄身上,不占场面 —— 那就更要报 ---------- */

/**
 * 背景:那局对面是牧师,第 3 回合挂上黑暗帝国之刃(0/3)。
 *
 * 它是 0 攻,所以场攻算出来是 0,建议老老实实说「对面打不到我」—— 每个数字都对。
 * 但它的效果是「每回合结束,如果你施放了暗影法术,敌方英雄受到疲劳伤害」:
 * 那一局我的疲劳层数从 1 一路涨到 8,牌库还剩二十多张,血也一路掉。
 * 她解释不了为什么 —— 因为这句话里根本没有那把刀。
 */
test('对面挂着 0 攻武器时不许说「打不到我」,要把刀摆出来', () => {
  const b = briefAdvice(snap(
    side({ health: 30, mana: 0, manaMax: 4, handCards: [] }),
    side({ isLocal: false, heroClass: '牧师', manaMax: 4, minions: [],
      weapon: { cardId: 'BE_227', name: '黑暗帝国之刃', atk: 0, durability: 3 } }),
  ));
  assert.match(b.text, /黑暗帝国之刃/, `整句里没有那把武器:${b.text}`);
  assert.doesNotMatch(b.text, /打不到我/, `0 攻武器在场还说「打不到我」:${b.text}`);
  assert.match(b.text, /0 攻打不出伤害/, `没说清 0 攻和效果的差别:${b.text}`);
});

test('武器有攻击力时也要带上名字 —— 场攻里那几点是哪来的', () => {
  const b = briefAdvice(snap(
    side({ health: 30, mana: 5, manaMax: 5 }),
    side({ isLocal: false, heroClass: '战士', manaMax: 5, minions: [],
      weapon: { cardId: 'CS2_112', name: '奥金斧', atk: 5, durability: 2 } }),
  ));
  assert.match(b.text, /奥金斧/, `没报武器名:${b.text}`);
  assert.match(b.text, /也算在场攻里/, b.text);
});

test('武器效果要进给模型的局面文本,而且身材不重复念两遍', () => {
  const text = renderSnapshot(snap(
    side(),
    side({ isLocal: false, heroClass: '牧师',
      weapon: { cardId: 'BE_227', name: '黑暗帝国之刃', atk: 0, durability: 3 } }),
  ));
  assert.match(text, /黑暗帝国之刃/, text);
  // 效果原文必须在 —— 她要在气泡里解释「这血是怎么掉的」,全靠这一句
  assert.match(text, /疲劳伤害/, `武器的效果没进去:${text}`);
  // 卡表摘要以身材开头(`0/0 效果…`),而括号里已经报了 0/3
  assert.doesNotMatch(text, /0\/3 0\/0/, `身材念了两遍:${text}`);
});

test('卡表里武器的效果不能被压成只剩身材', () => {
  // 251 张武器里有 79 张提不出结构化效果,以前摘要就只剩「0/3」。
  // 黑暗帝国之刃是最贵的一种错:摘要写 0/0,她的账上这把刀等于不存在。
  assert.match(cardNote('BE_227'), /疲劳/, `摘要丢了效果:${cardNote('BE_227')}`);
  // 提不出效果的随从同理 —— 艾维娜改的是费用,漏了她会以为那只是张 5/5
  assert.match(cardNote('AT_045'), /法力值消耗/, `摘要丢了效果:${cardNote('AT_045')}`);
});

/* ---------- 2026-10-24:疲劳钟（架墙挡不住的那种输法） ---------- */

/**
 * 那局第 9 个回合：我 16 血、疲劳第 6 层、对面场攻 8。
 *
 * 建议当时说的是「还有点余量但别拖」—— 数字没错，于是他照着去架墙。
 * 可是疲劳伤害不看场面、不吃嘲讽，下一轮第 7 层、再下一轮第 8 层，
 * 三个回合就能把人清空。**架墙对这条路完全无效**。
 *
 * 判据只认一件事：牌库还没空、疲劳层数却在涨 —— 那是外部疲劳源（黑暗帝国之刃那类）。
 * 牌库真抽干的疲劳不算「钟」，那是正常收官。
 */
test('牌库没空却在掉疲劳 —— 要说清还剩几个回合，并点明架墙无效', () => {
  const t = threatInfo(snap(
    side({ health: 16, fatigue: 6, deckCount: 20 }),
    side({ isLocal: false, heroClass: '牧师', manaMax: 9, minions: [] }),
  ));
  assert.deepEqual(t.fatigueClock, { next: 7, turns: 3 }, JSON.stringify(t.fatigueClock));

  const b = briefAdvice(snap(
    side({ health: 16, fatigue: 6, deckCount: 20, mana: 1, manaMax: 9, handCards: [] }),
    side({ isLocal: false, heroClass: '牧师', manaMax: 9, minions: [] }),
  ));
  assert.match(b.text, /疲劳在追杀/, b.text);
  assert.match(b.text, /下一轮第 7 层/, b.text);
  assert.match(b.text, /3 个回合/, b.text);
  assert.match(b.text, /架墙挡不住/, `没点明墙没用:${b.text}`);
});

test('疲劳是等差数列求和 —— 不是「血量除以层数」', () => {
  // 30 血、疲劳 1：2+3+4+5+6+7=27 还差 3 点，再来一发 8 就是 35 → 第 7 轮死。
  // （按「30÷2=15 轮」算会把整局读反：疲劳是等差数列，不是固定值。）
  const t = threatInfo(snap(side({ health: 30, fatigue: 1, deckCount: 20 }), side()));
  assert.deepEqual(t.fatigueClock, { next: 2, turns: 7 });
});

test('牌库真抽干时不算「钟」—— 那是正常收官的疲劳', () => {
  const t = threatInfo(snap(side({ health: 9, fatigue: 8, deckCount: 0 }), side()));
  assert.equal(t.fatigueClock, null);
  const b = briefAdvice(snap(
    side({ health: 9, fatigue: 8, deckCount: 0, mana: 3, manaMax: 9, handCards: [] }),
    side({ isLocal: false, heroClass: '战士', manaMax: 9, minions: [] }),
  ));
  assert.doesNotMatch(b.text, /疲劳在追杀/, `抽干局不该冒出钟:${b.text}`);
});

test('没疲劳时不许提这一句 —— 别把每回合都写成倒计时', () => {
  const b = briefAdvice(snap(
    side({ health: 25, fatigue: 0, deckCount: 18, mana: 4, manaMax: 5 }),
    side({ isLocal: false, heroClass: '战士', manaMax: 5, minions: [minion({ id: 9, atk: 3, health: 3 })] }),
  ));
  assert.doesNotMatch(b.text, /疲劳在追杀/, b.text);
});

/* ---------- 2026-10-24:架墙到底挡不挡得住 ---------- */

/**
 * 第 18 回合（9 费）真实场景：
 *   我 3 血、手牌 6 张、9/9 水晶；对面 5 个攻击者共 31 点。
 *   手上唯一像「墙」的是羁押装置（6/6 亡语 磁力 召唤）—— **它没有嘲讽**。
 *
 * 旧文案写的是「解不掉就守一下:羁押装置 能吃掉对面一次攻击」，
 * 她照着说成「只能架墙赌一把」。两处都错：
 *   1. 没有嘲讽的随从挡不住任何攻击，对面照脸打；
 *   2. 就算挂上嘲讽，一只也只吃一次攻击 —— 5 个攻击者挡掉一只还剩 23 点，3 血照样死。
 */
test('没有嘲讽的随从不是墙 —— 不许说「能吃掉一次攻击」', () => {
  const b = briefAdvice(snap(
    side({
      health: 3, mana: 9, manaMax: 9,
      handCards: [{ id: 1, cardId: 'TTN_700', cost: 7 }],   // 6/6 亡语 磁力 召唤，无嘲讽
    }),
    side({ isLocal: false, heroClass: '术士', manaMax: 9, minions: [
      minion({ id: 11, atk: 8, health: 8 }),
      minion({ id: 12, atk: 7, health: 6 }),
      minion({ id: 13, atk: 7, health: 4 }),
      minion({ id: 14, atk: 6, health: 4 }),
      minion({ id: 15, atk: 3, health: 6 }),
    ] }),
  ));
  assert.equal(b.kind, 'danger');
  assert.match(b.text, /没有嘲讽牌/, `没点明手上没墙:${b.text}`);
  assert.doesNotMatch(b.text, /吃掉/, `还在许诺挡一刀:${b.text}`);
  assert.doesNotMatch(b.text, /守一下/, `没有嘲讽还叫守:${b.text}`);
});

test('有嘲讽且挡得住 —— 把挡完还剩多少打脸写出来', () => {
  // 对面两只 3 点、我 6 血：挡掉一只还剩 3 点，扛得住
  const b = briefAdvice(snap(
    side({ health: 6, mana: 4, manaMax: 4, handCards: [{ id: 1, cardId: 'AT_097', cost: 1 }] }),
    side({ isLocal: false, heroClass: '术士', manaMax: 4, minions: [
      minion({ id: 11, atk: 3, health: 5 }),
      minion({ id: 12, atk: 3, health: 5 }),
    ] }),
  ));
  assert.match(b.text, /挂上嘲讽/, b.text);
  assert.match(b.text, /还剩 3 点打脸/, `没算挡完剩多少:${b.text}`);
  assert.match(b.text, /扛得住/, b.text);
});

test('有嘲讽但挡不住 —— 直说守不住，别让他把水晶花在墙上', () => {
  // 我 4 血、对面三只 5 点：挡掉一只还剩 10 点，怎么都死
  const b = briefAdvice(snap(
    side({ health: 4, mana: 4, manaMax: 4, handCards: [{ id: 1, cardId: 'AT_114', cost: 4 }] }),
    side({ isLocal: false, heroClass: '术士', manaMax: 5, minions: [
      minion({ id: 11, atk: 5, health: 5 }),
      minion({ id: 12, atk: 5, health: 5 }),
      minion({ id: 13, atk: 5, health: 5 }),
    ] }),
  ));
  assert.match(b.text, /守不住/, b.text);
  assert.match(b.text, /挡掉 1 只还剩 10 点打脸/, `没算清楚:${b.text}`);
  assert.doesNotMatch(b.text, /扛得住/, b.text);
});

/* ---------- 2026-10-24:打出去那一下的伤害（战吼 / 快枪） ---------- */

/**
 * 两处真错，同一局：
 *   · 第 5 回合 3 水晶、对面**空场**，建议「按费打：蹄铁发射机」——
 *     那张牌的战吼是「随机对一个敌方随从造成 2 点」，没目标就白扔；
 *   · 第 11 回合 6 水晶，日斑巨龙在手（快枪：造成 6 点伤害），
 *     对面一只 3/4，建议只说了「6/6 吸血，压上去正好」，那 6 点一个字没提。
 *
 * 判据都来自卡表摘要，不需要新数据；快枪生不生效看日志里的 POWERED_UP，
 * 别拿「第几回合进的手牌」猜（那是第二顺位）。
 */
const foeMinion = (o = {}) => minion({ id: 90, name: '火羽凤凰', cardId: 'CORE_UNG_084', atk: 3, health: 4, ...o });

test('战吼只能打随从、对面空场 —— 别当按费打的头名', () => {
  const b = briefAdvice(snap(
    side({ mana: 2, manaMax: 3, handCards: [
      { id: 1, cardId: 'WW_900', cost: 2 },   // 蹄铁发射机：战吼随机打敌方随从
      { id: 2, cardId: 'CS2_121', cost: 2 },   // 霜狼步兵 2/2 嘲讽（一个正常的身子）
    ] }),
    side({ isLocal: false, heroClass: '萨满', manaMax: 3, minions: [] }),
  ));
  assert.match(b.text, /霜狼步兵/, `空场还推了战吼没目标的牌:${b.text}`);
  assert.doesNotMatch(b.text, /蹄铁发射机/, `不该推白板:${b.text}`);
});

test('战吼能解掉对面那只时要点名', () => {
  const b = briefAdvice(snap(
    side({ mana: 2, manaMax: 3, handCards: [{ id: 1, cardId: 'WW_900', cost: 2 }] }),
    side({ isLocal: false, heroClass: '萨满', manaMax: 3, minions: [foeMinion({ id: 91, name: '火羽凤凰', atk: 1, health: 2 })] }),
  ));
  assert.match(b.text, /战吼 2 点能解掉/, `没算战吼能解谁:${b.text}`);
});

test('快枪没生效就明说「别算」——它只在本回合到手时才算', () => {
  const b = briefAdvice(snap(
    side({ mana: 6, manaMax: 6, handCards: [{ id: 1, cardId: 'WW_434', cost: 6, poweredUp: false }] }),
    side({ isLocal: false, heroClass: '萨满', manaMax: 6, minions: [foeMinion()] }),
  ));
  assert.match(b.text, /日斑巨龙/, b.text);
  assert.match(b.text, /快枪没生效/, `没说清那 6 点不成立:${b.text}`);
});

test('快枪生效时把那 6 点算进来 —— 能先点掉对面的 3/4', () => {
  const b = briefAdvice(snap(
    side({ mana: 6, manaMax: 6, handCards: [{ id: 1, cardId: 'WW_434', cost: 6, poweredUp: true }] }),
    side({ isLocal: false, heroClass: '萨满', manaMax: 6, minions: [foeMinion()] }),
  ));
  assert.match(b.text, /快枪 6 点能先点掉火羽凤凰\(3\/4\)/, `没算快枪那 6 点:${b.text}`);
});

test('带前提的战吼不许替它保证 —— 「战吼需控机械」没机械就别报伤害', () => {
  const b = briefAdvice(snap(
    side({ mana: 4, manaMax: 4, handCards: [{ id: 1, cardId: 'TOY_005', cost: 4 }] }),
    side({ isLocal: false, heroClass: '萨满', manaMax: 4, minions: [foeMinion()] }),
  ));
  // 迷你灭世者是「战吼 伤害4 战吼需控机械」；没机械时那 4 点打不出来，不能报
  assert.doesNotMatch(b.text, /战吼 4 点能/, `替条件战吼保证了伤害:${b.text}`);
});

test('「无法攻击」的随从不算对面场攻 —— 上古看守者挂着 4 点，一分也打不出来', () => {
  const keeper = minion({ id: 2, name: '上古看守者', cardId: 'EX1_045', atk: 4, health: 5, cantAttack: true, canAttack: false });
  const t = threatInfo(snap(side(), side({ isLocal: false, heroClass: '', manaMax: 2, minions: [keeper] })));
  assert.equal(t.minionAttack, 0, '无法攻击的随从被算进了场攻');
  assert.equal(t.enemyAttack, 0, '对面场攻里混进了打不出来的随从');
});

test('刚下场的随从(召唤失调)下回合就能打,仍然要算进威胁', () => {
  // 这一条是上一条的反面:不能为了排掉「无法攻击」,把刚铺下来的随从一起排掉
  const fresh = minion({ id: 3, name: '石丘防御者', atk: 1, health: 5, canAttack: false, cantAttack: false });
  const t = threatInfo(snap(side(), side({ isLocal: false, heroClass: '', manaMax: 2, minions: [fresh] })));
  assert.equal(t.minionAttack, 1, '刚下场的随从被误当成打不出来');
});

test('休眠的随从也不算场攻', () => {
  const asleep = minion({ id: 4, name: '被禁锢的萨特', atk: 4, health: 4, cantAttack: true, canAttack: false });
  const t = threatInfo(snap(side(), side({ isLocal: false, heroClass: '', manaMax: 2, minions: [asleep] })));
  assert.equal(t.minionAttack, 0, '休眠的随从被算进了场攻');
});

test('2 费回合对面下 4/5 上古看守者 —— 不许说她「下回合能打出攻击」', () => {
  const keeper = minion({ id: 2, name: '上古看守者', cardId: 'EX1_045', atk: 4, health: 5, cantAttack: true, canAttack: false });
  const b = briefAdvice(snap(
    side({ mana: 2, manaMax: 2 }),
    side({ isLocal: false, heroClass: '', mana: 2, manaMax: 2, minions: [keeper] }),
  ));
  assert.doesNotMatch(b.text, /下回合能打出攻击/, `把「无法攻击」的随从说成能打:${b.text}`);
  assert.match(b.text, /打不出来/, `没点明它动不了:${b.text}`);
});

test('衍生物不是「锻造后的本体」—— 快乐的雏龙不许回落到德鲁伊法术', () => {
  // WW_816t 是德鲁伊法术「飞向天空」召出来的 1/2 雏龙。
  // 旧逻辑把所有 `_t` 都当锻造形态回落到本体（WW_816 = 「飞向天空」），
  // 于是职业读成德鲁伊 —— 2026-10-24 第 24 回合对面是死亡骑士、场上冒出这只雏龙，
  // 她就报了「这是德鲁伊的牌，他玩的是死亡骑士」。
  //
  // 2026-11-06 起卡表也收衍生 token，所以这张**自己在表里**了（中立 1/2 嘲讽）。
  // 断言跟着改成「认自己」，重点仍是不许回落成德鲁伊法术。
  assert.equal(cardClassZh('WW_816t'), '中立', '它是中立的衍生物，该认自己');
  assert.notEqual(cardClassZh('WW_816t'), '德鲁伊', '回落到「飞向天空」就成德鲁伊法术了');
  // 反过来：本体真写着「可锻造」的，`_t` 仍然要回落（独眼突击者 3/3 → 锻造 6/5）
  assert.equal(cardClassZh('TTN_042t'), '中立', '可锻造卡的锻造形态回落坏了');
});

test('「无法攻击英雄」的武器不算打脸威胁 —— 无穷之手 4/2 只能砍随从', () => {
  const weapon = { cardId: 'END_012', name: '无穷之手', atk: 4, durability: 2, hitsHero: false };
  const t = threatInfo(snap(
    side(),
    side({ isLocal: false, heroClass: '', manaMax: 2, heroAttack: 4, weapon }),
  ));
  assert.equal(t.heroAttack, 0, '打不到脸的武器被算成了打脸伤害');
  assert.equal(t.enemyAttack, 0);

  const b = briefAdvice(snap(side(), side({ isLocal: false, heroClass: '', manaMax: 2, heroAttack: 4, weapon })));
  assert.match(b.text, /无法攻击英雄/, `没说明这把刀为什么不算:${b.text}`);
  assert.doesNotMatch(b.text, /也算在场攻里/, `还在说它进打脸场攻:${b.text}`);
});

test('普通武器照旧算进打脸威胁', () => {
  const weapon = { cardId: 'CS2_106', name: '奥金斧', atk: 5, durability: 2, hitsHero: true };
  const t = threatInfo(snap(side(), side({ isLocal: false, heroClass: '', manaMax: 2, heroAttack: 5, weapon })));
  assert.equal(t.heroAttack, 5, '能砍脸的武器被误伤排掉了');
});

test('场上法强要进 AOE 清场计算 —— 差 1 点就是「清不掉」和「全清」的分界', () => {
  // 麦芽岩浆(VAC_323)牌面「伤害1群」。场上站个电击学徒(+1 法术伤害),实际打 2 点。
  const me = side({ mana: 5, manaMax: 5, spellPower: 1, handCards: [{ id: 1, cardId: 'VAC_323', cost: 2 }] });
  const foe = side({ isLocal: false, minions: [minion({ id: 2, name: '太阳舞者', atk: 1, health: 2 })] });
  const out = aoeOptions(snap(me, foe));
  assert.equal(out.length, 1, `法强没进 AOE 计算:${JSON.stringify(out)}`);
  assert.equal(out[0].clears.length, 1, '1+1=2 点应该能清掉 2 血随从');

  // 没有法强时这张牌清不掉 2 血 —— 反过来确认不是把阈值放松了
  const plain = aoeOptions(snap(side({ mana: 5, manaMax: 5, spellPower: 0, handCards: [{ id: 1, cardId: 'VAC_323', cost: 2 }] }), foe));
  assert.equal(plain.length, 0, '没有法强时不该报能清场');
});

test('手牌里有衍生物时用日志里的名字,不念卡号', () => {
  // BE_327t 是「秘典翻译官」的变形体,卡表里没有;VAC_323t2 是「麦芽岩浆」的变体。
  // 只用 cardId 查表会念出 `BE_327t(4费)`,实测被吐槽「她在说乱码」。
  const hand = readHand(side({ mana: 4, handCards: [{ id: 1, cardId: 'BE_327t', name: '秘典翻译官', cost: 4 }] }));
  assert.equal(hand[0].name, '秘典翻译官', `读到的是:${hand[0].name}`);
});

test('潜行者已经有武器时,技能不再额外算 1 点 —— 那把刀不能数两遍', () => {
  // 潜行者技能是「装备一把 1/2 匕首」:刀已经在手上了,技能只是换一把,不会多砍一下。
  // 实测 2026-10-24 第 9 回合:对面挂邪恶短刀(1/2),她报「场攻 4(随从 2 + 武器/英雄 1 + 技能 1)」,
  // 实际只有 3。
  const w = { cardId: 'CS2_082', name: '邪恶短刀', atk: 1, durability: 2, hitsHero: true };
  const t = threatInfo(snap(side(), side({ isLocal: false, heroClass: '潜行者', manaMax: 5, heroAttack: 1, weapon: w })));
  assert.equal(t.heroPowerDamage, 0, '技能那 1 点是把同一把刀数了两遍');
  assert.equal(t.enemyAttack, 1, '场上只有那把刀的 1 点');

  // 没武器的时候,技能确实能装刀砍 1 点 —— 别把这条一起排掉
  const bare = threatInfo(snap(side(), side({ isLocal: false, heroClass: '潜行者', manaMax: 5 })));
  assert.equal(bare.heroPowerDamage, 1, '空手时技能仍能打 1 点');
});

test('群伤牌留着清场,不许劝他去打那 1 点脸伤', () => {
  // 麦芽岩浆「伤害1群」:对面一只 8 血随从清不掉,这时候提「顺带 1 点直伤」
  // 就是在教他把清场牌当小火球扔。实测 2026-10-24 第 10 回合他当场反问。
  const b = briefAdvice(snap(
    side({ mana: 2, manaMax: 2, handCards: [{ id: 1, cardId: 'VAC_323', cost: 2 }] }),
    side({ isLocal: false, heroClass: '', manaMax: 2, minions: [minion({ id: 2, name: '滑行者巨怪', atk: 1, health: 8 })] }),
  ));
  assert.doesNotMatch(b.text, /顺带 \d+ 点直伤/, `把群伤牌当直伤用了:${b.text}`);
});

test('场上没有随从时,「使一个随从获得圣盾」打不出去 —— 别推它', () => {
  // 魔菇采掘(DEEP_018)是「使一个随从获得圣盾。发掘一个宝藏。」
  // 费用够不代表能出:没随从就没目标。实测 2026-10-24 第 3 回合我方空场,
  // 她推「按费打:魔菇采掘」,他反问「场上没有随从怎么用蘑菇啊」。
  const b = briefAdvice(snap(
    side({ mana: 2, manaMax: 2, minions: [], handCards: [
      { id: 1, cardId: 'DEEP_018', cost: 2 },
      { id: 2, cardId: 'DEEP_008', cost: 2 },   // 针岩图腾 0/2 抽1 甲2,不需要目标
    ] }),
    side({ isLocal: false, heroClass: '', manaMax: 2 }),
  ));
  assert.doesNotMatch(b.text, /按费打:魔菇采掘/, `空场还推贴盾牌:${b.text}`);
  assert.match(b.text, /针岩图腾|巫毒图腾/, `该推那张不需要目标的:${b.text}`);
});



test('场上随从名字取空时,要回查卡表,不能把内部 id 递给她', () => {
  // 2026-10-28 实测:建议回执里写着「场面 …FIR_953 5/8」,而卡表里它叫「熔岩猎犬」。
  // 实体 NAME 标签在出牌那一瞬间常是空的,`name` 一空就落到 `cardId`,她只能照着念编号。
  const s = snap(
    side({ minions: [minion({ id: 7, name: '', cardId: 'FIR_953', atk: 5, health: 8 })] }),
    side({ isLocal: false }),
  );
  const prompt = buildModelPrompt(s);
  assert.match(prompt, /熔岩猎犬 5\/8/, `卡表兜底没生效:${prompt}`);
  assert.doesNotMatch(prompt, /FIR_953/, `内部 id 漏给她了:${prompt}`);

  const rendered = renderAdvice(advise(s), s);
  assert.match(rendered, /熔岩猎犬/, `排版那一路也要兜底:${rendered}`);
  assert.doesNotMatch(rendered, /FIR_953/);
});

test('卡表也查不到的衍生物,照样不许露内部 id', () => {
  // CATA_190t14 是 12/12 的衍生物,卡表里没有。露 id 对她零信息量,
  // 她读到「对手场上多了 CATA_190t14」只会含糊过去。
  const s = snap(
    side(),
    side({ isLocal: false, minions: [minion({ id: 3, name: '', cardId: 'CATA_190t14', atk: 12, health: 12 })] }),
  );
  const prompt = buildModelPrompt(s);
  assert.doesNotMatch(prompt, /CATA_190t14/, `衍生物 id 漏出去了:${prompt}`);
});

test('对面空场时,要把「你这点攻打脸能压到多少」说出来', () => {
  // 2026-10-28 实测:对手从第 6 回合起一直空场,血量九个回合停在 29;
  // 而回合正文只报了「对面场攻 1,还压不到我」——只报了要挨打的那一半。
  // 她手上没有这个数,只能问「你随从是不是没往脸上打?」,一句疑问就过去了。
  const s = snap(
    side({ health: 12, handCards: [{ id: 9, cardId: 'CS2_024', cost: 2 }],
      minions: [minion({ id: 1, name: '哨卫', atk: 5, health: 8 })] }),
    side({ isLocal: false, health: 29 }),
  );
  const brief = briefAdvice(s);
  assert.match(brief.text, /5 点攻/, brief.text);
  assert.match(brief.text, /29 血掉到 24/, brief.text);
});

test('对面有随从时不提「全打脸」—— 该换还是该打是另一件事', () => {
  const s = snap(
    side({ handCards: [{ id: 9, cardId: 'CS2_024', cost: 2 }],
      minions: [minion({ id: 1, atk: 5, health: 8 })] }),
    side({ isLocal: false, health: 29, minions: [minion({ id: 5, atk: 2, health: 2 })] }),
  );
  assert.doesNotMatch(briefAdvice(s).text, /全打脸/, briefAdvice(s).text);
});

/* ---------- 卡表摘要的「随机」要管对地方 ---------- */

test('大力扣杀：伤害是定向的，只有给友方的 buff 是随机', () => {
  // 真实效果（多来源核实）：造成 4 点伤害。随机使一个【友方】随从获得 +4/+4。
  // 卡表原来写成 `伤害4随机随从 +4/+4`，被读成「随机打一只敌方随从」——
  // 2026-10-30 实测她说成「4 点伤是随机的，两只不一定都死」，
  // 而日志里明明写着 `打出 大力扣杀 → 拨号机器人`（箭头指目标），那一下是必中的。
  const card = { name: '大力扣杀', cardId: 'VAC_915', note: '伤害4(仅随从) 随机给友方+4/+4' };
  const r = playDamage(card, 0);
  assert.equal(r.damage, 4);
  assert.equal(r.minionOnly, true, '这张牌打不了脸，「随从」必须紧跟伤害数字才判得出来');
});

test('卡表里大力扣杀不能写成「随机随从」形态', async () => {
  const { readFileSync } = await import('node:fs');
  const data = JSON.parse(readFileSync(new URL('../src/data/cards.json', import.meta.url), 'utf8'));
  const note = data.cards?.VAC_915?.[3] ?? '';
  assert.ok(!/伤害\s*4\s*随机随从/.test(note), `又写成「伤害4随机随从」了：${note}`);
  assert.match(note, /随机给友方/, '随机那半句必须写明是给友方的 buff');
});

test('斩杀要说清「多少点去撞墙了」—— 不然听起来像全砸在脸上', () => {
  // 2026-11-06：总攻 31、对面 10 血、站着 5/5 嘲讽。
  // 原来的文案是「能斩杀:场攻 21 打脸 = 21」—— 21 是对的（扣过墙），
  // 但它读起来像 21 点全打脸，中间撞墙那一步看不见。
  const mk = (o) => ({
    name: '', cardId: '', atk: 0, health: 1, taunt: false, divineShield: false,
    frozen: false, stealth: false, windfury: false, cantAttack: false, canAttack: true, ...o,
  });
  const me = side({
    mana: 10, manaMax: 10,
    minions: [mk({ atk: 10, health: 10 }), mk({ atk: 10, health: 10 }), mk({ atk: 11, health: 10 })],
  });
  const foe = side({ isLocal: false, health: 10, minions: [mk({ atk: 5, health: 5, taunt: true })] });
  const b = briefAdvice(snap(me, foe));
  assert.equal(b.kind, 'lethal');
  assert.match(b.text, /撞墙/, `过墙吃掉的那部分要说出来：${b.text}`);
  assert.match(b.text, /总攻 31/, `总攻要露出来做对照：${b.text}`);

  // 没有墙的时候不许画蛇添足
  const open = briefAdvice(snap(me, side({ isLocal: false, health: 10 })));
  assert.equal(open.kind, 'lethal');
  assert.doesNotMatch(open.text, /撞墙/, `对面空场还提过墙是废话：${open.text}`);
});

test('手牌里有 buff 就要说出「贴给谁、变多少」—— 原来只在斩杀路径上提', () => {
  /*
   * 2026-11-14 报障：「buff 情况的牌她都没有反应」。
   *
   * 查下来 buff 整条链上只出现在**斩杀计算**里（lethal.buffs / buffDamage），
   * 这回合斩不了，她一个字都不提 —— 手牌里躺着一张英勇圣印，场上还有随从，
   * 给模型的局面描述里当它不存在。
   *
   * 现在只补**事实**：哪张能打、贴给谁、贴完多少。贴不贴是她自己的判断。
   */
  const s = snap(
    side({
      mana: 3,
      // 英勇圣印：3 费 +3 攻
      handCards: [{ id: 1, cardId: 'AT_074', cost: 3 }],
      minions: [minion({ id: 10, name: '步兵', atk: 2, health: 4 })],
    }),
    side({ playerId: 2, isLocal: false }),
  );
  const prompt = buildModelPrompt(s);
  assert.match(prompt, /手牌里有 buff/, '没提到手牌里有 buff');
  assert.match(prompt, /英勇圣印/, '没说出是哪张');
  assert.match(prompt, /5\/4/, '没算出贴完是 5/4（2+3 攻）');
});

test('水晶不够的 buff 不该出现在提示里', () => {
  const s = snap(
    side({
      mana: 1,
      handCards: [{ id: 1, cardId: 'AT_074', cost: 3 }],  // 3 费，只有 1 水晶
      minions: [minion({ id: 10, name: '步兵', atk: 2, health: 4 })],
    }),
    side({ playerId: 2, isLocal: false }),
  );
  assert.doesNotMatch(buildModelPrompt(s), /手牌里有 buff/, '打不出来的 buff 不该提');
});

test('场上没随从时 buff 一文不值，别提', () => {
  const s = snap(
    side({ mana: 5, handCards: [{ id: 1, cardId: 'AT_074', cost: 3 }], minions: [] }),
    side({ playerId: 2, isLocal: false }),
  );
  assert.doesNotMatch(buildModelPrompt(s), /手牌里有 buff/, '空场贴不了 buff，不该提');
});

test('+N/+N 的 buff 要把血量一起算进去', () => {
  /*
   * 2026-11-14：buff 表原来只有 [名称, 费用, 攻击力] —— `+2/+2` 的牌
   * 被记成「+2攻」，贴上去只会说「变 5/4」而实际是「5/6」。
   *
   * 斩杀数字不受影响（血不加伤害），但**描述错了**，他会照着错的数判断。
   */
  const s = snap(
    side({
      mana: 2,
      // 加固：2 费 +2/+2
      handCards: [{ id: 1, cardId: 'AT_068', cost: 2 }],
      minions: [minion({ id: 10, name: '步兵', atk: 3, health: 4 })],
    }),
    side({ playerId: 2, isLocal: false }),
  );
  const prompt = buildModelPrompt(s);
  assert.match(prompt, /加固/, '没说出牌名');
  assert.match(prompt, /5\/6/, '没算出 3+2 / 4+2 = 5/6');
});

test('对手随从的「能不能攻击」按他的回合说,不按我这一手说', () => {
  /*
   * 2026-11-19 实测的那一句：
   *   「对手场攻 15(随从 15)」配「鱼人拉法姆 5/5(不能攻击)、虚空领主 3/7(不能攻击)…」
   * 同一段话里两套口径 —— 场攻把它们的攻击力算进去了，场面又说他打不出来。
   * 原因是对面刚铺下来的随从这一刻 canAttack=false（召唤失调），到了他的回合全能打。
   *
   * 判据：对手只标**永久**打不了的（cantAttack）；我方仍按这一回合的 canAttack 标。
   */
  const s = snap(
    side({ health: 27, minions: [minion({ id: 1, atk: 2, health: 2, canAttack: false })] }),
    side({ isLocal: false, health: 6, minions: [
      minion({ id: 21, atk: 5, health: 5, canAttack: false }),
      minion({ id: 22, atk: 3, health: 7, taunt: true, canAttack: false }),
    ] }),
  );
  const text = renderAdvice(advise(s), s);
  const foeLine = text.split('\n').find((l) => l.startsWith('对手:')) ?? '';
  const meLine = text.split('\n').find((l) => l.startsWith('我:')) ?? '';
  assert.doesNotMatch(foeLine, /不能攻击/, '对手的召唤失调不该标成「不能攻击」');
  assert.match(foeLine, /5\/5/, '随从本身仍要列出来');
  assert.match(meLine, /不能攻击/, '我方这回合打不了就该标出来');
});

test('对手永久打不了的随从仍然要标出来', () => {
  const s = snap(
    side({ health: 27 }),
    side({ isLocal: false, health: 6, minions: [minion({ id: 21, atk: 0, health: 4, cantAttack: true })] }),
  );
  const text = renderAdvice(advise(s), s);
  const foeLine = text.split('\n').find((l) => l.startsWith('对手:')) ?? '';
  assert.match(foeLine, /打不了/, '休眠/无法攻击的随从要标出来');
});
