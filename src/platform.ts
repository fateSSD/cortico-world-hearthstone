/**
 * 平台差异集中在这里。
 *
 * 上游 0.4.2 是 Windows-only 的：默认安装目录是 `C:\Program Files (x86)\Hearthstone`、
 * 日志配置在 `%LOCALAPPDATA%`、播放器进程靠 `tasklist` 看、宿主桌宠包在
 * `…\resources\app\node_modules\cortico-world-desktop-pet`。这些位置在 macOS 上全都不一样。
 *
 * 这里只做三件事，别的什么都不碰：
 *
 * 1. **把平台判断收成一层函数。** 其它模块不许再自己写 `process.platform === ...`，
 *    改平台就改这一个文件。
 * 2. **平台参数可注入。** 每个函数第一个参数默认 `process.platform`，路径按「传入的平台」
 *    用 `path.win32` / `path.posix` 拼，**不按跑测试的机器**拼 —— 所以同一份断言能在 mac 上
 *    验 Windows 的路径序列。
 * 3. **只依赖 node 内置。** 不 import `cortico/*`（宿主才有的裸模块名），
 *    这样 `node src/platform.ts` 这种直跑（Node 24 原生 strip types）能解析成功，
 *    平台逻辑可以脱离宿主单独测。
 *
 * ## 证据与待验证项
 *
 * - **Windows 一栏是上游 0.4.2 的原文**，一个字节都没改：默认 5 条安装目录、
 *   `%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`、`tasklist /NH /FO CSV` 的进程口径、
 *   宿主包候选序列。Windows 行为等价是硬要求，改这里之前先看平台断言的期望序列。
 * - **macOS 的 log.config 路径已真机验证**（2026-11-12 真机验证：Mac / Coopani 0.2.16 / 炉石 37.0.0.0）：
 *   就是 `~/Library/Preferences/Blizzard/Hearthstone/log.config`，炉石确实读它 ——
 *   扩展真机启动时已经实际写入成功（A/B 对照：偏好目录那份生效，安装目录那份不生效）。
 *   设置页 `worlds.hearthstone.logPath` 的覆盖机制仍然保留（换机器/换路径时能自救）。
 * - **macOS 的 client.config 只在安装目录**（`/Applications/Hearthstone/client.config`），
 *   已由四轮 A/B 真机矩阵证明（2026-11-12：Mac / Coopani 0.2.16 / 炉石 37.0.0.0）：偏好目录那份**不被读取** ——
 *   放进偏好目录，炉石的 `Failed to load config file` 依旧出现；放回安装目录才消失。
 *   所以 macOS 的候选**只有安装目录一条**（`installDir` 为空时回落 `/Applications/Hearthstone`）。
 */
import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * 平台标识。
 *
 * 只分三档处理：`win32` 走上游原逻辑，`darwin` 走 mac 分支，其余（linux 等）按 POSIX 兜底
 * 但默认安装目录为空 —— 没在那些平台上验证过，不假装支持。
 */
export type Platform = 'win32' | 'darwin' | (string & {});

/** 平台参数注入点：默认全取当前进程，测试时可整组替换。 */
export interface PlatformContext {
  platform?: Platform;
  home?: string;
  execPath?: string;
  env?: Record<string, string | undefined>;
}

/** 宿主桌宠包名。宿主补丁与宿主包定位都要用它。 */
const PET_PKG = 'cortico-world-desktop-pet';

/** 取该平台对应的 path 实现：按「传入的平台」拼，不按跑代码的机器。 */
const pathOf = (platform: Platform) => (platform === 'win32' ? win32 : posix);

/** Windows 上游默认的 5 条安装目录，原样保留。 */
const WIN_INSTALL_DIRS: readonly string[] = [
  'C:\\Program Files (x86)\\Hearthstone',
  'C:\\Program Files\\Hearthstone',
  'D:\\Hearthstone',
  'D:\\Program Files (x86)\\Hearthstone',
  'E:\\Hearthstone',
];

/**
 * 找不到日志时的默认安装位置。
 *
 * - win32：上游那 5 条，逐字节不变。
 * - darwin：炉石在 mac 上装成 `/Applications/Hearthstone`（`Hearthstone.app` 与 `Logs/`
 *   都在这个目录下），用户目录安装的再补一条 `~/Applications/Hearthstone`。
 */
export function defaultInstallDirs(platform: Platform = process.platform, home: string = homedir()): string[] {
  if (platform === 'win32') return [...WIN_INSTALL_DIRS];
  if (platform === 'darwin') {
    const P = pathOf(platform);
    return [
      '/Applications/Hearthstone',
      P.join(home, 'Applications', 'Hearthstone'),
    ];
  }
  return [];
}

