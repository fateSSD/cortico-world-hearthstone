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
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** 装到 `figures/<这个 id>/`；桌宠按这个 id 在换装页列出来。 */
export const FIGURE_PACK_ID = 'groove-game';

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
  /**
   * `missing` = 还没有，也没装（2026-11-16 加）。
   *
   * 它和 `failed` 分开，是因为面板要做的事不同：`missing` 该给一个「装」的按钮，
   * `failed` 该去看日志。合成一个，按钮上就会写着「再试一次」而不是「去修它」。
   */
  status: 'installed' | 'up-to-date' | 'occupied' | 'missing' | 'failed';
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
  /** 随包带的那一份（`assets/figure-groove-game`）。 */
  sourceDir: string;
  /** 记进标记文件：这个包是谁装的。 */
  installer: string;
  /**
   * 面板按钮是**明确的用户动作**，所以同版本也重写一遍。
   *
   * 没有这个的话「重装」按钮点了什么都不发生（`have === want` 直接返回 `up-to-date`），
   * 而真正需要重装的场合恰恰是「版本一样但包坏了」—— 装到一半断电、用户手动删过文件、
   * 复制时被杀软拦了半个。那时候唯一的自救就是整目录重写。（2026-11-16）
   */
  force?: boolean;
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

/**
 * 清掉上一次装到一半留下的临时目录（`.<id>-install-<nonce>`）。
 *
 * 2026-11-16 实测撞到：`figures/` 里同时存在 `.groove-game-install-3a163c7f`
 * 和 `groove-game/` 时，宿主两个都扫，报 **「id groove-game 已被另一个形象包占用」**，
 * 而 `/api/figures` 里那个包看着还是好的 —— 这种"看起来正常、实际被判冲突"的
 * 状态没人能自己查出来。所以每次装之前先把自家前缀的临时目录收掉。
 *
 * 前缀只认 `.${FIGURE_PACK_ID}-install-`，别人的目录一律不碰。
 */
async function clearStalePending(root: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const prefix = `.${FIGURE_PACK_ID}-install-`;
  await Promise.all(names
    .filter((n) => n.startsWith(prefix))
    .map((n) => rm(join(root, n), { recursive: true, force: true }).catch(() => {})));
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
 * 只看，不装（2026-11-16）。
 *
 * ## 为什么要有这个函数
 *
 * 官方在 `cortico-extensions#659` 里的原话：「请不要在 World 载入时自动安装，
 * 改成在 World 面板上放一个按钮，使用者点了才装，避免出现使用者预期之外的行为。」
 *
 * 所以 `start()` 不再调 `ensureFigurePack` —— **World 载入这一步一步盘都不写**。
 * 启动只调这里，把「装没装、是不是别人的、版本旧没旧」看清楚，一五一十写进灯里。
 *
 * 判据与 `ensureFigurePack` 逐条对齐，唯一差别在「该装而没装」那一支：
 * 那边动手，这边返回 `missing` 并告诉用户按钮在哪。
 */
export async function inspectFigurePack(opts: {
  dataDir: string;
  sourceDir: string;
}): Promise<FigurePackResult> {
  const { dataDir, sourceDir } = opts;
  const root = figuresRoot(dataDir);
  const target = join(root, FIGURE_PACK_ID);

  if (!existsSync(join(sourceDir, 'figure.json'))) {
    return {
      status: 'failed',
      dir: target,
      version: null,
      message: `扩展里的形象包不完整（找不到 ${join(sourceDir, 'figure.json')}），装不了。这不是能用按钮解决的问题，得重装扩展。`,
    };
  }

  const want = await readVersion(sourceDir);
  const have = existsSync(target) ? await readVersion(target) : null;

  if (have === null) {
    return {
      status: 'missing',
      dir: target,
      version: null,
      message: `形象包还没装（${REL_DIR}）。要那组跟着拍子的动作，点下面的按钮装；装完还得去换装页把它选上 —— 装好和用上是两步。`,
    };
  }
  if (have === want) {
    return {
      status: 'up-to-date',
      dir: target,
      version: have,
      message: `形象包已经是最新的 ${have}（${REL_DIR}）。去换装页把她选成「DeepSeek 大肥鱼 · 对局版」—— 选错等于没装。`,
    };
  }
  if (!existsSync(join(target, INSTALLER_MARK))) {
    return {
      status: 'occupied',
      dir: target,
      version: have,
      message: `${REL_DIR} 里已经有一个同名形象包（${have}），不是这条扩展装的，不会动它。要换成本包带的，自己把那一份挪走再点按钮。`,
    };
  }
  return {
    status: 'missing',
    dir: target,
    version: have,
    message: `形象包的版本旧了（装着 ${have}，包里带 ${want ?? '未知'}）。点下面的按钮换成新的。`,
  };
}

/**
 * 把随包带的形象包装进 `figures/`。
 *
 * 不抛错：失败也是一种结果，调用方拿 `status` 决定说什么。
 * 这里失败不该连累扩展启动 —— 装不上形象包，听歌/陪打照样该能用。
 *
 * **只在面板按钮里调**（2026-11-16 起）—— 别在 `start()` 里调。
 */
export async function ensureFigurePack(opts: FigurePackOptions): Promise<FigurePackResult> {
  const { dataDir, sourceDir, installer, log, force } = opts;
  const root = figuresRoot(dataDir);
  const target = join(root, FIGURE_PACK_ID);

  if (!existsSync(join(sourceDir, 'figure.json'))) {
    return {
      status: 'failed',
      dir: target,
      version: null,
      message: `扩展里的形象包不完整（找不到 ${join(sourceDir, 'figure.json')}），没装。`
        + `手动装：把扩展目录里的 assets/figure-groove-game 拷到 ${REL_DIR}，再去换装页选上它。`,
    };
  }

  const want = await readVersion(sourceDir);

  // 已经装过：同版本就到此为止，不同版本才换。
  const have = existsSync(target) ? await readVersion(target) : null;
  if (have !== null) {
    if (have === want && !force) {
      return {
        status: 'up-to-date',
        dir: target,
        version: have,
        message: `形象包已经是最新的 ${have}（${REL_DIR}）。去换装页把她选成「DeepSeek 大肥鱼 · 对局版」—— 选错等于没装。`,
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
    // 上一次装到一半的残料先收掉：留着会让宿主看到两个同 id 的包（见 clearStalePending）
    await clearStalePending(root);
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
      : `装形象包失败：${why}。手动装：把扩展目录里的 assets/figure-groove-game 拷到 ${REL_DIR}，再去换装页选上它。`;
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
  const message = `形象包 ${got} 装好了（${REL_DIR}）。去换装页选「DeepSeek 大肥鱼 · 对局版」—— 装和用是两步。`;
  log?.info(`${message}绝对路径：${target}`);
  return { status: 'installed', dir: target, version: got, message };
}
