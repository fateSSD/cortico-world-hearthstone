/**
 * 解析器的离线验证。
 *
 * 样本按真实 Power.log 的形状手造:同一行前缀、缩进 tag、两种实体引用形式、数字 tag 噪音。
 * 没有真实对局日志之前,这份样本就是唯一能证明解析器没写错的依据。
 *
 * 跑法:node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PowerLogParser, parseEntityRef, renderSnapshot } from '../src/parser.ts';
import { detectAlerts } from '../src/alerts.ts';

const TS = 'D 21:00:00.0000000 GameState.DebugPrintPower() - ';
const l = (...parts) => parts.map((p) => TS + p);

/** 一局:法师(我,PLAYER_ID=1)对猎人(对手,PLAYER_ID=2)。 */
const OPENING = l(
  'CREATE_GAME',
  '    GameEntity ID=1',
  '        tag=10 value=85',
  '        tag=STATE value=RUNNING',
  '        tag=TURN value=1',
  '        tag=CURRENT_PLAYER value=1',
  '    Player EntityID=2 PlayerID=1',
  '        tag=PLAYER_ID value=1',
  '        tag=HERO_ENTITY value=4',
  '        tag=RESOURCES value=1',
  '    Player EntityID=3 PlayerID=2',
  '        tag=PLAYER_ID value=2',
  '        tag=HERO_ENTITY value=5',
  '        tag=RESOURCES value=0',
  'FULL_ENTITY - Creating ID=4 CardID=HERO_08',
  '    tag=CARDTYPE value=HERO',
  '    tag=HEALTH value=30',
  '    tag=ZONE value=PLAY',
  '    tag=CONTROLLER value=1',
  'FULL_ENTITY - Creating ID=5 CardID=HERO_05',
  '    tag=CARDTYPE value=HERO',
  '    tag=HEALTH value=30',
  '    tag=ZONE value=PLAY',
  '    tag=CONTROLLER value=2',
  // ── 以下是开局真正决定「谁先手 / 现在轮到谁」的两条,不能省 ──
  //
  // 上面 GameEntity 那条 `tag=CURRENT_PLAYER value=1` **只说明「有当前玩家」,
  // 不说明是谁**。原来解析器把它的 value 当 playerId 用,于是 activePlayer 恒为 1,
  // 本地是 2 时先手永远说反(2026-10-28 实测:起手 4 张 + 硬币,扩展说「我先手」)。
  // 真实日志里指名道姓的是实体/名字形式,这里按真实形状补上:
  //   Entity=2 是 PlayerID=1 的玩家实体 —— 它先手,所以本地先手。
  'TAG_CHANGE Entity=2 tag=FIRST_PLAYER value=1',
  'TAG_CHANGE Entity=我#1111 tag=CURRENT_PLAYER value=1',
);

function fresh() {
  const p = new PowerLogParser(() => '2026-10-22T13:00:00.000Z');
  return p;
}

test('开局:双方职业、血量、回合与先手都读得出来', () => {
  const p = fresh();
  const delta = p.feed(OPENING);
  assert.equal(delta.gameStarted, true, 'CREATE_GAME 应标为开局');

  const s = p.snapshot();
  assert.ok(s, '开局后应有快照');
  assert.equal(s.me.heroClass, '法师');
  assert.equal(s.opponent.heroClass, '猎人');
  assert.equal(s.me.health, 30);
  assert.equal(s.opponent.health, 30);
  assert.equal(s.turn, 1);
  assert.equal(s.isMyTurn, true, 'CURRENT_PLAYER=1,本地是 1');
  assert.equal(s.ended, false);
});

test('血量是 HEALTH 减 DAMAGE,不是单看其中一个', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l('TAG_CHANGE Entity=4 tag=DAMAGE value=7'));
  assert.equal(p.snapshot().me.health, 23);

  // 上限提高(比如换了英雄)之后仍要按差值算
  p.feed(l('TAG_CHANGE Entity=4 tag=HEALTH value=40'));
  assert.equal(p.snapshot().me.health, 33);
});

test('水晶、手牌、牌库、护甲各自独立统计', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'TAG_CHANGE Entity=2 tag=RESOURCES value=5',
    'TAG_CHANGE Entity=2 tag=RESOURCES_USED value=2',
    'TAG_CHANGE Entity=4 tag=ARMOR value=3',
  ));
  // 三张手牌
  p.feed(l(
    'FULL_ENTITY - Creating ID=40 CardID=CS2_029',
    '    tag=CARDTYPE value=SPELL',
    '    tag=ZONE value=HAND',
    '    tag=CONTROLLER value=1',
    'FULL_ENTITY - Creating ID=41 CardID=CS2_029',
    '    tag=CARDTYPE value=SPELL',
    '    tag=ZONE value=HAND',
    '    tag=CONTROLLER value=1',
  ));
  const s = p.snapshot();
  assert.equal(s.me.mana, 3, '5 上限减 2 已用');
  assert.equal(s.me.manaMax, 5);
  assert.equal(s.me.armor, 3);
  assert.equal(s.me.handCount, 2);
});

