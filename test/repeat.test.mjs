/**
 * 同一张牌别连着劝五个回合。
 *
 * 2026-10-30 实测：一局里 T11–T19 连着五个回合的建议都是「按费打:大力扣杀」，
 * 她跟着说了五遍（21:47 / 21:48 / 21:49 / 21:50:03 / 21:50:58）。
 *
 * 根因不在她 —— `briefAdvice` 每回合独立算，不知道上回合推过什么。提示词里那条
 * 「同一个建议说两遍就够」太抽象，她得自己判断算不算重复。所以把「这是第几遍」
 * 直接写进事件正文，变成她能照着做的事实。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advicePick, sameCardName } from '../src/turn-event.ts';
import { HEARTHSTONE } from '../src/definition.ts';

function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'hs-rep-'));
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
    startedAt: '2026-10-30T12:00:00.000Z', result: 'won', turn: 12,
    me: { heroClass: '圣骑士', heroName: '乌瑟尔', health: 30, armor: 0 },
    opponent: { heroClass: '法师', heroName: '吉安娜', health: 0, armor: 0 },
    ...over,
  };
}

const turnText = (adviceLine) => `第 11 回合,轮到我。我 30 血、手牌 8 张。\n建议:${adviceLine}`;

test('advicePick：抠「按费打」后面那张牌', () => {
  assert.equal(advicePick(turnText('按费打:大力扣杀(6费 伤害4(仅随从) 随机给友方+4/+4)')), '大力扣杀');
  assert.equal(advicePick(turnText('按费打:星界翔龙(4费 3/3)、时序光环(5费 召唤),剩 1 费')), '星界翔龙');
  assert.equal(advicePick('按费打：陷坑蜘蛛(2费)'), '陷坑蜘蛛', '全角冒号也认');
});

test('advicePick：「先换」形态', () => {
  assert.equal(advicePick('先换:我的 3/4 打他的 2/3,换完对面场攻剩 1'), '我的');
});

test('advicePick：危险 / 空过 / 换牌这些没有「打哪张」的建议，返回空', () => {
  assert.equal(advicePick('危险:对面场攻 19,我 18 有效血,不解就死。'), '');
  assert.equal(advicePick('这回合手上能出的只有 奉献;不值得当普通牌打,宁可空过。'), '');
  assert.equal(advicePick(''), '');
  assert.equal(advicePick(null), '', '别因为空值炸掉');
});

test('连着推同一张：前两遍原样，第三遍起才加提示', () => {
  const { world, dir } = makeWorld();
  try {
    const t = turnText('按费打:大力扣杀(6费)');
    assert.equal(world.withRepeatNote(t), t, '第 1 遍不加');
    assert.equal(world.withRepeatNote(t), t, '第 2 遍还可以换个角度说');
    const third = world.withRepeatNote(t);
    assert.match(third, /连着推了/, '第 3 遍该开口了');
    assert.match(third, /大力扣杀/);
    assert.match(third, /3 个回合/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('换一张牌就重新计数', () => {
  const { world, dir } = makeWorld();
  try {
    const a = turnText('按费打:大力扣杀(6费)');
    world.withRepeatNote(a);
    world.withRepeatNote(a);
    const other = turnText('按费打:星界翔龙(4费)');
    assert.equal(world.withRepeatNote(other), other, '换了牌，第 1 遍不加提示');
    assert.equal(world.withRepeatNote(other), other, '第 2 遍也不加');
    assert.match(world.withRepeatNote(other), /连着推了/, '第 3 遍才开始提示');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('中间夹一个「危险」回合，之后回到同一张牌仍然算连着', () => {
  const { world, dir } = makeWorld();
  try {
    const t = turnText('按费打:大力扣杀(6费)');
    world.withRepeatNote(t);
    world.withRepeatNote(t);
    // 第 3 回合是危险提示，没有「打哪张」—— 不该清零
    world.withRepeatNote('危险:对面场攻 19,我 18 有效血,不解就死。');
    const back = world.withRepeatNote(t);
    assert.match(back, /连着推了/, '中间插一条危险，不等于他听进去了');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('提示里要说清该怎么做，不能只报个数', () => {
  const { world, dir } = makeWorld();
  try {
    const t = turnText('按费打:大力扣杀(6费)');
    world.withRepeatNote(t); world.withRepeatNote(t);
    const s = world.withRepeatNote(t);
    assert.match(s, /不同的理由|换个/, '得给她一条出路，不然只能闭嘴');
    assert.match(s, /他没打/, '要说明「他没照做」这个前提');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---------- 归档里的「建议 vs 实际」 ---------- */

