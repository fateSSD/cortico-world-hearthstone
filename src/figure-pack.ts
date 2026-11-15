/**
 * 形象包：随扩展带一份，装到桌宠找得到的地方。
 *
 * ## 为什么形象包要跟着扩展走
 *
 * 「跟着拍子动」那组动作（律动、蹦迪、打拍子、捂耳朵听…）宿主里没有，只能由**形象包**声明：
 * `figure.json` 的 vocab 条目带 `motion`，`figure.js` 的 `gestures` 点名。
 * 宿主 `act()` 碰到不认识的词只 `return false` —— 脸变、人不动、不报错。
 *
 * 而形象包**没有地方发**：扩展市场只收 world / bot / provider 三类包，
 * `catalog.json` 里 355 个包一个 `figure` 都没有，标签词表 29 个也没有形象包这一类。
 * 所以只能跟着扩展走。
 *
 * ## 为什么可以直接写 figures/
 *
 * `ctx.dataDir` 就是部署的 `data` 目录 —— 炉石的 `hearthstone-last-game.json`、
 * 听歌的 `lyrics/` 都写在这一层，桌宠的 `figures/` 也在这一层。市集里做同一件事的包
 * （`cortico-world-figure`）也是按这个位置找的。
 *
 * **边界**：只往 `figures/` 下自己那一格写，不读别人的配置、不碰宿主安装目录。
 * 后者是市集明令禁止的（`cortico-extensions#659` 起，改安装目录直接拉黑，
 * 按路径读安装包会卡认证）。
 *
 * ## 幂等与安全
 *
 * - 按 `figure.json` 的 `version` 判：同版本什么都不做。
 * - 不同版本整目录替换，但**先装到临时目录再换名**：中途断电/退出只会留下一个临时目录，
 *   不会留下半个包（半个包在换装页里的表现是那个形象白图，而且不报错）。
 * - 目录里带 `installed-by.json` 才认作自己装的。用户自己做了一个同 id 的包，
 *   我们不动它 —— 覆盖别人的形象比装不上更糟。
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** 装到 `figures/<这个 id>/`；桌宠按这个 id 在换装页列出来。 */
export const FIGURE_PACK_ID = 'groove';

/** 只有我们装的包才有这个标记文件。 */
const INSTALLER_MARK = 'installed-by.json';

/**
 * 写给人看的位置用正斜杠的相对路径。
 *
 * 灯里挂一个 `C:\...\data\figures\groove` 既长又不好念，而用户实际要对照的正是
 * 「data/figures/」这一层。绝对路径留给日志（排查时才有用）。
 */
const REL_DIR = `data/figures/${FIGURE_PACK_ID}/`;

export interface FigurePackResult {
  status: 'installed' | 'up-to-date' | 'occupied' | 'failed';
  /** 装到了哪里（失败时是想装到哪里）。 */
  dir: string;
  /** 装好的版本；没装成时是 null。 */
  version: string | null;
  /** 一句人话，直接进日志和灯。 */
  message: string;
}

export interface FigurePackOptions {
  /** `ctx.dataDir`。 */
  dataDir: string;
  /** 随包带的那一份（`assets/figure-groove`）。 */
  sourceDir: string;
  /** 记进标记文件：这个包是谁装的。 */
  installer: string;
  log?: { info(message: string): void; warn(message: string): void };
}

/**
 * 桌宠找形象的目录。
 *
 * 正常情况就是 `dataDir/figures`。往上找四层是兜底：万一哪天宿主把 `dataDir` 指到
 * 部署目录里更深的一层（`cortico-world-figure` 就是这么防的），现成的 `figures/` 仍然找得到。
 */
export function figuresRoot(dataDir: string): string {
  let dir = dataDir;
  for (let i = 0; i < 4; i += 1) {
    const candidate = join(dir, 'figures');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dataDir, 'figures');
}