test('场面随从带攻击力、生命与关键词,场攻合计正确', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=30 CardID=CS2_120',
    '    tag=CARDTYPE value=MINION',
    '    tag=ATK value=2',
    '    tag=HEALTH value=3',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=1',
    'TAG_CHANGE Entity=[name=淡水鳄 id=30 zone=PLAY zonePos=1 cardId=CS2_120 player=1] tag=TAUNT value=1',
  ));
  const s = p.snapshot();
  assert.equal(s.me.minions.length, 1);
  const m = s.me.minions[0];
  assert.equal(m.name, '淡水鳄', '名字要从方括号引用里补进来');
  assert.equal(m.atk, 2);
  assert.equal(m.health, 3);
  assert.equal(m.maxHealth, 3);
  assert.equal(m.taunt, true);
  assert.equal(s.boardAttack.mine, 2);
});

test('随从受伤:血量按 HEALTH 减 DAMAGE 走', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=30 CardID=CS2_120',
    '    tag=CARDTYPE value=MINION',
    '    tag=ATK value=2',
    '    tag=HEALTH value=3',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=1',
    'TAG_CHANGE Entity=30 tag=DAMAGE value=2',
  ));
  const m = p.snapshot().me.minions[0];
  assert.equal(m.health, 1, '3 点生命挨了 2 点伤害');
  assert.equal(m.maxHealth, 3);
});

test('打牌与攻击会记成动作,并且能分清是谁做的', () => {
  const p = fresh();
  p.feed(OPENING);
  const delta = p.feed(l(
    'FULL_ENTITY - Creating ID=40 CardID=CS2_029',
    '    tag=CARDTYPE value=SPELL',
    '    tag=ZONE value=HAND',
    '    tag=CONTROLLER value=1',
    'BLOCK_START BlockType=PLAY Entity=[name=火球术 id=40 zone=HAND zonePos=1 cardId=CS2_029 player=1] EffectCardId= EffectIndex=0 Target=0 SubOption=-1',
    'BLOCK_END',
    'BLOCK_START BlockType=ATTACK Entity=[name=淡水鳄 id=30 zone=PLAY zonePos=1 cardId=CS2_120 player=1] EffectCardId= EffectIndex=0 Target=[name=迅猛龙 id=31 zone=PLAY zonePos=1 cardId=CS2_120 player=2] SubOption=-1',
    'BLOCK_END',
  ));

  const kinds = delta.newActions.map((a) => a.kind);
  assert.deepEqual(kinds, ['play', 'attack']);
  assert.equal(delta.newActions[0].who, 'me');
  assert.match(delta.newActions[0].text, /火球术/);
  assert.match(delta.newActions[1].text, /攻击/);
  assert.match(delta.newActions[1].text, /迅猛龙/);
});

test('随从进墓地记一条阵亡', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=30 CardID=CS2_120',
    '    tag=CARDTYPE value=MINION',
    '    tag=ATK value=2',
    '    tag=HEALTH value=3',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=1',
  ));
  const delta = p.feed(l('TAG_CHANGE Entity=30 tag=ZONE value=GRAVEYARD'));
  assert.equal(delta.newActions.length, 1);
  assert.equal(delta.newActions[0].kind, 'death');
  assert.match(delta.newActions[0].text, /阵亡/);
  assert.equal(p.snapshot().me.minions.length, 0, '进墓地之后不该还在场上');
});

test('对手投降判我赢,并标出这局结束', () => {
  const p = fresh();
  p.feed(OPENING);
  const delta = p.feed(l('TAG_CHANGE Entity=3 tag=PLAYSTATE value=CONCEDED'));
  assert.equal(delta.gameEnded, true);
  const s = p.snapshot();
  assert.equal(s.ended, true);
  assert.equal(s.result, 'won');
});

test('自己投降判我输', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l('TAG_CHANGE Entity=2 tag=PLAYSTATE value=CONCEDED'));
  assert.equal(p.snapshot().result, 'lost');
});

test('换局时状态清空,不会把上一局的血量带进新局', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l('TAG_CHANGE Entity=4 tag=DAMAGE value=20'));
  assert.equal(p.snapshot().me.health, 10);
  p.feed(OPENING);
  assert.equal(p.snapshot().me.health, 30, '新的一局应回到 30 血');
  assert.equal(p.snapshot().me.minions.length, 0);
});

test('无法解析的玩家名不崩,只计入诊断', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l('TAG_CHANGE Entity=某个没见过的人名 tag=NUM_OPTIONS value=13'));
  const d = p.diagnostics();
  assert.ok(d.unmappedNames >= 1);
  assert.equal(p.snapshot().me.health, 30, '核心指标不受影响');
});

test('数字形式的 tag 当噪音丢掉,不进实体表', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l('TAG_CHANGE Entity=4 tag=1596 value=1'));
  const s = p.snapshot();
  assert.equal(s.me.health, 30);
});

