import { HEARTHSTONE_DEFAULTS } from '../src/config.ts';
/**
 * 结构校验:按宿主的用法把包加载一遍,检查默认导出的形状、工具表、提示词变量和设置页声明。
 * 不启动日志监听(那要读真实文件系统),只验证「装载器认不认、World 能不能造出来」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('../src/index.ts');
const definition = mod.default;

/**
 * 数据目录必须给临时目录，不能给 `process.cwd()`。
 *
 * 2026-11-06 实测：`start()` 会建 `hearthstone-style.md` 和 `hearthstone-his-style.md`，
 * 而 cwd 是源码目录 —— 跑一次测试就在项目里留两份运行时数据，
 * 还会让「他没打过局时切到他的立场」那条测试因为发现了这份残留而失败。
 * 测试不该有副作用，更不该改自己的工作目录。
 */
const TEST_DATA = mkdtempSync(join(tmpdir(), 'hs-struct-'));
process.on('exit', () => {
  try { rmSync(TEST_DATA, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
});

/** 一个够用的假 WorldContext:create() 只读这几项。 */
function fakeContext() {
  const cfg = definition.defaults();
  return {
    id: definition.id,
    cfg,
    timezone: 'Asia/Shanghai',
    botName: 'Coo',
    botDir: process.cwd(),
    packageDir: process.cwd(),
    dataDir: TEST_DATA,
    repoRoot: process.cwd(),
    secret: () => '',
    storeSecret: () => {},
    persist: (patch) => Object.assign(cfg, patch),
    restart: async () => {},
  };
}

test('manifest 形状符合装载器的要求', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module', '必须是 ESM');
  assert.equal(pkg.cortico.kind, 'world');
  assert.equal(pkg.cortico.api, 6);
  assert.ok(pkg.keywords.includes('cortico-world'), '市场靠这个关键字发现');
  assert.ok(pkg.exports['.'].endsWith('.ts'), '入口直接指向 TS,由宿主的 tsx 加载');
});

test('默认导出是一个 WorldDefinition', () => {
  assert.equal(typeof definition.create, 'function');
  assert.equal(typeof definition.defaults, 'function');
  assert.equal(definition.id, 'hearthstone');
});

test('默认配置:关着,且字段齐全', () => {
  const cfg = definition.defaults();
  assert.equal(cfg.enabled, false, '装完不该自己开起来');
  assert.equal(cfg.mode, 'normal');
  assert.equal(typeof cfg.pollMs, 'number');
  assert.equal(typeof cfg.alertHealth, 'number');
  // 解说立场默认在她自己那边:那是她在这个世界里长出来的东西,
  // 不该一上来就被「他更熟自己的打法」盖掉。
  assert.equal(cfg.voice, 'mine');
  // 每次返回新对象,改了不会污染下一次
  const again = definition.defaults();
  cfg.alertHealth = 99;
  assert.equal(again.alertHealth, 10);
});

test('解说立场:设置页声明了,而且代码真的读它 —— 声明 ≠ 接线', async () => {
  const world = definition.create(fakeContext());
  const ui = world.webUi('zh');
  const adv = ui.config.find((g) => g.id === 'hearthstone.advanced');
  const decl = adv.schema.properties['worlds.hearthstone.voice'];
  assert.ok(decl, '设置页要能切,不然面板按钮之外就没入口了');
  assert.deepEqual(decl.enum, ['mine', 'his']);
  // 键必须是完整点分路径,裸名会写到 config.json 顶层
  assert.ok(!adv.schema.properties.voice, '不许出现裸名');

  // 声明了但没人读 = 配了等于没配。这里直接盯源码:
  // envPromptVars 和面板数据面都必须读 this.cfg.voice。
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/world.ts', import.meta.url), 'utf8');
  assert.ok(/this\.cfg\.voice\s*===\s*'his'/.test(src), '注入层要按开关切换');
  assert.ok(/panelVoice\s*\(/.test(src), '面板那个按钮要有处理函数');
});

test('World 能造出来,十一个工具都在,并且都带 handler', () => {
  const world = definition.create(fakeContext());
  assert.equal(world.id, 'hearthstone');
  const tools = world.tools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['hearthstone_advice', 'hearthstone_diary', 'hearthstone_draft', 'hearthstone_his_style', 'hearthstone_last_game', 'hearthstone_meta', 'hearthstone_plan', 'hearthstone_recent', 'hearthstone_state', 'hearthstone_style', 'hearthstone_watch']);
  for (const t of tools) {
    assert.equal(typeof t.handler, 'function', `${t.name} 要有 handler`);
    assert.ok(t.tags.length > 0, `${t.name} 要有分类标签`);
    assert.equal(t.parameters.type, 'object', `${t.name} 的参数要是 JSON Schema 对象`);
  }
});

test('没连上日志时,工具回执给的是怎么把日志打开,不是一句干巴巴的失败', async () => {
  const world = definition.create(fakeContext());
  const state = world.tools().find((t) => t.name === 'hearthstone_state');
  const out = await state.handler({}, { log: console, role: 'test' });
  const text = typeof out === 'string' ? out : out.text;
  assert.match(text, /Power\.log|没有进行中的对局/);
});

test('扩展页:三盏灯、一块面板、三组配置、一份提示词模板', () => {
  const world = definition.create(fakeContext());
  const ui = world.webUi('zh');
  assert.equal(ui.label, '炉石陪打');
  assert.equal(ui.lamps.length, 3);
  for (const lamp of ui.lamps) {
    assert.ok(['online', 'loading', 'error', 'offline'].includes(lamp.state), `灯的 state 必须是约定值,现在是 ${lamp.state}`);
  }

  // 2026-10-24:设置页从三组 15 项砍到两组。
  // 日常要动的开关(自动开口/每回合提一句/关键节点)搬到了面板上 ——
  // 一个设置页塞十几项,他每次进来都得先找。
  // （具体项数不再写进注释:加一项就要改一次,而改漏了没人知道。）
  //
  // 2026-11-08 多出第三组「复盘日记」:日记存哪要能改(本机 / OneDrive 同步盘),
  // 那是设置页的事,不该塞进面板。
  assert.equal(ui.config.length, 3);
  assert.equal(ui.config[0].owner, 'world:hearthstone');
  assert.ok(ui.config[0].schema.properties['worlds.hearthstone.logPath'], '要能配日志路径');
  assert.deepEqual(ui.config.map((g) => g.id), ['hearthstone.connect', 'hearthstone.advanced', 'hearthstone.diary']);
  // 核心牌名单是「一次配好」的东西,跟着接入组走。
  // 机械规则读不出哪张牌是 combo 核心,必须留一个口子让他填。
  assert.ok(ui.config[0].schema.properties['worlds.hearthstone.keepCards'], '要能配核心牌名单');

  // 面板:非自动模式下他唯一的问法就是这一下。
  assert.equal(ui.panels.length, 1);
  assert.equal(ui.panels[0].id, 'main');
  assert.equal(ui.panels[0].defaultOpen, true);
  assert.equal(typeof ui.invoke, 'function', '面板没有数据面就只是个空壳');

  // 第三盏灯是「形象包」。
  //
  // 2026-11-14 试过把它做成第二块面板，界面直接报「面板产物中没有 figure，可用面板：main」——
  // 宿主的 WebUI 是预构建的，面板 id 必须在前端源码里有对应组件才算数。灯不需要构建产物，
  // `hint` 又是悬停就能看全的纯文本，所以说明改放这里。
  const figureLamp = ui.lamps.find((l) => l.label === '形象包');
  assert.ok(figureLamp, '要有「形象包」这盏灯 —— 不然没人知道动作要靠包装');
  for (const word of ['形象包', '换装', 'data/figures']) {
    assert.ok(figureLamp.hint.includes(word), `灯的说明里必须提到「${word}」—— 少一个他就装不上`);
  }
  // 装包入口要能点到（`/#/dress` 是应用内换装页；斜杠少了宿主会丢弃这条链接）
  assert.ok(ui.links.some((l) => l.href === '/#/dress'), '要有去换装页的入口');
  assert.equal(ui.promptDocs[0].role, 'envPrompt');
  assert.ok(ui.promptDocs[0].path.endsWith('ENV_PROMPT.md'));
  const varNames = ui.promptDocs[0].vars.map((v) => v.name).sort();
  assert.deepEqual(varNames, ['hs.deck', 'hs.game', 'hs.mode', 'hs.rules', 'hs.status']);
});

test('面板那个按钮真的能切，而且切了会落盘', async () => {
  const ctx = fakeContext();
  const world = definition.create(ctx);
  // panelInvoke 是私有的，但它是面板唯一的通道 —— 直接打它，比另开一条测试专用入口诚实。
  const invoke = (m, args) => world.panelInvoke('main', m, args);

  const before = await invoke('status', []);
  assert.equal(before.status.voice, 'mine', '默认必须在她自己那边');

  const after = await invoke('voice', ['his']);
  assert.equal(after.status.voice, 'his');
  assert.equal(ctx.cfg.voice, 'his', 'persist 没生效 —— 切了等于没切，下次开还是旧的');

  const back = await invoke('voice', ['mine']);
  assert.equal(back.status.voice, 'mine');
  assert.equal(ctx.cfg.voice, 'mine');

  // 不认的值要吵出来。静默当成 mine 的话，前端写错一个词就会变成「按钮点了没反应」。
  await assert.rejects(() => invoke('voice', ['随便什么']), /只认 mine/);
});

test('没打过局的时候切到他那边，要能看出那边是空的', async () => {
  const ctx = fakeContext();
  const world = definition.create(ctx);
  const payload = await world.panelInvoke('main', 'voice', ['his']);
  // fakeContext 的 dataDir 是 cwd，那里没有他的档案 → 面板该说「还没数出来」
  assert.equal(payload.status.voice, 'his');
  assert.equal(payload.status.hisReady, false, '空的还报 ready，他就不知道为什么她什么都不说');
});

/**
 * 设置页的键必须是**从 config.json 根开始的完整点分路径**。
 *
 * 这条是 2026-10-23 挖出来的真事故:原来三组配置的键都写成 `logPath`、`keepCards`
 * 这种裸名,framwork 的 `setConfigPath(root, path, v)` 拿它直接戳根 —— 于是他在
 * 设置页填的东西全落到 config.json 顶层,而扩展读的是 `worlds.hearthstone.*`,
 * 一个字都读不到。**配了等于没配,而且不报错。**
 * 症状:他填了核心牌名单,德雷阿佳丝照样被「按费打」推出去。
 */
test('配置组的键都带 worlds.<id>. 前缀 —— 裸名会写到 config.json 顶层', () => {
  const world = definition.create(fakeContext());
  for (const g of world.webUi('zh').config) {
    for (const key of Object.keys(g.schema.properties)) {
      assert.ok(
        key.startsWith('worlds.hearthstone.'),
        `「${g.schema.title}」里的 ${key} 没有前缀 —— 它会被写到 config.json 根部,扩展读不到`,
      );
    }
  }
});

test('提示词模板的路径在磁盘上真实存在', async () => {
  // 这条是回归测试:曾经用 ctx.packageDir(bot 的包目录)拼 <botDir>/ENV_PROMPT.md,
  // 拼出来的路径不存在,框架重建前缀时 readFileSync 抛 ENOENT,激活流程半途死掉,
  // 留下幽灵实例导致之后每次激活都报「工具撞名」。
  const { existsSync } = await import('node:fs');
  const world = definition.create(fakeContext());
  const doc = world.webUi('zh').promptDocs[0];
  assert.ok(doc.path && existsSync(doc.path), `模板路径必须真实存在,现在是:${doc.path}`);
  assert.ok(!doc.path.includes('bots'), `不能指向 bot 的包目录,现在是:${doc.path}`);
});

test('提示词变量与模板里的占位符对得上', async () => {
  const { readFile } = await import('node:fs/promises');
  const template = await readFile(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  const used = new Set([...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]));
  const world = definition.create(fakeContext());
  const provided = new Set(Object.keys(world.envPromptVars()));
  assert.deepEqual([...used].sort(), [...provided].sort(), '模板用了什么变量,envPromptVars 就要给什么');
});

test('自描述里的工具与实例给出的工具是同一批', () => {
  const declared = definition.describe.tools.map((t) => t.name).sort();
  const actual = definition.create(fakeContext()).tools().map((t) => t.name).sort();
  assert.deepEqual(declared, actual);
});

test('声明的事件都有中文说明和触发方式', () => {
  for (const event of definition.describe.events) {
    assert.ok(event.type.startsWith('hearthstone.'), `${event.type} 要用自己的前缀`);
    assert.ok(event.description.zh && event.description.en, `${event.type} 要中英两份说明`);
    assert.ok(['flush', 'debounce', 'preempt', 'interrupt', 'piggyback'].includes(event.trigger));
  }
});

/**
 * 配置项「哪一方是你」必须真的接到解析器上。
 *
 * 2026-10-24 自查:这一项在 schema 里有、有默认值、`diagnostics()` 里还专门留了
 * `localDetectedBy: 'config'` 分支 —— 但 `world.ts` 从来没调过 `setLocalPlayerId()`。
 * 用户在身份判反时按提示改它，什么都不会发生，还不报错。
 *
 * 这条测试读源码断言调用存在。丑，但这类「声明了却没人接线」的洞只有两种查法:
 * 端到端跑一遍，或者盯住那一行代码。前者在这个项目里要真开一局炉石。
 */
test('「哪一方是你」这个配置接了线,不是摆设', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const src = await readFile(fileURLToPath(new URL('../src/world.ts', import.meta.url)), 'utf8');
  assert.match(src, /setLocalPlayerId\s*\(/, 'world.ts 没有把 cfg.localPlayerId 交给解析器');
  assert.match(src, /this\.cfg\.localPlayerId/, 'syncLocalPref 没读配置项');
});

/**
 * 面板 bundle 是 package.json 里声明、由宿主按路径发出去的。
 *
 * 两个都容易忘：加了 `panels` 声明却没把 `webUiClient` 写进 manifest，
 * 页面会报「这一页没有面板实现」；写了路径但 `files` 里没带 `webui`，
 * 打包发出去之后别人装上是空的 —— 而本地开发一切正常。
 */
test('面板:manifest 声明了 bundle,文件也在,而且 files 里带上了', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.cortico.webUiClient, 'webui/panel.js');
  assert.equal(pkg.cortico.webUiStyle, 'webui/panel.css');
  for (const rel of [pkg.cortico.webUiClient, pkg.cortico.webUiStyle]) {
    assert.ok(existsSync(new URL(`../${rel}`, import.meta.url)), `${rel} 不存在`);
  }
  assert.ok(pkg.files.includes('webui'), 'files 里要带 webui,否则发出去面板是空的');
  // bundle 得是能 import 的 ESM,而且 default 里真的有 panels.main
  const mod = await import(new URL('../webui/panel.js', import.meta.url).href);
  assert.equal(typeof mod.default.panels.main.mount, 'function');
});

