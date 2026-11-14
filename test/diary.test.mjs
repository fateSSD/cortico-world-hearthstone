/**
 * 复盘日记的离线验证。
 *
 * 重点只有三件事：**写在哪**（能换到同步盘）、**追加还是覆盖**（一天十几局，覆盖只剩最后一局）、
 * **谁的口吻**（这是她的日记，不是他的成绩单 —— 写成「她推的」就成了旁观者记录）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendDiary, appendDiaryNote, appendThought, diaryFile, readThoughts, renderDiary } from '../src/diary.ts';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hs-diary-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ENTRY = {
  at: '2026-11-08T12:46:30.000+08:00',
  result: 'lost',
  turns: 24,
  me: { cls: '圣骑士', hp: 9, lowHp: 3 },
  foe: { cls: '死亡骑士', hp: 28 },
  decisions: 10,
  agreed: 3,
  splits: [{ turn: 6, advised: '龙鳞军备', played: '阳炎清算' }],
};

test('一天一个文件，文件名只带日期', () => {
  assert.match(diaryFile('D:/x', '2026-11-08T23:59:00+08:00'), /炉石日记-2026-11-08\.md$/);
  // 同一天的不同时刻 → 同一个文件
  assert.equal(diaryFile('D:/x', '2026-11-08T01:00:00+08:00'), diaryFile('D:/x', '2026-11-08T23:59:00+08:00'));
});

test('目录不存在要自己建出来 —— 换到新同步盘时第一次必然是空的', () => withDir((root) => {
  const dir = join(root, 'onedrive', '炉石日记');
  const r = appendDiary(dir, ENTRY);
  assert.equal(r.ok, true, r.error);
  assert.ok(readFileSync(r.path, 'utf8').startsWith('# 炉石日记 · 2026-11-08'));
}));

test('追加，不是覆盖 —— 一天打十几局，覆盖只剩最后一局', () => withDir((dir) => {
  appendDiary(dir, ENTRY);
  appendDiary(dir, { ...ENTRY, at: '2026-11-08T13:10:00.000+08:00', result: 'won' });
  const text = readFileSync(diaryFile(dir, ENTRY.at), 'utf8');
  assert.equal((text.match(/^## /gm) ?? []).length, 2, '两局该有两段');
  assert.match(text, /12:46/);
  assert.match(text, /13:10/);
}));

test('第一人称：这是她的日记，不是他的成绩单', () => {
  const text = renderDiary(ENTRY);
  assert.match(text, /我推的，他打了别的/, '标题要用她的口吻');
  assert.match(text, /我说「龙鳞军备」/, '要写成「我说」');
  // 站在旁观者角度记别人，翻回去看会像一份别人的复盘报告
  assert.doesNotMatch(text, /她推的/);
});

test('数字要对得上：最低血、分歧率', () => {
  const text = renderDiary(ENTRY);
  assert.match(text, /我 9 血 \/ 他 28 血/);
  assert.match(text, /最低掉到 3/);
  assert.match(text, /10 个决策点，按建议打 3 次（30%）/);
});

test('没有分歧的局也要能写 —— 不给空标题', () => {
  const text = renderDiary({ ...ENTRY, decisions: 0, agreed: 0, splits: [] });
  assert.doesNotMatch(text, /\*\*我推的，他打了别的\*\*/, '没分歧就别留个空标题');
  assert.doesNotMatch(text, /\*\*分歧\*\*/, '零决策点不写分歧率');
});

test('写不进去不能崩 —— 日记是旁路，不是主路径', () => withDir((dir) => {
  // 拿一个文件当目录用，mkdir 必然失败
  const bogus = join(dir, 'not-a-dir');
  writeFileSync(bogus, 'x', 'utf8');
  const r = appendDiary(bogus, ENTRY);
  assert.equal(r.ok, false);
  assert.ok(r.error, '要给出失败原因，不能静默');
}));

/* ---------- 感想栏 ---------- */

test('感想：写进去能按新到旧读出来', () => withDir((dir) => {
  appendThought(dir, { at: '2026-11-08T11:00:00+08:00', text: '第一条' });
  appendThought(dir, { at: '2026-11-08T12:00:00+08:00', text: '第二条', where: '第 12 回合' });
  const list = readThoughts(dir, 5);
  assert.equal(list.length, 2);
  assert.equal(list[0].text, '第二条', '新的排前面');
  assert.equal(list[0].where, '第 12 回合');
  assert.equal(list[1].text, '第一条');
}));

test('感想：坏行跳过，不许让整块面板空掉', () => withDir((dir) => {
  appendThought(dir, { at: '2026-11-08T11:00:00+08:00', text: '好的一条' });
  // 手动塞一行坏的（模拟写入中断 / 手工编辑出错）
  const f = join(dir, '感想.jsonl');
  writeFileSync(f, `${readFileSync(f, 'utf8')}{坏掉的 json\n`, 'utf8');
  const list = readThoughts(dir, 5);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '好的一条');
}));

test('感想：只留最近 200 条 —— 这是「最近在想什么」，不是档案', () => withDir((dir) => {
  for (let i = 0; i < 205; i += 1) {
    appendThought(dir, { at: `2026-11-08T${String(i % 24).padStart(2, '0')}:00:00+08:00`, text: `第 ${i} 条` });
  }
  const lines = readFileSync(join(dir, '感想.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 200);
  assert.match(lines[lines.length - 1], /第 204 条/, '最新的那条必须还在');
}));

test('感想：目录不存在也要能写', () => withDir((root) => {
  const dir = join(root, 'sync', 'deep');
  const r = appendThought(dir, { at: '2026-11-08T11:00:00+08:00', text: 'x' });
  assert.equal(r.ok, true, r.error);
}));
