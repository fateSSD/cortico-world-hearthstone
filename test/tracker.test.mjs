/**
 * 记牌器汇总测试：牌库剩余与单抽概率、宇宙判定、竞技场同步、未知牌库诚实降级、对手追踪。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDeckString, encodeDeckString } from '../src/deck-code.ts';
import { buildTrackerSnapshot, renderTrackerForModel, renderTrackerForPrompt } from '../src/tracker.ts';
import { PowerLogParser } from '../src/parser.ts';

function makeRaw(over = {}) {
  return {
    turn: 4,
    localPlayerId: 1,
    meta: { gameType: 'GT_RANKED', formatType: 'FT_STANDARD', scenarioId: 2 },
    me: {
      heroClass: '法师',
      deckCount: 2,
      drawnFromDeck: [
        { entityId: 11, cardId: 'CS2_029', name: '火球术', cost: 4, turn: 1, isCreated: false }, // 抽走了1张火球
      ],
      playedCards: [
        { entityId: 11, cardId: 'CS2_029', name: '火球术', cost: 4, turn: 4, isCreated: false },
      ],
      graveyardCards: [
        { entityId: 11, cardId: 'CS2_029', name: '火球术', cost: 4, turn: 4, isCreated: false },
      ],
      knownInDeck: [],
      handCards: [],
    },
    opponent: {
      heroClass: '潜行者',
      deckCount: 20,
      playedCards: [
        { entityId: 51, cardId: 'EX1_124', name: '刺骨', cost: 2, turn: 2, isCreated: false },
        { entityId: 52, cardId: 'EX1_124', name: '刺骨', cost: 2, turn: 3, isCreated: true, creatorName: '发现' },
      ],
      graveyardMinions: [],
      graveyardSpells: [],
      secrets: [{ entityId: 60, enteredTurn: 3 }],
      revealedSecrets: [],
      handCards: [
        { entityId: 61, enteredTurn: 0, heldTurns: 4, isCoin: true, isCreated: false },
        { entityId: 62, enteredTurn: 2, heldTurns: 2, isCoin: false, isCreated: true, creatorName: '剽窃' },
      ],
    },
    ...over,
  };
}

const EXTRA_SINGLETON_DBFS = [476, 268, 904, 1117, 69614];

test('导入卡组记牌：准确扣除已抽牌、算出抽中概率与宇宙状态', () => {
  // 构造 16 张单卡（1张剩余火球 + 1张烈焰风暴 + 14张不重复其他卡），满足完整套牌宇宙检测门槛 (>=15)
  const code = encodeDeckString({
    format: 2,
    heroes: [637], // 法师
    cards: [
      { dbfId: 315, count: 2 }, // 火球术 x2 (抽掉1张后还剩1张！)
      { dbfId: 1004, count: 1 }, // 烈焰风暴 x1
      { dbfId: 12, count: 1 },
      { dbfId: 34, count: 1 },
      { dbfId: 41, count: 1 },
      { dbfId: 45, count: 1 },
      { dbfId: 67, count: 1 },
      { dbfId: 68, count: 1 },
      { dbfId: 69, count: 1 },
      { dbfId: 90, count: 1 },
      { dbfId: 132, count: 1 },
      { dbfId: 134, count: 1 },
      { dbfId: 138, count: 1 },
      { dbfId: 157, count: 1 },
      { dbfId: 158, count: 1 },
      { dbfId: 179, count: 1 },
    ],
  });
  const dec = decodeDeckString(code);
  assert.equal(dec.ok, true);
  if (!dec.ok) return;

  const t = buildTrackerSnapshot(makeRaw({
    me: {
      heroClass: '法师',
      deckCount: 16,
      drawnFromDeck: [
        { entityId: 11, cardId: 'CS2_029', name: '火球术', cost: 4, turn: 1, isCreated: false }, // 抽掉1张火球
      ],
      playedCards: [{ entityId: 11, cardId: 'CS2_029', name: '火球术', cost: 4, turn: 4, isCreated: false }],
      graveyardCards: [],
      knownInDeck: [],
      handCards: [],
    },
  }), { importedDeck: dec.deck });
  assert.equal(t.deckSource, 'imported');
  assert.equal(t.me.deckCount, 16);
  // 火球被抽掉 1 张后牌库剩余全为单张：宇宙就绪！
  assert.equal(t.me.hasDuplicates, false);
  assert.equal(t.me.remainingBurstCount, 1);
  assert.equal(t.me.remainingBurstDamage, 6);
  const fb = t.me.remainingDeck.find((c) => c.cardId === 'CS2_029');
  assert.equal(fb?.left, 1);
  assert.equal(fb?.drawProb, 1 / 16);

  // 对手原生与衍生区分、手牌滞留与奥秘
  assert.equal(t.opponent.initialPlayed.length, 1);
  assert.equal(t.opponent.createdPlayed.length, 1);
  assert.equal(t.opponent.secrets.length, 1);
  assert.equal(t.opponent.handCards[0].isCoin, true);
  assert.equal(t.opponent.handCards[1].heldTurns, 2);
});

test('洗入牌库的衍生牌单独列出，未知牌库时诚实不编造牌库底', () => {
  const raw = makeRaw({
    me: {
      heroClass: '法师',
      deckCount: 15,
      drawnFromDeck: [{ entityId: 11, cardId: 'CS2_029', name: '火球术', cost: 4, turn: 1, isCreated: false }],
      playedCards: [],
      graveyardCards: [],
      knownInDeck: [{ entityId: 88, cardId: 'CS2_093', name: '奉献', cost: 3, turn: 2, isCreated: true }],
      handCards: [],
    },
  });
  const unknown = buildTrackerSnapshot(raw);
  assert.equal(unknown.deckSource, 'none');
  assert.equal(unknown.me.hasDuplicates, undefined);
  assert.equal(unknown.me.remainingDeck.length, 1); // 仅确定洗入的那张已知牌
  assert.equal(unknown.me.remainingDeck[0].extraCreated, true);
  const text = renderTrackerForModel(unknown);
  assert.match(text, /未导入卡组代码/);
});

test('竞技场选牌列表直接用于记牌器剩余牌库核算', () => {
  const raw = makeRaw({
    meta: { gameType: 'GT_UNDERGROUND_ARENA', formatType: 'FT_WILD', scenarioId: 2 },
    me: {
      heroClass: '圣骑士',
      deckCount: 1,
      drawnFromDeck: [{ entityId: 11, cardId: 'CS2_093', name: '奉献', cost: 3, turn: 1, isCreated: false }],
      playedCards: [],
      graveyardCards: [],
      knownInDeck: [],
      handCards: [],
    },
  });
  const arenaDeck = [
    'CS2_093', 'CORE_EX1_619', 'CS2_029', 'CS2_032', 'EX1_124',
    'EX1_134', 'CS2_073', 'CS2_022', 'CS2_076', 'EX1_116',
    'BOT_906', 'BOT_548', 'TIME_019', 'EDR_226', 'END_003',
  ];
  const t = buildTrackerSnapshot(raw, { arenaDeck });
  assert.equal(t.deckSource, 'arena');
  assert.equal(t.me.remainingDeck.length, 14);
  assert.ok(t.me.remainingDeck.some((c) => c.cardId === 'CORE_EX1_619'));
  assert.equal(t.me.hasDuplicates, false);
});

test('P1-④ 局中接入(firstPlayerId=null)时对手起手手牌绝不误判为硬币', () => {
  const p = new PowerLogParser(() => '2026-11-22T18:00:00Z');
  p.feed([
    'D 18:00:00.0000000 GameState.DebugPrintPower() - CREATE_GAME',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - GameEntity EntityID=1',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=1]',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - Player EntityID=3 PlayerID=2 GameAccountId=[hi=2 lo=2]',
    // 故意不给 FIRST_PLAYER / CURRENT_PLAYER，模拟从局中切入日志
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=68 CardID=HERO_04',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=1',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=HERO',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=70 CardID=HERO_08',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=2',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=HERO',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=40',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=2',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=ZONE value=HAND',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=ZONE_POSITION value=1',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=41',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=2',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=ZONE value=HAND',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=ZONE_POSITION value=2',
  ]);
  p.setLocalPlayerId(1);
  const tr = p.trackerData();
  assert.ok(tr);
  assert.equal(tr.opponent.handCards.length, 2);
  assert.ok(tr.opponent.handCards.every((h) => h.isCoin === false), 'firstPlayerId 为 null 时不能把普通起手留牌当硬币');
});

test('对手暗牌防泄露：Start-of-Game亮牌盖回牌库后摸起不透名，真REVEALED=1或PLAY回手才标明牌', () => {
  const p = new PowerLogParser(() => '2026-11-22T18:00:00Z');
  p.feed([
    'D 18:00:00.0000000 GameState.DebugPrintPower() - CREATE_GAME',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - GameEntity EntityID=1',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=1]',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - Player EntityID=3 PlayerID=2 GameAccountId=[hi=2 lo=2]',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=68 CardID=HERO_04',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=1',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=HERO',
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=70 CardID=HERO_08',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=2',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=HERO',
    // 1) 伊瑟拉 Start-of-Game 展示后盖回牌库再抽入手牌：对本地玩家必须是暗牌
    'D 18:00:00.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=45',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=2',
    'D 18:00:00.0000000 GameState.DebugPrintPower() -     tag=ZONE value=DECK',
    'D 18:00:01.0000000 GameState.DebugPrintPower() - SHOW_ENTITY - Updating Entity=[entityName=UNKNOWN ENTITY [cardType=INVALID] id=45 zone=DECK zonePos=0 cardId= player=2] CardID=EDR_000',
    'D 18:00:01.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=MINION',
    'D 18:00:01.0000000 GameState.DebugPrintPower() -     tag=ZONE value=DECK',
    'D 18:00:01.0000000 GameState.DebugPrintPower() - HIDE_ENTITY - Entity=[entityName=伊瑟拉，翡翠守护巨龙 id=45 zone=DECK zonePos=0 cardId= player=2] tag=ZONE value=DECK',
    'D 18:00:01.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=45 tag=REVEALED value=0',
    // 2) 真明牌：偷走带有 REVEALED=1 进入 HAND
    'D 18:00:02.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=46',
    'D 18:00:02.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=2',
    'D 18:00:02.0000000 GameState.DebugPrintPower() -     tag=ZONE value=DECK',
    'D 18:00:02.0000000 GameState.DebugPrintPower() - SHOW_ENTITY - Updating Entity=46 CardID=CS2_029',
    'D 18:00:02.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=SPELL',
    'D 18:00:02.0000000 GameState.DebugPrintPower() -     tag=REVEALED value=1',
    // 3) 场上随从 PLAY -> HAND 回手（明牌）
    'D 18:00:02.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=47 CardID=CS2_042',
    'D 18:00:02.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=2',
    'D 18:00:02.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=MINION',
    'D 18:00:02.0000000 GameState.DebugPrintPower() -     tag=ZONE value=PLAY',
    'D 18:00:03.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=1 tag=TURN value=4',
    'D 18:00:03.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=45 tag=ZONE value=HAND',
    'D 18:00:03.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=45 tag=ZONE_POSITION value=1',
    'D 18:00:03.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=46 tag=ZONE value=HAND',
    'D 18:00:03.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=46 tag=ZONE_POSITION value=2',
    'D 18:00:03.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=47 tag=ZONE value=HAND',
    'D 18:00:03.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=47 tag=ZONE_POSITION value=3',
  ]);
  p.setLocalPlayerId(1);
  const tr = p.trackerData();
  assert.ok(tr);
  const h45 = tr.opponent.handCards.find((h) => h.entityId === 45);
  const h46 = tr.opponent.handCards.find((h) => h.entityId === 46);
  const h47 = tr.opponent.handCards.find((h) => h.entityId === 47);
  assert.equal(h45?.revealedCardId, undefined, 'Start-of-Game 盖回牌库后暗抽的牌绝不能泄密');
  assert.equal(h45?.revealedName, undefined);
  assert.equal(h46?.revealedCardId, 'CS2_029', 'REVEALED=1 明牌应正常记录');
  assert.equal(h47?.revealedCardId, 'CS2_042', 'PLAY->HAND 回手明牌应正常记录');

  const snap = buildTrackerSnapshot(tr);
  const modelText = renderTrackerForModel(snap);
  assert.doesNotMatch(modelText, /伊瑟拉/);
  assert.match(modelText, /火球术\[明牌\]/);
});

test('P2-⑨ renderTrackerForPrompt 常驻提示词保持紧凑，不展开整副牌库逐张明细', () => {
  const cards = [
    { dbfId: 315, count: 2 }, { dbfId: 1004, count: 1 },
    { dbfId: 12, count: 2 }, { dbfId: 34, count: 2 }, { dbfId: 41, count: 2 },
    { dbfId: 45, count: 2 }, { dbfId: 67, count: 2 }, { dbfId: 68, count: 2 },
    { dbfId: 69, count: 2 }, { dbfId: 90, count: 2 }, { dbfId: 132, count: 2 },
    { dbfId: 134, count: 2 }, { dbfId: 138, count: 2 }, { dbfId: 157, count: 2 },
    { dbfId: 158, count: 2 }, { dbfId: 179, count: 1 },
  ];
  const code = encodeDeckString({ format: 2, heroes: [637], cards });
  const dec = decodeDeckString(code);
  assert.equal(dec.ok, true);
  if (!dec.ok) return;

  const t = buildTrackerSnapshot(makeRaw({
    me: { heroClass: '法师', deckCount: 28, drawnFromDeck: [], playedCards: [], graveyardCards: [], knownInDeck: [], handCards: [] },
  }), { importedDeck: dec.deck });

  const fullText = renderTrackerForModel(t, { progressBrief: '天梯(标准):钻5 2星' });
  const promptText = renderTrackerForPrompt(t, { progressBrief: '天梯(标准):钻5 2星' });
  assert.ok(promptText.length < fullText.length, '常驻提示版应显著短于完整逐张清单');
  assert.ok(promptText.length < 400, `常驻提示版应保持在 400 字内，实际 ${promptText.length}`);
  assert.match(promptText, /直伤 2 张\(12伤\)/);
  assert.match(promptText, /hearthstone_tracker/);
});
