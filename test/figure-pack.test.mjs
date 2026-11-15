/**
 * 形象包安装的自检。
 *
 * 跑法（跟主测试一样，用宿主的 tsx）：
 *   node "E:/Coopanion/resources/app/node_modules/tsx/dist/cli.mjs" --test test/figure-pack.test.mjs
 *
 * 这件事有四种只会在别人机器上暴露的失败，各压一次：
 * 1. 装到一半中断 → 留下半个包（装扮页里那个形象白图，而且不报错）
 * 2. 每次启动都重装 → 16MB 的包在 SSD 上也是白磨，还可能在桌宠读图时撞文件占用
 * 3. 用户自己做了一个同 id 的包 → 被扩展覆盖掉（比装不上糟糕得多）
 * 4. 装失败把启动搞崩 → 听歌/陪打跟着一起挂
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIGURE_PACK_ID, ensureFigurePack, figuresRoot } from '../src/figure-pack.ts';

const tmp = (tag) => mkdtempSync(join(tmpdir(), `figure-pack-${tag}-`));

/** 造一份「最小形象包」：这个模块只认 figure.json 和 installed-by.json，贴图不参与判断。 */
function makeSource(root, version) {
  mkdirSync(join(root, 'tex'), { recursive: true });
  writeFileSync(join(root, 'figure.json'), JSON.stringify({ manifest: 2, api: 2, id: FIGURE_PACK_ID, version }), 'utf8');
  writeFileSync(join(root, 'figure.js'), 'export const createWhaleBody = () => ({});\n', 'utf8');
  writeFileSync(join(root, 'tex', 'a.png'), 'not-a-real-png', 'utf8');
  return root;
}

const opts = (dataDir, sourceDir) => ({ dataDir, sourceDir, installer: 'test-world' });

test('装进 dataDir/figures/<id>/，内容与源一致', async () => {
  const data = tmp('fresh');
  const src = makeSource(tmp('src'), '1.0.0');
  const r = await ensureFigurePack(opts(data, src));
  assert.equal(r.status, 'installed');
  assert.equal(r.version, '1.0.0');
  assert.equal(r.dir, join(data, 'figures', FIGURE_PACK_ID));
  assert.equal(readFileSync(join(r.dir, 'tex', 'a.png'), 'utf8'), 'not-a-real-png');
  // 标记文件写进去了 —— 下次才认得出「这个包是我装的」
  const mark = JSON.parse(readFileSync(join(r.dir, 'installed-by.json'), 'utf8'));
  assert.equal(mark.installer, 'test-world');
  assert.equal(mark.version, '1.0.0');
});

test('同版本再跑一次什么都不做（不重装）', async () => {
  const data = tmp('idem');
  const src = makeSource(tmp('src'), '1.0.0');
  const first = await ensureFigurePack(opts(data, src));
  assert.equal(first.status, 'installed');
  const at = readFileSync(join(first.dir, 'installed-by.json'), 'utf8');
  const second = await ensureFigurePack(opts(data, src));
  assert.equal(second.status, 'up-to-date');
  assert.equal(readFileSync(join(second.dir, 'installed-by.json'), 'utf8'), at, '没重写，说明没重装');
});

test('源升级后整目录替换，旧文件不残留', async () => {
  const data = tmp('upgrade');
  const oldSrc = makeSource(tmp('src-old'), '1.0.0');
  writeFileSync(join(oldSrc, 'tex', 'only-in-old.png'), 'x', 'utf8');
  const first = await ensureFigurePack(opts(data, oldSrc));
  assert.equal(first.status, 'installed');

  const newSrc = makeSource(tmp('src-new'), '1.1.0');
  const second = await ensureFigurePack(opts(data, newSrc));
  assert.equal(second.status, 'installed');
  assert.equal(second.version, '1.1.0');
  assert.equal(existsSync(join(second.dir, 'tex', 'only-in-old.png')), false, '旧版本的文件必须走掉');
});

test('用户自己放的同名包不动它', async () => {
  const data = tmp('occupied');
  const mine = join(data, 'figures', FIGURE_PACK_ID);
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, 'figure.json'), JSON.stringify({ id: FIGURE_PACK_ID, version: '9.9.9' }), 'utf8');
  writeFileSync(join(mine, 'figure.js'), '// 用户自己的\n', 'utf8');

  const src = makeSource(tmp('src'), '1.0.0');
  const r = await ensureFigurePack(opts(data, src));
  assert.equal(r.status, 'occupied');
  assert.equal(r.version, '9.9.9');
  assert.equal(readFileSync(join(mine, 'figure.js'), 'utf8'), '// 用户自己的\n', '一个字都不能改');
});

test('源不完整时不装，也不留半成品', async () => {
  const data = tmp('broken');
  const src = tmp('src-broken'); // 空目录：没有 figure.json
  const r = await ensureFigurePack(opts(data, src));
  assert.equal(r.status, 'failed');
  assert.equal(existsSync(join(data, 'figures', FIGURE_PACK_ID)), false);
  assert.equal(existsSync(join(data, 'figures')), false, '连 figures/ 都不该建');
});

test('figures/ 在就不另建，在上层也能找到', async () => {
  const root = tmp('root');
  mkdirSync(join(root, 'data', 'figures'), { recursive: true });
  assert.equal(figuresRoot(join(root, 'data')), join(root, 'data', 'figures'));
  // dataDir 指到更深一层时，往上找得到现成的 figures/
  assert.equal(figuresRoot(join(root, 'data', 'deep', 'deeper')), join(root, 'data', 'figures'));
  // 一层都没有就回落到 dataDir/figures
  const empty = tmp('empty');
  assert.equal(figuresRoot(empty), join(empty, 'figures'));
});

test('装失败不抛错 —— 调用方拿状态说话，启动不能被拖垮', async () => {
  const data = tmp('swallow');
  const r = await ensureFigurePack(opts(data, join(data, '不存在的源目录')));
  assert.equal(r.status, 'failed');
  assert.match(r.message, /不完整/);
});

test('真包能装进去 —— assets 就是发货的那一份，贴图必须在里面', async () => {
  const src = fileURLToPath(new URL('../assets/figure-groove', import.meta.url));
  const data = tmp('real');
  const r = await ensureFigurePack(opts(data, src));
  assert.equal(r.status, 'installed');
  assert.equal(r.version, '1.0.0');
  for (const need of ['figure.json', 'figure.js', 'model.json', 'tex', 'feat', 'schemes', 'outfits', 'thumbs']) {
    assert.ok(existsSync(join(r.dir, need)), `${need} 没跟过去`);
  }
  // 只拷两个文件也算「成功」，但那个包在装扮页里是白图。数量兜一下。
  const count = readdirSync(r.dir, { recursive: true }).length;
  assert.ok(count > 400, `文件太少（${count}）—— 贴图没进包`);
});