test('实体引用三种写法都解得开', () => {
  assert.deepEqual(parseEntityRef('357'), { id: 357 });
  assert.deepEqual(parseEntityRef('GameEntity'), { id: 1 });
  const bracket = parseEntityRef('[name=淡水鳄 id=82 zone=PLAY zonePos=1 cardId=CS2_120 player=1]');
  assert.equal(bracket.id, 82);
  assert.equal(bracket.name, '淡水鳄');
  assert.equal(bracket.cardId, 'CS2_120');
  assert.equal(bracket.playerId, 1);
  assert.equal(bracket.zone, 'PLAY');
  // 卡名里带空格的也要整段取下来
  const spaced = parseEntityRef('[name=Al\'akir the Windlord id=9 zone=PLAY cardId=NEW_1 player=2]');
  assert.equal(spaced.name, "Al'akir the Windlord");
});

test('告警:残血只跨过阈值时报一次', () => {
  const p = fresh();
  p.feed(OPENING);
  const before = p.snapshot();
  p.feed(l('TAG_CHANGE Entity=4 tag=DAMAGE value=22'));
  const now = p.snapshot();

  const first = detectAlerts({ before, now, alertHealth: 10, swarmCount: 4 });
  assert.ok(first.some((a) => a.id === 'low-health'), '8 血应触发残血告警');

  // 再挨一下,血量更低,但已经报过这一条
  const mid = p.snapshot();
  p.feed(l('TAG_CHANGE Entity=4 tag=DAMAGE value=25'));
  const again = detectAlerts({ before: mid, now: p.snapshot(), alertHealth: 10, swarmCount: 4 });
  assert.equal(again.some((a) => a.id === 'low-health'), false, '阈值已跨过,不该重复');
  assert.ok(again.some((a) => a.id === 'critical-health'), '5 血以下要单独报一条濒死');
});

test('告警:对手场攻够斩杀时给出具体数字', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=50 CardID=CS2_120',
    '    tag=CARDTYPE value=MINION',
    '    tag=ATK value=9',
    '    tag=HEALTH value=9',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=2',
    'TAG_CHANGE Entity=4 tag=DAMAGE value=22',
  ));
  const alerts = detectAlerts({ before: null, now: p.snapshot(), alertHealth: 10, swarmCount: 4 });
  const lethal = alerts.find((a) => a.id === 'lethal-threat');
  assert.ok(lethal, '对手场攻 9 ≥ 我 8 血,应报斩杀威胁');
  assert.match(lethal.text, /9/);
  assert.match(lethal.text, /8/);
});

test('快照文本把双方和回合都写清楚', () => {
  const p = fresh();
  p.feed(OPENING);
  const text = renderSnapshot(p.snapshot());
  assert.match(text, /我:法师/);
  assert.match(text, /对手:猎人/);
  assert.match(text, /第 1 回合,轮到我行动/);
});

test('非 GameState 前缀的行不参与解析,避免同一动作记两遍', () => {
  const p = fresh();
  p.feed(OPENING);
  const delta = p.feed([
    'D 21:00:01.0000000 PowerTaskList.DebugPrintPower() - CREATE_GAME',
    'D 21:00:01.0000000 GameTask.DebugPrintEntityChoices() - 无关内容',
  ]);
  assert.equal(delta.newActions.length, 0);
  assert.equal(p.snapshot().turn, 1, 'PowerTaskList 的 CREATE_GAME 不该把对局重置');
});

/**
 * 断线重连回来的那局:没有一条 PLAYSTATE,只有 GameEntity 自己的收尾标签。
 *
 * 这是真事(2026-10-23 21:52 那局):炉石重启后重连到第 26 回合的对局,日志里没有任何
 * PLAYSTATE,但对手已经 0 血、GameEntity 报了 FINAL_GAMEOVER / STATE=COMPLETE。
 * 当时 checkEndState 只在 PLAYSTATE 出现时被调用,于是这局永远结束不了 ——
 * 她会一直拿最后那一帧当现在,对手 0 血了还在问「这回合打什么」。
 */
test('没有 PLAYSTATE 时,GameEntity 的 STATE=COMPLETE 也算这局结束', () => {
  const p = fresh();
  p.feed(OPENING);
  assert.equal(p.snapshot().ended, false);

  p.feed(l(
    'TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER',
    'TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE',
  ));

  const s = p.snapshot();
  assert.equal(s.ended, true, '只认 PLAYSTATE 会漏掉整局');
  assert.equal(s.result, 'unknown', '没有 PLAYSTATE 就判不出谁赢,不要瞎猜');
});

test('STEP=FINAL_GAMEOVER 单独出现也认', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l('TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER'));
  assert.equal(p.snapshot().ended, true);
});

