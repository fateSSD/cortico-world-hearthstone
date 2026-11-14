/**
 * 拿真实的 Power.log 过一遍解析器,把诊断、快照和动作流水打出来。
 *
 * 这是「手造样本」之外的第一次真实校验:样本只能证明逻辑没写反,
 * 真实日志才能暴露 tag 形式、实体引用写法、前缀差异这些没预料到的东西。
 *
 *   node test/inspect.mjs "C:/Program Files (x86)/Hearthstone/Logs/<会话>/Power.log"
 */
import { readFileSync } from 'node:fs';
import { PowerLogParser, renderSnapshot } from '../src/parser.ts';

const path = process.argv[2];
if (!path) {
  console.error('用法: node test/inspect.mjs <Power.log 路径>');
  process.exit(1);
}

const text = readFileSync(path, 'utf8');
const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
console.log(`总行数 ${lines.length},字节 ${text.length}\n`);

const parser = new PowerLogParser(() => new Date().toISOString());

// 统计游戏局数:CREATE_GAME 出现几次
const games = lines.filter((l) => /GameState\.DebugPrintPower\(\) - CREATE_GAME/.test(l)).length;
console.log(`日志里出现过 ${games} 次 CREATE_GAME\n`);

// 分批喂,模拟实时读取的粒度
const BATCH = 500;
for (let i = 0; i < lines.length; i += BATCH) parser.feed(lines.slice(i, i + BATCH));

const d = parser.diagnostics();
console.log('=== 诊断 ===');
console.log('总行数     :', d.lines);
console.log('对局前缀行 :', d.powerLines);
console.log('未识别行   :', d.unmatchedLines, `(${((d.unmatchedLines / Math.max(1, d.powerLines)) * 100).toFixed(1)}%)`);
console.log('TAG_CHANGE :', d.tagChanges);
console.log('未映射的名字:', d.unmappedNames);
if (d.unmappedSamples.length) {
  console.log('\n未映射的名字样本(玩家名形式的标签):');
  for (const s of d.unmappedSamples.slice(0, 8)) console.log('  ·', s);
}
if (d.unmatchedSamples.length) {
  console.log('\n未识别的行样本:');
  for (const s of d.unmatchedSamples.slice(0, 10)) console.log('  ·', s);
}

const snap = parser.snapshot();
console.log('\n=== 最终快照 ===');
console.log(snap ? renderSnapshot(snap) : '(无快照:没读到 CREATE_GAME)');

console.log('\n=== 动作流水(最后 15 条) ===');
for (const a of parser.recent(15)) console.log(`  第${a.turn}回合 [${a.who}] ${a.kind} · ${a.text}`);
