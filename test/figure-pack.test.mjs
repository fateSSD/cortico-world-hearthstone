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

import { FIGURE_PACK_ID, ensureFigurePack, figuresRoot, inspectFigurePack } from '../src/figure-pack.ts';

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
  const src = fileURLToPath(new URL('../assets/figure-groove-game', import.meta.url));
  const data = tmp('real');
  const want = JSON.parse(readFileSync(join(src, 'figure.json'), 'utf8')).version;
  const r = await ensureFigurePack(opts(data, src));
  assert.equal(r.status, 'installed');
  assert.equal(r.version, want, '装进去的版本要和 assets 里那份一致');
  for (const need of ['figure.json', 'figure.js', 'model.json', 'tex', 'feat', 'schemes', 'outfits', 'thumbs']) {
    assert.ok(existsSync(join(r.dir, need)), `${need} 没跟过去`);
  }
  // 只拷两个文件也算「成功」，但那个包在装扮页里是白图。数量兜一下。
  const count = readdirSync(r.dir, { recursive: true }).length;
  assert.ok(count > 400, `文件太少（${count}）—— 贴图没进包`);
});

/* ------------------------------------------------------------------
 * 2026-11-16：载入时不装（`cortico-extensions#659` 明确要求）
 *
 * 谁把 `start()` 改回 `ensureFigurePack`，第一条就会红。
 * ------------------------------------------------------------------ */

test('只看不装：inspect 一步盘都不写', async () => {
  const data = tmp('inspect');
  const src = makeSource(tmp('src'), '1.0.0');
  const r = await inspectFigurePack({ dataDir: data, sourceDir: src });
  assert.equal(r.status, 'missing');
  assert.match(r.message, /按钮|面板/);
  assert.equal(existsSync(join(data, 'figures', FIGURE_PACK_ID)), false, '光看一眼就把包装上了');
  assert.equal(existsSync(join(data, 'figures')), false, '连 figures/ 都不该建');
});

test('装过之后 inspect 报的是真状态（不是「刚装过」）', async () => {
  const data = tmp('inspect-ok');
  const src = makeSource(tmp('src'), '2.0.0');
  await ensureFigurePack(opts(data, src));
  const same = await inspectFigurePack({ dataDir: data, sourceDir: src });
  assert.equal(same.status, 'up-to-date');
  assert.equal(same.version, '2.0.0');

  const newer = makeSource(tmp('src-new'), '3.0.0');
  const old = await inspectFigurePack({ dataDir: data, sourceDir: newer });
  assert.equal(old.status, 'missing', '版本旧了要报 missing（该装），不能报 up-to-date');
  assert.match(old.message, /2\.0\.0/);
});

/* ------------------------------------------------------------------
 * 对局版 1.3.8：
 *
 * 已恢复正常体型（BODY_SCALE = 1）并联动底部窗口自动避让（avoidLogo），
 * extent / hits 仍须与 BODY_SCALE 和避让偏移同步映射，防止出现错位或隐形点击死区。
 * ------------------------------------------------------------------ */

test('门牌一致：assets 里的 id 就是装进去的那一格', () => {
  const src = fileURLToPath(new URL('../assets/figure-groove-game', import.meta.url));
  const m = JSON.parse(readFileSync(join(src, 'figure.json'), 'utf8'));
  assert.equal(m.id, FIGURE_PACK_ID, 'figure.json 的 id 和 FIGURE_PACK_ID 对不上，装进去换装页也认不出');
});