/**
 * 真回归(2026-10-24 读真实日志抓到的):**GameEntity 的收尾标签会早于 PLAYSTATE 到。**
 *
 * 10_23_20_46_05 那份日志里,COMPLETE 在第 12788 行,中津静流 WON / 对手 LOST 在
 * 12791–12797 行。`ended` 在 COMPLETE 那一刻就翻成 true,而此刻 playStates 还是空的,
 * 于是 `resultFor()` 给 `unknown` —— 世界层拿这一帧就把 `hearthstone.game.end` 推出去了,
 * 她照 `unknown` 说「这局结束」、桌宠给 `<neutral>`:一局斩杀获胜,既没庆祝也没说对。
 *
 * 修法不是去等那三行(要引入延时补偿),而是让血量也管 `unknown`:对手 0 血就是赢。
 */
test('收尾标签先到、PLAYSTATE 还没到时,血量已经能定胜负', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l('TAG_CHANGE Entity=5 tag=DAMAGE value=30')); // 对手英雄 0 血
  p.feed(l(
    'TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER',
    'TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE',
  ));

  const s = p.snapshot();
  assert.equal(s.ended, true);
  assert.equal(s.opponent.health, 0);
  assert.equal(s.result, 'won', '对手 0 血、我还活着,当场就该判赢,不能给 unknown');
});

test('同一个出口的镜像:我 0 血时给 unknown 也必须翻成输', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l('TAG_CHANGE Entity=4 tag=DAMAGE value=30')); // 我 0 血
  p.feed(l('TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE'));

  const s = p.snapshot();
  assert.equal(s.ended, true);
  assert.equal(s.me.health, 0);
  assert.equal(s.result, 'lost', '我 0 血、对手还活着,不能给 unknown');
});

test('双方都 0 血时不编结果:同归于尽和日志尾巴清血分不清', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l('TAG_CHANGE Entity=4 tag=DAMAGE value=30', 'TAG_CHANGE Entity=5 tag=DAMAGE value=30'));
  p.feed(l('TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE'));
  assert.equal(p.snapshot().result, 'unknown');
});

/**
 * 胜负判反:名字形式的 PLAYSTATE 必须落到正确的 playerId 上。
 *
 * 2026-10-23 实况:她连着几局报「赢了:第 30 回合,我 0 血 / 对手 30 血」,
 * 用户的原话是「输的判定点得看看,每次她都很疑惑」。
 *
 * 根因两层:
 *   1. 谁是我,原来靠「换牌阶段第一个 MULLIGAN_STATE=INPUT 的名字」定 —— 但**两个玩家都会出现
 *      INPUT**,谁先纯看日志顺序,实测抓到的是对手。
 *   2. 拿到 PLAYSTATE 就当场判,而那一刻「我 = 哪个 playerId」可能还没算出来(默认按 1),
 *      于是对手的 WON 记成了我的。
 */
test('名字形式的 PLAYSTATE 按 playerId 落地:我是后手时不能被判成赢', () => {
  const p = fresh();
  p.feed(l(
    'CREATE_GAME',
    '    GameEntity ID=1',
    '        tag=STATE value=RUNNING',
    '        tag=TURN value=1',
    '    Player EntityID=2 PlayerID=1',
    '        tag=PLAYER_ID value=1',
    '        tag=HERO_ENTITY value=4',
    '    Player EntityID=3 PlayerID=2',
    '        tag=PLAYER_ID value=2',
    '        tag=HERO_ENTITY value=5',
    'FULL_ENTITY - Creating ID=4 CardID=HERO_05',
    '    tag=CARDTYPE value=HERO',
    '    tag=HEALTH value=30',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=1',
    'FULL_ENTITY - Creating ID=5 CardID=HERO_08',
    '    tag=CARDTYPE value=HERO',
    '    tag=HEALTH value=30',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=2',
    // 本地(controller 2)起手三张可见,对手一张都不露 → 我是 playerId 2
    'FULL_ENTITY - Creating ID=21 CardID=CS2_029',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=2',
    'FULL_ENTITY - Creating ID=22 CardID=CS2_024',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=2',
    'FULL_ENTITY - Creating ID=23 CardID=CS2_025',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=2',
    // 开局:数字形式说 playerId 1(实体 2)先动
    'TAG_CHANGE Entity=2 tag=CURRENT_PLAYER value=1',
    // 名字形式紧跟着出现 —— 这一刻把名字钉到 playerId 1 上
    'TAG_CHANGE Entity=对手#1111 tag=CURRENT_PLAYER value=1',
    'TAG_CHANGE Entity=对手#1111 tag=PLAYSTATE value=WON',
    'TAG_CHANGE Entity=我#2222 tag=PLAYSTATE value=LOST',
  ));
  const s = p.snapshot();
  assert.equal(s.me.health, 30, '我这边应该还活着');
  assert.equal(s.result, 'lost', '对手 WON 不能被记成我赢');
});

