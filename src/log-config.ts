/**
 * 炉石自己的日志大小上限。
 *
 * `Power.log` 到 10MB 就停笔（实测：打印 `Truncating log, which has reached the size limit
 * of 10000KB` 之后彻底不再写，那行后面只剩一个结束分隔线）。一份日志大概能装 4 局 ——
 * 打到第 3、4 局就断供，之后整局数据全丢，唯一恢复是重启炉石。
 *
 * **但这个上限是炉石自己的一个配置项**，就在安装目录的 `client.config`：
 *
 *     [Log]
 *     FileSizeLimit.Int=-1
 *
 * `-1` 是它自己的「无限制」。记牌器（HDT、Firestone）都会写这个键，所以它们从不撞这个问题。
 *
 * 两条弯路，都踩过：
 *
 *   1. **从外部把文件裁短,不行。** 炉石以独占方式打开日志(不共享写),我们连
 *      `open(path, 'r+b')` 都拿不到 —— 实测 `Permission denied`。它只在启动那一刻建新会话目录,
 *      整个会话期间句柄都不放。
 *   2. **就算能裁,也会裁出空洞。** 炉石记着自己的写偏移,文件变短之后它下一次写会定位回原位置,
 *      中间那段变成 0 字节。社区实测:报告大小 6.7MB、实际只分配 20KB,日志看着正常但里面有洞。
 *
 * 所以唯一的正解是在它启动之前把上限关掉 —— 代价只是最后重启一次炉石。
 *
 * ## macOS
 *
 * mac 上 `client.config` **只在安装目录**（`/Applications/Hearthstone/client.config`），
 * 2026-11-12 四轮 A/B 真机矩阵证明偏好目录那份不被读取（Mac / Coopani 0.2.16 / 炉石 37.0.0.0）。
 * 所以路径还是「安装目录/client.config」，与 Windows 同构；`installDir` 没定位到时回落
 * `/Applications/Hearthstone`。改的仍然是炉石自己的配置文件，备份与「临时文件 + 改名」
 * 那套谨慎标准原样保留。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';

import { clientConfigCandidates, logConfigPath as platformLogConfigPath, type Platform } from './platform.ts';

/** 炉石默认的日志上限（KB）。 */
const DEFAULT_LIMIT_KB = 10000;

export interface LogLimitResult {
  /** 炉石的安装目录（client.config 所在的目录）。 */
  installDir: string;
  /** 配置文件路径。 */
  configPath: string;
  /** 改之前的值。null 表示文件里根本没写这一项。 */
  before: number | null;
  /** 现在是不是已经被关掉了上限。 */
  unlimited: boolean;
  /** 这次有没有真的改文件。 */
  changed: boolean;
  /** 没改成功的原因（权限之类）。 */
  problem?: string;
  /** 已经存在的备份文件路径。 */
  backup?: string;
}

/**
 * 从 Power.log 的路径反推安装目录。
 *
 * 路径长这样: `<安装目录>\Logs\Hearthstone_2025_01_01_00_00_00\Power.log`
 * 老版本直接 `<安装目录>\Logs\Power.log`。两种都往上找那个叫 Logs 的目录。
 */
