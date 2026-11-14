/**
 * 对局档案：每局一行，留最近 50 局。
 *
 * 存在的理由就是它要测的东西：`GameArchive` 只存最后一局，session 会轮转 ——
 * 打完三把之后想复盘「最近几把」，两个来源都靠不住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEARTHSTONE } from '../src/definition.ts';

function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'hs-games-'));
  const cfg = { ...HEARTHSTONE.defaults(), enabled: true, autoPatchHost: false };
  const world = HEARTHSTONE.create({
    id: 'hearthstone', cfg, timezone: 'Asia/Shanghai', botName: 'probe',
    botDir: dir, packageDir: dir, dataDir: dir, repoRoot: dir,
    secret: () => '', storeSecret: () => {}, persist: () => {}, restart: async () => {},
  });
  return { world, dir };
}

function snapshot(over = {}) {
  return {
    startedAt: '2026-10-30T12:00:00.000Z',
    result: 'won',
    turn: 12,
    me: { heroClass: '圣骑士', heroName: '乌瑟尔', health: 30, armor: 0 },
    opponent: { heroClass: '法师', heroName: '吉安娜', health: 0, armor: 0 },
    ...over,
  };
}

function lines(dir) {
  const p = join(dir, 'hearthstone-games.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

test('每局追加一行，不覆盖上一行', () => {
  const { world, dir } = makeWorld();
  try {
    world.appendGameLog(snapshot({ startedAt: 'A', turn: 10 }));
    world.appendGameLog(snapshot({ startedAt: 'B', turn: 12 }));
    const rows = lines(dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].startedAt, 'A');
    assert.equal(rows[1].startedAt, 'B');
    assert.equal(rows[1].turns, 12);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同一局重复触发不重复记 —— 重启补历史会把结束点再放一遍', () => {
  const { world, dir } = makeWorld();
  try {
    const s = snapshot({ startedAt: 'X', turn: 9 });
    world.appendGameLog(s);
    world.appendGameLog(s);
    world.appendGameLog(s);
    assert.equal(lines(dir).length, 1, '同一局只能有一行');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('起始时刻相同但回合数不同，算两局', () => {
  const { world, dir } = makeWorld();
  try {
    world.appendGameLog(snapshot({ startedAt: 'X', turn: 9 }));
    world.appendGameLog(snapshot({ startedAt: 'X', turn: 11 }));
    assert.equal(lines(dir).length, 2, '指纹是「起始时刻 + 回合数」，不能只看一个');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('只留最近 50 局，老的被挤掉', () => {
  const { world, dir } = makeWorld();
  try {
    for (let i = 0; i < 55; i += 1) {
      world.appendGameLog(snapshot({ startedAt: `G${i}`, turn: i + 1 }));
    }
    const rows = lines(dir);
    assert.equal(rows.length, 50);
    assert.equal(rows[0].startedAt, 'G5', '最早那 5 局该被挤掉');
    assert.equal(rows[49].startedAt, 'G54');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('最低血量取自全程，不是终局', () => {
  const { world, dir } = makeWorld();
  try {
    world.timeline = [{ turn: 1, myHp: 30 }, { turn: 5, myHp: 12 }, { turn: 9, myHp: 25 }];
    world.appendGameLog(snapshot({ turn: 9 }));
    assert.equal(lines(dir)[0].lowHp, 12, '这局赢的时候 25 血，但曾经掉到 12');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('坏行跳过，不影响读其他行', () => {
  const { world, dir } = makeWorld();
  try {
    const p = join(dir, 'hearthstone-games.jsonl');
    writeFileSync(p, `${JSON.stringify({ startedAt: 'ok', turns: 8, result: 'won' })}\n{坏行\n`, 'utf8');
    world.appendGameLog(snapshot({ startedAt: 'new', turn: 10 }));
    const rows = lines(dir);
    assert.equal(rows.length, 2, '坏行被丢掉，好的两行都在');
    assert.equal(rows[1].startedAt, 'new');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('战绩文案：空档案要明说没打完过', () => {
  const { world, dir } = makeWorld();
  try {
    assert.match(world.recentGamesText(), /还没打完/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('战绩文案：赢了 1 局要说清局数，不能只报最近 5 局', () => {
  const { world, dir } = makeWorld();
  try {
    world.appendGameLog(snapshot({ startedAt: 'A', turn: 12, result: 'won' }));
    world.appendGameLog(snapshot({ startedAt: 'B', turn: 9, result: 'lost' }));
    const t = world.recentGamesText();
    assert.match(t, /最近 2 局/);
    assert.match(t, /赢了 1 局/);
    assert.match(t, /胜/);
    assert.match(t, /负/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('战绩文案：新的在上面，且提醒别据此编过程', () => {
  const { world, dir } = makeWorld();
  try {
    world.appendGameLog(snapshot({ startedAt: 'old', turn: 5 }));
    world.appendGameLog(snapshot({ startedAt: 'new', turn: 15 }));
    const t = world.recentGamesText();
    const i15 = t.indexOf('15 回合');
    const i5 = t.indexOf('5 回合');
    assert.ok(i15 >= 0 && i5 > i15, '新的那局要排在前面');
    assert.match(t, /hearthstone_last_game/, '要告诉她明细去哪取');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('对局档案和「上一局存档」是两个文件，互不覆盖', () => {
  const { world, dir } = makeWorld();
  try {
    world.appendGameLog(snapshot({ startedAt: 'A', turn: 7 }));
    assert.ok(existsSync(join(dir, 'hearthstone-games.jsonl')));
    assert.equal(existsSync(join(dir, 'hearthstone-last-game.json')), false, '不该顺手覆盖存档');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