/**
 * 炉石的日志配置（`log.config`）位置。和游戏安装目录无关，在用户目录。
 *
 * - win32：`%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`（上游原逻辑，含
 *   `LOCALAPPDATA` 缺失时回落 `~/AppData/Local`）。
 * - darwin：`~/Library/Preferences/Blizzard/Hearthstone/log.config` —— **已真机验证**
 *   （2026-11-12 真机验证：Mac / Coopani 0.2.16 / 炉石 37.0.0.0）：扩展在真机启动时已经把 `[Power]` 段写进这个文件并生效。
 *   设置页的 `logPath` 仍然能覆盖（`resolvePowerLog` 优先取手动路径），换路径时能自救。
 */
export function logConfigPath(
  platform: Platform = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string {
  const P = pathOf(platform);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? P.join(home, 'AppData', 'Local');
    return P.join(local, 'Blizzard', 'Hearthstone', 'log.config');
  }
  return P.join(home, 'Library', 'Preferences', 'Blizzard', 'Hearthstone', 'log.config');
}

/**
 * `client.config` 的候选路径。
 *
 * `client.config` 是炉石自己的配置（日志 10MB 上限 `[Log] FileSizeLimit.Int` 写在里面）。
 * **两个平台都只有安装目录一条**：
 *
 * - win32：上游原逻辑，`安装目录/client.config`。
 * - darwin：`/Applications/Hearthstone/client.config`。这里曾经放过「偏好目录优先」的推断，
 *   2026-11-12 四轮 A/B 真机矩阵把它推翻了（Mac / Coopani 0.2.16 / 炉石 37.0.0.0）：
 *   偏好目录那份**炉石根本不读**（放进去 `Failed to load config file` 照旧出现，放回安装目录才消失）。
 *   所以候选只留安装目录；`installDir` 为空（没定位到日志）时回落 `/Applications/Hearthstone`。
 *
 * `home` 参数保留在签名里（调用方与测试统一传），当前两个平台都只用安装目录。
 */
export function clientConfigCandidates(
  installDir: string,
  platform: Platform = process.platform,
  home: string = homedir(),
): string[] {
  const P = pathOf(platform);
  if (platform === 'win32') return [P.join(installDir, 'client.config')];
  if (platform === 'darwin') {
    const dir = installDir.trim() ? installDir : '/Applications/Hearthstone';
    return [P.join(dir, 'client.config')];
  }
  return installDir.trim() ? [P.join(installDir, 'client.config')] : [];
}

/** 宿主包候选的注入上下文。 */
export interface HostPackContext {
  execPath?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

/**
 * 宿主桌宠包目录的候选，按可信度排序：环境变量 → 从运行程序逐级往上找 → 常见安装位置。
 *
 * 不只靠 `dirname(process.execPath)`：实测这个值会变。用 `tsx` 手动跑脚本时它指向 node，
 * 真实 core 进程里才是 Coopani 自己的路径。所以从 execPath 往上逐级都试。
 *
 * - win32：候选序列与上游 0.4.2 **逐字节一致**（`<dir>\resources\app\node_modules\<包>`
 *   → `<dir>\node_modules\<包>` 逐级上溯 → `E:/D:/C:/Coopanion` 与 `~/Coopanion`、`~/Desktop/Coopanion`）。
 * - darwin：Coopani 是 mac 应用包，真实路径在
 *   `/Applications/Coopanion.app/Contents/Resources/app/node_modules/cortico-world-desktop-pet`。
 *   Electron 的 `process.execPath` 是 `…/Coopanion.app/Contents/MacOS/Coopanion`，
 *   从它上溯两级到 `…/Contents` 就拼得出 `Contents/Resources/app/...`，所以逐级上溯时
 *   **同时试 `Resources`（mac 大小写）与 `resources`（上游大小写）**，再加上两个应用目录。
 *   （APFS 默认大小写不敏感，但外接盘可能是敏感的，两个都试一遍最省事。）
 */
export function hostPackCandidates(platform: Platform = process.platform, ctx: HostPackContext = {}): string[] {
  const P = pathOf(platform);
  const execPath = ctx.execPath ?? process.execPath;
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? homedir();

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    if (!raw) return;
    const r = P.resolve(raw);
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  };

  const fromEnv = (env.COOPANION_PACK ?? '').trim();
  if (fromEnv) push(fromEnv);