export function installDirFromLog(logPath: string): string | null {
  let dir = dirname(logPath);
  for (let i = 0; i < 8; i += 1) {
    if (basename(dir).toLowerCase() === 'logs') return dirname(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * 读配置里的上限。
 *
 * 返回 `null` = 文件里没这一项（炉石会用默认的 10000KB）。
 * 两种写法都认：`[Log]` 段下的 `FileSizeLimit.Int`，以及扁平写法 `Log.FileSizeLimit.Int`。
 */
export function readLogSizeLimit(configPath: string): number | null {
  const text = readText(configPath);
  if (text === null) return null;
  return parseLimit(text);
}

function parseLimit(text: string): number | null {
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    const hit = (section === 'log' && key === 'filesizelimit.int') || key === 'log.filesizelimit.int';
    if (!hit) continue;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readText(configPath: string): string | null {
  try {
    if (!existsSync(configPath)) return null;
    // latin1:逐字节保真,不碰原文件里可能存在的非 ASCII 内容
    return readFileSync(configPath).toString('latin1');
  } catch {
    return null;
  }
}

interface Patched {
  text: string;
  before: number | null;
  /** 已经是无限制了，不用写。 */
  already: boolean;
}

/**
 * 在文本里改这一项，其余一个字节都不动。
 *
 * 三种情况：已有这一项 → 改值；有 `[Log]` 段没这一项 → 插在段内；连段都没有 → 末尾追加。
 */
export function patchLogLimit(text: string): Patched {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const before = parseLimit(text);
  if (before === -1) return { text, before, already: true };

  let section = '';
  let logSectionAt = -1;
  let lastInLog = -1;
  let targetAt = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      if (section === 'log') logSectionAt = i;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (section === 'log') lastInLog = i;
    const hit = (section === 'log' && key === 'filesizelimit.int') || key === 'log.filesizelimit.int';
    if (hit) targetAt = i;
  }

  if (targetAt >= 0) {
    // 保留原来的键格式（段形式还是扁平形式），只把值换掉
    lines[targetAt] = lines[targetAt].replace(/=\s*.*$/, '=-1');
    return { text: lines.join(eol), before, already: false };
  }

  if (logSectionAt >= 0) {
    const at = (lastInLog >= 0 ? lastInLog : logSectionAt) + 1;
    lines.splice(at, 0, 'FileSizeLimit.Int=-1');
    return { text: lines.join(eol), before, already: false };
  }

  // 没有 [Log] 段：追加。前面留一个空行，避免和上一段粘在一起。
  const tail = text.length && !text.endsWith('\n') ? eol : '';
  return { text: `${text}${tail}${text.length ? eol : ''}[Log]${eol}FileSizeLimit.Int=-1${eol}`, before, already: false };
}

/**
 * 把上限关掉（-1）。返回改了什么、为什么没改。
 *
 * 会先在旁边留一份 `client.config.bak`（只留第一次的那份，不覆盖）——
 * 配置文件是炉石的东西，改它之前得能退回去。
 */
export function ensureLogSizeUnlimited(
  installDir: string,
  opts: { platform?: Platform; home?: string } = {},
): LogLimitResult {
  const platform = opts.platform ?? process.platform;
  // 两个平台都只有安装目录一条（Windows 与上游逐字节一致；mac 的偏好目录经真机 A/B 证明不被读取）。
  // 这里仍保留「已存在的优先、没有就建第一条」的写法：将来万一多一条候选，不用改这段。
  const candidates = clientConfigCandidates(installDir, platform, opts.home);
  const configPath = candidates.find((p) => existsSync(p)) ?? candidates[0];
  const base: LogLimitResult = {
    installDir,
    configPath,
    before: null,
    unlimited: false,
    changed: false,
  };

  const text = readText(configPath);
  if (text === null && existsSync(configPath)) {
    return { ...base, problem: 'client.config 读不出来（权限或格式）' };
  }

  const patched = patchLogLimit(text ?? '');
  if (patched.already) return { ...base, before: patched.before, unlimited: true };

  // 备份：只在第一次改之前留
  let backup: string | undefined;
  if (text !== null) {
    const bak = `${configPath}.bak`;
    if (!existsSync(bak)) {
      try {
        copyFileSync(configPath, bak);
        backup = bak;
      } catch {
        // 备份失败就别改 —— 没有退路的事不做
        return { ...base, before: patched.before, problem: '备份 client.config 失败，没敢改' };
      }
    } else {
      backup = bak;
    }
  }

  try {
    if (text === null) {
      // 原本不存在：先写临时文件再改名，避免半截文件被炉石读到。
      // 目录也缺时先建出来（mac 的偏好目录可能整条不存在；Windows 上安装目录本来就在，
      // recursive mkdir 对已存在目录是空操作，行为不变）。
      mkdirSync(dirname(configPath), { recursive: true });
      const tmp = `${configPath}.tmp`;
      writeFileSync(tmp, patched.text, 'latin1');
      renameSync(tmp, configPath);
    } else {
      writeFileSync(configPath, patched.text, 'latin1');
    }
  } catch (error) {
    return {
      ...base,
      before: patched.before,
      backup,
      problem: `写不进去（${(error as Error).message}）—— 那个目录没有写权限`,
    };
  }

  return {
    ...base,
    before: patched.before,
    unlimited: true,
    changed: true,
    backup,
  };
}

/** 供诊断文案用：一句人话。 */
export function describeLimit(before: number | null): string {
  if (before === null) return `没设过（炉石按默认 ${DEFAULT_LIMIT_KB}KB 算）`;
  if (before === -1) return '已经关掉上限';
  return `${before}KB`;
}

/* ------------------------------------------------------------------ */
/* 另一件事：让炉石真的往 Power.log 里写对局数据                       */
/* ------------------------------------------------------------------ */

/**
 * 炉石的 Power 日志默认是**关的**。
 *
 * `Power.log` 文件会存在（炉石启动时自己建），但里面只有错误行 —— 新机器上实测是
 * 6 行 `SubSpellController ... Failed to load spell prefab`，`CREATE_GAME` 一次都没有。
 * 开关在**用户目录**，不在安装目录（`logConfigPath()` 按平台给具体位置）：
 *
 *     Windows: %LOCALAPPDATA%\Blizzard\Hearthstone\log.config
 *     macOS:   ~/Library/Preferences/Blizzard/Hearthstone/log.config（已真机验证）
 *     [Power]
 *     LogLevel=1
 *     FilePrinting=true
 *
 * 没有这个文件就不写 GameState，扩展读到的永远是个空壳。
 *
 * 更麻烦的是它**不报错**：文件在、能读、能监听，就是没有内容。用户看到的是「她一句话不说」，
 * 而不是「日志没开」。所以这层自己补上 —— 装完即用，不能让用户去翻 ini。
 *
 * 只动 `[Power]` 这一段，别的段一个字节都不碰；编码走 latin1 逐字节保真。
 */
export interface PowerLogResult {
  configPath: string;
  /** 动手之前这个文件存在吗。 */
  existed: boolean;
  /** 动手之前的状态。 */
  before: 'ok' | 'incomplete' | 'absent';
  /** 这次有没有真的写文件。 */
  changed: boolean;
  /** 没改成功的原因。 */
  problem?: string;
  backup?: string;
}

/**
 * 炉石日志配置的位置（用户目录，与安装目录无关）。
 *
 * 平台差异在 `platform.ts`：Windows 是 `%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`，
 * macOS 是 `~/Library/Preferences/Blizzard/Hearthstone/log.config`（**已真机验证**，2026-11-12：
 * Mac / Coopani 0.2.16 / 炉石 37.0.0.0；扩展真机启动时已实际写入生效）。设置页的 `logPath` 仍能覆盖。
 */
export function logConfigPath(platform: Platform = process.platform, home: string = homedir()): string {
  return platformLogConfigPath(platform, home);
}

/** `[Power]` 段里这两项齐了，炉石才把对局写进文件。 */
const POWER_WANT: ReadonlyArray<readonly [string, string]> = [
  ['LogLevel', '1'],
  ['FilePrinting', 'true'],
];

/** 读一遍配置，判断 `[Power]` 段够不够用。 */
export function powerLoggingState(text: string): 'ok' | 'incomplete' {
  const seen = new Map<string, string>();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || section !== 'power') continue;
    seen.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim().toLowerCase());
  }
  return POWER_WANT.every(([k, v]) => seen.get(k.toLowerCase()) === v) ? 'ok' : 'incomplete';
}

