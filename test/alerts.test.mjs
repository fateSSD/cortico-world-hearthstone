/**
 * 告警与紧迫度。
 *
 * 用户要的是「局势变了能有不同反应」——不是多报几条,而是**同一条消息用不同重量说**。
 * 所以每条告警都带一个 tone,推送时渲染成〔提醒〕〔紧张〕〔危险〕,
 * 她在提示词里学过这三档该怎么换口吻。
 *
 * 这一组测试盯两件事:
 *   1. 新加的「局势转向」型告警真的会触发(不是只写了代码)
 *   2. tone 分档没搞反 —— 快死了报〔提醒〕是最糟的错
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAlerts, endText, faceOf, lethalText, surpriseAlerts, toneOf } from '../src/alerts.ts';

const minion = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 0, health: 1, maxHealth: 1,
  taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false,
  poisonous: false, lifesteal: false, reborn: false, rush: false, charge: false, canAttack: true, ...o,
});

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 30, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 3, handCards: [], deckCount: 20, secrets: 0,
  spellPower: 0, minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe, extra = {}) => ({
  startedAt: '', turn: 8, activePlayerId: 1, isMyTurn: true, step: 'MAIN_ACTION', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 }, ...extra,
});

const ctx = (before, now, extra = {}) => ({ before, now, alertHealth: 10, swarmCount: 4, ...extra });

test('残血是〔紧张〕,濒死是〔危险〕—— 不能搞反', () => {
  const low = detectAlerts(ctx(snap(side({ health: 14 }), side()), snap(side({ health: 9 }), side())));
  const lowAlert = low.find((a) => a.id === 'low-health');
  assert.ok(lowAlert);
  assert.equal(toneOf(lowAlert), 'tense');

  const critical = detectAlerts(ctx(snap(side({ health: 9 }), side()), snap(side({ health: 4 }), side())));
  const critAlert = critical.find((a) => a.id === 'critical-health');
  assert.ok(critAlert);
  assert.equal(toneOf(critAlert), 'danger');
});

test('能斩杀是〔提醒〕,被人斩杀是〔危险〕', () => {
  const win = detectAlerts(ctx(
    snap(side(), side({ health: 8 }), { boardAttack: { mine: 3, theirs: 0 } }),
    snap(side({ minions: [minion({ id: 1, atk: 12, health: 12 })] }), side({ health: 8 })),
  ));
  const boardLethal = win.find((a) => a.id === 'board-lethal');
  assert.ok(boardLethal, win.map((a) => a.id).join(','));
  assert.equal(toneOf(boardLethal), 'calm');

  const die = detectAlerts(ctx(
    snap(side({ health: 20 }), side({ minions: [minion({ id: 9, atk: 3, health: 3 })] }), { boardAttack: { mine: 0, theirs: 3 } }),
    snap(side({ health: 6 }), side({ minions: [minion({ id: 9, atk: 9, health: 3 })] }), { boardAttack: { mine: 0, theirs: 9 } }),
  ));
  const threat = die.find((a) => a.id === 'lethal-threat');
  assert.ok(threat, die.map((a) => a.id).join(','));
  assert.equal(toneOf(threat), 'danger');
});

/**
 * 回归:召唤失调的随从**这回合一点也打不出去**。
 *
 * 2026-10-24 用真实日志数出来的:`board-lethal` 在 6 份 Power.log 里一共只触发 4 次,
 * 4 次全是假的 —— 两次全场刚下场(不可动)、两次大半已动过。旧代码拿「场上随从攻击力合计」
 * 当「这回合能打出的伤害」,于是它偏偏在**刚铺完场**那一刻越过阈值,报「这一轮够斩杀了」。
 */
test('刚下场的随从不算这回合的攻击力 —— 不能报「够斩杀」', () => {
  const out = detectAlerts(ctx(
    snap(side(), side({ health: 12 })),
    snap(side({ minions: [
      minion({ id: 1, atk: 6, health: 6, canAttack: false }),
      minion({ id: 2, atk: 6, health: 6, canAttack: false }),
    ] }), side({ health: 12 }), { boardAttack: { mine: 12, theirs: 0 } }),
  ));
  assert.equal(out.some((a) => a.id === 'board-lethal'), false, `召唤失调的随从被算成这回合的斩杀了:${out.map((a) => a.text).join(' / ')}`);
});

