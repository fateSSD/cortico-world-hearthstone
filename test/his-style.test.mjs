/**
 * 他的打法档案：从对局记录里数出来的那份。
 *
 * 这里钉四件事，每一条都是"说错了会害到他"的那种：
 *   1. `agreed` 是 null 的不算决策点 —— 那 321 条里 287 条是 null，混进去整份统计就废了。
 *   2. 短得不像真对局的记录要整局跳过，并且**说出来跳过了几条**。
 *   3. 人写的那一节，重算多少遍都不许动。
 *   4. 注入时要明确"这是他的，不是你的" —— 用第一人称复述就成了她的主张。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HIS_MANUAL_TITLE, addHisLine, hisHabitNote, hisStyleForPrompt, hisStylePath, readHisStyle,
  renderStats, summarize, writeHisStyle,
} from '../src/his-style.ts';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hs-his-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一局：默认是真打（10 分钟），可以指定时长、胜负、回合记录。 */
function game({ turns = 12, result = 'won', cls = '圣骑士', turnLog = [], minutes = 10 } = {}) {
  const start = new Date('2026-11-06T10:00:00Z');
  const end = new Date(start.getTime() + minutes * 60_000);
  return {
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    result,
    turns,
    me: { heroClass: cls, name: '测试' },
    opponent: { heroClass: '法师', name: '对手' },
    final: { myHp: 30, myArmor: 0, foeHp: 0, foeArmor: 0 },
    lowHp: 26,
    turnLog,
  };
}

test('agreed 是 null 的不算决策点 —— 那是「没得比」，不是「没听」', () => {
  const g = game({
    turnLog: [
      { turn: 2, advised: '龙鳞军备', played: '龙鳞军备', agreed: true },
      { turn: 3, advised: null, played: '某张牌', agreed: null },
      { turn: 4, advised: '誓缚光环', played: '加速光环', agreed: false },
      { turn: 5, advised: '某张牌', played: null, agreed: null },
    ],
  });
  const s = summarize([g]);
  assert.equal(s.decisions, 2, '只有两条明确可比的');
  assert.equal(s.agreed, 1);
  assert.equal(s.games, 1);
});

test('短得不像真对局的整局跳过，并且数出来跳了几条', () => {
  // 他的档案里 50 条中有 45 条是这种：时长 0.008 秒、全是圣骑士、49 胜。
  const fake = Array.from({ length: 45 }, () => game({ minutes: 0.0002, result: 'won' }));
  const real = [game({ result: 'won' }), game({ result: 'lost' })];
  const s = summarize([...fake, ...real]);
  assert.equal(s.skipped, 45);
  assert.equal(s.games, 2, '假的那批一条都不进');
  assert.equal(s.won.games, 1);
  assert.equal(s.lost.games, 1, '挡掉假数据之后，输的那一局才数得出来');
});

test('一条都不剩的时候，要说清为什么没有 —— 不许给一句空话', () => {
  const s = summarize(Array.from({ length: 3 }, () => game({ minutes: 0.0002 })));
  assert.equal(s.games, 0);
  const lines = renderStats(s);
  const text = lines.join('\n');
  assert.match(text, /3 条/, '要说出看到了几条');
  assert.match(text, /60 秒/, '要说出判据，不然他不知道为什么没算');
  assert.match(text, /没算进来|一条都没算/, '要明确说一条都没用');
});

test('老记录没有 endedAt 时照收，不因为缺字段否定历史', () => {
  const g = game({ turnLog: [{ turn: 2, advised: 'A', played: 'A', agreed: true }] });
  delete g.endedAt;
  const s = summarize([g]);
  assert.equal(s.games, 1);
  assert.equal(s.skipped, 0);
});

test('胜负分桶：只认 won / lost，平局和掉线不倒进输那一栏', () => {
  const s = summarize([
    game({ result: 'won' }),
    game({ result: 'lost' }),
    game({ result: 'tied' }),
    game({ result: 'conceded' }),
  ]);
  assert.equal(s.games, 4);
  assert.equal(s.won.games, 1);
  assert.equal(s.lost.games, 1, '平局和掉线不许算成输');
});

test('阶段分布按回合切：前 5 / 6–10 / 11 以后', () => {
  const s = summarize([game({
    turnLog: [
      { turn: 3, advised: 'A', played: 'A', agreed: true },
      { turn: 8, advised: 'B', played: 'C', agreed: false },
      { turn: 14, advised: 'D', played: 'D', agreed: true },
    ],
  })]);
  assert.deepEqual(s.phases.map((p) => p.decisions), [1, 1, 1]);
  assert.deepEqual(s.phases.map((p) => p.agreed), [1, 0, 1]);
});

test('职业按局数排，赢局单独数', () => {
  const s = summarize([
    game({ cls: '圣骑士', result: 'won' }),
    game({ cls: '圣骑士', result: 'lost' }),
    game({ cls: '法师', result: 'won' }),
  ]);
  assert.equal(s.classes[0].heroClass, '圣骑士');
  assert.equal(s.classes[0].games, 2);
  assert.equal(s.classes[0].won, 1);
});

test('没按建议走时，记的是他改打的那张，不是被放弃的那张', () => {
  const s = summarize([game({
    turnLog: [
      { turn: 3, advised: '建议A', played: '他选的X', agreed: false },
      { turn: 4, advised: '建议A', played: '他选的X', agreed: false },
      { turn: 5, advised: '建议B', played: '他选的Y', agreed: false },
    ],
  })]);
  assert.equal(s.ignored[0].card, '他选的X');
  assert.equal(s.ignored[0].count, 2);
});

