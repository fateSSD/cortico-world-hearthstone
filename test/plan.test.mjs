/**
 * 「这套牌怎么赢」的推演(`hearthstone_plan`)。
 *
 * 这一步卡表算不出来:它能数平均费、数解场,但算不出这 30 张凑在一起是什么东西。
 * 交给模型推 —— 代价是一次调用,所以要测清楚**什么时候不重算**:
 * 牌组没变就别重复花钱,牌组变了才重新推。
 *
 * 另外盯一下规则文本:模型说「靠铺场压死」之前,得先知道嘲讽挡路、突袭不能打脸。
 * 规则写漏一条,推出来的方向可能就是反的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES_BRIEF, RULES_FOR_MODEL } from '../src/rules.ts';

const mod = await import('../src/index.ts');
const definition = mod.default;

function context(dir) {
  const cfg = definition.defaults();
  return {
    id: definition.id,
    cfg,
    timezone: 'Asia/Shanghai',
    botName: 'Coo',
    botDir: dir,
    packageDir: dir,
    dataDir: dir,
    repoRoot: dir,
    secret: () => '',     // 没有密钥 —— 模型这条路是关的，正好测降级
    storeSecret: () => {},
    persist: (patch) => Object.assign(cfg, patch),
    restart: async () => {},
  };
}

function bench(seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hs-plan-'));
  if (seed.arena) writeFileSync(join(dir, 'hearthstone-arena.json'), JSON.stringify({ cards: seed.arena }), 'utf8');
  if (seed.plan) writeFileSync(join(dir, 'hearthstone-arena-plan.json'), JSON.stringify(seed.plan), 'utf8');
  const world = definition.create(context(dir));
  const call = async (name, args) => {
    const out = await world.tools().find((t) => t.name === name).handler(args ?? {}, {});
    return typeof out === 'string' ? out : out.text;
  };
  return { dir, world, call, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('没推过时,read 指路到 generate,并说明一次就好', async () => {
  const b = bench();
  try {
    const text = await b.call('hearthstone_plan', {});
    assert.match(text, /还没推过/);
    assert.match(text, /generate/);
    assert.match(text, /卡组不变就不用重跑/);
  } finally {
    b.done();
  }
});

test('没有牌组时,先说清楚要记牌 —— 空手套不出推演', async () => {
  const b = bench();
  try {
    const text = await b.call('hearthstone_plan', { action: 'generate' });
    assert.match(text, /还没有牌组快照/);
    assert.match(text, /hearthstone_draft/);
  } finally {
    b.done();
  }
});

test('有牌组但没配模型,要说清「没模型也能打」,别假装算过', async () => {
  const b = bench({ arena: ['火球术', '寒冰箭', '水元素'] });
  try {
    const text = await b.call('hearthstone_plan', { action: 'generate' });
    assert.match(text, /模型没配/);
    assert.match(text, /规则|曲线/, `没说清降级后还能给什么:${text}`);
    assert.doesNotMatch(text, /快攻|中速|控制/, '没跑模型却给了推演结论');
  } finally {
    b.done();
  }
});

test('存下来的推演能读回来,并且认得出是同一套牌', async () => {
  const b = bench({
    arena: ['CS2_029', 'CS2_024'],
    plan: { text: '中速：靠 2 费铺场抢节奏，火球留着解大怪。最怕对面更快。', savedAt: '2026-10-24T03:00:00.000Z', model: 'deepseek-chat', heroClass: '法师', deck: ['CS2_029', 'CS2_024'] },
  });
  try {
    const text = await b.call('hearthstone_plan', { action: 'read' });
    assert.match(text, /中速/);
    assert.match(text, /deepseek-chat/);
    assert.match(text, /✓ 还是推这套牌时的牌组/);
    assert.doesNotMatch(text, /对不上/);
  } finally {
    b.done();
  }
});

test('牌组换了之后,老实说推演过期了', async () => {
  const b = bench({
    arena: ['CS2_057'],   // 岩浆暴怒者，跟推演时那套完全不同
    plan: { text: '快攻：抢血。', savedAt: '2026-10-24T03:00:00.000Z', model: 'x', heroClass: '', deck: ['CS2_029'] },
  });
  try {
    const text = await b.call('hearthstone_plan', { action: 'read' });
    assert.match(text, /牌组已经变了/);
    assert.match(text, /火球术/, `该指出是哪张不在了:${text}`);
    assert.match(text, /force=true/, '要告诉她怎么重推');
  } finally {
    b.done();
  }
});

test('牌组一模一样时不重复花钱,直接给上次结论', async () => {
  const b = bench({
    arena: ['CS2_029'],
    plan: { text: '中速：稳。', savedAt: '2026-10-24T03:00:00.000Z', model: 'x', heroClass: '', deck: ['CS2_029'] },
  });
  try {
    const text = await b.call('hearthstone_plan', { action: 'generate' });
    assert.match(text, /不重复花钱/, `同卡组还去跑模型:${text}`);
    assert.match(text, /中速/);
  } finally {
    b.done();
  }
});

test('clear 之后回到「还没推过」', async () => {
  const b = bench({
    arena: ['CS2_029'],
    plan: { text: '中速：稳。', savedAt: '2026-10-24T03:00:00.000Z', model: 'x', heroClass: '', deck: ['CS2_029'] },
  });
  try {
    assert.match(await b.call('hearthstone_plan', { action: 'clear' }), /已清掉/);
    assert.match(await b.call('hearthstone_plan', {}), /还没推过/);
  } finally {
    b.done();
  }
});

test('规则文本里,判断用得上的那几条一条都不能少', () => {
  const must = ['同时结算', '突袭', '冲锋', '嘲讽', '剧毒', '吸血', '水晶'];
  for (const kw of must) {
    assert.ok(RULES_FOR_MODEL.includes(kw), `给模型的规则缺了「${kw}」`);
    assert.ok(RULES_BRIEF.includes(kw), `给她的规则缺了「${kw}」`);
  }
  // 精简版不能比完整版长 —— 它要塞进每一轮的前缀
  assert.ok(RULES_BRIEF.length < RULES_FOR_MODEL.length, '精简版反而更长');
  // 竞技场的特殊性必须写到，否则模型会按构筑的思路推
  assert.match(RULES_FOR_MODEL, /竞技场/);
  assert.match(RULES_BRIEF, /竞技场/);
});

test('规则进了环境变量 —— 她读得到，不用另开工具', async () => {
  const b = bench();
  try {
    const vars = b.world.envPromptVars();
    assert.ok(vars['hs.rules'], 'hs.rules 没注入');
    assert.match(vars['hs.rules'], /同时结算/);
  } finally {
    b.done();
  }
});