test('一回合掉 8 血以上会报「被压着打」', () => {
  const out = detectAlerts(ctx(snap(side({ health: 26 }), side()), snap(side({ health: 17 }), side())));
  const momentum = out.find((a) => a.id === 'momentum');
  assert.ok(momentum, out.map((a) => a.id).join(','));
  assert.match(momentum.text, /掉了 9 血/);
  assert.equal(toneOf(momentum), 'tense');
});

test('掉得少就不报 —— 不能被每一次碰一下就刷', () => {
  const out = detectAlerts(ctx(snap(side({ health: 26 }), side()), snap(side({ health: 22 }), side())));
  assert.equal(out.some((a) => a.id === 'momentum'), false);
});

test('场面从我压着变成被反压,要报「场面翻了」', () => {
  const before = snap(side({ minions: [minion({ id: 1, atk: 8, health: 8 })] }), side(), { boardAttack: { mine: 8, theirs: 0 } });
  const now = snap(side({ minions: [] }), side({ minions: [minion({ id: 2, atk: 9, health: 9 })] }), { boardAttack: { mine: 0, theirs: 9 } });
  const out = detectAlerts(ctx(before, now));
  const reversal = out.find((a) => a.id === 'reversal');
  assert.ok(reversal, out.map((a) => a.id).join(','));
  assert.match(reversal.text, /场面翻了/);
});

test('差 1–5 点就能杀时,报「逼近斩杀」', () => {
  const out = detectAlerts(ctx(
    snap(side(), side({ health: 14 }), { boardAttack: { mine: 3, theirs: 0 } }),
    snap(side({ minions: [minion({ id: 1, atk: 12, health: 12 })] }), side({ health: 14 })),
  ));
  const near = out.find((a) => a.id === 'near-lethal');
  assert.ok(near, out.map((a) => a.id).join(','));
  assert.match(near.text, /还差 2 点/);
  assert.equal(toneOf(near), 'calm');
});

test('对面手牌攒到 8 张会提一句', () => {
  const out = detectAlerts(ctx(snap(side(), side({ handCount: 6 })), snap(side(), side({ handCount: 9 }))));
  const hoard = out.find((a) => a.id === 'foe-hoarding');
  assert.ok(hoard, out.map((a) => a.id).join(','));
  assert.equal(toneOf(hoard), 'calm');
});

test('对局结束时不再报任何告警', () => {
  const out = detectAlerts(ctx(snap(side({ health: 3 }), side()), snap(side({ health: 3 }), side(), { ended: true })));
  assert.deepEqual(out, []);
});

/* ---------- 表情 ---------- */

test('快死的告警给「吓到」的脸,不是温吞的担心', () => {
  assert.equal(faceOf({ id: 'critical-health', text: '' }), 'scared');
  assert.equal(faceOf({ id: 'lethal-threat', text: '' }), 'scared');
  assert.equal(faceOf({ id: 'low-health', text: '' }), 'worried');
});

test('优势局面给正面的脸', () => {
  assert.equal(faceOf({ id: 'board-lethal', text: '' }), 'excited', '够斩杀该兴奋');
  assert.equal(faceOf({ id: 'foe-low', text: '' }), 'determined');
});

test('顺时针每一条告警都有脸,不会留给默认值', () => {
  // 表情 id 必须是桌宠立绘包里真实存在的词,写错了会被静默丢弃(什么都不发生)
  const FACE_IDS = new Set([
    'neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad',
    'sleepy', 'thinking', 'smug', 'pout', 'worried', 'determined', 'flustered',
    'scared', 'excited', 'cry', 'confused',
  ]);
  const ids = ['critical-health', 'lethal-threat', 'fatigue', 'low-health', 'swarmed',
    'empty-board', 'empty-hand', 'deck-low', 'momentum', 'reversal', 'foe-low',
    'board-lethal', 'near-lethal', 'mana-flooded', 'foe-hoarding'];
  for (const id of ids) {
    const face = faceOf({ id, text: '' });
    assert.ok(FACE_IDS.has(face), `${id} 给了不存在的表情 id: ${face}`);
    assert.notEqual(face, 'neutral', `${id} 应该有具体的脸`);
  }
});