test('样本量的三档文案：不够 / 偏少 / 够', () => {
  const few = renderStats(summarize([game()])).join('\n');
  assert.match(few, /样本还不够/);

  const mid = renderStats(summarize(Array.from({ length: 6 }, () => game({
    // 每局 4 个决策点 → 6 局 24 个，过了「能算」那条线，但没到「够说习惯」
    turnLog: [
      { turn: 3, advised: 'A', played: 'A', agreed: true },
      { turn: 5, advised: 'B', played: 'B', agreed: true },
      { turn: 7, advised: 'C', played: 'D', agreed: false },
      { turn: 9, advised: 'E', played: 'E', agreed: true },
    ],
  })))).join('\n');
  assert.match(mid, /样本偏少/, '6 局刚过线，不该说成「你习惯这么打」');

  const many = renderStats(summarize(Array.from({ length: 12 }, () => game({
    turnLog: [
      { turn: 3, advised: 'A', played: 'A', agreed: true },
      { turn: 6, advised: 'B', played: 'C', agreed: false },
      { turn: 9, advised: 'D', played: 'D', agreed: true },
      { turn: 12, advised: 'E', played: 'E', agreed: true },
    ],
  })))).join('\n');
  assert.doesNotMatch(many, /样本还不够|样本偏少/);
});

test('人写的那一节，重算多少遍都不许动', () => withDir((dir) => {
  writeHisStyle(dir, summarize([game()]));
  const r = addHisLine(dir, '这局在试新卡组，不是打错了', 60);
  assert.ok(r.ok, r.message);
  assert.match(readHisStyle(dir), /试新卡组/);

  // 重算：数据变了，机器段换掉，人写段必须还在
  writeHisStyle(dir, summarize([game(), game({ result: 'lost' }), game({ cls: '法师' })]));
  const after = readHisStyle(dir);
  assert.match(after, /试新卡组/, '重算把人写的冲掉了 —— 那是在替人删他自己的话');
  assert.match(after, /法师/, '机器段应该更新了');
}));

test('人写段重复的按包含去重，加不了第二条', () => withDir((dir) => {
  writeHisStyle(dir, summarize([game()]));
  addHisLine(dir, '这局在试新卡组', 60);
  const r = addHisLine(dir, '试新卡组', 60);
  assert.ok(r.ok);
  assert.match(r.message, /已经有这条/);
}));

test('内容没变就不碰文件 —— 启动时也会重算，不该每次都改修改时间', () => withDir((dir) => {
  const s = summarize([game()]);
  writeHisStyle(dir, s);
  const first = readFileSync(hisStylePath(dir), 'utf8');
  writeHisStyle(dir, s);
  assert.equal(readFileSync(hisStylePath(dir), 'utf8'), first);
}));

test('注入时说清「这是他的，不是你」', () => withDir((dir) => {
  writeHisStyle(dir, summarize([game({ turnLog: [{ turn: 3, advised: 'A', played: 'B', agreed: false }] })]));
  const p = hisStyleForPrompt(dir);
  assert.match(p, /他的/, '要标明归属');
  assert.match(p, /别用「我」|不是你的/, '要挡住她用第一人称复述');
  assert.match(p, /hearthstone_advice|算出来/, '要重申算出来的东西不让');
}));

test('档案不存在时让她说「还没数出来」，不许猜', () => withDir((dir) => {
  const p = hisStyleForPrompt(dir);
  assert.match(p, /还没建起来|别猜/);
}));

test('文件骨架里不写示范句子 —— 给了例子就会被照抄', () => withDir((dir) => {
  writeHisStyle(dir, summarize([game()]));
  const text = readHisStyle(dir);
  // 人工段一开始是空的
  const head = text.indexOf(`## ${HIS_MANUAL_TITLE}`);
  const tail = text.indexOf('---', head);
  const between = text.slice(head, tail);
  const bullets = between.split(/\r?\n/).filter((l) => l.trim().startsWith('- '));
  assert.equal(bullets.length, 0, `人写段不该预填内容：${bullets.join(' / ')}`);
}));

test('侧写：样本不够就不给 —— 十局以下说「他习惯怎么打」是编', () => {
  const few = summarize([game(), game()]);
  assert.equal(hisHabitNote(few), '', '两局就给侧写，等于编');
});

test('侧写：给数据，但必须带上「别拿它去迎合他」', () => {
  // 31 局那组真实的形状：前 5 回合采纳率高，后期掉下来，没听时常打光环
  const games = Array.from({ length: 12 }, (_, i) => game({
    result: i % 3 === 0 ? 'lost' : 'won',
    turnLog: [
      { turn: 3, advised: 'A', played: 'A', agreed: true },
      { turn: 4, advised: 'B', played: 'B', agreed: true },
      { turn: 8, advised: 'C', played: 'D', agreed: false },
      { turn: 14, advised: 'E', played: '加速光环', agreed: false },
      { turn: 15, advised: 'F', played: '加速光环', agreed: false },
      { turn: 16, advised: 'G', played: '誓缚光环', agreed: false },
    ],
  }));
  const note = hisHabitNote(summarize(games));
  assert.match(note, /前 5 回合/, '要给阶段数据');
  assert.match(note, /11 回合以后/, '要露出后期那个掉下来的数');
  assert.match(note, /加速光环/, '要说出他没听时最常打什么');
  // 这条最要紧：只给事实，不许变成「所以你应该听我的」或者「你就爱这么打」
  assert.match(note, /不是.*对错的标准/, '必须点明这不是判断标准');
  assert.match(note, /迎合/, '必须挡住「顺着他说」这一路');
  // 硬币不是打法偏好，不许出现在侧写里
  assert.doesNotMatch(note, /幸运币|硬币/);
});