test('对局版恢复正常体型：缩放系数为 1 且包围盒、命中圈与避让联动都在', () => {
  const src = readFileSync(new URL('../assets/figure-groove-game/figure.js', import.meta.url), 'utf8');
  const m = src.match(/const BODY_SCALE = ([\d.]+);/);
  assert.ok(m, 'BODY_SCALE 没了');
  const k = Number(m[1]);
  assert.equal(k, 1, `BODY_SCALE=${k}，应为正常体型 1`);
  assert.match(src, /spG\.setAttribute\('transform', SCALE_T\)/, '画布外层没有缩放层');
  assert.match(src, /get extent\(\) \{[\s\S]{0,220}?scalePoint\(EXTENT\)[\s\S]{0,220}?avoidLogo/, 'extent 没跟着缩 / 没跟着避让 —— 包围盒还是原尺寸，她被推开后点不着');
  assert.match(src, /get hits\(\) \{[\s\S]{0,220}?avoidLogo[\s\S]{0,220}?HITS\.map/, 'hits 没跟着缩 / 没跟着避让 —— 点她周围的空气仍然算点她');
});

/* ------------------------------------------------------------------
 * 2026-11-16（第二版）：让开手牌 + 跑跳
 *
 * 官方宿主没有「跨手牌」那一类腾空（`MOVING_MODES` 里没有补丁加过的 `leap`），形象包也改不了
 * 她往哪走。能用的官方口子只有 `figure.json` 的 `moves`：声明在清单里、实现在 `figure.js` 里，
 * **两边缺一边不会报错**——只会 `interrupted`，看着像她不肯动。下面钉住这两边和落点。
 * ------------------------------------------------------------------ */

const FIGURE_DIR = new URL('../assets/figure-groove-game/', import.meta.url);

test('让开手牌：清单里声明的每个目标，figure.js 里都有函数', async () => {
  const m = JSON.parse(readFileSync(new URL('figure.json', FIGURE_DIR), 'utf8'));
  const ids = (m.moves ?? []).map((x) => x.id).sort();
  assert.deepEqual(ids, ['off-hand-left', 'off-hand-right'], 'figure.json 的 moves 变了');
  const { MOVES } = await import(new URL('figure.js', FIGURE_DIR).href);
  for (const id of ids) {
    assert.equal(typeof MOVES[id], 'function', `清单里有 ${id}，figure.js 没实现 —— 调它只回 interrupted`);
  }
  for (const id of Object.keys(MOVES)) {
    assert.ok(ids.includes(id), `figure.js 实现了 ${id}，清单里没声明 —— bot 根本看不到这个目标`);
  }
});

test('让开手牌：落点真的在手牌带外，还留了半个身位', async () => {
  const { MOVES } = await import(new URL('figure.js', FIGURE_DIR).href);
  const HALF = 104;             // 宿主 body.js 的半宽：104 * S
  const S = .42;              // 1080p 全屏、scale 1.0
  for (const W of [1024, 1280, 1920, 2560]) {
    const H = Math.round(W * 9 / 16);
    const b = { W, H, floorY: H, S, minX: HALF * S + 8, maxX: W - HALF * S - 8, minY: 300 };
    const l = MOVES['off-hand-left']({}, b).x;
    const r = MOVES['off-hand-right']({}, b).x;
    // 26% / 74% 是炉石手牌区的实测边界（原来 skipZone 用的同一组数）：身体中心进这段就是压到牌
    assert.ok(l <= W * .26 - HALF * S, `${W} 宽：左边落点 ${Math.round(l)} 还压在手牌上`);
    assert.ok(r >= W * .74 + HALF * S, `${W} 宽：右边落点 ${Math.round(r)} 还压在手牌上`);
    assert.ok(l >= b.minX && r <= b.maxX, `${W} 宽：落点出界了`);
  }
});

test('跑跳：run 时画布外层真的抬起来了', () => {
  const src = readFileSync(new URL('figure.js', FIGURE_DIR), 'utf8');
  assert.match(src, /hopOf\(mode, t\)/, 'draw 里没接跑跳 —— 跑起来还是贴地滑');
  assert.match(src, /256 - 256 \* K - hop/, '抬起来的高度没写进外层 transform');
  assert.match(src, /hopWas = null/, '换层/重置后不重写，跑跳会在新画布上卡住');
});

test('force：同版本也重写一遍（包坏了靠它救）', async () => {
  const data = tmp('force');
  const src = makeSource(tmp('src'), '1.0.0');
  const first = await ensureFigurePack(opts(data, src));
  assert.equal(first.status, 'installed');
  rmSync(join(first.dir, 'figure.js'));                         // 装之后坏掉了一个文件
  const plain = await ensureFigurePack(opts(data, src));        // 普通安装：同版本，什么都不做
  assert.equal(plain.status, 'up-to-date');
  assert.equal(existsSync(join(first.dir, 'figure.js')), false, '普通安装不该动它');
  const forced = await ensureFigurePack({ ...opts(data, src), force: true });
  assert.equal(forced.status, 'installed');
  assert.equal(existsSync(join(first.dir, 'figure.js')), true, 'force 没有把包写回来');
});

test('残料清理：上次装到一半的临时目录不会让宿主看到两个同 id', async () => {
  const data = tmp('stale');
  const src = makeSource(tmp('src'), '1.0.0');
  const root = join(data, 'figures');
  // 上一版装到一半留下的残料（前缀是自家的）
  const stale = join(root, `.${FIGURE_PACK_ID}-install-deadbeef`);
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'figure.json'), JSON.stringify({ manifest: 2, api: 2, id: FIGURE_PACK_ID, version: '0.9.0' }), 'utf8');
  // 别人的目录，不能碰
  const alien = join(root, 'someone-else');
  mkdirSync(alien, { recursive: true });

  const r = await ensureFigurePack(opts(data, src));
  assert.equal(r.status, 'installed');
  assert.equal(existsSync(stale), false, '残料还在，宿主会报「id 已被另一个形象包占用」');
  assert.equal(existsSync(alien), true, '别人的目录被顺手删了');
});