/* ---------- 2026-10-24 「下回合斩杀没算对面能交换我的随从」 ---------- */

test('斩杀线要报「下回合最坏情况」—— 对面是先动手的那一方', () => {
  // 我场攻 8(6/8 + 1/1 + 1/1),对面血 25;他一只 8/8 能动手
  const now = snap(
    side({ health: 19, minions: [
      minion({ id: 1, atk: 6, health: 8 }),
      minion({ id: 2, atk: 1, health: 1 }),
      minion({ id: 3, atk: 1, health: 1 }),
    ] }),
    side({ isLocal: false, health: 25, minions: [minion({ id: 21, atk: 8, health: 8 })] }),
  );
  const text = lethalText(now);
  assert.match(text, /最坏情况/, `只报了当前场攻,没说对面能换掉:${text}`);
  assert.match(text, /只剩 2/, `最坏情况的数算错了:${text}`);
  assert.match(text, /现在 8/, `没把「现在」和「最坏」分开:${text}`);
});

test('对面一只能打的都没有时,不啰嗦这句', () => {
  const now = snap(
    side({ health: 19, minions: [minion({ id: 1, atk: 5, health: 5 })] }),
    side({ isLocal: false, health: 25, minions: [minion({ id: 21, atk: 0, health: 4, taunt: true })] }),
  );
  assert.doesNotMatch(lethalText(now), /最坏情况/, '对面打不到随从,这句是噪音');
});

test('对手回合不报「这一轮够斩杀」—— 那个数字还没兑现', () => {
  // 对手回合里我场攻 12,对面 8 血:这不是「这一轮够了」,是他动手之前的样子
  const out = detectAlerts(ctx(
    snap(side({ health: 20 }), side({ health: 8 })),
    snap(side({ health: 20 }), side({ health: 8 }), { isMyTurn: false, boardAttack: { mine: 12, theirs: 3 } }),
  ));
  assert.equal(out.some((a) => a.id === 'board-lethal'), false, out.map((a) => a.id).join(','));
});

test('对手回合也不报「逼近斩杀」—— 他会先把场面拆掉', () => {
  const out = detectAlerts(ctx(
    snap(side({ health: 20 }), side({ health: 14 })),
    snap(side({ health: 20 }), side({ health: 14 }),
      { isMyTurn: false, boardAttack: { mine: 12, theirs: 3 } }),
  ));
  assert.equal(out.some((a) => a.id === 'near-lethal'), false, out.map((a) => a.id).join(','));
});

/* ---------- 2026-10-24:对手打出「出乎意料」的牌 ---------- */

/**
 * 需求是「对面打出出乎意料的卡时让她惊讶一下」。
 *
 * 难点不在表情，在**判据**：什么算意外。这里只认三条客观事实 ——
 * 跨职业（只可能是发现/偷来的）、比他这回合水晶还贵的牌（靠减费/硬币硬凑）、
 * 超大身材。纯高费、纯传说**不算**：对手后期打出 10 费传说是按计划，不叫意外。
 * 惊一次是惊喜，惊五次是噪音。
 */
const actA = (o = {}) => ({ seq: 1, turn: 8, who: 'opponent', kind: 'play', text: '打出 某牌', ...o });

test('跨职业牌:他的职业打不出这张,只可能是发现或偷来的', () => {
  // 对手是法师，打出一张德鲁伊的牌（德鲁伊牌 id 用 DEEP_027 暗石守卫）
  const out = surpriseAlerts([actA({ cardId: 'DEEP_027', cost: 4, atk: 6, health: 8 })], null, snap(
    side(), side({ isLocal: false, heroClass: '法师', manaMax: 8 }),
  ));
  const hit = out.find((a) => a.id.startsWith('surprise:'));
  assert.ok(hit, '没认出来');
  assert.match(hit.text, /德鲁伊的牌/);
  assert.match(hit.text, /法师/);
  assert.equal(faceOf(hit), 'surprised', '这种时刻该是惊讶的脸');
});

