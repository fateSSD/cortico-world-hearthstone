/**
 * 2026-11-03 那局（圣骑士 vs 萨满，21 回合输）暴露的四处算法问题。
 *
 * 这一局里她说的每句话都有原文可对，所以测试直接照那几个回合的样子造局面：
 *   · 第 2 回合：「雏龙牧人」被当成墙 → 「不值得当普通牌打，这回合宁可空过」
 *   · 第 14 回合：7 水晶只推一张 4 费，剩 3 费写句「剩 3 费」就完了
 *   · 第 20 回合：对面 3 面嘲讽，建议却写「直接抢脸」
 *   · 第 20 回合：同一时刻「攻 22」与「场攻合计 29」两个数并列出现
 *
 * 判据盯的是**她照着念会错的那句话**，不是内部字段：
 * 断言里出现的是用户能看见的文案，不是函数名或变量名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aoeCombos, briefAdvice, selfKeyword } from '../src/advice.ts';
import { turnText } from '../src/alerts.ts';

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
  startedAt: '', turn: 8, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 },
});

// ── 一、摘要里提「嘲讽」不等于自己是墙 ────────────────────────────────

test('自身的嘲讽认得出,「给别人加」的嘲讽不算', () => {
  // 雏龙牧人：2/3 本体，回合结束**获取**一张带嘲讽的雏龙
  assert.equal(selfKeyword('2/3 在你的回合结束时，获取一张1/2并具有嘲讽的雏龙。', '嘲讽'), false);
  // 战马训练师：给白银之手新兵加嘲讽
  assert.equal(selfKeyword('3/4 你的白银之手新兵拥有+2攻击力和嘲讽。', '嘲讽'), false);
  // 真本体：关键词就在身材后面那一截
  assert.equal(selfKeyword('3/2 嘲讽 战吼', '嘲讽'), true);
  assert.equal(selfKeyword('3/4 预备 嘲讽', '嘲讽'), true);
  // 条件性嘲讽（战争古树）保守当成没有 —— 少算一面墙不致命
  assert.equal(selfKeyword('5/5 抉择： +5攻击力；或者+5生命值并具有嘲讽。', '嘲讽'), false);
});

test('第 2 回合那种「只有雏龙牧人」的局面,给「按费打」不给「宁可空过」', () => {
  const s = snap(
    side({
      mana: 2, manaMax: 2, handCount: 1,
      handCards: [{ id: 1, cardId: 'WW_827', cost: 2 }],
    }),
    side({ isLocal: false, mana: 2, manaMax: 2 }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /雏龙牧人/, '要提到那张牌');
  assert.doesNotMatch(text, /宁可空过/, '2 费 2/3 铺场牌不是「不值得当普通牌打」');
  assert.match(text, /按费打/, '该照常走下牌建议');
});

// ── 二、按费打要填到打不动为止 ──────────────────────────────────────

test('7 水晶、4/2/1 费三张都能打,三张都要出现在建议里', () => {
  const s = snap(
    side({
      mana: 7, manaMax: 7, handCount: 3,
      handCards: [
        { id: 1, cardId: 'CS2_182', cost: 4 },  // 冰风雪人 4/5
        { id: 2, cardId: 'CS2_120', cost: 2 },  // 淡水鳄 2/3
        { id: 3, cardId: 'CS2_171', cost: 1 },  // 石牙野猪 1/1 冲锋
      ],
    }),
    side({ isLocal: false, mana: 7, manaMax: 7 }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /冰风雪人/);
  assert.match(text, /淡水鳄/);
  assert.match(text, /石牙野猪/);
  assert.doesNotMatch(text, /剩 \d+ 费/, '四费二费一费正好花完,不该再说「剩 N 费」');
});

test('填充不吃硬币:硬币只该为值得的那一张垫一次费用', () => {
  const s = snap(
    side({
      mana: 3, manaMax: 3, handCount: 3, coinCount: 1,
      handCards: [
        { id: 1, cardId: 'CS2_182', cost: 4 },  // 要打硬币才够
        { id: 2, cardId: 'CS2_120', cost: 2 },
        { id: 3, cardId: 'CS2_171', cost: 1 },
      ],
    }),
    side({ isLocal: false, mana: 3, manaMax: 3 }),
  );
  const text = briefAdvice(s).text;
  // 4+2+1=7 > 4(3 水晶 + 1 硬币) —— 三张全推就是教人超费
  const names = ['冰风雪人', '淡水鳄', '石牙野猪'].filter((n) => text.includes(n));
  assert.ok(names.length <= 2, `硬币只够垫一次,不能推三张:${names.join('、')}`);
});

// ── 三、对面有墙时不许说「直接抢脸」 ────────────────────────────────

test('危险回合 + 对面三面嘲讽:说墙,不说抢脸', () => {
  const s = snap(
    side({
      health: 8, mana: 4, manaMax: 4, handCount: 2,
      // 手上只有普通随从,一个嘲讽都没有
      handCards: [
        { id: 1, cardId: 'CS2_182', cost: 4 },
        { id: 2, cardId: 'CS2_120', cost: 2 },
      ],
      minions: [minion({ id: 11, cardId: 'CS2_120', name: '淡水鳄', atk: 2, health: 3 })],
    }),
    side({
      isLocal: false, health: 21, mana: 6, manaMax: 6,
      minions: [
        minion({ id: 21, name: '威能恐魔', atk: 5, health: 7, taunt: true }),
        minion({ id: 22, name: '迷时始祖幼龙', atk: 5, health: 5, taunt: true }),
        minion({ id: 23, name: '威能恐魔', atk: 5, health: 7, taunt: true }),
      ],
    }),
  );
  const text = briefAdvice(s).text;
  assert.doesNotMatch(text, /直接抢脸/, '三面嘲讽挡着,脸打不到');
  assert.match(text, /嘲讽/, '要把墙说出来');
  assert.match(text, /19/, '要报墙的总血量(7+5+7)');
});

test('对面没墙的时候,「抢脸」这句话还得留着', () => {
  const s = snap(
    side({
      health: 8, mana: 4, manaMax: 4, handCount: 1,
      handCards: [{ id: 1, cardId: 'CS2_182', cost: 4 }],
      minions: [minion({ id: 11, name: '淡水鳄', atk: 2, health: 3 })],
    }),
    side({
      isLocal: false, health: 21, mana: 6, manaMax: 6,
      minions: [
        minion({ id: 21, name: '威能恐魔', atk: 5, health: 7 }),
        minion({ id: 22, name: '迷时始祖幼龙', atk: 5, health: 5 }),
      ],
    }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /抢脸/, '没有墙时抢脸是可行的,不能一并删掉');
});

// ── 四、几张群伤叠起来才是解的时候,要说出来 ──────────────────────────

test('第 20 回合：四张群伤叠 7 点、9 费清掉三面墙,不再只说「先挨」', () => {
  const me = side({
    health: 20, mana: 10, manaMax: 10, handCount: 5, spellPower: 0,
    minions: [minion({ id: 31, name: '坦克机械师', atk: 2, health: 1, divineShield: true })],
    handCards: [
      { id: 1, cardId: 'CORE_CS2_093', cost: 3 },  // 奉献 伤害2群
      { id: 2, cardId: 'WW_336', cost: 2 },         // 棱彩光束 伤害3群随从（日志里被减到 2 费）
      { id: 3, cardId: 'BE_153', cost: 2 },         // 阳炎清算 伤害1群随从
      { id: 4, cardId: 'BE_153', cost: 2 },
      { id: 5, cardId: 'TIME_043', cost: 6 },       // 无穷永动机（普通随从，干扰项）
    ],
  });
  const foe = side({
    isLocal: false, health: 21, mana: 10, manaMax: 10, handCount: 5,
    minions: [
      minion({ id: 21, name: '威能恐魔', atk: 5, health: 7, taunt: true }),
      minion({ id: 22, name: '迷时始祖幼龙', atk: 5, health: 5, taunt: true }),
      minion({ id: 23, name: '威能恐魔', atk: 5, health: 7, taunt: true }),
      minion({ id: 24, name: '锋线铁裔', atk: 7, health: 9 }),
      minion({ id: 25, name: '治疗图腾', atk: 0, health: 2 }),
    ],
  });
  const s = snap(me, foe);
  const best = aoeCombos(s)[0];
  assert.equal(best.damage, 7, '2+3+1+1');
  assert.equal(best.cost, 9, '3+2+2+2');
  assert.equal(best.cut, 15, '清掉两只 5/7 和一只 5/5');

  const text = briefAdvice(s).text;
  assert.match(text, /叠起来清/, '要把这一手说出来');
  assert.match(text, /9 费/);
  assert.doesNotMatch(text, /直接抢脸/);
});

test('随机分配的群伤不参与叠加（下界是 0,不能当「能清」）', () => {
  const s = snap(
    side({ mana: 10, manaMax: 10, handCount: 1, handCards: [{ id: 1, cardId: 'EX1_279', cost: 10 }] }),
    side({
      isLocal: false,
      minions: [
        minion({ id: 21, name: '石头人', atk: 4, health: 8 }),
        minion({ id: 22, name: '石头人乙', atk: 4, health: 8 }),
      ],
    }),
  );
  for (const c of aoeCombos(s)) assert.doesNotMatch(c.text, /随机/);
});

// ── 六、剩费要说清为什么剩 / 法强要标出来 ────────────────────────────

test('第 14 回合：剩 3 费要说「剩下的都是留着清场的」,不能光报数', () => {
  const s = snap(
    side({
      mana: 7, manaMax: 7, handCount: 5,
      handCards: [
        { id: 1, cardId: 'EX1_306', cost: 4 },        // 石心之王 4 费
        { id: 2, cardId: 'CORE_CS2_093', cost: 3 },  // 奉献 3 费（群伤）
        { id: 3, cardId: 'BE_153', cost: 2 },         // 阳炎清算 2 费（群伤）
      ],
    }),
    side({ isLocal: false, mana: 7, manaMax: 7 }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /剩 3 费/);
  assert.match(text, /留着清场/, '要说清那 3 费为什么没花');
});

test('场上有法强时,群伤的点数要标出法强加了多少', () => {
  const s = snap(
    side({
      mana: 10, manaMax: 10, handCount: 2, spellPower: 1,
      handCards: [
        { id: 1, cardId: 'CORE_CS2_093', cost: 3 },  // 牌面 2 点
        { id: 2, cardId: 'WW_336', cost: 4 },        // 牌面 3 点
      ],
    }),
    side({
      isLocal: false,
      minions: [minion({ id: 21, name: '迷时始祖幼龙', atk: 5, health: 6, taunt: true })],
    }),
  );
  // 2+1 + 3+1 = 7 点。她按牌面算会得 5,不标法强就是两个数各说各的。
  const combo = aoeCombos(s)[0];
  assert.equal(combo.damage, 7);
  assert.match(combo.text, /含法强 \+1/);
});

// ── 七、脸被墙挡住时,除了说「得先过墙」,还要给过墙的办法 ────────────────

test('对面一面嘲讽挡着、手上两张群伤能拆:要说过墙的办法', () => {
  const s = snap(
    side({
      mana: 9, manaMax: 9, handCount: 3,
      minions: [minion({ id: 31, name: '瓦尼尔士兵', atk: 4, health: 4 })],
      handCards: [
        { id: 1, cardId: 'CORE_CS2_093', cost: 3 },
        { id: 2, cardId: 'WW_336', cost: 4 },
        { id: 3, cardId: 'CS2_182', cost: 4 },
      ],
    }),
    side({
      isLocal: false, health: 21, mana: 9, manaMax: 9,
      minions: [minion({ id: 21, name: '迷时始祖幼龙', atk: 5, health: 5, taunt: true })],
    }),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /要经过墙|得先过墙|拆墙/, '要承认墙挡着');
  assert.match(text, /奉献 \+ 棱彩光束/, '要给出拆墙的那一组牌');
  assert.match(text, /二选一|顺带还能过墙/, '费用够不够要交代清楚');
});

test('打得进脸的时候不提过墙（那是废话）', () => {
  const s = snap(
    side({
      mana: 6, manaMax: 6, handCount: 2,
      minions: [minion({ id: 31, name: '瓦尼尔士兵', atk: 6, health: 4 })],
      handCards: [
        { id: 1, cardId: 'CORE_CS2_093', cost: 3 },
        { id: 2, cardId: 'WW_336', cost: 4 },
      ],
    }),
    side({ isLocal: false, health: 21, mana: 6, manaMax: 6 }),
  );
  const text = briefAdvice(s).text;
  assert.doesNotMatch(text, /拆墙|过墙有办法/, '对面没有墙,别教过墙');
});

// ── 八、场攻两个口径要能对上 ────────────────────────────────────────
test('回合事件里风怒随从要给出两个口径,别和告警的 29 打架', () => {
  const s = snap(
    side({ health: 20, mana: 10, manaMax: 10, handCount: 5 }),
    side({
      isLocal: false, health: 21, mana: 10, manaMax: 10, handCount: 5,
      minions: [
        minion({ id: 21, name: '威能恐魔', atk: 5, health: 7, taunt: true }),
        minion({ id: 22, name: '迷时始祖幼龙', atk: 5, health: 5, taunt: true }),
        minion({ id: 23, name: '威能恐魔', atk: 5, health: 7, taunt: true }),
        minion({ id: 24, name: '锋线铁裔', atk: 7, health: 9, windfury: true }),
      ],
    }),
  );
  const text = turnText(s);
  // 身材和 22 / 风怒按两刀 29 —— 两个数都在,关系写清楚
  assert.match(text, /攻 22/);
  assert.match(text, /风怒算两刀 29/);
});