/* ------------------------------------------------------------------
 * 2026-11-16（第三版）：她自己认出站在手牌区，然后画到带子外面去
 *
 * 宿主不让她挪（位移在 `walkTo` 里），她能动的只有「画在哪」。所以三样必须同时偏：
 * 外层 `<g>`、`extent`/`hits`（点哪儿算点她）、`anchors`（气泡锚点），外加宿主那圈阴影。
 * 少一样就是「人挪了、点击没挪」这类看不见的坑。
 * ------------------------------------------------------------------ */

test('自己让开：带外不动，带里推到最近的那条沿', async () => {
  const { avoidShift } = await import(new URL('figure.js', FIGURE_DIR).href);
  const S = .42, halfW = 73.44 * S, W = 1920;
  const minX = 104 * S + 8, maxX = W - 104 * S - 8;
  const l = W * .26 - halfW, r = W * .74 + halfW;
  assert.equal(avoidShift(100, W, halfW, minX, maxX), 0, '屏幕最左边也在躲，判定反了');
  assert.equal(avoidShift(1700, W, halfW, minX, maxX), 0, '屏幕最右边也在躲');
  assert.ok(Math.abs(500 + avoidShift(500, W, halfW, minX, maxX) - l) < .01, '左侧压线没推到左沿');
  assert.ok(Math.abs(1400 + avoidShift(1400, W, halfW, minX, maxX) - r) < .01, '右侧压线没推到右沿');
  const d = avoidShift(960, W, halfW, minX, maxX);   // 正中：哪边近去哪边，一样近取右
  assert.ok(Math.abs(960 + d - l) < .01 || Math.abs(960 + d - r) < .01, '正中没被推出去');
});

test('自己让开：推出去会出可站范围就不挪（别把她甩到屏幕外）', async () => {
  const { avoidShift } = await import(new URL('figure.js', FIGURE_DIR).href);
  const S = .42, halfW = 73.44 * S;
  assert.equal(avoidShift(150, 300, halfW, 104 * S + 8, 300 - 104 * S - 8), 0, '窄屏上还是硬推了');
});

test('自己让开：读得懂宿主写在 petG 上的那个变换', async () => {
  const { stageCenterX } = await import(new URL('figure.js', FIGURE_DIR).href);
  assert.equal(stageCenterX(null), null, '没有 petG 该返回 null，不是 0');
  assert.equal(stageCenterX({ getAttribute: () => null }), null, '没有变换该返回 null');
  const x = stageCenterX({ getAttribute: () => 'translate(960 880) rotate(0) scale(0.42 0.42) translate(-128 -128)' });
  assert.ok(Math.abs(x - 960) < .01, `反推出来是 ${x}，跟宿主给的 960 对不上`);
});

test('自己让开：外层、命中圈、气泡锚点、阴影，四样一起偏', () => {
  const src = readFileSync(new URL('../assets/figure-groove-game/figure.js', import.meta.url), 'utf8');
  assert.match(src, /avoidStep\(petG, dt/, 'draw 里根本没调避让，位置永远不会变');
  assert.match(src, /get anchors\(\) \{[\s\S]{0,260}?avoidLogo/, '气泡锚点没跟着偏 —— 人被推开，气泡还留在原地');
  assert.match(src, /cx \* \(1 - K\) \+ avoidStage/, '阴影没跟着偏 —— 她站在自己影子外面');
  assert.match(src, /hopOf\(mode, t\)[\s\S]{0,30}?\+ avoidLift/, '跃起没接上 —— 让开时会像平移过去，不是跳过去');
  assert.match(src, /avoidPinned[\s\S]{0,160}?visualVx < 25/, '缺少避让钉住停步检测 —— 走到边上停住后脚下会原地空跑');
  assert.match(src, /pinnedK\s*=\s*lerp\(pinnedK,\s*avoidPinned/, '缺少 pinnedK 平滑收脚 —— 停住后腿部与上下颠簸不会停下');
});