  let dir = P.dirname(execPath);
  for (let i = 0; i < 8; i += 1) {
    if (platform === 'darwin') {
      push(P.join(dir, 'Resources', 'app', 'node_modules', PET_PKG));
      push(P.join(dir, 'resources', 'app', 'node_modules', PET_PKG));
    } else {
      push(P.join(dir, 'resources', 'app', 'node_modules', PET_PKG));
    }
    push(P.join(dir, 'node_modules', PET_PKG));
    const up = P.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  if (platform === 'win32') {
    for (const root of [
      'E:/Coopanion',
      'D:/Coopanion',
      'C:/Coopanion',
      P.join(home, 'Coopanion'),
      P.join(home, 'Desktop', 'Coopanion'),
    ]) {
      push(P.join(root, 'resources', 'app', 'node_modules', PET_PKG));
    }
  } else if (platform === 'darwin') {
    for (const app of ['/Applications/Coopanion.app', P.join(home, 'Applications', 'Coopanion.app')]) {
      push(P.join(app, 'Contents', 'Resources', 'app', 'node_modules', PET_PKG));
      push(P.join(app, 'Resources', 'app', 'node_modules', PET_PKG));
    }
  }
  return out;
}

/**
 * 「听歌时让路」要看哪些进程。
 *
 * - win32：上游口径，带 `.exe`（`tasklist /FO CSV` 的输出里就是带后缀的）。
 * - darwin：`ps -Ao comm=` 给的是可执行文件的完整路径，末段是不带后缀的进程名。
 *   这两个名字**还没在真机验证过**（本机没装这两个播放器）—— 名字对不上时表现为
 *   「听歌时不安静」，不会误伤别处，所以按名字匹配就够，别去按 bundle id。
 */
export function peerProcessNames(platform: Platform = process.platform): string[] {
  return platform === 'win32' ? ['QQMusic.exe', 'cloudmusic.exe'] : ['QQMusic', 'NeteaseMusic'];
}

/** 列进程要跑什么命令。win32 是 `tasklist`，其它平台是系统自带的 `/bin/ps`。 */
export function peerProbeCommand(platform: Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'tasklist', args: ['/NH', '/FO', 'CSV'] };
  return { command: '/bin/ps', args: ['-Ao', 'comm='] };
}

/**
 * 在进程列表输出里找名单里的进程。
 *
 * - win32：`tasklist /FO CSV` 一行一个进程，形如 `"QQMusic.exe","1234","Console",...`，
 *   所以按**带引号的名字**匹配（防止 `foo.exe` 里命中 `oo.exe` 这类子串）。逐字节沿用上游逻辑。
 * - darwin：`ps -Ao comm=` 每行一个完整路径，取末段比。同时容忍 `X.app` 与
 *   `X Helper` 这类派生进程名。
 */
export function matchesPeerNames(stdout: string, names: readonly string[], platform: Platform = process.platform): boolean {
  if (platform === 'win32') {
    const lower = stdout.toLowerCase();
    return names.some((name) => lower.includes(`"${name.toLowerCase()}"`));
  }
  const wanted = names.map((n) => n.toLowerCase());
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .some((line) => {
      const base = line.slice(line.lastIndexOf('/') + 1);
      return wanted.some((w) => base === w || base === `${w}.app` || base.startsWith(`${w} `));
    });
}

/** 宿主补丁可不可打。 */
export interface HostPatchMode {
  ok: boolean;
  /** 不能打的原因（给日志和 `hearthstone.setup` 文案用）。 */
  reason?: string;
}

/**
 * 宿主补丁在这台机器上打不打得成。
 *
 * - win32：上游没有预检（直接读改写，失败由 `patchHost` 的 try/catch 兜），保持原样。
 * - darwin：Coopani.app 是 adhoc 签名、正常是属主可写，**允许打**（改的是包内文件，
 *   不会触发 Gatekeeper 重新校验 —— 但要让使用者知道改的是应用包里面，所以配
 *   `hostPatchNote()` 一起用）。目标不可写时返回明确原因，让上层按降级处理而不是报异常。
 */
export function hostPatchMode(
  platform: Platform = process.platform,
  packDir?: string | null,
): HostPatchMode {
  if (platform === 'win32') return { ok: true };
  if (!packDir) {
    return { ok: false, reason: '找不到宿主桌宠包（Coopani.app 不在常见位置）—— 手牌禁行带那几套补丁打不上' };
  }
  try {
    accessSync(packDir, fsConstants.W_OK);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `Coopani.app 包内文件不可写（${packDir}）：${detail} —— 扩展不能越过权限改宿主，动作补丁按降级跳过`,
    };
  }
  return { ok: true };
}

/**
 * 「改的是哪儿」的补充说明。
 *
 * Windows 上宿主就装在普通目录里，不用解释；macOS 上改的是 `Coopani.app` **包内的文件**，
 * 不说清楚使用者会以为是改了他自己的东西，或者以为是扩展装坏了。
 */
export function hostPatchNote(platform: Platform = process.platform): string {
  if (platform === 'win32') return '';
  return '（改的是 Coopani.app 包内文件。）';
}

/**
 * 「没找到 Power.log」时给使用者的一句怎么开日志。
 *
 * 路径按平台说：Windows 是 `%LOCALAPPDATA%\...`，mac 是 `~/Library/Preferences/...`。
 */
export function logSetupHint(platform: Platform = process.platform, home: string = homedir()): string {
  if (platform === 'win32') {
    return '要让她看得到,得先打开炉石的日志:在 %LOCALAPPDATA%\\Blizzard\\Hearthstone\\log.config 里写 [Power] 段(LogLevel=1、FilePrinting=true),然后重启炉石。装到别的盘的话,在设置里填一下「炉石安装目录」。';
  }
  return `要让她看得到,得先打开炉石的日志:在 ${logConfigPath(platform, home)} 里写 [Power] 段(LogLevel=1、FilePrinting=true),然后重启炉石。装在别的位置的话,在设置里填一下「炉石安装目录」。`;
}
