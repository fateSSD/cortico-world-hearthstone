/**
 * 对手主流卡组情报库 & hearthstone_matchup 工具端到端测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchetypeStore, renderMatchupSummary } from '../src/archetypes.ts';

test('ArchetypeStore：存取、按特征牌匹配、过滤已交威胁与7天过期检测', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-arch-'));
  try {
    const store = new ArchetypeStore(dir);
    const now = Date.parse('2026-11-22T12:00:00Z');
    store.saveBucket('standard', '潜行者', [
      {
        name: '节奏贼',
        coreCards: ['刺骨', '军情七处特工', '伺机待发'],
        threats: ['刺骨', '奇利亚斯', '暗影步'],
        strategy: '前期抢血凶，留牌找低费解',
      },
      {
        name: '机械贼',
        coreCards: ['格洛顿', '吵吵机器人'],
        threats: ['奇利亚斯'],
        strategy: '不能给场留机械磁力',
      },
    ], '2026-11-21T12:00:00Z');

    // 未打出特征牌 -> candidates 提示
    const m0 = store.match('standard', '潜行者', [], now);
    assert.equal(m0.matched, null);
    assert.equal(m0.needsSearch, false);

    // 对手打出刺骨与军情七处特工 -> high 置信度命中节奏贼，且「刺骨」已交过不再报在 pendingThreats 里
    const m1 = store.match('standard', '潜行者', ['刺骨', '军情七处特工'], now);
    assert.equal(m1.matched?.name, '节奏贼');
    assert.equal(m1.confidence, 'high');
    assert.deepEqual(m1.pendingThreats, ['奇利亚斯', '暗影步']);
    const msg = renderMatchupSummary(m1, '潜行者');
    assert.match(msg, /节奏贼/);
    assert.match(msg, /奇利亚斯/);

    // 8天后过期检测
    const later = now + 8 * 24 * 60 * 60 * 1000;
    const mStale = store.match('standard', '潜行者', ['刺骨'], later);
    assert.equal(mStale.stale, true);
    assert.equal(mStale.needsSearch, true);

    // 重载与清除
    const reloaded = new ArchetypeStore(dir);
    assert.equal(reloaded.read('standard', '潜行者')?.archetypes.length, 2);
    assert.equal(reloaded.clearBucket('standard', '潜行者'), true);
    assert.equal(reloaded.read('standard', '潜行者'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hearthstone_matchup 工具支持 read/save/clear 且提示联网搜索', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-world-arch-'));
  try {
    const mod = await import('../src/index.ts');
    const def = mod.default;
    const cfg = def.defaults();
    const world = def.create({
      id: def.id, cfg, timezone: 'Asia/Shanghai', botName: 'Coo',
      botDir: process.cwd(), packageDir: process.cwd(), dataDir: dir, repoRoot: process.cwd(),
      secret: () => '', storeSecret: () => {}, persist: (p) => Object.assign(cfg, p), restart: async () => {},
    });
    const tool = world.tools().find((t) => t.name === 'hearthstone_matchup');
    assert.ok(tool);

    const r1 = await tool.handler({ action: 'read', format: 'standard', heroClass: '法师' });
    assert.match(r1.text, /browser_search/);

    const rSave = await tool.handler({
      action: 'save',
      format: 'standard',
      heroClass: '法师',
      archetypes: [{ name: '元素法', coreCards: ['燃灯元素', '火球术'], threats: ['烈焰风暴'], strategy: '防6费清场' }],
    });
    assert.match(rSave.text, /元素法/);

    const r2 = await tool.handler({ action: 'read', format: 'standard', heroClass: '法师' });
    assert.match(r2.text, /元素法/);
    assert.match(r2.text, /烈焰风暴/);

    const rClr = await tool.handler({ action: 'clear', format: 'standard', heroClass: '法师' });
    assert.match(rClr.text, /已清空/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
