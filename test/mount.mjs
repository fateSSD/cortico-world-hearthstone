/**
 * 装载验证:按宿主真实的方式加载这个包。
 *
 * 复刻 resources/app/build/cortico/src/extensions/runtime.ts 做的那件事 —— 把 `cortico/*`
 * 映射到框架 src,然后交给 tsx 转译。这一步过了,才说明扩展在 Coopani 里真的能起来,
 * 而不只是「单测里能跑」。
 *
 * 跑法(用宿主自带的 tsx):
 *   node test/mount.mjs
 *
 * ⚠ 路径必须**现场探测**,不能写死。2026-11-06 这里原来钉的是
 * `C:/Users/祁鹏宇/Coopanion`,换到这台机器(Administrator / E 盘)之后
 * 报的是 ERR_MODULE_NOT_FOUND,看起来像包坏了,其实只是路径过期。
 * 同一个坑在「安装路径不能写死某一台的盘符」那节记过,这次落在测试脚本里。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

/**
 * 数据目录给临时目录，别给 cwd。
 * `start()` 会建 `hearthstone-style.md` / `hearthstone-his-style.md` ——
 * 指向源码目录的话，跑一次就在项目里留两份运行时数据。
 */
const TEST_DATA = mkdtempSync(join(tmpdir(), 'hs-mount-'));
process.on('exit', () => {
  try { rmSync(TEST_DATA, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
});

/** 依次试这些位置,第一个带 `resources/app/build/cortico/src` 的就是宿主根。 */
function findCoopani() {
  const tried = [];
  const candidates = [
    process.env.COOPANI_HOME,
    'E:/Coopanion',
    `C:/Users/${process.env.USERNAME ?? ''}/Coopanion`,
    join(homedir(), 'Coopanion'),
    'D:/Coopanion',
    'C:/Program Files/Coopanion',
  ].filter(Boolean);
  for (const root of candidates) {
    const src = join(root, 'resources/app/build/cortico/src');
    tried.push(root);
    if (existsSync(src)) return root;
  }
  throw new Error(
    '找不到 Coopani 安装目录。试过:\n  ' + tried.join('\n  ')
    + '\n设一个 COOPANI_HOME 环境变量指过去就行。',
  );
}

const COOPANI_ROOT = findCoopani();
const CORTICO_SRC = pathToFileURL(join(COOPANI_ROOT, 'resources/app/build/cortico/src')).href + '/';
// 包入口直接用本文件旁边的 src —— 别再走 node_modules 那层符号链接,
// 它指向的就是这里,多一层只是多一个会过期的路径。
const PACKAGE_ENTRY = new URL('../src/index.ts', import.meta.url).href;
console.log('宿主:', COOPANI_ROOT);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('cortico/')) {
      return next(new URL(specifier.slice('cortico/'.length), CORTICO_SRC).href, context);
    }
    return next(specifier, context);
  },
});

const mod = await import(PACKAGE_ENTRY);
const definition = mod.default;

assert.ok(definition, '要有默认导出');
assert.equal(definition.id, 'hearthstone');
assert.equal(typeof definition.create, 'function');
console.log('✓ 模块钩子生效,包被成功 import');

// 造一个最小的 host:World 只用到 pushEvent / log / store
const pushed = [];
const logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {}, child() { return logger; } };
const host = {
  pushEvent: async (event, opts) => {
    pushed.push({ type: event.type, text: event.text, trigger: opts?.trigger });
    return { cursor: pushed.length, ...event, origin: 'external' };
  },
  store: { latestCursor: () => 0 },
  modelFacts: {},
  blob: () => null,
  reportUsage: () => {},
  log: logger,
};

const cfg = definition.defaults();
const ctx = {
  id: definition.id,
  cfg,
  timezone: 'Asia/Shanghai',
  botName: 'Coo',
  botDir: process.cwd(),
  dataDir: TEST_DATA,
  repoRoot: process.cwd(),
  secret: () => '',
  storeSecret: () => {},
  persist: (patch) => Object.assign(cfg, patch),
  restart: async () => {},
};

const world = definition.create(ctx);
console.log('✓ World 构造成功,tools:', world.tools().map((t) => t.name).join(', '));

await world.start(host);
console.log('✓ start() 通过,日志监听已起来');
console.log('  状态:', world.envPromptVars()['hs.status']);

// 工具在没有对局时也要给出可读的回执
const state = world.tools().find((t) => t.name === 'hearthstone_state');
const receipt = await state.handler({}, { role: 'test', log: logger });
const text = typeof receipt === 'string' ? receipt : receipt.text;
console.log('✓ hearthstone_state 回执:');
console.log(text.split('\n').map((line) => `  ${line}`).join('\n'));

// 建议工具的 handler 也走一遍:它依赖卡表文件和斩杀规划,任何一环断了这里会炸
const advice = world.tools().find((t) => t.name === 'hearthstone_advice');
const adviceReceipt = await advice.handler({ full: true }, { role: 'test', log: logger });
const adviceText = typeof adviceReceipt === 'string' ? adviceReceipt : adviceReceipt.text;
assert.ok(adviceText.length > 0, 'advice 回执不能是空的');
console.log('✓ hearthstone_advice 回执(前 6 行):');
console.log(adviceText.split('\n').slice(0, 6).map((line) => `  ${line}`).join('\n'));

// 选牌:候选是从用户那里来的,所以这里显式传进去,顺便验证记录与曲线
const draft = world.tools().find((t) => t.name === 'hearthstone_draft');
await draft.handler({ reset: true }, { role: 'test', log: logger });
await draft.handler({ pick: '火球术' }, { role: 'test', log: logger });
const draftReceipt = await draft.handler(
  { options: ['石拳食人魔', '烈焰风暴', '银背族长'] },
  { role: 'test', log: logger },
);
const draftText = typeof draftReceipt === 'string' ? draftReceipt : draftReceipt.text;
assert.ok(draftText.includes('【候选】'), '选牌回执要有候选块');
console.log('✓ hearthstone_draft 回执:');
console.log(draftText.split('\n').map((line) => `  ${line}`).join('\n'));
await draft.handler({ reset: true }, { role: 'test', log: logger });

await world.stop();
console.log('✓ stop() 通过');

console.log('\n装载验证全部通过。已推送事件数:', pushed.length);