test('我是先手时同样成立(不能只会判输)', () => {
  const p = fresh();
  p.feed(l(
    'CREATE_GAME',
    '    GameEntity ID=1',
    '        tag=STATE value=RUNNING',
    '    Player EntityID=2 PlayerID=1',
    '        tag=PLAYER_ID value=1',
    '        tag=HERO_ENTITY value=4',
    '    Player EntityID=3 PlayerID=2',
    '        tag=PLAYER_ID value=2',
    '        tag=HERO_ENTITY value=5',
    'FULL_ENTITY - Creating ID=4 CardID=HERO_08',
    '    tag=CARDTYPE value=HERO', '    tag=HEALTH value=30', '    tag=ZONE value=PLAY', '    tag=CONTROLLER value=1',
    'FULL_ENTITY - Creating ID=5 CardID=HERO_05',
    '    tag=CARDTYPE value=HERO', '    tag=HEALTH value=30', '    tag=ZONE value=PLAY', '    tag=CONTROLLER value=2',
    'FULL_ENTITY - Creating ID=21 CardID=CS2_029',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=1',
    'FULL_ENTITY - Creating ID=22 CardID=CS2_024',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=1',
    'FULL_ENTITY - Creating ID=23 CardID=CS2_025',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=1',
    'TAG_CHANGE Entity=2 tag=CURRENT_PLAYER value=1',
    'TAG_CHANGE Entity=我#2222 tag=CURRENT_PLAYER value=1',
    'TAG_CHANGE Entity=我#2222 tag=PLAYSTATE value=WON',
    'TAG_CHANGE Entity=对手#1111 tag=PLAYSTATE value=LOST',
  ));
  assert.equal(p.snapshot().result, 'won');
});

test('血量和胜负打架时,血量赢 —— 0 血不可能赢', () => {
  // 身份判定万一还是错,这是最后一道闸:英雄血量 ≤ 0 立刻判负,所以「我赢但我 0 血」不成立
  const p = fresh();
  p.feed(l(
    'CREATE_GAME',
    '    GameEntity ID=1',
    '        tag=STATE value=RUNNING',
    '    Player EntityID=2 PlayerID=1',
    '        tag=PLAYER_ID value=1',
    '        tag=HERO_ENTITY value=4',
    '    Player EntityID=3 PlayerID=2',
    '        tag=PLAYER_ID value=2',
    '        tag=HERO_ENTITY value=5',
    'FULL_ENTITY - Creating ID=4 CardID=HERO_05',
    '    tag=CARDTYPE value=HERO', '    tag=HEALTH value=30', '    tag=ZONE value=PLAY', '    tag=CONTROLLER value=1',
    'FULL_ENTITY - Creating ID=5 CardID=HERO_08',
    '    tag=CARDTYPE value=HERO', '    tag=HEALTH value=30', '    tag=ZONE value=PLAY', '    tag=CONTROLLER value=2',
    'FULL_ENTITY - Creating ID=21 CardID=CS2_029',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=2',
    'FULL_ENTITY - Creating ID=22 CardID=CS2_024',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=2',
    'TAG_CHANGE Entity=2 tag=CURRENT_PLAYER value=1',
    'TAG_CHANGE Entity=对手#1111 tag=CURRENT_PLAYER value=1',
    // 故意给出一个矛盾的组合:说我赢,但我(实体 5)已经 0 血
    'TAG_CHANGE Entity=5 tag=DAMAGE value=30',
    'TAG_CHANGE Entity=对手#1111 tag=PLAYSTATE value=LOST',
    'TAG_CHANGE Entity=我#2222 tag=PLAYSTATE value=WON',
  ));
  const s = p.snapshot();
  assert.equal(s.me.health, 0, '我 0 血');
  assert.equal(s.result, 'lost', '0 血还说赢,必须翻过来');
});

/**
 * 真凶:先手方那个名字**只出现在 PowerTaskList 里**。
 *
 * 2026-10-23 23:32 那局的原始日志:
 *   23:32:02  GameState     TAG_CHANGE Entity=3(FIRST_PLAYER=1)      ← 数字,说明了 playerId 2 先手
 *   23:32:04  PowerTaskList TAG_CHANGE Entity=无恋风影#5957(FIRST_PLAYER=1)  ← 名字,只在这一侧
 *   23:32:42  GameState     TAG_CHANGE Entity=中津静流#51151(CURRENT_PLAYER=1)
 *
 * LINE_RE 只认 GameState(避免镜像重复计数),于是那个名字被丢掉,第一个被看到的成了他,
 * 对手术士的 CONCEDED 就算到了他头上 —— 他 5 血认输,系统报「赢了」。用户当场说「反了」。
 */
