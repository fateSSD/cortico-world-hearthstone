/**
 * 用最新解析器把指定的 Power.log 重建成一份归档,写到 Coopani 的数据目录。
 * 用途:core 没来得及重写归档时(比如启动被别的 World 拖住),先把数据补齐,工具立刻可读。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PowerLogParser } from '../src/parser.ts';
import { renderArchive } from '../src/world.ts';

const [logPath, outPath] = process.argv.slice(2);
if (!logPath || !outPath) {
  console.error('用法: node test/rebuild-archive.mjs <Power.log> <输出 json>');
  process.exit(1);
}

const lines = readFileSync(logPath, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
const parser = new PowerLogParser(() => new Date().toISOString());
parser.setHistoryLimit(200);

let archive = null;
const BATCH = 500;
for (let i = 0; i < lines.length; i += BATCH) {
  parser.feed(lines.slice(i, i + BATCH));
  const s = parser.snapshot();
  if (s?.ended && !archive) {
    archive = {
      startedAt: s.startedAt,
      endedAt: new Date().toISOString(),
      result: s.result,
      turns: s.turn,
      me: { heroClass: s.me.heroClass, name: s.me.heroName },
      opponent: { heroClass: s.opponent.heroClass, name: s.opponent.heroName },
      final: { myHp: s.me.health, myArmor: s.me.armor, foeHp: s.opponent.health, foeArmor: s.opponent.armor },
      timeline: parser.turnTimeline(),
      actions: parser.recent(200),
    };
  }
}

if (!archive) {
  console.error('这份日志里没有已结束的对局。');
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify(archive, null, 2), 'utf8');
console.log('已写入:', outPath);
console.log('结果:', archive.result, '| 回合:', archive.turns, '| 时间线:', archive.timeline.length, '| 动作:', archive.actions.length);
