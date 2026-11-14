/**
 * 模拟一场实时对局:前半局当「启动时补历史」(不推事件),后半局当「实时到达」(应当推事件)。
 *
 * 目的是验证「回合开始自动开口」这条链路真的通 —— 之前那一局是在扩展装好之前打完的,
 * 重放时按设计不推事件,所以 turn 事件从没被真正触发过。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const CORTICO_SRC = pathToFileURL('C:/Users/祁鹏宇/Coopanion/resources/app/build/cortico/src/').href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('cortico/')) return next(new URL(specifier.slice(7), CORTICO_SRC).href, context);
    return next(specifier, context);
  },
});

const { default: definition } = await import(
  pathToFileURL('C:/Users/祁鹏宇/WorkBuddy/2026-10-22-21-42-07/coopani-world-hearthstone/src/index.ts').href
);

const logPath = 'C:/Program Files (x86)/Hearthstone/Logs/Hearthstone_2026_10_23_19_09_13/Power.log';
const lines = readFileSync(logPath, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));

const cfg = definition.defaults();
cfg.logPath = 'C:/__nope__/Power.log';   // 让实时监听空转,避免和手工喂的行打架
cfg.speakTurns = true;
cfg.speakAlerts = true;

const pushed = [];
const logger = { info() {}, warn: (...a) => console.error('WARN', ...a), error: (...a) => console.error('ERR', ...a), debug() {}, trace() {}, emit() {}, child() { return logger; } };
const host = {
  pushEvent: async (event, opts) => {
    pushed.push({ type: event.type, text: event.text, trigger: opts?.trigger });
    return { cursor: pushed.length, ...event, origin: 'external' };
  },
  store: { latestCursor: () => 0 },
  modelFacts: {}, blob: () => null, reportUsage: () => {}, log: logger,
};

const ctx = {
  id: definition.id, cfg, timezone: 'Asia/Shanghai', botName: 'Coo',
  botDir: process.cwd(), packageDir: process.cwd(), dataDir: process.cwd(), repoRoot: process.cwd(),
  secret: () => '', storeSecret: () => {}, persist: (p) => Object.assign(cfg, p), restart: async () => {},
};

const world = definition.create(ctx);

await world.start(host);

// 前半局:启动补历史,不该推任何事件
const mid = Math.floor(lines.length * 0.3);
world.onLines(lines.slice(0, mid), true);
console.log('补历史后事件数:', pushed.length, '(应为 0)');

// 后半局:模拟实时到达,应当推 turn / alert / end
// 真实运行时每 400ms 读一次新增,一次也就几十上百行 —— 这里按 150 行一批模拟那个节奏
const rest = lines.slice(mid);
for (let i = 0; i < rest.length; i += 150) {
  world.onLines(rest.slice(i, i + 25), false);
  await new Promise((r) => setTimeout(r, 5));
}
await new Promise((r) => setTimeout(r, 300));

const byType = {};
for (const e of pushed) byType[e.type] = (byType[e.type] || 0) + 1;
console.log('\n实时段推出的事件:');
for (const [k, v] of Object.entries(byType)) console.log(`  ${k}: ${v} 条`);

console.log('\n前 3 条 turn:');
for (const e of pushed.filter((x) => x.type === 'hearthstone.turn').slice(0, 3)) console.log('  ·', e.text.slice(0, 110));
console.log('\n前 3 条 alert:');
for (const e of pushed.filter((x) => x.type === 'hearthstone.alert').slice(0, 3)) console.log('  ·', e.text.replace(/\n/g, ' / ').slice(0, 140));
console.log('\n结束事件:');
for (const e of pushed.filter((x) => x.type === 'hearthstone.game.end')) console.log('  ·', e.text);

await world.stop();