test('先手的名字只在 PowerTaskList 里,也要能绑上', () => {
  const pl = (p) => `D 21:00:00.0000000 PowerTaskList.DebugPrintPower() - ${p}`;
  const p = fresh();
  p.feed(l(
    'CREATE_GAME',
    '    GameEntity ID=1',
    '        tag=STATE value=RUNNING',
    '    Player EntityID=2 PlayerID=1',
    '        tag=PLAYER_ID value=1',
    '        tag=HERO_ENTITY value=4',
    '    Player EntityID=3 PlayerID=2',
    '        tag=PLAYER_ID value=2',
    '        tag=HERO_ENTITY value=5',
    'FULL_ENTITY - Creating ID=4 CardID=HERO_03',
    '    tag=CARDTYPE value=HERO', '    tag=HEALTH value=30', '    tag=ZONE value=PLAY', '    tag=CONTROLLER value=1',
    'FULL_ENTITY - Creating ID=5 CardID=HERO_07',
    '    tag=CARDTYPE value=HERO', '    tag=HEALTH value=30', '    tag=ZONE value=PLAY', '    tag=CONTROLLER value=2',
    // 本地是一号位(playerId 1)的对手,他手牌可见 —— 这里造他是 playerId 1
    'FULL_ENTITY - Creating ID=21 CardID=CS2_029',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=1',
    'FULL_ENTITY - Creating ID=22 CardID=CS2_024',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=1',
    // 数字形式:playerId 2(实体 3)先手
    'TAG_CHANGE Entity=3 tag=FIRST_PLAYER value=1',
    'TAG_CHANGE Entity=3 tag=CURRENT_PLAYER value=1',
  ));
  // 先手的名字只走 PowerTaskList —— 主流程会把它过滤掉,旁路扫描要接住
  p.feed([pl('TAG_CHANGE Entity=对手#5957 tag=FIRST_PLAYER value=1')]);
  p.feed(l(
    'TAG_CHANGE Entity=对手#5957 tag=PLAYSTATE value=WON',
    'TAG_CHANGE Entity=我#51151 tag=PLAYSTATE value=LOST',
  ));
  assert.equal(p.snapshot().result, 'lost', '对手先手且对手赢,不能判成我赢');
});

/**
 * 配置项「哪一方是你」。
 *
 * 2026-10-24 自查发现:这个下拉框从来没人读。`config.ts` 声明了它、默认值有它、
 * schema 里有它、`diagnostics()` 甚至写好了 `localDetectedBy: 'config'` 分支 ——
 * 但 `world.ts` 从来没调过 `parser.setLocalPlayerId()`。
 * 于是用户在身份判反时按提示改成「1」，什么都不会变，也不报错。
 */
test('配置强制指定本地玩家:能盖过自动判定,也能还回去', () => {
  const p = fresh();
  p.feed(l(
    'CREATE_GAME',
    '    GameEntity ID=1',
    '        tag=STATE value=RUNNING',
    '    Player EntityID=2 PlayerID=1',
    '        tag=PLAYER_ID value=1',
    '        tag=HERO_ENTITY value=4',
    '    Player EntityID=3 PlayerID=2',
    '        tag=PLAYER_ID value=2',
    '        tag=HERO_ENTITY value=5',
    'FULL_ENTITY - Creating ID=4 CardID=HERO_08',
    '    tag=CARDTYPE value=HERO', '    tag=HEALTH value=30', '    tag=ZONE value=PLAY', '    tag=CONTROLLER value=1',
    'FULL_ENTITY - Creating ID=5 CardID=HERO_05',
    '    tag=CARDTYPE value=HERO', '    tag=HEALTH value=30', '    tag=ZONE value=PLAY', '    tag=CONTROLLER value=2',
    // 手牌只在 controller=2 那边有 cardId → 自动判定:我是 playerId 2
    'FULL_ENTITY - Creating ID=21 CardID=CS2_029',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=2',
    'FULL_ENTITY - Creating ID=22 CardID=CS2_024',
    '    tag=CARDTYPE value=SPELL', '    tag=ZONE value=HAND', '    tag=CONTROLLER value=2',
  ));
  // 自动判定是在 snapshot() 里跑的 —— 先要一次快照，它才会去数手牌
  assert.equal(p.snapshot().me.heroClass, '猎人', '自动判定下我是 controller 2(HERO_05 猎人)');
  assert.equal(p.localPlayerId(), 2, '自动判定应该认出 2');

  p.setLocalPlayerId(1);
  assert.equal(p.localPlayerId(), 1, '强制 1 必须盖过自动判定');
  assert.equal(p.diagnostics().localDetectedBy, 'config');
  assert.equal(p.snapshot().me.heroClass, '法师', '改成 1 之后我该是 controller 1(HERO_08 法师)');

  p.setLocalPlayerId(null);
  assert.equal(p.localPlayerId(), 2, 'auto 要还回自动判定');
  assert.equal(p.diagnostics().localDetectedBy, 'hand');
});

test('强制指定跨局保持 —— 换局不能被 reset 抹掉', () => {
  const p = fresh();
  p.setLocalPlayerId(2);
  p.feed(OPENING);
  assert.equal(p.localPlayerId(), 2);
  // 新的一局:reset() 会清掉一堆字段,但不该清配置
  p.feed(l('CREATE_GAME', '    GameEntity ID=1', '        tag=STATE value=RUNNING'));
  assert.equal(p.localPlayerId(), 2, 'reset 把配置一起清了,用户每局都要重设一次');
});