/**
 * 把 `[Power]` 段补成能用的样子，其余原样：
 * 已有的键只改值，缺的键插在该段末尾，整段都没有就在文件末尾补一段。
 */
export function patchPowerLogging(text: string): { text: string; changed: boolean } {
  if (powerLoggingState(text) === 'ok') return { text, changed: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];

  let section = '';
  let powerAt = -1;
  let lastInPower = -1;
  const have = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      if (section === 'power') powerAt = i;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || section !== 'power') continue;
    lastInPower = i;
    const key = line.slice(0, eq).trim().toLowerCase();
    const want = POWER_WANT.find(([k]) => k.toLowerCase() === key);
    if (!want) continue;
    have.add(key);
    if (line.slice(eq + 1).trim().toLowerCase() !== want[1]) {
      lines[i] = `${lines[i].slice(0, eq)}=${want[1]}`;
    }
  }

  const missing = POWER_WANT.filter(([k]) => !have.has(k.toLowerCase()));
  if (powerAt >= 0) {
    const at = (lastInPower >= 0 ? lastInPower : powerAt) + 1;
    lines.splice(at, 0, ...missing.map(([k, v]) => `${k}=${v}`));
    return { text: lines.join(eol), changed: true };
  }

  const block = ['[Power]', ...POWER_WANT.map(([k, v]) => `${k}=${v}`)];
  const tail = text.length && !text.endsWith('\n') ? eol : '';
  const gap = text.length ? eol : '';
  return { text: `${text}${tail}${gap}${block.join(eol)}${eol}`, changed: true };
}

/**
 * 确保炉石会把对局写进 `Power.log`。
 *
 * 与 `ensureLogSizeUnlimited` 同一套谨慎标准：先备份，写的时候先临时文件再改名 ——
 * 免得炉石正好启动读到半截配置（半截 ini 会让它整段忽略，等于没开）。
 */
export function ensurePowerLogging(configPath = logConfigPath()): PowerLogResult {
  const existed = existsSync(configPath);
  const text = readText(configPath);
  const base: PowerLogResult = {
    configPath,
    existed,
    before: text === null ? 'absent' : powerLoggingState(text),
    changed: false,
  };
  if (text === null && existed) return { ...base, problem: 'log.config 读不出来（权限或格式）' };

  const patched = patchPowerLogging(text ?? '');
  if (!patched.changed) return base;

  let backup: string | undefined;
  if (text !== null) {
    const bak = `${configPath}.bak`;
    if (!existsSync(bak)) {
      try {
        copyFileSync(configPath, bak);
        backup = bak;
      } catch {
        return { ...base, problem: '备份 log.config 失败，没敢改' };
      }
    } else {
      backup = bak;
    }
  }

  try {
    const tmp = `${configPath}.tmp`;
    writeFileSync(tmp, patched.text, 'latin1');
    renameSync(tmp, configPath);
  } catch (error) {
    return { ...base, backup, problem: `写不进去（${(error as Error).message}）` };
  }

  return { ...base, changed: true, backup };
}

/** 供诊断文案用：一句话交代日志开没开。 */
export function describePowerLogging(result: PowerLogResult): string {
  if (result.problem) return `开不起来：${result.problem}`;
  if (result.changed) {
    return result.before === 'absent'
      ? '之前没有 log.config，已建好（重启炉石后生效）'
      : '之前 [Power] 段不全，已补齐（重启炉石后生效）';
  }
  return 'Power 日志已开着';
}
