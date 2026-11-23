/**
 * 扩展页那块「陪打」面板的数据面。
 *
 * 这块面板存在的理由很具体:设置页是接入用的,他一天真正要点几十次的是
 * 「现在什么情况」和「这回合怎么打」。非自动模式(mode=quiet)下,那个按钮就是唯一的问法 ——
 * 所以它不能只是好看:状态要准,建议要和回合事件里说的一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelAdvice, panelAskText, panelStatus } from '../src/panel.ts';

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 30, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 3, handCards: [], deckCount: 18, secrets: 0,
  spellPower: 0, minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe, extra = {}) => ({
  startedAt: '', turn: 9, activePlayerId: 1, isMyTurn: true, step: 'MAIN_ACTION',
  ended: false, result: null, me, opponent: foe, boardAttack: { mine: 0, theirs: 0 }, ...extra,
});

const cfg = { mode: 'quiet', speakTurns: true, speakAlerts: true, keepCards: '' };

test('没找到日志时面板说清「看不见对局」,而不是显示 0 血', () => {
  const st = panelStatus(null, { phase: 'no-log', path: null, note: '没找到 Power.log。' }, cfg);
  assert.equal(st.phase, 'no-log');
  assert.equal(st.me, null);
  assert.equal(st.foe, null);
  assert.equal(st.turn, null);
  assert.match(st.note, /Power\.log/);
  // 开关状态照样要读出来,不然面板上的复选框全是空的
  assert.equal(st.auto.mode, 'quiet');
});

test('对局中:面板给的是能直接看的数,不是日志原文', () => {
  const st = panelStatus(
    snap(
      side({ heroClass: '术士', health: 22, armor: 3, mana: 6, manaMax: 9, handCount: 5 }),
      side({ isLocal: false, heroClass: '牧师', health: 15, armor: 0, minions: [1, 2].map((id) => ({
        id, name: '', cardId: '', atk: 3, health: 3, maxHealth: 3, taunt: false, divineShield: false,
        frozen: false, stealth: false, windfury: false, poisonous: false, lifesteal: false,
        reborn: false, rush: false, charge: false, canAttack: true,
      })) }),
      { boardAttack: { mine: 4, theirs: 7 } },
    ),
    { phase: 'in-game', path: 'x/Power.log', note: '第 9 回合。' },
    cfg,
  );
  assert.equal(st.turn, 9);
  assert.equal(st.myTurn, true);
  assert.equal(st.me.hp, 22);
  assert.equal(st.me.armor, 3);
  assert.equal(st.me.manaMax, 9);
  assert.equal(st.me.hand, 5);
  assert.equal(st.foe.cls, '牧师');
  assert.equal(st.foe.boardAttack, 7);
  assert.equal(st.foe.minions, 2);
});

test('对局结束后不给建议 —— 没有「这回合打什么」这回事', () => {
  const ended = snap(side(), side(), { ended: true, result: 'lost' });
  assert.equal(panelAdvice(ended, ''), null);
  assert.equal(panelAdvice(null, ''), null);
});

test('面板建议和回合事件同一句 —— 两处各写一套就会互相打脸', () => {
  const s = snap(
    side({ health: 6, mana: 4, manaMax: 4, handCards: [] }),
    side({ isLocal: false, heroClass: '战士', manaMax: 5, minions: [{
      id: 21, name: '', cardId: '', atk: 9, health: 9, maxHealth: 9, taunt: false, divineShield: false,
      frozen: false, stealth: false, windfury: false, poisonous: false, lifesteal: false,
      reborn: false, rush: false, charge: false, canAttack: true,
    }] }),
  );
  const a = panelAdvice(s, '');
  assert.ok(a);
  assert.equal(a.kind, 'danger');
  assert.match(a.text, /危险/);
  // face 要给出来:面板旁边的桌宠要摆同一张脸
  assert.equal(a.face, 'scared');
});

test('点按钮推给她的事件:说清是他主动问的,并带上机械建议', () => {
  const s = snap(
    side({ health: 20, mana: 7, manaMax: 9, handCount: 4 }),
    side({ isLocal: false, heroClass: '术士', health: 12 }),
  );
  const advice = panelAdvice(s, '');
  assert.ok(advice);
  const text = panelAskText(s, advice);
  assert.match(text, /第 9 回合/);
  assert.match(text, /点.*让她看这回合/, `没说清是他主动问的:${text}`);
  assert.match(text, /机械建议/, text);
  // 建议正文要原样带上,不然她还得再查一次工具
  assert.ok(text.includes(advice.text));
});

test('面板 progress 与 tracker 新字段可选透传且 world panelInvoke 支持导入卡组与段位/竞技场校准', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { encodeDeckString } = await import('../src/deck-code.ts');
  const mod = await import('../src/index.ts');
  const def = mod.default;

  const dir = mkdtempSync(join(tmpdir(), 'hs-panel-invoke-'));
  try {
    const cfg = def.defaults();
    const world = def.create({
      id: def.id, cfg, timezone: 'Asia/Shanghai', botName: 'Coo',
      botDir: process.cwd(), packageDir: process.cwd(), dataDir: dir, repoRoot: process.cwd(),
      secret: () => '', storeSecret: () => {}, persist: (p) => Object.assign(cfg, p), restart: async () => {},
    });

    const invoke = (m, args = []) => world.panelInvoke('main', m, args);
    const st0 = await invoke('status');
    assert.ok(st0.status.progress, 'status 应当带 progress');
    assert.ok(st0.status.tracker, 'status 应当带 tracker');

    // 设置天梯段位与竞技场战绩
    const rBad = await invoke('setRank', ['standard', '胡写一通']);
    assert.equal(rBad.ok, false);
    const rOk = await invoke('setRank', ['standard', '钻5 2星']);
    assert.equal(rOk.ok, true);
    assert.match(rOk.status.progress.ladderText, /钻5/);

    const aOk = await invoke('setArena', [4, 1, 'underground']);
    assert.equal(aOk.ok, true);
    assert.match(aOk.status.progress.arenaText, /4胜1负/);

    const aReset = await invoke('resetArena', ['arena']);
    assert.equal(aReset.ok, true);
    assert.equal(aReset.status.progress.arenaMode, 'arena');
    assert.match(aReset.status.progress.arenaText, /0胜0负/);

    // 编码一个测试标准卡组再通过 panelInvoke 导入与清除
    const code = encodeDeckString({
      format: 2,
      heroes: [637], // HERO_08 法师
      cards: [
        { dbfId: 315, count: 1 }, // 火球术 CS2_029
        { dbfId: 1004, count: 2 }, // 烈焰风暴 CS2_032
      ],
    });
    const impBad = await invoke('importDeck', ['not-a-deck-code']);
    assert.equal(impBad.ok, false);
    const impOk = await invoke('importDeck', [`### 我的火球法\n${code}`]);
    assert.equal(impOk.ok, true);
    assert.equal(impOk.status.tracker.deckSource, 'imported');
    assert.equal(impOk.status.tracker.hasImportedDeck, true);
    assert.equal(impOk.status.tracker.deckName, '我的火球法');
    assert.equal(impOk.status.tracker.myRemainingCount, 3);

    // P1-⑤ 职业不符时 deckSource 变为 'none' 且 deckMismatch=true，但「清代码」依赖的 hasImportedDeck 必须仍为 true
    world.onLines([
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
      'D 18:00:00.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=1 tag=TURN value=1',
    ], true);
    const mismatchSt = await invoke('status');
    assert.equal(mismatchSt.status.tracker.deckSource, 'none');
    assert.equal(mismatchSt.status.tracker.deckMismatch, true);
    assert.equal(mismatchSt.status.tracker.hasImportedDeck, true, '职业不符时仍必须暴露 hasImportedDeck=true 供面板显示清代码按钮');
    const tr = mismatchSt.status.tracker;
    const clearBtnHidden = !(tr.hasImportedDeck ?? (tr.deckSource === 'imported' || tr.deckMismatch));
    assert.equal(clearBtnHidden, false, '职业不符时面板「清代码」按钮不能消失');

    const clr = await invoke('clearDeck', []);
    assert.equal(clr.ok, true);
    assert.equal(clr.status.tracker.deckSource, 'none');
    assert.equal(clr.status.tracker.hasImportedDeck, false);

    // 多卡组保存、切换（selectDeck）与删除（deleteDeck）
    const code2 = encodeDeckString({
      format: 2,
      heroes: [671], // 圣骑士
      cards: [{ dbfId: 1004, count: 1 }],
    });
    await invoke('importDeck', [`### 套牌A\n${code}`]);
    const impB = await invoke('importDeck', [`### 套牌B\n${code2}`]);
    assert.equal(impB.status.tracker.savedDecks.length, 2);
    assert.equal(impB.status.tracker.deckName, '套牌B');

    const deckA = impB.status.tracker.savedDecks.find((d) => d.name === '套牌A');
    const deckB = impB.status.tracker.savedDecks.find((d) => d.name === '套牌B');
    assert.ok(deckA && deckB);

    const sw = await invoke('selectDeck', [deckA.id]);
    assert.equal(sw.ok, true);
    assert.equal(sw.status.tracker.activeDeckId, deckA.id);
    assert.equal(sw.status.tracker.deckMismatch, true, '圣骑士局切到法师套牌A应标职业不符');

    const del = await invoke('deleteDeck', [deckA.id]);
    assert.equal(del.ok, true);
    assert.equal(del.status.tracker.savedDecks.length, 1);
    assert.equal(del.status.tracker.deckName, '套牌B');

    // 对手记牌器独立导入、多卡组切换、删除与清代码
    const oppImp1 = await invoke('importOppDeck', [`### 对手法1\n${code}`]);
    assert.equal(oppImp1.ok, true);
    assert.equal(oppImp1.status.tracker.oppDeckName, '对手法1');
    assert.equal(oppImp1.status.tracker.hasOppImportedDeck, true);
    assert.equal(oppImp1.status.tracker.oppRemaining.length, 2);

    const oppImp2 = await invoke('importOppDeck', [`### 对手骑2\n${code2}`]);
    assert.equal(oppImp2.status.tracker.oppSavedDecks.length, 2);
    assert.equal(oppImp2.status.tracker.oppDeckName, '对手骑2');

    const opp1 = oppImp2.status.tracker.oppSavedDecks.find((d) => d.name === '对手法1');
    assert.ok(opp1);
    const oppSw = await invoke('selectOppDeck', [opp1.id]);
    assert.equal(oppSw.ok, true);
    assert.equal(oppSw.status.tracker.oppDeckName, '对手法1');

    const oppClr = await invoke('clearOppDeck', []);
    assert.equal(oppClr.ok, true);
    assert.equal(oppClr.status.tracker.oppDeckSource, 'none');
    assert.equal(oppClr.status.tracker.hasOppImportedDeck, false);
    assert.equal(oppClr.status.tracker.oppSavedDecks.length, 1);

    // 搜对手卡组：无对手职业时返回友好提示，不会抛异常
    const sNoOpp = await invoke('searchOppDeck', []);
    assert.equal(sNoOpp.ok, false);
    assert.match(sNoOpp.error, /对手职业/);

    // 工具 hearthstone_tracker 支持 import_opp_deck
    const trTool = world.tools().find((t) => t.name === 'hearthstone_tracker');
    assert.ok(trTool);
    const trRes = await trTool.handler({ action: 'import_opp_deck', deckCode: code, deckName: 'AI搜到的法' });
    assert.match(trRes.text, /对手记牌器.*AI搜到的法/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