/* ---------- 2026-10-24:手牌上的「已预备」状态 ---------- */

/**
 * 预备(`tag=PREPARE`)是玩家主动操作的结果:把牌拖进牌库,花掉剩余法力换减费。
 *
 * 日志里它是 0/1 状态位,不是计数器 —— 实测 10-24 10:45:15 那条,对手手牌被揭示时
 * 带着 `tag=PREPARE value=1`;同一份日志里也有 `value=0` 的(没预备过的牌)。
 * 我们的手牌视图必须带上这一位,否则「这回合打得出是因为它已经打过折」这件事就丢了。
 */
test('手牌实体上的 PREPARE 标签会读进 handCards', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=50 CardID=JAIL_407',
    '    tag=CARDTYPE value=MINION',
    '    tag=ZONE value=HAND',
    '    tag=CONTROLLER value=1',
    '    tag=COST value=3',
    '    tag=PREPARE value=1',
    'FULL_ENTITY - Creating ID=51 CardID=JAIL_998',
    '    tag=CARDTYPE value=MINION',
    '    tag=ZONE value=HAND',
    '    tag=CONTROLLER value=1',
    '    tag=COST value=3',
    '    tag=PREPARE value=0',
  ));
  const hand = p.snapshot().me.handCards;
  const prepared = hand.find((c) => c.cardId === 'JAIL_407');
  const plain = hand.find((c) => c.cardId === 'JAIL_998');
  assert.equal(prepared.prepared, true, 'PREPARE=1 要读成已预备');
  assert.equal(plain.prepared, false, 'PREPARE=0 是没预备过');
  assert.equal(prepared.cost, 3, '预备之后的费用以日志里的 COST 为准');
});

test('预备动作发生时的 TAG_CHANGE 也能把状态翻过去', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=50 CardID=JAIL_407',
    '    tag=CARDTYPE value=MINION',
    '    tag=ZONE value=HAND',
    '    tag=CONTROLLER value=1',
    '    tag=COST value=7',
  ));
  assert.equal(p.snapshot().me.handCards[0].prepared, false);

  // 铁匠铺那一手:预备 + 费用被减到 1
  p.feed(l(
    'TAG_CHANGE Entity=50 tag=PREPARE value=1',
    'TAG_CHANGE Entity=50 tag=COST value=1',
  ));
  const card = p.snapshot().me.handCards[0];
  assert.equal(card.prepared, true);
  assert.equal(card.cost, 1, '减费要跟着更新');
});

/* ---------- 2026-10-24:快枪的开关是 POWERED_UP ---------- */

/**
 * 快枪(Quickdraw)只在「本回合到手」时生效。日志里有现成的 `tag=POWERED_UP`
 * 就是它的开关 —— 别拿「第几回合进手牌」去猜:
 * 实测那局蹄铁发射机开局 POWERED_UP=1、回合结束被清成 0；日斑巨龙抽到时 1、打出时 0。
 */
test('手牌上的 POWERED_UP 要读出来，之后的变化也要跟上', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=60 CardID=WW_434',
    '    tag=CARDTYPE value=MINION',
    '    tag=ZONE value=HAND',
    '    tag=CONTROLLER value=1',
    '    tag=COST value=6',
    '    tag=POWERED_UP value=1',
  ));
  const drafted = p.snapshot().me.handCards[0];
  assert.equal(drafted.poweredUp, true, 'POWERED_UP=1 就是快枪此刻生效');

  // 回合结束被清掉
  p.feed(l('TAG_CHANGE Entity=60 tag=POWERED_UP value=0'));
  assert.equal(p.snapshot().me.handCards[0].poweredUp, false, '清掉之后要跟着变');
});

test('进手牌的回合号也记下来 —— 没有 POWERED_UP 时的兜底判据', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=61 CardID=WW_900',
    '    tag=CARDTYPE value=MINION',
    '    tag=ZONE value=DECK',
    '    tag=CONTROLLER value=1',
    '    tag=COST value=2',
  ));
  // 抽到手
  p.feed(l('TAG_CHANGE Entity=61 tag=ZONE value=HAND'));
  const card = p.snapshot().me.handCards.find((c) => c.cardId === 'WW_900');
  assert.ok(card, '抽到之后手牌里要有它');
  assert.equal(card.enteredTurn, p.snapshot().turn, '进手时的回合号要记成当前回合');
});

test('「无法攻击」与「休眠」的随从:不能攻击,也不进场面攻击力合计', () => {
  // 上古看守者 2 费 4/5「无法攻击」—— 挂着 4 点攻击力,一个回合也打不出来。
  // 曾经场攻把它算进去,于是 2 费回合对面明明没威胁,她却报「对面场攻 4」。
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=40 CardID=EX1_045',
    '    tag=CARDTYPE value=MINION',
    '    tag=ATK value=4',
    '    tag=HEALTH value=5',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=2',
    '    tag=CANT_ATTACK value=1',
    // 休眠:同样的道理,醒来之前一点伤害也打不出来
    'FULL_ENTITY - Creating ID=41 CardID=BT_127',
    '    tag=CARDTYPE value=MINION',
    '    tag=ATK value=4',
    '    tag=HEALTH value=4',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=2',
    '    tag=DORMANT value=1',
  ));
  const s = p.snapshot();
  for (const m of s.opponent.minions) {
    assert.equal(m.cantAttack, true, `${m.cardId} 应标成打不出来`);
    assert.equal(m.canAttack, false, `${m.cardId} 不该能动`);
  }
  assert.equal(s.boardAttack.theirs, 0, '打不出来的随从进了场攻合计');
});

