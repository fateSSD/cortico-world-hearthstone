/**
 * 拿真实日志走一遍「打完一局 → 归档 → 渲染复盘」的完整路径,
 * 看看她复盘时实际会读到什么。
 *
 *   node test/archive.mjs "<Power.log 路径>"
 */
import { readFileSync } from 'node:fs';
import { PowerLogParser } from '../src/parser.ts';
import { renderArchive } from '../src/world.ts';

const path = process.argv[2];
const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));

const parser = new PowerLogParser(() => new Date().toISOString());
parser.setHistoryLimit(200);

let timeline = [];
let lastTurn = -1;
let archive = null;

const BATCH = 400;
for (let i = 0; i < lines.length; i += BATCH) {
  parser.feed(lines.slice(i, i + BATCH));
  const s = parser.snapshot();
  if (!s) continue;
  if (s.turn > lastTurn && !s.ended) {
    lastTurn = s.turn;
    const bl = (x) => x.minions.length
      ? `${x.minions.length} 个(攻 ${x.minions.reduce((a, m) => a + m.atk, 0)}/血 ${x.minions.reduce((a, m) => a + m.health, 0)})`
      : '空场';
    timeline.push({
      turn: s.turn,
      myHp: s.me.health, myArmor: s.me.armor, myHand: s.me.handCount, myBoard: bl(s.me),
      foeHp: s.opponent.health, foeArmor: s.opponent.armor, foeHand: s.opponent.handCount, foeBoard: bl(s.opponent),
    });
  }
  if (s.ended && !archive) {
    archive = {
      startedAt: s.startedAt,
      endedAt: new Date().toISOString(),
      result: s.result,
      turns: s.turn,
      me: { heroClass: s.me.heroClass, name: s.me.heroName },
      opponent: { heroClass: s.opponent.heroClass, name: s.opponent.heroName },
      final: { myHp: s.me.health, myArmor: s.me.armor, foeHp: s.opponent.health, foeArmor: s.opponent.armor },
      timeline: [...timeline],
      actions: parser.recent(200),
    };
  }
}

if (!archive) {
  console.log('这局还没结束,没有归档。');
  process.exit(0);
}

const text = renderArchive(archive, true);
console.log(text);
console.log('\n--- 体量 ---');
console.log('字符数:', text.length, '| 时间线点:', archive.timeline.length, '| 动作:', archive.actions.length);
