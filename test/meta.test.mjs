/**
 * 竞技场打法笔记(`hearthstone_meta`)。
 *
 * 为什么要有这个东西:卡表里有费、有身材、有摘要,**唯独没有「什么牌真的能赢」**。
 * 那份知识只在网上,而每次选牌都搜一遍不可能 —— 一个 run 三十来次选牌。
 *
 * 所以:搜一次 → 提炼几条 → 存本地 → 之后每次选牌先读。
 * 什么时候要重搜是这套测试的重点:换牌组要重搜,同一套牌在长则不用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    secret: () => '',
    storeSecret: () => {},
    persist: (patch) => Object.assign(cfg, patch),
    restart: async () => {},
  };
}

/** 一个干净的 world + 它的三个相关工具。每个用例一个独立目录,互不干扰。 */
function bench() {
  const dir = mkdtempSync(join(tmpdir(), 'hs-meta-'));
  const world = definition.create(context(dir));
  const tool = (name) => world.tools().find((t) => t.name === name);
  const call = async (name, args) => {
    const out = await tool(name).handler(args ?? {}, { log: console, role: 'test' });
    return typeof out === 'string' ? out : out.text;
  };
  return { dir, world, call, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('没有笔记时,教她去搜一次,并且说清「整个 run 只搜这一次」', async () => {
  const b = bench();
  try {
    const text = await b.call('hearthstone_meta', {});
    assert.match(text, /还没有任何打法笔记/);
    assert.match(text, /browser_search/, '要指路到搜索工具');
    assert.match(text, /save/, '要告诉她搜完存回来');
  } finally {
    b.done();
  }
});

test('存下来之后能原样读回来,并且认得出是同一套牌', async () => {
  const b = bench();
  try {
    // 先记三张牌 —— 笔记会把当时的牌组快照一起存下来
    for (const card of ['火球术', '寒冰箭', '水元素']) await b.call('hearthstone_draft', { pick: card });

    const saved = await b.call('hearthstone_meta', {
      action: 'save',
      heroClass: '法师',
      notes: '抢节奏：优先直伤，2 费曲线要满，别拿大白板。',
    });
    assert.match(saved, /已存「法师」/);
    assert.match(saved, /3 张牌/, `没记下牌组快照:${saved}`);

    const read = await b.call('hearthstone_meta', { action: 'read', heroClass: '法师' });
    assert.match(read, /抢节奏/, '笔记正文丢了');
    assert.match(read, /✓ 同一套牌/, `没认出是同一套:${read}`);
  } finally {
    b.done();
  }
});

test('选牌过程中牌在增加 —— 那还是同一套,不该催她重搜', async () => {
  const b = bench();
  try {
    await b.call('hearthstone_draft', { pick: '火球术' });
    await b.call('hearthstone_draft', { pick: '寒冰箭' });
    await b.call('hearthstone_meta', { action: 'save', heroClass: '法师', notes: '走脸。' });

    // 又选了两张新的
    await b.call('hearthstone_draft', { pick: '水元素' });
    await b.call('hearthstone_draft', { pick: '暴风雪' });

    const read = await b.call('hearthstone_meta', { action: 'read', heroClass: '法师' });
    assert.match(read, /✓ 同一套牌/, `把「牌变多」当成换卡组了:${read}`);
    assert.doesNotMatch(read, /对不上/);
  } finally {
    b.done();
  }
});

test('换了牌组 — 笔记里的牌不在了,要明说重搜', async () => {
  const b = bench();
  try {
    await b.call('hearthstone_draft', { pick: '火球术' });
    await b.call('hearthstone_draft', { pick: '寒冰箭' });
    await b.call('hearthstone_meta', { action: 'save', heroClass: '法师', notes: '走脸。' });

    // 开新的一轮,牌完全不同
    await b.call('hearthstone_draft', { reset: true });
    await b.call('hearthstone_draft', { pick: '岩浆暴怒者' });

    const read = await b.call('hearthstone_meta', { action: 'read', heroClass: '法师' });
    assert.match(read, /对不上/, `换了牌组还在说同一套:${read}`);
    assert.match(read, /火球术|寒冰箭/, `没指出是哪张对不上:${read}`);
  } finally {
    b.done();
  }
});

test('同名两张不会因为有一张就通过 —— 按数量比', async () => {
  const b = bench();
  try {
    await b.call('hearthstone_draft', { pick: '火球术' });
    await b.call('hearthstone_draft', { pick: '火球术' });
    await b.call('hearthstone_meta', { action: 'save', heroClass: '法师', notes: '双火球。' });

    await b.call('hearthstone_draft', { reset: true });
    await b.call('hearthstone_draft', { pick: '火球术' });   // 只剩一张

    const read = await b.call('hearthstone_meta', { action: 'read', heroClass: '法师' });
    assert.match(read, /对不上/, `少了一张同名卡也算同一套了:${read}`);
  } finally {
    b.done();
  }
});

test('还没开始记牌时,笔记照给,但说明它是上一套的', async () => {
  const b = bench();
  try {
    await b.call('hearthstone_draft', { pick: '火球术' });
    await b.call('hearthstone_meta', { action: 'save', heroClass: '法师', notes: '走脸。' });
    await b.call('hearthstone_draft', { reset: true });

    const read = await b.call('hearthstone_meta', { action: 'read', heroClass: '法师' });
    assert.match(read, /走脸/);
    assert.match(read, /上一套/, `没说明这是旧笔记:${read}`);
  } finally {
    b.done();
  }
});

test('save 缺参数时别默默存个空的', async () => {
  const b = bench();
  try {
    assert.match(await b.call('hearthstone_meta', { action: 'save', notes: '没写职业' }), /heroClass/);
    assert.match(await b.call('hearthstone_meta', { action: 'save', heroClass: '法师' }), /notes/);
  } finally {
    b.done();
  }
});

test('笔记真的落盘了 —— 换一个 world 实例还读得到', async () => {
  const b = bench();
  try {
    await b.call('hearthstone_meta', { action: 'save', heroClass: '术士', notes: '铺场压死。' });
    // 同一个 dataDir 再建一个实例:模拟重启 Core
    const again = definition.create(context(b.dir));
    const read = await again.tools().find((t) => t.name === 'hearthstone_meta')
      .handler({ action: 'read', heroClass: '术士' }, {});
    assert.match(read.text, /铺场压死/, '重启之后笔记没了 —— 没写进磁盘');
  } finally {
    b.done();
  }
});

test('卡组摘要进环境变量 —— 她不调工具也看得见曲线', async () => {
  const b = bench();
  try {
    const empty = b.world.envPromptVars();
    assert.match(empty['hs.deck'], /没在选牌/);

    for (const card of ['火球术', '寒冰箭', '水元素']) await b.call('hearthstone_draft', { pick: card });
    const vars = b.world.envPromptVars();
    assert.match(vars['hs.deck'], /已选 3 张/);
    assert.match(vars['hs.deck'], /曲线/);
    assert.match(vars['hs.deck'], /随从 1 \/ 法术 2/);
  } finally {
    b.done();
  }
});