/** 读一个形象包的版本；读不出来返回 null（不是形象包、或者还没装完）。 */
async function readVersion(dir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'figure.json'), 'utf8')) as { version?: unknown; id?: unknown };
    return typeof raw.version === 'string' ? raw.version : null;
  } catch {
    return null;
  }
}

/**
 * 把随包带的形象包装进 `figures/`。
 *
 * 不抛错：失败也是一种结果，调用方拿 `status` 决定说什么。
 * 这里失败不该连累扩展启动 —— 装不上形象包，听歌/陪打照样该能用。
 */
export async function ensureFigurePack(opts: FigurePackOptions): Promise<FigurePackResult> {
  const { dataDir, sourceDir, installer, log } = opts;
  const root = figuresRoot(dataDir);
  const target = join(root, FIGURE_PACK_ID);

  if (!existsSync(join(sourceDir, 'figure.json'))) {
    return {
      status: 'failed',
      dir: target,
      version: null,
      message: `扩展里的形象包不完整（找不到 ${join(sourceDir, 'figure.json')}），没装。`
        + `手动装：把扩展目录里的 assets/figure-groove 拷到 ${REL_DIR}，再去换装页选上它。`,
    };
  }

  const want = await readVersion(sourceDir);

  // 已经装过：同版本就到此为止，不同版本才换。
  const have = existsSync(target) ? await readVersion(target) : null;
  if (have !== null) {
    if (have === want) {
      return {
        status: 'up-to-date',
        dir: target,
        version: have,
        message: `形象包已经是最新的 ${have}（${REL_DIR}）。去换装页确认选的是它，不是原版大肥鱼。`,
      };
    }
    // 目录里有 figure.json 但没有我们的标记 —— 是别人（或用户自己）的包，不动。
    if (!existsSync(join(target, INSTALLER_MARK))) {
      return {
        status: 'occupied',
        dir: target,
        version: have,
        message: `${REL_DIR} 里已经有一个同名形象包（${have}），不是这条扩展装的，没有动它。`
          + '想用带动作的那个，先把这一份挪走，或者去换装页手选现在这个。',
      };
    }
  }

  const nonce = randomBytes(4).toString('hex');
  const pending = join(root, `.${FIGURE_PACK_ID}-install-${nonce}`);
  try {
    await mkdir(root, { recursive: true });
    await cp(sourceDir, pending, { recursive: true });
    await writeFile(
      join(pending, INSTALLER_MARK),
      `${JSON.stringify({ installer, version: want, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    // 先删旧的再换名：Windows 上目录不能原子覆盖。删失败多半是文件被占着。
    if (existsSync(target)) await rm(target, { recursive: true, force: true });
    await rename(pending, target);
  } catch (error) {
    await rm(pending, { recursive: true, force: true }).catch(() => {});
    const why = error instanceof Error ? error.message : String(error);
    const message = /EBUSY|EPERM|EACCES/.test(why)
      ? `装形象包时文件被占着（${why}）。先在换装页把她换成别的形象、或者重启一次 Coopanion 再试。`
      : `装形象包失败：${why}。手动装：把扩展目录里的 assets/figure-groove 拷到 ${REL_DIR}，再去换装页选上它。`;
    log?.warn(message);
    return { status: 'failed', dir: target, version: have, message };
  }

  // 装完回读一次。复制的成功不等于包能用 —— 版本读得出来才算真的装好了。
  const got = await readVersion(target);
  if (got === null) {
    const message = `形象包装进去了但读不回来（${REL_DIR}figure.json），去看一眼那个目录。`;
    log?.warn(`${message}绝对路径：${target}`);
    return { status: 'failed', dir: target, version: null, message };
  }
  const message = `形象包 ${got} 装好了（${REL_DIR}）。去换装页选「DeepSeek 大肥鱼 · 律动版」—— 装和用是两步。`;
  log?.info(`${message}绝对路径：${target}`);
  return { status: 'installed', dir: target, version: got, message };
}
