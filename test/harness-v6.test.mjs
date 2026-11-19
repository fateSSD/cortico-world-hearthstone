/**
 * Cortico Harness API v6 对齐与用量/取消接入回归测试。
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { askModelWithUsage } from '../src/llm.ts';
import definition, { HEARTHSTONE_DESCRIBE } from '../src/index.ts';
import { HearthstoneWorld } from '../src/world.ts';

function fakeContext(dir, overrides = {}) {
  const cfg = {
    ...definition.defaults(),
    mode: 'normal',
    ...overrides,
  };
  return {
    id: definition.id,
    cfg,
    timezone: 'Asia/Shanghai',
    botName: 'Coo',
    botDir: dir,
    packageDir: dir,
    dataDir: dir,
    repoRoot: dir,
    secret: (k) => (k === 'CORTICO_HEARTHSTONE_DEEPSEEK_API_KEY' ? 'sk-test-dummy' : ''),
    storeSecret: () => {},
    persist: (patch) => Object.assign(cfg, patch),
    restart: async () => {},
  };
}

function patchFs(method, implementation) {
  const stub = mock.method(fs, method, implementation);
  syncBuiltinESMExports();
  return () => {
    stub.mock.restore();
    syncBuiltinESMExports();
  };
}

function settledTurn(spec, cursor, text = 'x') {
  return {
    type: 'hearthstone.turn', senderKey: spec.senderKey, meta: spec.meta,
    source: 'world:hearthstone', ts: 'x', text, origin: 'external', cursor,
  };
}

function turnSnapshot(turn, overrides = {}) {
  return {
    startedAt: overrides.startedAt ?? '2026-11-19T12:00:00Z', turn,
    activePlayerId: overrides.isMyTurn === false ? 2 : 1,
    isMyTurn: overrides.isMyTurn ?? true, step: 'MAIN_ACTION',
    ended: false, result: null,
    me: {
      playerId: 1, isLocal: true, heroClass: '法师', heroName: '', heroCardId: '',
      health: 24, maxHealth: 30, armor: 2, heroAttack: 0, fatigue: 0,
      mana: Math.ceil(turn / 2), manaMax: Math.ceil(turn / 2), overload: 0, handCount: 1,
      handCards: overrides.handCards ?? [{ id: 101, cardId: 'CS2_029', name: '火球术', cost: 4, baseCost: 4, zone: 'HAND', type: 'SPELL', atk: 0, health: 0, text: '造成6点伤害' }],
      deckCount: 20, secrets: 0, minions: [], weapon: null, playState: 'PLAYING',
    },
    opponent: {
      playerId: 2, isLocal: false, heroClass: '战士', heroName: '', heroCardId: '',
      health: 27, maxHealth: 30, armor: 4, heroAttack: 0, fatigue: 0,
      mana: 3, manaMax: 3, overload: 0, handCount: 4, handCards: [], deckCount: 21, secrets: 0,
      minions: [], weapon: null, playState: 'PLAYING',
    },
    boardAttack: { mine: 0, theirs: 0 },
  };
}

test('askModelWithUsage: 已取消信号返回 { text: null, aborted: true } 且不发 fetch；HTTP 200 空文本带 usage 仍如实记账', async () => {
  const ac = new AbortController();
  ac.abort();
  let fetched = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response(JSON.stringify({
      choices: [{ message: { content: '   ' } }],
      usage: { prompt_tokens: 90, completion_tokens: 15, prompt_cache_hit_tokens: 30 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const abortedRes = await askModelWithUsage(
      { apiKey: 'sk-test', baseUrl: 'https://example.invalid', model: 'deepseek-chat' },
      { system: 's', user: 'u', signal: ac.signal },
    );
    assert.deepEqual(abortedRes, { text: null, aborted: true });
    assert.equal(fetched, false);

    // HTTP 200 但 choices content 为空且带 usage：必须返回 usage 供上层 reportUsage
    const emptyWithUsage = await askModelWithUsage(
      { apiKey: 'sk-test', baseUrl: 'https://example.invalid', model: 'deepseek-chat' },
      { system: 's', user: 'u' },
    );
    assert.equal(fetched, true);
    assert.equal(emptyWithUsage?.text, null);
    assert.deepEqual(emptyWithUsage?.usage, {
      promptTokens: 90,
      completionTokens: 15,
      cacheHitTokens: 30,
      cacheMissTokens: 60,
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('askModelWithUsage: 仅在响应含真实 usage 时返回 LLMUsage', async () => {
  const origFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = async () => {
    callIndex += 1;
    const payload = callIndex === 1
      ? {
          choices: [{ message: { content: '主线1' } }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 45,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 40,
          },
        }
      : { choices: [{ message: { content: '主线2' } }] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const r1 = await askModelWithUsage(
      { apiKey: 'sk-test', baseUrl: 'https://example.invalid', model: 'deepseek-chat' },
      { system: 's', user: 'u' },
    );
    assert.equal(r1?.text, '主线1');
    assert.deepEqual(r1?.usage, {
      promptTokens: 120,
      completionTokens: 45,
      cacheHitTokens: 80,
      cacheMissTokens: 40,
    });

    const r2 = await askModelWithUsage(
      { apiKey: 'sk-test', baseUrl: 'https://example.invalid', model: 'deepseek-chat' },
      { system: 's', user: 'u' },
    );
    assert.equal(r2?.text, '主线2');
    assert.equal(r2?.usage, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('tools(): hearthstone_advice 与 hearthstone_plan 开启 interruptible，plan 上报真实 usage，空回复不妄言未花钱且取消回执准确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-v6-plan-'));
  const origFetch = globalThis.fetch;
  const usages = [];
  let mode = 'normal';
  globalThis.fetch = async () => {
    if (mode === 'empty_usage') {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 150, completion_tokens: 10, prompt_cache_hit_tokens: 50 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '中速卡组：抢前期场面，后期斩杀。怕清场。' } }],
      usage: { prompt_tokens: 300, completion_tokens: 55, prompt_cache_hit_tokens: 100 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const world = definition.create(fakeContext(dir));
    world.host = {
      pushEvent: async () => ({}),
      reportUsage: (u, opts) => usages.push({ u, opts }),
    };
    const tools = world.tools();
    const adviceTool = tools.find((t) => t.name === 'hearthstone_advice');
    const planTool = tools.find((t) => t.name === 'hearthstone_plan');
    assert.equal(adviceTool?.interruptible, true);
    assert.equal(planTool?.interruptible, true);

    world.arenaDeck = ['火球术', '寒冰箭', '水元素'];
    const ac = new AbortController();
    const reply = await planTool.handler({ action: 'generate', heroClass: '法师' }, { signal: ac.signal });
    assert.match(reply.text, /中速卡组/);
    assert.equal(usages.length, 1);
    assert.equal(usages[0].opts.label, 'hearthstone:plan');
    assert.deepEqual(usages[0].u, {
      promptTokens: 300,
      completionTokens: 55,
      cacheHitTokens: 100,
      cacheMissTokens: 200,
    });

    // H6 + H9：空内容但含 usage 时仍上报用量，且提示不使用“没花钱”承诺
    mode = 'empty_usage';
    const emptyReply = await planTool.handler({ action: 'generate', heroClass: '法师', force: true }, {});
    assert.equal(usages.length, 2, '空内容但含 usage 的 200 响应也必须记账');
    assert.doesNotMatch(emptyReply.text, /没花钱/);
    assert.match(emptyReply.text, /未返回有效结果/);

    // H6：AbortSignal 已触发时明确返回推演已取消
    const abortedAc = new AbortController();
    abortedAc.abort();
    const abortedReply = await planTool.handler({ action: 'generate', heroClass: '法师', force: true }, { signal: abortedAc.signal });
    assert.equal(abortedReply.text, '推演已取消。');
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pushDeferred（H1）与 onHandoffEnded（H3/H4/H5/H10/H11）：回合实时重算、交接同步入队与静音/音乐门禁', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-v6-defer-'));
  try {
    const world = definition.create(fakeContext(dir));
    const deferred = [];
    const pushed = [];
    world.host = {
      pushEvent: async (ev, opts) => { pushed.push({ ev, opts }); return {}; },
      pushDeferred: (spec, opts) => deferred.push({ spec, opts }),
    };
    world.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

    // 未在对局中时不发 handoff
    world.onHandoffEnded();
    assert.equal(deferred.length, 0);

    const makeSnap = (turn, overrides = {}) => ({
      startedAt: overrides.startedAt ?? '2026-11-19T00:00:00Z',
      turn,
      activePlayerId: overrides.isMyTurn === false ? 2 : 1,
      isMyTurn: overrides.isMyTurn ?? true,
      step: 'MAIN_ACTION',
      ended: overrides.ended ?? false,
      result: overrides.ended ? 'won' : null,
      me: {
        playerId: 1, isLocal: true, heroClass: '法师', heroName: '', heroCardId: '',
        health: overrides.myHp ?? 24, maxHealth: 30, armor: overrides.myArmor ?? 2, heroAttack: 0, fatigue: 0,
        mana: overrides.mana ?? Math.ceil(turn / 2), manaMax: Math.ceil(turn / 2), overload: 0,
        handCount: 1,
        handCards: [{ id: 101, cardId: 'CS2_029', name: '火球术', cost: 4, baseCost: 4, zone: 'HAND', type: 'SPELL', atk: 0, health: 0, text: '造成6点伤害' }],
        deckCount: 20, secrets: 0,
        minions: [], weapon: null, playState: 'PLAYING',
      },
      opponent: {
        playerId: 2, isLocal: false, heroClass: '战士', heroName: '', heroCardId: '',
        health: overrides.foeHp ?? 27, maxHealth: 30, armor: overrides.foeArmor ?? 4, heroAttack: 0, fatigue: 0,
        mana: 3, manaMax: 3, overload: 0, handCount: 4, handCards: [], deckCount: 21, secrets: 0,
        minions: [], weapon: null, playState: 'PLAYING',
      },
      boardAttack: { mine: 0, theirs: 0 },
    });

    // H1：通过真实 onLines 触发 hearthstone.turn 入队，验证同回合实时重算与跨回合/换局/对手回合失效
    let curSnap = makeSnap(5, { myHp: 24, mana: 3 });
    world.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    world.parser.snapshot = () => curSnap;
    world.onLines([], false);
    await world.chain;
    const turnItem = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.ok(turnItem, '第 5 回合应通过 pushDeferred 入队 hearthstone.turn');
    assert.deepEqual(turnItem.spec.tags, ['snapshot']);
    assert.match(String(turnItem.spec.render()), /我 26 血/);

    // 同回合内我方出牌消耗水晶、对方或自伤掉血 -> render() 动态反映最新局面而非入队旧字符串
    curSnap = makeSnap(5, { myHp: 19, myArmor: 0, mana: 1 });
    world.lastSnapshot = curSnap;
    const reRendered = String(turnItem.spec.render());
    assert.match(reRendered, /我 19 血/, 'render() 应反映同回合最新的 19 血');
    assert.doesNotMatch(reRendered, /我 26 血/, 'render() 不应继续返回入队时的 26 血旧快照');

    // 变为对手回合 / 新对局 / 下一回合 / 对局结束均应返回 null
    world.lastSnapshot = makeSnap(5, { isMyTurn: false });
    assert.equal(turnItem.spec.render(), null, '切为对手回合应返回 null');
    world.lastSnapshot = makeSnap(5, { startedAt: '2026-11-19T01:00:00Z' });
    assert.equal(turnItem.spec.render(), null, '新对局 startedAt 变化应返回 null');
    world.lastSnapshot = makeSnap(6, { isMyTurn: true });
    assert.equal(turnItem.spec.render(), null, '进入新回合应返回 null');

    // H3/H4/H5/H10/H11：onHandoffEnded 同步入队（不依赖 await world.chain），使用 hearthstone.handoff 与统一护甲格式
    deferred.length = 0;
    world.lastSnapshot = makeSnap(7, { myHp: 20, myArmor: 5, foeHp: 18, foeArmor: 3 });
    world.onHandoffEnded();
    assert.equal(deferred.length, 1, 'onHandoffEnded 必须同步入队，不能等待 world.chain');
    assert.equal(deferred[0].spec.type, 'hearthstone.handoff');
    assert.deepEqual(deferred[0].spec.tags, ['snapshot']);
    assert.equal(deferred[0].opts.trigger, 'piggyback');
    const handoffFirst = String(deferred[0].spec.render());
    assert.match(handoffFirst, /第 7 回合.*我 20 血 \+ 5 护甲.*对手 18 血 \+ 3 护甲/);

    // 交接期间推进到第 8 回合且血量变动，render() 实时重算
    world.lastSnapshot = makeSnap(8, { myHp: 16, myArmor: 0, foeHp: 12, foeArmor: 0 });
    const handoffSecond = String(deferred[0].spec.render());
    assert.match(handoffSecond, /第 8 回合.*我 16 血 .*对手 12 血/);

    // 对局结束或重启后 startedAt 变化 -> 返回 null
    world.lastSnapshot = makeSnap(8, { ended: true });
    assert.equal(deferred[0].spec.render(), null);

    // H5：quiet / !speakTurns / musicRunning 时交接不入队，且已入队后中途切换静音或听歌，render() 必须复查并返回 null
    deferred.length = 0;
    world.lastSnapshot = makeSnap(9);
    world.cfg.mode = 'quiet';
    world.onHandoffEnded();
    world.cfg.mode = 'normal';
    world.cfg.speakTurns = false;
    world.onHandoffEnded();
    world.cfg.speakTurns = true;
    world.musicRunning = true;
    world.onHandoffEnded();
    assert.equal(deferred.length, 0, '静音、关闭回合说话或听歌让路时不发交接快照');

    world.musicRunning = false;
    world.onHandoffEnded();
    assert.equal(deferred.length, 1);
    world.musicRunning = true;
    assert.equal(deferred[0].spec.render(), null, 'H5: 入队后听歌让路激活时 render() 应返回 null');
    world.musicRunning = false;

    // H14：pushDeferred 回合事件仅在 onEventsSettled('delivered') 后提交 lastAnnouncedTurn 与 turnAdvice，discarded 不消费水位
    deferred.length = 0;
    world.lastAnnouncedTurn = -1;
    world.queuedTurn = -1;
    world.turnAdvice.clear();
    world.advicePickStreak = 0;
    world.lastAdvicePick = '';
    const turn10Snap = makeSnap(10, { mana: 4 });
    world.lastSnapshot = turn10Snap;
    world.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    world.parser.snapshot = () => world.lastSnapshot;
    world.onLines([], false);
    await world.chain;
    const turn10Defer = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.ok(turn10Defer, '第 10 回合应入队');
    assert.equal(world.lastAnnouncedTurn, -1, 'H14: 未结算投递前不得推进 lastAnnouncedTurn');
    assert.equal(world.turnAdvice.has(10), false, 'H14: 未结算投递前不得预先写 turnAdvice');

    // H5：turn 事件在 render() 时同样复查 quiet
    world.cfg.mode = 'quiet';
    assert.equal(turn10Defer.spec.render(), null, 'H5: 回合事件 render() 遇到 quiet 应返回 null');
    world.cfg.mode = 'normal';
    // 重新排一次并中途更换手牌为寒冰箭
    world.queuedTurn = -1;
    deferred.length = 0;
    world.onLines([], false);
    await world.chain;
    const turn10Defer2 = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.ok(turn10Defer2);
    const changedSnap = makeSnap(10, { mana: 2 });
    changedSnap.me.handCards = [{ id: 102, cardId: 'CS2_024', name: '寒冰箭', cost: 2, baseCost: 2, zone: 'HAND', type: 'SPELL', atk: 0, health: 0, text: '造成3点伤害并使其冻结' }];
    world.lastSnapshot = changedSnap;
    const rendered10 = String(turn10Defer2.spec.render());
    assert.match(rendered10, /寒冰箭/);
    assert.equal(world.lastAnnouncedTurn, -1);

    // discarded 不提交水位与建议记录
    world.onEventsSettled([{ type: 'hearthstone.turn', senderKey: turn10Defer2.spec.senderKey, meta: turn10Defer2.spec.meta, source: 'world:hearthstone', ts: 'x', text: rendered10, origin: 'external', cursor: 88 }], 'discarded');
    assert.equal(world.lastAnnouncedTurn, -1);
    assert.equal(world.turnAdvice.has(10), false);

    // 重新入队、render 并 delivered 后精准提交
    deferred.length = 0;
    world.onLines([], false);
    await world.chain;
    const turn10Defer3 = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    const finalRendered10 = String(turn10Defer3.spec.render());
    world.onEventsSettled([{ type: 'hearthstone.turn', senderKey: turn10Defer3.spec.senderKey, meta: turn10Defer3.spec.meta, source: 'world:hearthstone', ts: 'x', text: finalRendered10, origin: 'external', cursor: 89 }], 'delivered');
    assert.equal(world.lastAnnouncedTurn, 10, 'H14: delivered 后应推进 lastAnnouncedTurn');
    assert.equal(world.turnAdvice.get(10), '寒冰箭', 'H14: turnAdvice 应记录 render() 重算出的最新推荐牌');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('webUi().storage 覆盖五项数据目录（H7 DIARY_FILE_RE 与 H8 先删盘后清内存）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-v6-store-'));
  const customDiaryDir = join(dir, 'custom-diary');
  try {
    writeFileSync(join(dir, 'hearthstone-last-game.json'), '{"turns":5}\n', 'utf8');
    writeFileSync(join(dir, 'hearthstone-games.jsonl'), '{"turns":5,"result":"won","startedAt":"A","endedAt":"B","me":{},"opponent":{},"final":{"myHp":20,"myArmor":0,"foeHp":0,"foeArmor":0}}\n', 'utf8');
    writeFileSync(join(dir, 'hearthstone-style.md'), '# 我怎么打牌\n## 我在牌桌上是什么人\n- 我不爱浪费水晶\n', 'utf8');
    const diarySub = join(dir, 'hearthstone-diary');
    mkdirSync(diarySub, { recursive: true });
    writeFileSync(join(diarySub, '炉石日记-2026-11-19.md'), '# 炉石日记\n', 'utf8');
    writeFileSync(join(diarySub, '感想.jsonl'), '{"at":"2026-11-19T10:00:00Z","text":"好局"}\n', 'utf8');

    const world = definition.create(fakeContext(dir));
    const ui = world.webUi('zh');
    assert.ok(Array.isArray(ui.storage) && ui.storage.length === 5);
    assert.deepEqual(ui.storage.map((s) => s.key), [
      'hearthstone-archive', 'hearthstone-games', 'hearthstone-arena', 'hearthstone-diary', 'hearthstone-style',
    ]);
    for (const part of ui.storage) assert.match(part.key, /^hearthstone-[a-z]+$/, 'H23: StoragePart key 必须使用连字符前缀');

    const gamesPart = ui.storage.find((s) => s.key === 'hearthstone-games');
    assert.match(gamesPart.stat(), /1 局/);
    gamesPart.clear();
    assert.match(gamesPart.stat(), /0 局/);
    assert.equal(existsSync(join(dir, 'hearthstone-games.jsonl')), false);

    // H7：验证真实文件名「炉石日记-YYYY-MM-DD.md」统计与清理（默认目录与自定义目录均生效，且自定义目录不误删其它 md）
    const diaryPart = ui.storage.find((s) => s.key === 'hearthstone-diary');
    assert.match(diaryPart.stat(), /1 天日记 · 1 条感想/);
    diaryPart.clear();
    assert.match(diaryPart.stat(), /0 天 · 0 条感想/);

    mkdirSync(customDiaryDir, { recursive: true });
    writeFileSync(join(customDiaryDir, '炉石日记-2026-11-19.md'), '# 炉石日记\n', 'utf8');
    writeFileSync(join(customDiaryDir, '感想.jsonl'), '{"at":"2026-11-19T10:00:00Z","text":"自定义"}\n', 'utf8');
    writeFileSync(join(customDiaryDir, '个人笔记.md'), '# 不要删我\n', 'utf8');
    const customWorld = definition.create(fakeContext(dir, { diaryDir: customDiaryDir }));
    const customDiaryPart = customWorld.webUi('zh').storage.find((s) => s.key === 'hearthstone-diary');
    assert.match(customDiaryPart.stat(), /1 天日记 · 1 条感想/);
    customDiaryPart.clear();
    assert.equal(existsSync(join(customDiaryDir, '炉石日记-2026-11-19.md')), false);
    assert.equal(existsSync(join(customDiaryDir, '感想.jsonl')), false);
    assert.equal(existsSync(join(customDiaryDir, '个人笔记.md')), true, '自定义目录清理不应误删普通 md 文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ENV_PROMPT（H2）与 HEARTHSTONE_DESCRIBE 净化合规', () => {
  const envPrompt = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  assert.ok(envPrompt.length <= 3800, `ENV_PROMPT 超长: ${envPrompt.length}`);
  assert.equal(envPrompt.includes('她'), false, 'ENV_PROMPT 含第三人称「她」');
  assert.match(envPrompt, /\*\*所有战吼伤害\*\*.*绝不并入下界/);
  for (const t of HEARTHSTONE_DESCRIBE.tools) {
    assert.equal(t.description.includes('她'), false, `${t.name} description 含「她」`);
    assert.equal(/\b(she|her|hers)\b/i.test(t.description), false, `${t.name} description 含英文第三人称`);
    assert.equal(t.summary.zh.includes('她'), false, `${t.name} zh summary 含「她」`);
    assert.equal(/\b(she|her|hers)\b/i.test(t.summary.en), false, `${t.name} en summary 含第三人称`);
  }
  for (const e of HEARTHSTONE_DESCRIBE.events) {
    assert.equal(e.description.zh.includes('她'), false, `${e.type} zh 含「她」`);
    assert.equal(/\b(she|her|hers)\b/i.test(e.description.en), false, `${e.type} en 含第三人称`);
  }
});

test('第二轮复审（H13/H15/H16）：arena 清空拦截在途 generate 写回、package 形象包描述一致、plan clear 写盘失败诚实回滚', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r2-'));
  const origFetch = globalThis.fetch;
  try {
    // H15：package.json 不再写启动时自动安装形象包，统一改为面板点击安装
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.doesNotMatch(pkg.cortico.locales.en.description, /installed into data\/figures\/ at startup/);
    assert.doesNotMatch(pkg.cortico.locales.zh.description, /启动时自动装进 data\/figures\//);
    assert.match(pkg.cortico.locales.en.description, /extension panel/);
    assert.match(pkg.cortico.locales.zh.description, /扩展面板/);

    // H13：在途 generate 遇 arena.clear() 时只 reportUsage 记账，绝不写回 arenaPlan 与磁盘
    const usages = [];
    let releaseFetch;
    globalThis.fetch = () => new Promise((resolve) => {
      releaseFetch = () => resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '中速卡组：抢血。怕解场。' } }],
        usage: { prompt_tokens: 210, completion_tokens: 40, prompt_cache_hit_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const world = definition.create(fakeContext(dir));
    world.host = {
      pushEvent: async () => ({}),
      reportUsage: (u, opts) => usages.push({ u, opts }),
    };
    world.arenaDeck = ['火球术', '寒冰箭'];
    const planTool = world.tools().find((t) => t.name === 'hearthstone_plan');
    const genPromise = planTool.handler({ action: 'generate', heroClass: '法师' }, {});
    const arenaPart = world.webUi('zh').storage.find((s) => s.key === 'hearthstone-arena');
    // 在模型返回前清空竞技场
    arenaPart.clear();
    releaseFetch();
    const genOut = await genPromise;
    assert.match(genOut.text, /被清空.*已丢弃/);
    assert.equal(usages.length, 1, 'H13: 已生成的云端用量仍应如实 reportUsage');
    assert.equal(world.arenaPlan, null, 'H13: 清空后在途 generate 不得覆盖 arenaPlan');
    assert.equal(existsSync(join(dir, 'hearthstone-arena-plan.json')), false, 'H13: 不得写回推演磁盘缓存');

    // H16：planPath 无法删除/覆盖时，hearthstone_plan(action='clear') 回滚内存并返回失败说明
    const planFile = join(dir, 'hearthstone-arena-plan.json');
    mkdirSync(join(planFile, 'lockdir'), { recursive: true });
    writeFileSync(join(planFile, 'lockdir', 'f.txt'), 'x', 'utf8');
    world.arenaPlan = { text: '保留的推演', savedAt: '2026-11-19T00:00:00Z', model: 'm', heroClass: '法师', deck: ['火球术'] };
    const failClearOut = await planTool.handler({ action: 'clear' }, {});
    assert.match(failClearOut.text, /清除失败/);
    assert.ok(world.arenaPlan !== null, 'H16: 磁盘清除失败时不得假清内存');
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第三轮复审（H13/H19）：并发 generate 反序留新不留旧、draft pick 失效在途请求、写盘失败回滚且不报已存本地', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r3-arena-'));
  const origFetch = globalThis.fetch;
  try {
    const usages = [];
    const resolvers = [];
    globalThis.fetch = () => new Promise((resolve) => {
      resolvers.push((content) => resolve(new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 150, completion_tokens: 30, prompt_cache_hit_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    const world = definition.create(fakeContext(dir));
    world.host = {
      pushEvent: async () => ({}),
      reportUsage: (u, opts) => usages.push({ u, opts }),
    };
    world.arenaDeck = ['火球术', '寒冰箭'];
    const planTool = world.tools().find((t) => t.name === 'hearthstone_plan');
    const draftTool = world.tools().find((t) => t.name === 'hearthstone_draft');

    // H13-1：并发两个 generate（A 先发，B 后发），B 先完成、A 后完成 -> 必须保留 B
    const pA = planTool.handler({ action: 'generate', heroClass: '法师' }, {});
    const pB = planTool.handler({ action: 'generate', heroClass: '法师' }, {});
    assert.equal(resolvers.length, 2);
    resolvers[1]('B：较新的推演');
    const resB = await pB;
    assert.match(resB.text, /B：较新的推演/);
    assert.equal(world.arenaPlan?.text, 'B：较新的推演');

    resolvers[0]('A：较早的推演');
    const resA = await pA;
    assert.match(resA.text, /已丢弃/);
    assert.equal(world.arenaPlan?.text, 'B：较新的推演', 'H13: 较早发出的请求不得覆盖较新的 arenaPlan');
    const savedAfterRace = JSON.parse(readFileSync(join(dir, 'hearthstone-arena-plan.json'), 'utf8'));
    assert.equal(savedAfterRace.text, 'B：较新的推演');
    assert.equal(usages.length, 2, 'H13: 两次真实模型请求均应上报 reportUsage');

    // H13-2：在途 generate 遇到 draft pick（新增卡牌）必须失效丢弃
    const pC = planTool.handler({ action: 'generate', force: true, heroClass: '法师' }, {});
    assert.equal(resolvers.length, 3);
    await draftTool.handler({ pick: '寒冰箭' }, {});
    resolvers[2]('C：过时牌组的推演');
    const resC = await pC;
    assert.match(resC.text, /已丢弃/);
    assert.equal(world.arenaPlan?.text, 'B：较新的推演', 'H13: draft pick 使在途 generate 失效后不得覆盖原结论');

    // H19：planPath 无法写入时，generate 必须回滚 prevPlan 且绝不回复「已存本地」，同时保留 usage
    const planFile = join(dir, 'hearthstone-arena-plan.json');
    rmSync(planFile, { force: true });
    mkdirSync(join(planFile, 'lockdir'), { recursive: true });
    writeFileSync(join(planFile, 'lockdir', 'f.txt'), 'lock', 'utf8');
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'D：落盘会失败的推演' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const usageBeforeH19 = usages.length;
    const resFailSave = await planTool.handler({ action: 'generate', force: true, heroClass: '法师' }, {});
    assert.doesNotMatch(resFailSave.text, /已存本地/, 'H19: 写盘失败绝不能报「已存本地」');
    assert.match(resFailSave.text, /未能写入磁盘.*已回滚/);
    assert.equal(world.arenaPlan?.text, 'B：较新的推演', 'H19: 写盘失败时内存 arenaPlan 必须回滚为原值');
    assert.equal(usages.length, usageBeforeH19 + 1, 'H19: 写盘失败但云端已生成仍应记 usage');
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第三轮复审（H17/H18）：无 pushDeferred 旧宿主同步重算与提交、render 后失效/显式回收/append 异常可重排', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r3-turn-'));
  try {
    let clockMs = Date.UTC(2026, 10, 19, 12, 0, 0);
    const makeSnap = (turn, overrides = {}) => ({
      startedAt: overrides.startedAt ?? '2026-11-19T12:00:00Z',
      turn,
      activePlayerId: overrides.isMyTurn === false ? 2 : 1,
      isMyTurn: overrides.isMyTurn ?? true,
      step: 'MAIN_ACTION',
      ended: overrides.ended ?? false,
      result: null,
      me: {
        playerId: 1, isLocal: true, heroClass: '法师', heroName: '', heroCardId: '',
        health: overrides.myHp ?? 24, maxHealth: 30, armor: overrides.myArmor ?? 2, heroAttack: 0, fatigue: 0,
        mana: overrides.mana ?? Math.ceil(turn / 2), manaMax: overrides.manaMax ?? Math.ceil(turn / 2), overload: 0,
        handCount: 1,
        handCards: overrides.handCards ?? [{ id: 101, cardId: 'CS2_029', name: '火球术', cost: 4, baseCost: 4, zone: 'HAND', type: 'SPELL', atk: 0, health: 0, text: '造成6点伤害' }],
        deckCount: 20, secrets: 0,
        minions: [], weapon: null, playState: 'PLAYING',
      },
      opponent: {
        playerId: 2, isLocal: false, heroClass: '战士', heroName: '', heroCardId: '',
        health: 27, maxHealth: 30, armor: 4, heroAttack: 0, fatigue: 0,
        mana: 3, manaMax: 3, overload: 0, handCount: 4, handCards: [], deckCount: 21, secrets: 0,
        minions: [], weapon: null, playState: 'PLAYING',
      },
      boardAttack: { mine: 0, theirs: 0 },
    });

    // H17：仅提供 pushEvent 的旧宿主
    const legacyWorld = new HearthstoneWorld({ ...fakeContext(dir), now: () => clockMs });
    const legacyPushed = [];
    legacyWorld.host = {
      pushEvent: async (ev, opts) => { legacyPushed.push({ ev, opts }); return { ...ev, cursor: legacyPushed.length }; },
    };
    legacyWorld.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

    let snap = makeSnap(10, { myHp: 24, mana: 4 });
    legacyWorld.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    legacyWorld.parser.snapshot = () => snap;
    legacyWorld.onLines([], false);
    // 在 enqueue 微任务跑 push 前更新快照为 17 血 + 寒冰箭
    const updated10 = makeSnap(10, {
      myHp: 17, myArmor: 0, mana: 2,
      handCards: [{ id: 102, cardId: 'CS2_024', name: '寒冰箭', cost: 2, baseCost: 2, zone: 'HAND', type: 'SPELL', atk: 0, health: 0, text: '冰冻伤害' }],
    });
    snap = updated10;
    legacyWorld.lastSnapshot = updated10;
    await legacyWorld.chain;

    const turnPushed = legacyPushed.filter((x) => x.ev.type === 'hearthstone.turn');
    assert.equal(turnPushed.length, 1, 'H17: 旧宿主应通过 pushEvent 发出第 10 回合提醒');
    assert.match(turnPushed[0].ev.text, /我 17 血/);
    assert.match(turnPushed[0].ev.text, /寒冰箭/);
    assert.doesNotMatch(turnPushed[0].ev.text, /我 26 血/);
    assert.equal(legacyWorld.lastAnnouncedTurn, 10, 'H17: 旧宿主投递后必须推进 lastAnnouncedTurn');
    assert.equal(legacyWorld.turnAdvice.get(10), '寒冰箭', 'H17: turnAdvice 应记录重算后的首选牌');
    assert.equal(legacyWorld.advicePickStreak, 1, 'H17: 连推计数应正确更新');
    assert.equal(legacyWorld.queuedTurn, -1);

    // 第 11 回合发送前切换为对手回合 -> renderTurn 返回 null，不推 pushEvent 且不推进水位
    const oppTurn11 = makeSnap(11, { isMyTurn: false });
    snap = makeSnap(11, { isMyTurn: true });
    legacyWorld.onLines([], false);
    snap = oppTurn11;
    legacyWorld.lastSnapshot = oppTurn11;
    await legacyWorld.chain;
    assert.equal(legacyPushed.filter((x) => x.ev.type === 'hearthstone.turn').length, 1, 'H17: 过时回合在 fallback renderTurn 返 null 时不得调用 pushEvent');
    assert.equal(legacyWorld.lastAnnouncedTurn, 10);
    assert.equal(legacyWorld.queuedTurn, -1);

    // H18：pushDeferred render 后不调 onEventsSettled 的三重恢复路径
    const deferred = [];
    const pushed = [];
    let throwOnPush = false;
    const w18 = new HearthstoneWorld({ ...fakeContext(dir), now: () => clockMs });
    w18.host = {
      pushEvent: async (ev, opts) => {
        if (throwOnPush) throw new Error('store.append failed');
        pushed.push({ ev, opts });
        return { ...ev, cursor: pushed.length };
      },
      pushDeferred: (spec, opts) => deferred.push({ spec, opts }),
    };
    w18.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

    let snap18 = makeSnap(5);
    w18.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    w18.parser.snapshot = () => snap18;

    // 路径 A：render() 执行后宿主因 session 失效静默未调 onEventsSettled -> onHandoffEnded() 清理后同回合可重排
    w18.onLines([], false);
    await w18.chain;
    const t5First = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.ok(t5First && typeof t5First.spec.render() === 'string');
    w18.onHandoffEnded();
    assert.equal(w18.queuedTurn, -1, 'H18-A: onHandoffEnded 应释放已 render 未结算的占位');
    deferred.length = 0;
    w18.onLines([], false);
    await w18.chain;
    assert.ok(deferred.some((d) => d.spec.type === 'hearthstone.turn'), 'H18-A: 释放后同第 5 回合应允许重新排队');

    // 完成第 5 回合投递后再测路径 B（无期限 onDelivery 不按时间判死，仅显式交接回收）
    const t5Second = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    const t5Text = String(t5Second.spec.render());
    w18.onEventsSettled([{ type: 'hearthstone.turn', senderKey: t5Second.spec.senderKey, meta: t5Second.spec.meta, source: 'world:hearthstone', ts: 'x', text: t5Text, origin: 'external', cursor: 1 }], 'delivered');
    deferred.length = 0;
    snap18 = makeSnap(6);
    w18.lastSnapshot = snap18;
    w18.onLines([], false);
    await w18.chain;
    const t6First = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.ok(t6First && typeof t6First.spec.render() === 'string');

    clockMs += 500;
    deferred.length = 0;
    w18.onLines([], false);
    await w18.chain;
    assert.equal(deferred.length, 0, 'H18-B: 2000ms 内仍防重，不重复入队');

    clockMs += 2000;
    w18.onLines([], false);
    await w18.chain;
    assert.equal(deferred.length, 0, 'H18-B: 超 2000ms 未 settled 仍不得按时间判死重排');
    w18.onHandoffEnded();
    deferred.length = 0;
    w18.onLines([], false);
    await w18.chain;
    assert.equal(deferred.filter((d) => d.spec.type === 'hearthstone.turn').length, 1, 'H18-B: 显式交接回收后允许同第 6 回合重排');

    // 路径 C：pushEvent / store.append 抛错时，清理占位并允许立即重排
    const wErr = new HearthstoneWorld({ ...fakeContext(dir), now: () => clockMs });
    let errSnap = makeSnap(7);
    const errPushed = [];
    wErr.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    wErr.parser.snapshot = () => errSnap;
    throwOnPush = true;
    wErr.host = {
      pushEvent: async (ev, opts) => {
        if (throwOnPush) throw new Error('store.append failed');
        errPushed.push({ ev, opts });
        return { ...ev, cursor: errPushed.length };
      },
    };
    wErr.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    wErr.onLines([], false);
    await wErr.chain;
    assert.equal(wErr.queuedTurn, -1, 'H18-C: pushEvent 抛错后必须释放 queuedTurn');
    assert.equal(wErr.pendingTurns.size, 0, 'H18-C: pushEvent 抛错后必须清理 pendingTurns');
    throwOnPush = false;
    wErr.onLines([], false);
    await wErr.chain;
    assert.equal(errPushed.filter((x) => x.ev.type === 'hearthstone.turn').length, 1, 'H18-C: 故障恢复后第 7 回合应立即重排并投递成功');
    assert.equal(wErr.lastAnnouncedTurn, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第四轮 H13：缓存命中、无模型、空牌组早退都先使旧 generate 失效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r4-generate-'));
  const origFetch = globalThis.fetch;
  try {
    for (const kind of ['cache', 'no-model', 'empty-deck']) {
      const sub = join(dir, kind);
      mkdirSync(sub, { recursive: true });
      const oldPlan = {
        text: `旧缓存-${kind}`, savedAt: '2026-11-19T00:00:00Z', model: 'm', heroClass: '法师', deck: ['火球术', '寒冰箭'],
      };
      writeFileSync(join(sub, 'hearthstone-arena-plan.json'), JSON.stringify(oldPlan, null, 2), 'utf8');
      const world = definition.create(fakeContext(sub));
      const usages = [];
      world.host = { pushEvent: async () => ({}), reportUsage: (u) => usages.push(u) };
      world.arenaDeck = ['火球术', '寒冰箭'];
      const planTool = world.tools().find((t) => t.name === 'hearthstone_plan');
      let release;
      globalThis.fetch = () => new Promise((resolve) => {
        release = () => resolve(new Response(JSON.stringify({
          choices: [{ message: { content: `A-${kind}-过期结果` } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      });
      const pendingA = planTool.handler({ action: 'generate', force: true, heroClass: '法师' }, {});
      assert.equal(typeof release, 'function');

      if (kind === 'cache') {
        const cached = await planTool.handler({ action: 'generate', heroClass: '法师' }, {});
        assert.match(cached.text, new RegExp(`旧缓存-${kind}`));
      } else if (kind === 'no-model') {
        world.llmKey = '';
        const noModel = await planTool.handler({ action: 'generate', force: true, heroClass: '法师' }, {});
        assert.match(noModel.text, /模型没配/);
      } else {
        world.arenaDeck = [];
        const empty = await planTool.handler({ action: 'generate', force: true, heroClass: '法师' }, {});
        assert.match(empty.text, /还没有牌组快照/);
      }

      release();
      const staleA = await pendingA;
      assert.match(staleA.text, /已丢弃/, `${kind}: 早退必须使 A 失效`);
      assert.equal(world.arenaPlan?.text, `旧缓存-${kind}`);
      assert.equal(JSON.parse(readFileSync(join(sub, 'hearthstone-arena-plan.json'), 'utf8')).text, `旧缓存-${kind}`);
      assert.equal(usages.length, 1, `${kind}: 旧请求实际用量仍须记账`);
    }
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第四轮 H14/H18/H20：旧 A discarded 不碰新 B，render 异常可回收重排', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r4-turn-'));
  try {
    let clockMs = Date.UTC(2026, 10, 19, 12, 0, 0);
    const world = new HearthstoneWorld({ ...fakeContext(dir), now: () => clockMs });
    const deferred = [];
    world.host = {
      pushEvent: async (ev) => ({ ...ev, cursor: 1 }),
      pushDeferred: (spec, opts) => deferred.push({ spec, opts }),
    };
    world.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    let snap = turnSnapshot(10);
    world.lastSnapshot = snap;
    world.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    world.parser.snapshot = () => snap;

    world.onLines([], false);
    await world.chain;
    const a = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.ok(a);
    assert.match(String(a.spec.render()), /火球术/);
    const attemptA = a.spec.meta.hearthstoneTurnAttempt;
    assert.equal(world.pendingTurns.has(attemptA), true);

    world.onHandoffEnded();
    assert.equal(world.queuedTurn, -1);
    assert.equal(world.pendingTurns.size, 0);
    deferred.length = 0;
    snap = turnSnapshot(10, {
      handCards: [{ id: 102, cardId: 'CS2_024', name: '寒冰箭', cost: 2, baseCost: 2, zone: 'HAND', type: 'SPELL', atk: 0, health: 0, text: '冰冻伤害' }],
    });
    world.lastSnapshot = snap;
    world.onLines([], false);
    await world.chain;
    const b = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.ok(b);
    assert.match(String(b.spec.render()), /寒冰箭/);
    const attemptB = b.spec.meta.hearthstoneTurnAttempt;
    assert.notEqual(attemptB, attemptA);

    world.onEventsSettled([settledTurn(a.spec, 99)], 'discarded');
    assert.equal(world.lastAnnouncedTurn, -1, '旧 A discarded 不得提交新 B');
    assert.equal(world.pendingTurns.has(attemptB), true, '旧 A discarded 不得清 B pending');
    assert.equal(world.queuedTurnAttempt, attemptB, '旧 A discarded 不得清 B 占位');
    world.onEventsSettled([{ ...settledTurn(b.spec, 101), meta: undefined }], 'delivered');
    assert.equal(world.lastAnnouncedTurn, -1, '缺 attempt 身份的事件不得按 senderKey 猜测提交');
    assert.equal(world.pendingTurns.has(attemptB), true);

    world.onEventsSettled([settledTurn(b.spec, 102)], 'delivered');
    assert.equal(world.lastAnnouncedTurn, 10);
    assert.equal(world.turnAdvice.get(10), '寒冰箭');
    assert.equal(world.pendingTurns.size, 0);
    assert.equal(world.queuedTurn, -1);

    deferred.length = 0;
    snap = turnSnapshot(11);
    world.lastSnapshot = snap;
    world.onLines([], false);
    await world.chain;
    const broken = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    const originalPreview = world.previewRepeatNote;
    world.previewRepeatNote = () => { throw new Error('render exploded'); };
    assert.equal(broken.spec.render(), null, 'render 内部异常应转成不投递并自行回收');
    assert.equal(world.queuedTurn, -1);
    assert.equal(world.pendingTurns.size, 0);
    world.previewRepeatNote = originalPreview;
    deferred.length = 0;
    world.onLines([], false);
    await world.chain;
    assert.equal(deferred.filter((d) => d.spec.type === 'hearthstone.turn').length, 1, '异常回收后同回合应能立即重排');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第四轮 H21：旧宿主 handoff fallback 的 pushEvent rejection 显式 catch + warn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r4-handoff-'));
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const world = definition.create(fakeContext(dir));
    world.lastSnapshot = turnSnapshot(5);
    const warnings = [];
    let pushes = 0;
    world.host = {
      pushEvent: async () => { pushes += 1; throw new Error('pushEvent rejected'); },
    };
    world.log = { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {}, debug: () => {} };
    world.onHandoffEnded();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pushes, 1);
    assert.equal(unhandled.length, 0, 'fallback Promise 必须被显式处理');
    assert.ok(warnings.some((msg) => /交接快照推送失败.*pushEvent rejected/.test(msg)));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第四轮 H22：arena 三文件 unlink 故障矩阵全部回滚，代次在删除前递增', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r4-clear-'));
  const names = ['hearthstone-arena.json', 'hearthstone-arena-meta.json', 'hearthstone-arena-plan.json'];
  try {
    for (let failIndex = 0; failIndex < names.length; failIndex += 1) {
      const sub = join(dir, String(failIndex));
      mkdirSync(sub, { recursive: true });
      const paths = names.map((name) => join(sub, name));
      const bodies = [
        JSON.stringify({ cards: ['火球术'] }, null, 2),
        JSON.stringify({ 法师: { notes: '保留笔记', savedAt: '2026-11-19T00:00:00Z' } }, null, 2),
        JSON.stringify({ text: '保留推演', savedAt: '2026-11-19T00:00:00Z', model: 'm', heroClass: '法师', deck: ['火球术'] }, null, 2),
      ];
      paths.forEach((path, index) => writeFileSync(path, bodies[index], 'utf8'));
      const world = definition.create(fakeContext(sub));
      assert.equal(world.arenaPlan?.text, '保留推演');
      const generation = world.arenaGeneration;
      const target = paths[failIndex];
      const originalUnlink = fs.unlinkSync;
      const restore = patchFs('unlinkSync', (path, ...args) => {
        if (String(path) === target) throw new Error(`injected unlink ${failIndex}`);
        return originalUnlink(path, ...args);
      });
      let thrown = null;
      try {
        world.webUi('zh').storage.find((s) => s.key === 'hearthstone-arena').clear();
      } catch (error) {
        thrown = error;
      } finally {
        restore();
      }
      assert.match(String(thrown), /已恢复本次删除的全部文件/, `第 ${failIndex + 1} 个 unlink 失败应完整回滚`);
      assert.equal(world.arenaGeneration, generation + 1, 'clear 一开始就必须使在途请求失效');
      paths.forEach((path, index) => assert.equal(readFileSync(path, 'utf8'), bodies[index], `${names[index]} 内容必须保留`));
      assert.equal(world.arenaDeck.length, 1);
      assert.equal(world.arenaMeta.法师.notes, '保留笔记');
      assert.equal(world.arenaPlan?.text, '保留推演');
      assert.equal(fs.readdirSync(sub).some((name) => name.includes('.tmp-')), false, '回滚不得遗留临时文件');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第四轮 H24：临时文件写入/flush/rename 故障均保留旧 JSON 并清理临时文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r4-atomic-'));
  const origFetch = globalThis.fetch;
  try {
    for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) {
      const sub = join(dir, method);
      mkdirSync(sub, { recursive: true });
      const planFile = join(sub, 'hearthstone-arena-plan.json');
      const oldPlan = { text: `旧有效 JSON-${method}`, savedAt: '2026-11-19T00:00:00Z', model: 'm', heroClass: '法师', deck: ['火球术'] };
      const oldBody = JSON.stringify(oldPlan, null, 2);
      writeFileSync(planFile, oldBody, 'utf8');
      const world = definition.create(fakeContext(sub));
      world.arenaDeck = ['火球术'];
      const usages = [];
      world.host = { pushEvent: async () => ({}), reportUsage: (u) => usages.push(u) };
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: `新推演-${method}` } }],
        usage: { prompt_tokens: 20, completion_tokens: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });

      let restore;
      if (method === 'writeFileSync') {
        const original = fs.writeFileSync;
        restore = patchFs(method, (...args) => {
          original(...args);
          throw new Error('injected partial write');
        });
      } else if (method === 'fsyncSync') {
        restore = patchFs(method, () => { throw new Error('injected flush failure'); });
      } else {
        const original = fs.renameSync;
        restore = patchFs(method, (from, to) => {
          if (String(to) === planFile) throw new Error('injected rename failure');
          original(from, to);
        });
      }
      let reply;
      try {
        reply = await world.tools().find((t) => t.name === 'hearthstone_plan')
          .handler({ action: 'generate', force: true, heroClass: '法师' }, {});
      } finally {
        restore();
      }
      assert.match(reply.text, /未能写入磁盘.*已回滚/, `${method}: 不得假报保存成功`);
      assert.equal(world.arenaPlan?.text, oldPlan.text, `${method}: 内存回滚到旧值`);
      assert.equal(readFileSync(planFile, 'utf8'), oldBody, `${method}: 磁盘旧 JSON 必须逐字保留`);
      assert.equal(fs.readdirSync(sub).some((name) => name.includes('.tmp-')), false, `${method}: 临时文件必须清理`);
      assert.equal(usages.length, 1, `${method}: 实际模型用量仍须记账`);
    }
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第五轮 stop-inflight：plan/advice 先切代并取消，等待真实 usage 恰好结算一次后才卸载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r5-stop-'));
  const origFetch = globalThis.fetch;
  try {
    for (const kind of ['plan', 'advice']) {
      const sub = join(dir, kind);
      mkdirSync(sub, { recursive: true });
      let releaseFetch;
      let requestSignal;
      globalThis.fetch = (_url, opts) => new Promise((resolve) => {
        requestSignal = opts?.signal;
        releaseFetch = () => resolve(new Response(JSON.stringify({
          choices: [{ message: { content: `STOP_${kind}_LATE_RESULT` } }],
          usage: { prompt_tokens: 123, completion_tokens: 45, prompt_cache_hit_tokens: 23 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      });
      const world = definition.create(fakeContext(sub));
      const usages = [];
      world.host = {
        pushEvent: async () => ({}),
        reportUsage: (u, opts) => usages.push({ u, opts }),
      };
      world.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

      let pending;
      if (kind === 'plan') {
        world.arenaDeck = ['火球术', '寒冰箭'];
        pending = world.tools().find((t) => t.name === 'hearthstone_plan')
          .handler({ action: 'generate', force: true, heroClass: '法师' }, {});
      } else {
        world.cfg.llmAdvice = true;
        world.lastSnapshot = turnSnapshot(10);
        pending = world.tools().find((t) => t.name === 'hearthstone_advice').handler({}, {});
      }
      assert.equal(typeof releaseFetch, 'function');
      const generation = world.arenaGeneration;
      const stopping = world.stop();
      const generationAfterStop = world.arenaGeneration;
      const hostBeforeRelease = world.host;
      const abortedAtStop = requestSignal?.aborted;
      releaseFetch();
      const [receipt] = await Promise.all([pending, stopping]);

      if (kind === 'plan') {
        assert.equal(generationAfterStop, generation + 1, 'stop 第一动就必须使在途 plan 失效');
        assert.match(receipt.text, /已丢弃/);
        assert.equal(world.arenaPlan, null, '停止后不得写回 arenaPlan');
        assert.equal(existsSync(join(sub, 'hearthstone-arena-plan.json')), false, '停止后不得写推演磁盘缓存');
      } else {
        assert.doesNotMatch(receipt.text, /STOP_advice_LATE_RESULT/, '停止后的第二意见不得再拼进工具回执');
      }
      assert.ok(hostBeforeRelease, '在途请求结算前不得提前清空 host');
      assert.equal(abortedAtStop, true, 'stop 必须主动取消在途 LLM');
      assert.equal(usages.length, 1, `${kind}: 迟到的真实 usage 必须恰好上报一次`);
      assert.equal(usages[0].opts.label, `hearthstone:${kind}`);
      assert.deepEqual(usages[0].u, {
        promptTokens: 123, completionTokens: 45, cacheHitTokens: 23, cacheMissTokens: 100,
      });
      assert.equal(world.llmInflight.size, 0);
      assert.equal(world.host, null);
      assert.equal(world.log, null);
    }
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第五轮 deferred：render 超过 2 秒不判死，回收 A 后迟到 delivered 仍提交 A 并取消未 append 的 B', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r5-late-delivery-'));
  try {
    let clockMs = Date.UTC(2026, 10, 19, 12, 0, 0);
    const world = new HearthstoneWorld({ ...fakeContext(dir), now: () => clockMs });
    const deferred = [];
    world.host = {
      pushEvent: async (ev) => ({ ...ev, cursor: 1 }),
      pushDeferred: (spec, opts) => deferred.push({ spec, opts }),
    };
    world.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    let snap = turnSnapshot(10);
    world.lastSnapshot = snap;
    world.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    world.parser.snapshot = () => snap;

    world.onLines([], false);
    await world.chain;
    const a = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.match(String(a.spec.render()), /火球术/);
    const attemptA = a.spec.meta.hearthstoneTurnAttempt;

    clockMs += 5000;
    world.onLines([], false);
    await world.chain;
    assert.equal(deferred.filter((d) => d.spec.type === 'hearthstone.turn').length, 1,
      '无期限 onDelivery 未 settled 时不得仅靠 2 秒超时再排 B');

    // 明确的交接边界才回收占位；A 的 rendered 身份留作 tombstone，不能删账。
    world.onHandoffEnded();
    deferred.length = 0;
    world.onLines([], false);
    await world.chain;
    const b = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.ok(b);
    assert.notEqual(b.spec.meta.hearthstoneTurnAttempt, attemptA);

    // A 在 B 尚未 render/append 前迟到：提交 A，B 再 render 必须返回 null，避免两条提醒。
    world.onEventsSettled([settledTurn(a.spec, 100)], 'delivered');
    assert.equal(world.lastAnnouncedTurn, 10);
    assert.equal(world.turnAdvice.get(10), '火球术');
    assert.equal(world.advicePickStreak, 1);
    assert.equal(b.spec.render(), null, 'A 已真实 delivered 后，未 append 的 B 不得再形成重复提醒');
    assert.equal(world.queuedTurn, -1);

    world.onEventsSettled([settledTurn(a.spec, 100)], 'delivered');
    assert.equal(world.advicePickStreak, 1, '重复 delivered 回调不得重复记账');
    assert.equal(world.turnAdvice.get(10), '火球术');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第五轮 deferred：A 永不 settled 时不自动重排，显式回收后 B 可投递且 stop 清理 tombstone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r5-never-settled-'));
  try {
    let clockMs = Date.UTC(2026, 10, 19, 12, 0, 0);
    const world = new HearthstoneWorld({ ...fakeContext(dir), now: () => clockMs });
    const deferred = [];
    world.host = {
      pushEvent: async (ev) => ({ ...ev, cursor: 1 }),
      pushDeferred: (spec, opts) => deferred.push({ spec, opts }),
    };
    world.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    let snap = turnSnapshot(10);
    world.lastSnapshot = snap;
    world.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    world.parser.snapshot = () => snap;

    world.onLines([], false);
    await world.chain;
    const a = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.ok(a.spec.render());
    const attemptA = a.spec.meta.hearthstoneTurnAttempt;
    clockMs += 60_000;
    world.onLines([], false);
    await world.chain;
    assert.equal(deferred.filter((d) => d.spec.type === 'hearthstone.turn').length, 1,
      'A 永不 settled 也不能靠时间制造重复提醒');

    world.onHandoffEnded();
    assert.equal(world.retiredTurnAttempts.has(attemptA), true, '回收必须保留迟到结算所需 tombstone');
    deferred.length = 0;
    snap = turnSnapshot(10, {
      handCards: [{ id: 102, cardId: 'CS2_024', name: '寒冰箭', cost: 2, baseCost: 2, zone: 'HAND', type: 'SPELL', atk: 0, health: 0, text: '冰冻伤害' }],
    });
    world.lastSnapshot = snap;
    world.onLines([], false);
    await world.chain;
    const b = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    const bText = String(b.spec.render());
    world.onEventsSettled([settledTurn(b.spec, 101, bText)], 'delivered');
    assert.equal(world.lastAnnouncedTurn, 10);
    assert.equal(world.turnAdvice.get(10), '寒冰箭');

    deferred.length = 0;
    world.onLines([], false);
    await world.chain;
    assert.equal(deferred.filter((d) => d.spec.type === 'hearthstone.turn').length, 0,
      'B 已提交后不得继续重排同回合提醒');
    await world.stop();
    assert.equal(world.pendingTurns.size, 0);
    assert.equal(world.retiredTurnAttempts.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第五轮 deferred：A/B 均已 append 时诚实告警，迟到 A 与后续 B 只提交一次回合账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r5-double-append-'));
  try {
    const world = definition.create(fakeContext(dir));
    const deferred = [];
    const warnings = [];
    world.host = {
      pushEvent: async (ev) => ({ ...ev, cursor: 1 }),
      pushDeferred: (spec, opts) => deferred.push({ spec, opts }),
    };
    world.log = { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {}, debug: () => {} };
    let snap = turnSnapshot(10);
    world.lastSnapshot = snap;
    world.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    world.parser.snapshot = () => snap;
    world.onLines([], false);
    await world.chain;
    const a = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.match(String(a.spec.render()), /火球术/);
    world.onHandoffEnded();

    deferred.length = 0;
    snap = turnSnapshot(10, {
      handCards: [{ id: 102, cardId: 'CS2_024', name: '寒冰箭', cost: 2, baseCost: 2, zone: 'HAND', type: 'SPELL', atk: 0, health: 0, text: '冰冻伤害' }],
    });
    world.lastSnapshot = snap;
    world.onLines([], false);
    await world.chain;
    const b = deferred.find((d) => d.spec.type === 'hearthstone.turn');
    assert.match(String(b.spec.render()), /寒冰箭/);

    world.onEventsSettled([settledTurn(a.spec, 100)], 'delivered');
    assert.equal(world.turnAdvice.get(10), '火球术');
    assert.ok(warnings.some((msg) => /无法撤回/.test(msg)), '两条均已 append 时必须诚实说明无法撤回');
    world.onEventsSettled([settledTurn(b.spec, 101)], 'delivered');
    assert.equal(world.turnAdvice.get(10), '火球术', '同回合后续 B 不得覆盖或重复提交 A 的账');
    assert.equal(world.advicePickStreak, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第五轮 deferred：隐藏 World 从未 render 的占位按租约恢复，旧 render 不清新槽，render 后不按时间判死', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r5-hidden-unrendered-'));
  try {
    let clockMs = Date.UTC(2026, 10, 19, 12, 0, 0);
    let visible = false;
    const world = new HearthstoneWorld({ ...fakeContext(dir), now: () => clockMs });
    const enqueued = [];
    const delivered = [];
    world.host = {
      pushEvent: async (ev) => ({ ...ev, cursor: 1 }),
      pushDeferred: (spec, opts) => {
        enqueued.push({ spec, opts });
        // 宿主对隐藏 World 的 deferred 直接丢弃，既不 render 也不回调。
        if (visible) delivered.push({ spec, opts });
      },
    };
    world.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const snap = turnSnapshot(10);
    world.lastSnapshot = snap;
    world.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
    world.parser.snapshot = () => snap;

    world.onLines([], false);
    await world.chain;
    assert.equal(enqueued.length, 1, '隐藏时 pushDeferred 仍会被调用一次');
    assert.equal(delivered.length, 0, '隐藏时宿主不投递');
    const hidden = enqueued[0];
    const attemptHidden = hidden.spec.meta.hearthstoneTurnAttempt;
    assert.equal(world.queuedTurn, 10, '从未 render 的占位暂时保留，避免同回合刷屏');
    assert.equal(world.queuedTurnRenderedAt, 0);

    // 租约内不得恢复：宿主可能只是慢，不能按 2 秒判死。
    clockMs += 2_000;
    world.onLines([], false);
    await world.chain;
    assert.equal(enqueued.length, 1, '租约未到不得重排同回合');

    // 租约到期后恢复可见：释放未 render 占位，可立即重新入队。
    clockMs += 29_000;
    visible = true;
    world.onLines([], false);
    await world.chain;
    assert.equal(delivered.length, 1, '租约到期且恢复可见后应有新的 deferred 入队');
    const fresh = delivered[0];
    const attemptFresh = fresh.spec.meta.hearthstoneTurnAttempt;
    assert.notEqual(attemptFresh, attemptHidden, '恢复必须使用新 attempt');
    assert.equal(world.queuedTurnAttempt, attemptFresh);

    // 旧 A 的迟到 render 只能作废自己，不能清掉新 B 的占位。
    assert.equal(hidden.spec.render(), null, '旧 attempt 晚 render 必须返回 null');
    assert.equal(world.queuedTurn, 10);
    assert.equal(world.queuedTurnAttempt, attemptFresh, '旧 render 不得清新槽');

    const freshText = String(fresh.spec.render());
    assert.match(freshText, /火球术/);
    clockMs += 60_000;
    world.onLines([], false);
    await world.chain;
    assert.equal(enqueued.length, 2, 'render 后超过租约也不得再排同回合提醒');
    assert.equal(world.queuedTurnAttempt, attemptFresh);

    world.onEventsSettled([settledTurn(fresh.spec, 100, freshText)], 'delivered');
    assert.equal(world.lastAnnouncedTurn, 10);
    assert.equal(world.turnAdvice.get(10), '火球术');
    assert.equal(world.queuedTurn, -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第五轮 deferred：旧实例同 attempt+senderKey 的迟到回执不得结算新实例', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'hs-r5-instance-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'hs-r5-instance-b-'));
  try {
    const makeWorld = (dir) => {
      const w = new HearthstoneWorld(fakeContext(dir));
      const deferred = [];
      w.host = {
        pushEvent: async (ev) => ({ ...ev, cursor: 1 }),
        pushDeferred: (spec, opts) => deferred.push({ spec, opts }),
      };
      w.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      const snap = turnSnapshot(10);
      w.lastSnapshot = snap;
      w.parser.feed = () => ({ turnChanged: true, gameStarted: false, gameEnded: false, newActions: [] });
      w.parser.snapshot = () => snap;
      return { w, deferred, snap };
    };
    const a = makeWorld(dirA);
    const b = makeWorld(dirB);
    a.w.onLines([], false);
    b.w.onLines([], false);
    await a.w.chain;
    await b.w.chain;
    const specA = a.deferred.find((d) => d.spec.type === 'hearthstone.turn').spec;
    const specB = b.deferred.find((d) => d.spec.type === 'hearthstone.turn').spec;

    assert.equal(specA.senderKey, specB.senderKey, '重载后同回合 senderKey 相同');
    assert.equal(specA.meta.hearthstoneTurnAttempt, specB.meta.hearthstoneTurnAttempt,
      '两实例各自从 1 计数，attempt 数值相同');
    assert.notEqual(specA.meta.hearthstoneTurnInstance, specB.meta.hearthstoneTurnInstance,
      '实例身份必须不可复用');

    assert.ok(specA.render());
    assert.ok(specB.render());
    // 宿主按 source 广播：旧实例 A 的 delivered 也会送到新实例 B。
    b.w.onEventsSettled([settledTurn(specA, 100)], 'delivered');
    assert.equal(b.w.lastAnnouncedTurn, -1, '旧实例回执不得提交新实例的回合账');
    assert.equal(b.w.turnAdvice.has(10), false);
    assert.equal(b.w.pendingTurns.has(specB.meta.hearthstoneTurnAttempt), true, '新实例 pending 不得被旧回执清掉');

    const textB = String(specB.render());
    b.w.onEventsSettled([settledTurn(specB, 101, textB)], 'delivered');
    assert.equal(b.w.lastAnnouncedTurn, 10);
    assert.equal(b.w.turnAdvice.get(10), '火球术');

    // A 自己的回执仍只结算 A。
    a.w.onEventsSettled([settledTurn(specA, 100)], 'delivered');
    assert.equal(a.w.lastAnnouncedTurn, 10);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('第五轮 webUi(en)：五个 StoragePart 的声明、stat 与 clear 回执全英文且 key 不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-r5-storage-en-'));
  try {
    const world = definition.create(fakeContext(dir));
    const zh = world.webUi('zh').storage;
    const en = world.webUi('en').storage;
    assert.deepEqual(en.map((part) => part.key), zh.map((part) => part.key));
    assert.equal(en.length, 5);
    for (const part of en) {
      for (const text of [part.label, part.note, part.stat()]) {
        assert.match(text, /[A-Za-z]/, `${part.key}: 英文声明不得为空或仅含数字`);
        assert.doesNotMatch(text, /[\u3400-\u9fff]/, `${part.key}: 英文声明仍含中文: ${text}`);
      }
      const receipt = await part.clear();
      assert.match(receipt, /[A-Za-z]/);
      assert.doesNotMatch(receipt, /[\u3400-\u9fff]/, `${part.key}: clear 回执仍含中文: ${receipt}`);
      assert.doesNotMatch(part.stat(), /[\u3400-\u9fff]/, `${part.key}: clear 后 stat 仍含中文`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