test('比他这回合水晶还贵的牌:靠减费或硬币硬打出来的', () => {
  const out = surpriseAlerts([actA({ cardId: 'TTN_075', cost: 9, atk: 3, health: 8 })], null, snap(
    side(), side({ isLocal: false, heroClass: '法师', manaMax: 5 }),
  ));
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].text, /9 费/);
  assert.match(out[0].text, /只有 5 点水晶/);
});

test('超大身材:一只 8/8 以上突然压场', () => {
  const out = surpriseAlerts([actA({ cardId: 'CS2_029', cost: 4, atk: 8, health: 8 })], null, snap(
    side(), side({ isLocal: false, heroClass: '法师', manaMax: 8 }),
  ));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /8\/8/);
});

test('纯高费传说**不算**意外 —— 他水晶够、职业也对,那就是按计划出牌', () => {
  // 法师打出一张法师的 8 费传说，水晶够
  const out = surpriseAlerts([actA({ cardId: 'TTN_075', cost: 8, atk: 3, health: 8 })], null, snap(
    side(), side({ isLocal: false, heroClass: '法师', manaMax: 10 }),
  ));
  assert.deepEqual(out, [], `按计划出牌不该惊讶:${JSON.stringify(out)}`);
});

test('只盯对手:自己打出的牌不触发', () => {
  const out = surpriseAlerts([actA({ who: 'me', cardId: 'DEEP_027', cost: 4 })], null, snap(
    side(), side({ isLocal: false, heroClass: '法师', manaMax: 8 }),
  ));
  assert.deepEqual(out, []);
});

test('对手职业读不到时不硬判 —— 没得比就是不比', () => {
  const out = surpriseAlerts([actA({ cardId: 'DEEP_027', cost: 4 })], null, snap(
    side(), side({ isLocal: false, heroClass: '', manaMax: 8 }),
  ));
  assert.deepEqual(out, [], '职业未知时不能判跨职业');
});

test('一次冒出好几只时合并成一条 —— 惊讶不是通报', () => {
  // 实测里见过:对手一次随机召唤直接添了三只跨职业随从。分三条推过去就是刷屏。
  const before = snap(side(), side({ isLocal: false, heroClass: '萨满', manaMax: 8, minions: [] }));
  const now = snap(side(), side({ isLocal: false, heroClass: '萨满', manaMax: 8, minions: [
    minion({ id: 1, atk: 3, health: 3, cardId: 'DEEP_027' }),   // 德鲁伊
    minion({ id: 2, atk: 4, health: 4, cardId: 'TTN_075' }),    // 法师
    minion({ id: 3, atk: 2, health: 2, cardId: 'BAR_328' }),    // 恶魔猎手
  ] }));
  const out = surpriseAlerts([], before, now);
  assert.equal(out.length, 1, `该合并成一条:${out.map((a) => a.text).join(' / ')}`);
  assert.match(out[0].text, /暗石守卫/);
  assert.match(out[0].text, /诺甘农/);
  assert.equal(faceOf(out[0]), 'surprised');
});

test('变形体只算一次 —— 同一张牌的 `t` 版本不该惊第二下', () => {
  const before = snap(side(), side({ isLocal: false, heroClass: '法师', manaMax: 8, minions: [] }));
  const now = snap(side(), side({ isLocal: false, heroClass: '法师', manaMax: 8, minions: [
    minion({ id: 1, atk: 3, health: 3, cardId: 'VAC_511' }),
    minion({ id: 2, atk: 3, health: 3, cardId: 'VAC_511t' }),
  ] }));
  const out = surpriseAlerts([], before, now);
  assert.equal(out.length, 1, `变形体和本体被算成两件事:${out.map((a) => a.text).join(' / ')}`);
});

