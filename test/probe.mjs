import { readFileSync } from 'node:fs';
import { PowerLogParser } from '../src/parser.ts';

const path = 'C:/Program Files (x86)/Hearthstone/Logs/Hearthstone_2026_10_22_22_08_25/Power.log';
const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
console.log('行数:', lines.length);

const p = new PowerLogParser(() => new Date().toISOString());
for (let i = 0; i < lines.length; i += 500) {
  p.feed(lines.slice(i, i + 500));
}
const d = p.diagnostics();
console.log('diag.lines:', d.lines, '| powerLines:', d.powerLines, '| tagChanges:', d.tagChanges);
console.log('inGame:', p.inGame, '| turn:', p.snapshot()?.turn);
console.log('turnTimeline:', p.turnTimeline().length);