test('playedCardName：抠出牌名，目标不要', async () => {
  const { playedCardName } = await import('../src/turn-event.ts');
  assert.equal(playedCardName('打出 正义保护者'), '正义保护者');
  assert.equal(playedCardName('打出 大力扣杀 → 拨号机器人'), '大力扣杀', '箭头后面是目标，不是牌名');
  assert.equal(playedCardName('打出 未知的牌 → 正义保护者'), '未知的牌');
  assert.equal(playedCardName(''), null);
  assert.equal(playedCardName('使用英雄技能'), null, '不是「打出」就不算');
});

test('turnLog：建议和实际按回合对齐，只取每回合第一张', async () => {
  const { world, dir } = makeWorld();
  try {
    world.turnAdvice.set(3, '流沙塑型者');
    world.turnAdvice.set(5, '');           // 那回合是「危险」提示，没有推牌
    world.turnAdvice.set(7, '星界翔龙');
    world.parser = {
      recent: () => [
        { turn: 3, who: 'me', kind: 'play', text: '打出 流沙塑型者' },
        { turn: 3, who: 'me', kind: 'play', text: '打出 幸运币' },
        { turn: 3, who: 'opponent', kind: 'play', text: '打出 银蛇' },
        { turn: 5, who: 'me', kind: 'play', text: '打出 奉献' },
        { turn: 7, who: 'me', kind: 'attack', text: '星界翔龙 发起攻击' },
      ],
    };
    const log = world.buildTurnLog();
    assert.deepEqual(log, [
      { turn: 3, advised: '流沙塑型者', played: '流沙塑型者', agreed: true },
      { turn: 5, advised: null, played: '奉献', agreed: null },
      { turn: 7, advised: '星界翔龙', played: null, agreed: null },
    ], '第三回合只留第一张；对手的不算；攻击不是出牌');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('全名与简称算同一张：别把「听了建议」记成「没听」', () => {
  // 2026-11-03 实测：建议写卡表全名，动作记录里是场上实体名
  assert.equal(sameCardName('诺兹多姆，青铜守护巨龙', '诺兹多姆'), true);
  assert.equal(sameCardName('阿米图特', '阿米图特，阿米图斯的守护者'), true);
  assert.equal(sameCardName('诺兹多姆', '诺兹多姆，青铜守护巨龙'), true);
  assert.equal(sameCardName('加速光环', '正义保护者'), false);
  // 没得比 ≠ 没听
  assert.equal(sameCardName('', '奉献'), null);
  assert.equal(sameCardName('星界翔龙', null), null);
  assert.equal(sameCardName(null, null), null);
});

test('turnLog 会跟着归档一起落盘', async () => {
  const { world, dir } = makeWorld();
  try {
    world.turnAdvice.set(2, '狗头人矿工');
    world.parser = { recent: () => [{ turn: 2, who: 'me', kind: 'play', text: '打出 狗头人矿工' }] };
    world.appendGameLog(snapshot({ startedAt: 'L', turn: 2 }));
    const { readFileSync } = await import('node:fs');
    const row = JSON.parse(readFileSync(join(dir, 'hearthstone-games.jsonl'), 'utf8').trim());
    assert.equal(row.turnLog.length, 1);
    assert.equal(row.turnLog[0].advised, '狗头人矿工');
    assert.equal(row.turnLog[0].played, '狗头人矿工');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
