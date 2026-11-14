/**
 * 开局换牌。
 *
 * 这一段的错法和「回合建议」不同:它没有第二次机会。换牌窗口只有一次,
 * 说错了、或者干脆不提,那一局就过去了。所以这里盯四件事:
 *   1. 窗口判据 —— 换完之后才开口是马后炮,比不说更糟;
 *   2. 硬币不参与留换 —— 后手那枚硬币本来就不在可换范围里;
 *   3. 建议只按费用和核心牌说话,不许出现卡牌效果(换牌阶段根本没有那些信息);
 *   4. 文案里不许露内部 id。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMulliganOpen, mulliganPlan, mulliganText, openingHand } from '../src/mulligan.ts';

const card = (cardId, cost, extra = {}) => ({
  id: 1, cardId, name: '', cost, prepared: false, poweredUp: false, ...extra,
});

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '圣骑士', heroName: '', heroCardId: '',
  health: 30, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 0, manaMax: 0, overload: 0, handCount: 0, handCards: [], coinCount: 0, deckCount: 26, secrets: 0,
  minions: [], weapon: null, playState: 'PLAYING', mulliganState: 'INPUT', ...o,
});

const snap = (me, o = {}) => ({
  startedAt: '', turn: 1, activePlayerId: 1, firstPlayerId: 1, isMyTurn: false,
  step: 'BEGIN_MULLIGAN', ended: false, result: null,
  me, opponent: side({ playerId: 2, isLocal: false, heroClass: '术士', mulliganState: 'DONE' }),
  boardAttack: { mine: 0, theirs: 0 }, ...o,
});

test('换牌窗口:只认还没换完的那一刻', () => {
  // 这是整段的地基。窗口关掉之后再说「建议换掉哪张」,是让人去做一件已经做不了的事。
  assert.equal(isMulliganOpen(snap(side({ mulliganState: 'INPUT' }))), true);
  assert.equal(isMulliganOpen(snap(side({ mulliganState: 'DEALING' }))), false);
  assert.equal(isMulliganOpen(snap(side({ mulliganState: 'WAITING' }))), false);
  assert.equal(isMulliganOpen(snap(side({ mulliganState: 'DONE' }))), false);
  // 状态还没写进来、但 STEP 已经进换牌:这一两帧也算开着(日志批次常卡在这里)
  assert.equal(isMulliganOpen(snap(side({ mulliganState: '' }), { step: 'BEGIN_MULLIGAN' })), true);
  assert.equal(isMulliganOpen(snap(side({ mulliganState: '' }), { step: 'MAIN_ACTION' })), false);
});

test('先手起手全是高费:建议全换,而不是硬留一张', () => {
  const s = snap(side({
    handCards: [card('BE_183', 8), card('BE_229', 7), card('JAIL_511', 5)],
  }));
  const plan = mulliganPlan(s);
  assert.equal(plan.keep.length, 0, `不该留:${plan.keep.map((c) => c.name).join(',')}`);
  assert.equal(plan.toss.length, 3);
  assert.match(plan.text, /全换/);
  assert.match(plan.text, /最便宜的也要 5 费/, plan.text);
});

test('先手两张 2 费一张 8 费:留低费、换高费', () => {
  const s = snap(side({
    handCards: [card('BE_183', 8), card('BE_153', 2), card('JAIL_328', 2)],
  }));
  const plan = mulliganPlan(s);
  const kept = plan.keep.map((c) => c.cost).sort();
  assert.deepEqual(kept, [2, 2], plan.text);
  assert.equal(plan.toss.length, 1);
  assert.match(plan.text, /起源大厅/);
  assert.match(plan.text, /换掉/);
});

test('后手那枚硬币不进留换清单 —— 它本来就不在可换范围里', () => {
  const s = snap(side({
    playerId: 2, coinCount: 1,
    handCards: [card('GAME_005', 0), card('BE_142', 1), card('CATA_479', 4), card('BE_153', 2), card('BE_183', 8)],
  }), { firstPlayerId: 1, activePlayerId: 2 });
  const cards = openingHand(s);
  assert.equal(cards.length, 4, `硬币被算进起手了:${cards.map((c) => c.cardId).join(',')}`);
  assert.ok(!cards.some((c) => c.cardId === 'GAME_005'));
  const plan = mulliganPlan(s);
  assert.ok(!plan.toss.some((c) => c.cardId === 'GAME_005'), '建议里出现了硬币');
  assert.match(mulliganText(s), /硬币（换不掉）/);
});

test('后手最多留 3 张,不会把 4 张起手全留着', () => {
  const s = snap(side({
    playerId: 2, coinCount: 1,
    handCards: [card('GAME_005', 0), card('BE_142', 1), card('BE_153', 2), card('JAIL_328', 2), card('BE_229', 7)],
  }), { firstPlayerId: 1 });
  const plan = mulliganPlan(s);
  assert.ok(plan.keep.length <= 3, `留多了:${plan.keep.length}`);
});

test('核心牌必留 —— 哪怕它 8 费', () => {
  const s = snap(side({ handCards: [card('BE_183', 8), card('BE_153', 2), card('JAIL_328', 2)] }));
  const plan = mulliganPlan(s, { keepCards: '起源大厅' });
  assert.ok(plan.keep.some((c) => c.cardId === 'BE_183'), plan.text);
  // **2026-10-28 改了：核心牌不再占留牌名额。**
  // 原来它是占的，于是这一手会算成「留 2 费 + 核心，换掉另一张 2 费」——
  // 拿一张确定的 2 费去换未知牌。在低费本来就少的控制卡组里这是负期望，
  // 而且「必留」的语义本来就该是**额外**保留，不是从正常名额里扣一个。
  // 现在先手 cap=2 全部留给普通牌，加核心正好 3 张全留。
  assert.equal(plan.keep.length, 3, plan.text);
  assert.equal(plan.toss.length, 0, plan.text);
  assert.match(plan.text, /核心名单/, plan.text);
});

test('同名的第二张降权 —— 起手两张一模一样的 1 费,留一张就够', () => {
  const s = snap(side({
    handCards: [card('BE_142', 1), card('BE_142', 1), card('BE_153', 2)],
  }));
  const plan = mulliganPlan(s);
  const same = plan.keep.filter((c) => c.cardId === 'BE_142').length;
  assert.equal(same, 1, plan.text);
  assert.match(plan.text, /换掉/, plan.text);
});

test('文案只用日志里有的东西:不出现内部 id,也不编卡牌效果', () => {
  const s = snap(side({ handCards: [card('BE_183', 8), card('BE_153', 2), card('JAIL_328', 2)] }));
  const text = `${mulliganText(s)}\n${mulliganPlan(s).text}`;
  assert.doesNotMatch(text, /BE_183|BE_153|JAIL_328/, `内部 id 漏出来了:${text}`);
  // 换牌阶段手牌的 note 是空的,任何「战吼/亡语/打 3」都是编的
  assert.doesNotMatch(text, /战吼|亡语|造成 \d+ 点伤害/, `编了卡牌效果:${text}`);
});

test('手牌还没读出来时闭嘴,不说空话', () => {
  const s = snap(side({ handCards: [card('BE_153', 2)] }));
  assert.equal(mulliganText(s), '');
  assert.equal(mulliganPlan(s).text, '');
});

test('核心牌填进配置,7 费也必留 —— 这就是那个配置存在的理由', () => {
  // 2026-10-28 实测:阿米图特(7费 5/8 嘲讽)是这套牌的 key,但 keepCards 是空的,
  // 于是它被按「7 费、后手用不上」换掉了。卡组核心不该由费用规则替人决定。
  const hand = [
    card('BG_001', 1, { name: '正义保护者' }),
    card('BG_002', 1, { name: '龙鳞军备' }),
    card('BG_003', 2, { name: '阳炎清算' }),
    card('BE_143', 7, { name: '阿米图特，阿米图斯的守护者' }),
  ];
  const s = snap(side({ handCards: hand }), { firstPlayerId: 2 });   // 对手先手 = 我后手

  const kept = mulliganPlan(s, { keepCards: '阿米图特' });
  assert.ok(kept.keep.some((c) => c.cardId === 'BE_143'), `填了核心牌还是被换掉:${kept.text}`);
  assert.match(kept.text, /核心名单/, kept.text);

  // 不填的时候它就是被换的那张 —— 说明差别确实来自配置,不是别的规则碰巧留下它
  const bare = mulliganPlan(s, {});
  assert.ok(bare.toss.some((c) => c.cardId === 'BE_143'), `没填核心牌时居然没换:${bare.text}`);
});

test('核心牌不占留牌名额 —— 别为了留它把 2 费牌挤出去', () => {
  // 2026-10-28 实测：后手起手「1费、1费、2费、核心7费」。核心牌也占名额时，
  // 算出来是「留 1、1、核心，换掉阳炎清算（2费）」——把一张好牌换出去换未知牌，
  // 比原来还差。他既然指定了核心必留，剩下那几张便宜牌本来就该一起留。
  const s = snap(side({
    handCards: [
      card('BG_001', 1, { name: '正义保护者' }),
      card('BG_002', 1, { name: '龙鳞军备' }),
      card('BG_003', 2, { name: '阳炎清算' }),
      card('BE_143', 7, { name: '阿米图特，阿米图斯的守护者' }),
    ],
  }), { firstPlayerId: 2 });

  const plan = mulliganPlan(s, { keepCards: '阿米图特' });
  assert.equal(plan.keep.length, 4, `该全留：${plan.text}`);
  assert.equal(plan.toss.length, 0, `不该换任何一张：${plan.text}`);
});

test('核心牌不占名额，但普通牌仍然有上限', () => {
  // 起手四张全便宜 + 两张核心：核心全留，普通牌只留到 cap，别把整手都锁死。
  const s = snap(side({
    handCards: [
      card('A_1', 1, { name: '一费甲' }),
      card('A_2', 1, { name: '一费乙' }),
      card('A_3', 2, { name: '二费甲' }),
      card('A_4', 2, { name: '二费乙' }),
      card('K_1', 7, { name: '核心甲' }),
      card('K_2', 8, { name: '核心乙' }),
    ],
  }), { firstPlayerId: 2 });

  const plan = mulliganPlan(s, { keepCards: '核心甲、核心乙' });
  const keptCore = plan.keep.filter((c) => c.cardId.startsWith('K_')).length;
  const keptNormal = plan.keep.filter((c) => c.cardId.startsWith('A_')).length;
  assert.equal(keptCore, 2, `两张核心都该留：${plan.text}`);
  assert.ok(keptNormal <= 3, `普通牌不该超过 cap：${plan.text}`);
});
