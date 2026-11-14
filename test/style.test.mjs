/**
 * 打法档案：她自己的立场。
 *
 * 这里钉的是"它是什么、它不是什么"：
 *   是 —— 第一人称、一条一行、能加能删、空了不编。
 *   不是 —— 第二份战术笔记、能被算出来的数字盖掉、越写越长的流水账。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STYLE_FILE, STYLE_INJECT_MAX, STYLE_LINE_MAX, STYLE_SECTION_MAX, STYLE_SECTIONS,
  addStyleLine, dropStyleLine, ensureStyle, isStyleSection, readStyle,
  styleForPrompt, styleLineCount, stylePath,
} from '../src/style.ts';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hs-style-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('骨架：四节都在，一开始一条内容都没有', () => withDir((dir) => {
  const text = ensureStyle(dir);
  for (const title of Object.values(STYLE_SECTIONS)) {
    assert.ok(text.includes(`## ${title}`), `缺这一节：${title}`);
  }
  assert.equal(styleLineCount(text), 0, '骨架是容器，不是内容');
  assert.ok(existsSync(stylePath(dir)));
}));

test('骨架不写示范句子 —— 给了范例她就会照抄', () => withDir((dir) => {
  const text = ensureStyle(dir);
  // 骨架里不该有任何以 "- " 开头的行
  const bullets = text.split(/\r?\n/).filter((l) => l.trim().startsWith('- '));
  assert.deepEqual(bullets, [], '骨架里不能有示范条目');
}));

test('加一条：写进对的那一节，回执说清写在哪', () => withDir((dir) => {
  const r = addStyleLine(dir, 'push', '我宁可多留一手解牌也不贪脸');
  assert.equal(r.ok, true);
  assert.match(r.message, /我倾向这么打/);
  const text = readStyle(dir);
  assert.ok(text.includes('- 我宁可多留一手解牌也不贪脸'));
  assert.equal(styleLineCount(text), 1);
}));

test('加一条：换一节不会串行', () => withDir((dir) => {
  addStyleLine(dir, 'who', '我话少，一般只报数');
  addStyleLine(dir, 'dislike', '为了做任务把场面丢光是耍流氓');
  const text = readStyle(dir);
  const whoIdx = text.indexOf(`## ${STYLE_SECTIONS.who}`);
  const disIdx = text.indexOf(`## ${STYLE_SECTIONS.dislike}`);
  assert.ok(text.indexOf('我话少') > whoIdx && text.indexOf('我话少') < disIdx, 'who 那条要留在 who 节里');
  assert.ok(text.indexOf('耍流氓') > disIdx, 'dislike 那条要在后面那一节');
}));

test('去重：换个词说同一件事，不该多一条', () => withDir((dir) => {
  addStyleLine(dir, 'who', '我看不得水晶浪费');
  const again = addStyleLine(dir, 'who', '看不得水晶浪费');
  assert.equal(again.ok, true);
  assert.match(again.message, /已经有这条/);
  assert.equal(styleLineCount(readStyle(dir)), 1);
}));

test('上限：写满了不加，而且要她自己去删', () => withDir((dir) => {
  for (let i = 0; i < STYLE_SECTION_MAX; i += 1) {
    assert.equal(addStyleLine(dir, 'who', `第 ${i} 条立场`).ok, true);
  }
  const over = addStyleLine(dir, 'who', '多出来的一条');
  assert.equal(over.ok, false);
  assert.match(over.message, /装不下/);
  assert.match(over.message, /先删一条/);
  assert.equal(styleLineCount(readStyle(dir)), STYLE_SECTION_MAX);
}));

test('超长一条会被截断，不会把文件撑爆', () => withDir((dir) => {
  const long = '啊'.repeat(STYLE_LINE_MAX + 30);
  addStyleLine(dir, 'push', long);
  const line = readStyle(dir).split(/\r?\n/).find((l) => l.trim().startsWith('- '));
  assert.ok(line.includes('…'), '截断要留个省略号，别无声砍掉');
  assert.ok(line.length <= STYLE_LINE_MAX + 4, `太长了：${line.length}`);
}));

test('删一条：按包含匹配，删掉第一条', () => withDir((dir) => {
  addStyleLine(dir, 'push', '我偏爱先解场再打脸');
  addStyleLine(dir, 'push', '实在解不动就全打脸');
  const r = dropStyleLine(dir, '先解场');
  assert.equal(r.ok, true);
  assert.match(r.message, /删掉了/);
  const text = readStyle(dir);
  assert.ok(!text.includes('先解场'));
  assert.ok(text.includes('全打脸'), '只该删命中那一条');
  assert.equal(styleLineCount(text), 1);
}));

test('删一条：找不到就明说没找到，不静默成功', () => withDir((dir) => {
  addStyleLine(dir, 'who', '我话少');
  const r = dropStyleLine(dir, '压根没写过的话');
  assert.equal(r.ok, false);
  assert.match(r.message, /没找到/);
  assert.equal(styleLineCount(readStyle(dir)), 1);
}));

test('那一节被人删了：加的时候补回来，不默默丢她这条', () => withDir((dir) => {
  // 人造一份缺了「push」那一节的文件 —— 人手动编辑时很容易删掉一整节
  const broken = '# 我怎么打牌\n\n## 我在牌桌上是什么人\n\n- 我话少\n';
  writeFileSync(stylePath(dir), broken, 'utf8');
  const r = addStyleLine(dir, 'push', '我宁可留一手');
  assert.equal(r.ok, true);
  assert.match(r.message, /补上了/);
  const text = readStyle(dir);
  assert.ok(text.includes(`## ${STYLE_SECTIONS.push}`));
  assert.ok(text.includes('- 我宁可留一手'));
  assert.ok(text.includes('- 我话少'), '原有的内容不能被抹掉');
}));

test('原子写：写完不留临时文件', () => withDir((dir) => {
  addStyleLine(dir, 'who', '我说话直');
  const junk = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(junk, []);
}));

test('注入提示词：空档案要明说「还没长出来」，不能返回空串', () => withDir((dir) => {
  const s = styleForPrompt(dir);
  assert.ok(s.length > 10, '空的时候也必须有一段话');
  assert.match(s, /空|还没有/);
  assert.match(s, /别编/);
}));

test('注入提示词：有条目时带上「它管不了数学」那一句', () => withDir((dir) => {
  addStyleLine(dir, 'push', '我偏爱慢慢磨');
  const s = styleForPrompt(dir);
  assert.ok(s.includes('我偏爱慢慢磨'));
  assert.match(s, /斩杀|数学/, '必须提醒她这份东西盖不住算出来的东西');
  assert.match(s, /1 条/);
}));

test('注入提示词：太长会截断，并且告诉她全文在哪', () => withDir((dir) => {
  // 单节写满才 8×60，撑不到上限；四节全写满才够。
  for (const [key] of Object.entries(STYLE_SECTIONS)) {
    for (let i = 0; i < STYLE_SECTION_MAX; i += 1) {
      addStyleLine(dir, key, `${'长'.repeat(STYLE_LINE_MAX - 2)}${i}`);
    }
  }
  const s = styleForPrompt(dir);
  assert.ok(s.length < STYLE_INJECT_MAX + 400, `注入太长了：${s.length}`);
  assert.match(s, /全文在/, '截断了就得告诉她去哪看剩下的');
}));

test('小节键的判定：只认那四个，别的字符串不算', () => {
  assert.equal(isStyleSection('who'), true);
  assert.equal(isStyleSection('push'), true);
  assert.equal(isStyleSection('dislike'), true);
  assert.equal(isStyleSection('unsure'), true);
  assert.equal(isStyleSection('love'), false, '那是音乐那边的键，别串台');
  assert.equal(isStyleSection(''), false);
  assert.equal(isStyleSection(null), false);
  assert.equal(isStyleSection(3), false);
});

test('空白的 add 不写', () => withDir((dir) => {
  const r = addStyleLine(dir, 'who', '   ');
  assert.equal(r.ok, false);
  assert.equal(styleLineCount(readStyle(dir)), 0);
}));

test('文件不在时 readStyle 返回 null，别假装读到了空文件', () => withDir((dir) => {
  assert.equal(readStyle(dir), null);
  assert.equal(readStyle(join(dir, 'nope')), null);
}));

test('文件名和音乐那份不重名 —— 两个扩展共用一个 dataDir', () => {
  assert.equal(STYLE_FILE, 'hearthstone-style.md');
  assert.notEqual(STYLE_FILE, 'music-soul.md');
});

test('全员第一人称：写入的内容原样保留，不做任何改写', () => withDir((dir) => {
  const line = '我看不得为了做任务把场面丢光';
  addStyleLine(dir, 'dislike', line);
  const text = readFileSync(stylePath(dir), 'utf8');
  assert.ok(text.includes(`- ${line}`), '她的措辞要原样落地，别替她润色');
}));

test('打了够多局还一条没写，要催 —— 但只提「哪几类算立场」，不给现成判断', () => withDir((dir) => {
  ensureStyle(dir);
  const few = styleForPrompt(dir, 2);
  assert.doesNotMatch(few, /一条都没写/, '只打两局就催，像逼人交作业');

  const many = styleForPrompt(dir, 12);
  assert.match(many, /12 局/, '要说出打了多少局，她才有个数');
  assert.match(many, /一条都没写/);
  assert.match(many, /不为填满而编/, '必须留一条「写不出来也行」的退路');

  // 不许给现成判断 —— 给了她就会编一条来交差。
  // 这几句是那天她真说过的，写进催办就等于我替她定了要写什么。
  for (const quote of ['怪游戏', '在等一套', '不该换', '该打脸']) {
    assert.ok(!many.includes(quote), `催办里不许引她的原话（${quote}）`);
  }
}));

test('写过一条就不催了', () => withDir((dir) => {
  ensureStyle(dir);
  addStyleLine(dir, 'push', '水晶没花完我难受', 60);
  const text = styleForPrompt(dir, 30);
  assert.doesNotMatch(text, /一条都没写/);
  assert.match(text, /一共 1 条/);
}));

test('没传局数就不催 —— 调用方不知道，就别替它猜', () => withDir((dir) => {
  ensureStyle(dir);
  assert.doesNotMatch(styleForPrompt(dir), /一条都没写/);
}));