/* ---------- 2026-10-24:疲劳的两个来源不是一回事 ---------- */

/**
 * `tag=FATIGUE` 只是「这个英雄被疲劳伤害过几次」,**不是「牌库空了」**。
 *
 * 实测那局:牧师挂上黑暗帝国之刃后,我的层数从 1 涨到 8,而牌库还有二十多张。
 * 旧文案一律说「牌库抽干了」—— 他会真以为牌库没了,然后按错的理由做决策。
 * 牌库空没空只看 deckCount。
 */
test('疲劳层数涨了、牌库却还有牌 —— 那是卡片效果,不是抽干', () => {
  const out = detectAlerts(ctx(
    snap(side({ deckCount: 23, fatigue: 0 }), side()),
    snap(side({ deckCount: 23, fatigue: 1 }), side()),
  ));
  const a = out.find((x) => x.id === 'fatigue-effect');
  assert.ok(a, out.map((x) => x.id).join(','));
  assert.match(a.text, /牌库还有 23 张/);
  assert.doesNotMatch(a.text, /牌库抽干/, `牌库还在,却说抽干了:${a.text}`);
  assert.equal(toneOf(a), 'tense');
  assert.equal(faceOf(a), 'worried');
  // 旧的那条不能同时冒出来
  assert.equal(out.find((x) => x.id === 'fatigue'), undefined);
});

test('牌库真空了才说「抽干了」', () => {
  const out = detectAlerts(ctx(
    snap(side({ deckCount: 0, fatigue: 0 }), side()),
    snap(side({ deckCount: 0, fatigue: 1 }), side()),
  ));
  const a = out.find((x) => x.id === 'fatigue');
  assert.ok(a, out.map((x) => x.id).join(','));
  assert.match(a.text, /牌库抽干了/);
  assert.equal(out.find((x) => x.id === 'fatigue-effect'), undefined);
});
test('护甲不许说成血 —— 叠甲不是回血', () => {
  // 2026-10-28 实测:对手 9 血 + 12 护甲,提醒却写着「对面 21 血」,
  // 她照着念「他血量又回上来了,现在 21」—— 对手一滴血都没回,只是叠了甲。
  // 血量会掉也会回,护甲只增不减,这两件事在牌局里的意思完全不同。
  const out = detectAlerts(ctx(
    snap(side(), side({ health: 14, armor: 0 }), { boardAttack: { mine: 3, theirs: 0 } }),
    snap(side({ minions: [minion({ id: 1, atk: 17, health: 17 })] }), side({ health: 9, armor: 12 })),
  ));
  const near = out.find((a) => a.id === 'near-lethal');
  assert.ok(near, out.map((a) => a.id).join(','));
  assert.match(near.text, /9 血 \+ 12 护甲/, near.text);
  assert.match(near.text, /还差 4 点/, near.text);
  assert.doesNotMatch(near.text, /21 血/, `把护甲算进「血」了:${near.text}`);
});

test('我没有护甲时,「血」还是「血」—— 别加零碎前缀', () => {
  const out = detectAlerts(ctx(snap(side(), side()), snap(side({ health: 9 }), side())));
  const low = out.find((a) => a.id === 'low-health');
  assert.ok(low, out.map((a) => a.id).join(','));
  assert.doesNotMatch(low.text, /护甲/, low.text);
});

test('赢了但对手血没归零 —— 要点明他是退了,不是被打死', () => {
  // 2026-10-28 实测:对手 9 血 8 甲认输,播报却是「这局赢了 … 对手 17 血」,
  // 读起来自相矛盾。日志里 PLAYSTATE=LOST 而英雄 HEALTH 全程没到 0,可以判定是退了。
  const walked = snap(side({ health: 30 }), side({ health: 9, armor: 8 }), { ended: true, result: 'won' });
  assert.match(endText(walked), /他没打完就退了/, endText(walked));

  const killed = snap(side({ health: 30 }), side({ health: 0, armor: 0 }), { ended: true, result: 'won' });
  assert.doesNotMatch(endText(killed), /退/, endText(killed));
});