test('「无法攻击英雄」的武器:读出来 hitsHero 是 false,普通武器是 true', () => {
  // 无穷之手(END_012)4/2,卡面「该武器无法攻击英雄」—— 那 4 点只能砍随从。
  // 只看 ATK 会把它当成 4 点打脸伤害(实测 2026-10-24 第 6 回合她就是这么报的)。
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=50 CardID=END_012',
    '    tag=CARDTYPE value=WEAPON',
    '    tag=ATK value=4',
    '    tag=HEALTH value=2',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=2',
  ));
  const s = p.snapshot();
  assert.equal(s.opponent.weapon.atk, 4);
  assert.equal(s.opponent.weapon.durability, 2, '耐久从 HEALTH 读,不是 0');
  assert.equal(s.opponent.weapon.hitsHero, false, '无穷之手写着「无法攻击英雄」');

  // 普通武器不该被误伤
  const q = fresh();
  q.feed(OPENING);
  q.feed(l(
    'FULL_ENTITY - Creating ID=51 CardID=CS2_106',
    '    tag=CARDTYPE value=WEAPON',
    '    tag=ATK value=3',
    '    tag=HEALTH value=2',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=2',
  ));
  assert.equal(q.snapshot().opponent.weapon.hitsHero, true, '奥金斧没写这条,应当能砍脸');
});


test('场攻:风怒武器让英雄那一份算两次', () => {
  // 毁灭之锤那类。2026-10-30 实测:英雄连砍两刀,可场攻只记一刀,
  // 于是她说「这回合只凑出 3 点,他还剩 6」—— 实际正好 6 点够斩。
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=60 CardID=CS2_039',
    '    tag=CARDTYPE value=WEAPON',
    '    tag=ATK value=3',
    '    tag=HEALTH value=8',
    '    tag=WINDFURY value=1',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=1',
  ));
  const s = p.snapshot();
  assert.equal(s.me.weapon.windfury, true, '武器自己带风怒');
  assert.equal(s.me.heroWindfury, true, '武器风怒要传导到英雄身上');
  assert.equal(s.boardAttack.mine, 6, '3 点风怒 = 6 点场攻,不是 3');
});

test('场攻:没有风怒的武器仍算一次', () => {
  const p = fresh();
  p.feed(OPENING);
  p.feed(l(
    'FULL_ENTITY - Creating ID=61 CardID=CS2_106',
    '    tag=CARDTYPE value=WEAPON',
    '    tag=ATK value=3',
    '    tag=HEALTH value=2',
    '    tag=ZONE value=PLAY',
    '    tag=CONTROLLER value=1',
  ));
  const s = p.snapshot();
  assert.equal(s.me.heroWindfury, false);
  assert.equal(s.boardAttack.mine, 3, '奥金斧就是 3 点,别翻倍');
});

test('无穷攻（INT32_MAX）念成 ∞，不是「二十多亿」', () => {
  // 2026-11-06 实测：「无穷之手」END_012 会把 ATK 直接设成 2147483647。
  // 那天她照实念了「攻击力写成二十多亿了，数字都溢出来了」—— 数字没错，是没人翻译它。
  const HUGE = 2147483647;
  const snap = {
    turn: 5, isMyTurn: true, step: null, ended: false, result: '',
    boardAttack: { mine: 3, theirs: HUGE },
    me: {
      heroClass: '圣骑士', heroName: '乌瑟尔', health: 30, armor: 0, mana: 3, manaMax: 3,
      handCount: 2, deckCount: 20, secrets: 0, fatigue: 0, weapon: null, minions: [], heroWindfury: false,
    },
    opponent: {
      heroClass: '萨满', heroName: '萨尔', health: 20, armor: 0, mana: 0, manaMax: 0,
      handCount: 1, deckCount: 15, secrets: 0, fatigue: 0, weapon: null, heroWindfury: false,
      minions: [{
        name: '无穷之手', cardId: 'END_012', atk: HUGE, health: 8,
        taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false, cantAttack: false,
      }],
    },
  };
  const text = renderSnapshot(snap);
  assert.match(text, /∞/, '要念成无限，不是原数');
  assert.doesNotMatch(text, /2147483647/, '二十多亿这种数她没法用来判断');
  // 但别改坏正常数字
  assert.match(text, /30 血/);
  assert.match(text, /我 3/, '我这边场攻还是 3');
});