/**
 * 「问模型要第二意见」默认必须关着。
 *
 * 它是在 `hearthstone_advice` 里同步 await 的 —— 打开就是点一下多等 3–7 秒,
 * 体感直接是「卡」。机械规则(斩杀/交换/墙/疲劳钟)本来就够硬,第二意见的边际价值
 * 抵不上这几秒。想开的人在设置里自己开。
 */
test('模型第二意见默认关着 —— 它堵在「点一下要结果」的路径上', () => {
  const d = HEARTHSTONE_DEFAULTS();
  assert.equal(d.llmAdvice, false, '默认开着就是点一下卡 3–7 秒');
});

/**
 * 渲染层不许把内部 id 当名字递出去。
 *
 * 2026-10-28 实测:建议回执里是「FIR_953 5/8」、归档里是「打出 #57」、
 * 提示里是「对手场上多了 CATA_190t14」。同一个根因:`name` 取空时兜底直接落到 `cardId`。
 * 逐个函数改容易漏(advice / alerts / parser / lethal 各有一份),所以在这里盯源码:
 * 名字兜底链里只要还留着「name || xxx.cardId」这种直落,就说明改漏了。
 */
test('名字兜底链里不许以内部编号收尾', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  for (const f of ['parser.ts', 'alerts.ts', 'advice.ts', 'lethal.ts']) {
    const src = await readFile(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(
      src,
      /\.name \|\| [A-Za-z_]\w*(?:\.\w+)*\.cardId/,
      `${f} 里还有「name 取空就直接落 cardId」的兜底`,
    );
  }
});
