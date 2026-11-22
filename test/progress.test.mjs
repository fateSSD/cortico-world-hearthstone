/**
 * 天梯等级推算、保护底线与竞技场输赢累计测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgressStore, parseRankInput } from '../src/progress.ts';

test('parseRankInput：解析各类中文/英文段位写法', () => {
  assert.deepEqual(parseRankInput('钻5 2星'), { league: '钻石', tier: 5, stars: 2, rankText: '钻5 2星' });
  assert.deepEqual(parseRankInput('黄金10'), { league: '黄金', tier: 10, stars: 0, rankText: '黄金10 0星' });
  assert.deepEqual(parseRankInput('传说 #1200'), { league: '传说', legendRank: 1200, rankText: '传说 #1200' });
  assert.deepEqual(parseRankInput('D1 3*'), { league: '钻石', tier: 1, stars: 3, rankText: '钻1 3星' });
  assert.equal(parseRankInput('胡说八道'), null);
});

test('天梯升星、连胜双星、钻5无连胜加星与5级保护底线', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-prog-ladder-'));
  try {
    const store = new ProgressStore(dir);
    const metaStd = { gameType: 'GT_RANKED', formatType: 'FT_STANDARD', scenarioId: 2 };

    // 1) 未设段位前，只统计胜负，不虚构段位；一局输局清零连胜后设起始段位
    store.recordGameResult('g1', metaStd, 'lost', '法师', '2026-11-22T10:00:00Z');
    assert.equal(store.snapshot().ladder.standard.rankText, null);
    assert.equal(store.snapshot().ladder.standard.losses, 1);
    assert.match(store.briefForMeta(metaStd), /未设段位.*0胜1负/);

    // 2) 设「黄金10 0星」，连赢三把触发连胜双星（1+1+2 = 4星 = 黄金9 1星）
    store.setRank('standard', '黄金10 0星', 1, '2026-11-22T10:01:00Z');
    store.recordGameResult('g2', metaStd, 'won', '法师', '2026-11-22T10:02:00Z'); // +1 (streak=1)
    store.recordGameResult('g3', metaStd, 'won', '法师', '2026-11-22T10:03:00Z'); // +1 (streak=2)
    store.recordGameResult('g4', metaStd, 'won', '法师', '2026-11-22T10:04:00Z'); // +2 (streak=3) -> 共4星 = 黄金9 1星
    const gTrack = store.snapshot().ladder.standard;
    assert.equal(gTrack.league, '黄金');
    assert.equal(gTrack.tier, 9);
    assert.equal(gTrack.stars, 1);
    assert.equal(gTrack.estimated, true);

    // 3) 钻5保护底线：输局不掉到钻6；钻5起无连胜额外加星
    store.setRank('standard', '钻5 0星', 1);
    store.recordGameResult('g5', metaStd, 'lost');
    assert.equal(store.snapshot().ladder.standard.tier, 5);
    assert.equal(store.snapshot().ladder.standard.stars, 0);

    // 连续赢3把：从钻5起每把只+1星，所以总共 +3 星 = 钻4 0星（不是4星）
    store.recordGameResult('g6', metaStd, 'won');
    store.recordGameResult('g7', metaStd, 'won');
    store.recordGameResult('g8', metaStd, 'won');
    const dTrack = store.snapshot().ladder.standard;
    assert.equal(dTrack.tier, 4);
    assert.equal(dTrack.stars, 0);

    // 4) 同一 gameKey 幂等去重 + 持久化重读
    store.recordGameResult('g8', metaStd, 'won');
    assert.equal(store.snapshot().ladder.standard.tier, 4);
    const reloaded = new ProgressStore(dir);
    assert.equal(reloaded.snapshot().ladder.standard.rankText, dTrack.rankText);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('竞技场累计：普通 5胜2负 与地下 12胜3负 结轮、手动校准与重置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-prog-arena-'));
  try {
    const store = new ProgressStore(dir);
    const underMeta = { gameType: 'GT_UNDERGROUND_ARENA', formatType: 'FT_WILD', scenarioId: 2 };
    const normMeta = { gameType: 'GT_ARENA', formatType: 'FT_WILD', scenarioId: 2 };

    // 手动校准地下竞技场 11-2 -> 再赢一局 12-2 结轮
    store.calibrateArena(11, 2, 'underground', '德鲁伊');
    const fin = store.recordGameResult('u1', underMeta, 'won', '德鲁伊');
    assert.equal(fin.recorded, true);
    assert.match(fin.summary ?? '', /12胜2负/);
    assert.equal(store.snapshot().arena?.active, false);
    assert.equal(store.snapshot().arenaHistory.length, 1);

    // 新一轮普通竞技场 5胜2负：连输两局 0-2 结轮
    store.resetArenaRun('arena', '圣骑士');
    store.recordGameResult('n1', normMeta, 'lost', '圣骑士');
    store.recordGameResult('n2', normMeta, 'lost', '圣骑士');
    assert.equal(store.snapshot().arena?.wins, 0);
    assert.equal(store.snapshot().arena?.losses, 2);
    assert.equal(store.snapshot().arena?.active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
