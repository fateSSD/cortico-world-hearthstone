/**
 * 找到炉石正在写的 Power.log,并按增量读出新行。
 *
 * 炉石 2024 之后把日志改成「每次启动一个会话子目录」:
 *   <安装目录>/Logs/Hearthstone_YYYY_MM_DD_HH_MM_SS/Power.log
 * 老版本直接写在 <安装目录>/Logs/Power.log。两种都要认,所以这里递归找、取最新。
 * 用轮询而不是 fs.watch:炉石的写盘方式不固定,轮询在两边都可靠,几百毫秒的延迟对陪打没有影响。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULT_INSTALL_DIRS } from './config.ts';

const LOG_NAME = 'Power.log';
/** 目录递归深度:Logs/Hearthstone_xxx/Power.log 只要两层。 */
const MAX_DEPTH = 3;
/**
 * 多久重新扫一次目录找日志。
 *
 * 定位要走递归扫(安装目录下每个会话目录都 stat 一遍),实测 2.4ms —— 每 400ms 轮询都做一次
 * 就是白白占着事件循环,而且 `Logs` 只增不减(日志上限已关掉,每次重启炉石都多一个目录),
 * 会越扫越慢。日志文件只在重启炉石时才换,15 秒一次足够。
 */
const RESCAN_MS = 15_000;

/** 首次打开时最多回看的字节数,用来找最后一局的起点。 */
const BACKFILL_BYTES = 2 * 1024 * 1024;

type Ctx = { logPath: string; installDir: string };

interface Candidate {
  path: string;
  mtimeMs: number;
  size: number;
}

/** 在目录里找 Power.log,只往下看几层。 */
function scan(dir: string, depth: number, out: Candidate[]): void {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.toLowerCase() === LOG_NAME.toLowerCase()) {
      try {
        const st = statSync(full);
        out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // 文件在扫描途中消失,忽略
      }
    }
  }
}

/**
 * 定位当前该读的那份日志。
 * 优先用配置里的绝对路径;否则在安装目录(配置的,或常见位置)的 Logs 下取修改时间最新的。
 */
export function resolvePowerLog(ctx: Ctx): { path: string; why: string } | null {
  const manual = ctx.logPath.trim();
  if (manual) {
    const abs = isAbsolute(manual) ? manual : resolve(manual);
    return existsSync(abs) ? { path: abs, why: '配置指定的路径' } : null;
  }

  const roots = [
    ...(ctx.installDir.trim() ? [ctx.installDir.trim()] : []),
    ...DEFAULT_INSTALL_DIRS,
  ];
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const root of roots) {
    const logs = join(root, 'Logs');
    const key = logs.toLowerCase();
    if (seen.has(key) || !existsSync(logs)) continue;
    seen.add(key);
    scan(logs, 0, candidates);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const best = candidates[0];
  return { path: best.path, why: `安装目录下最新的日志(${candidates.length} 份候选)` };
}

/**
 * 初次打开时从哪个字节开始读。
 *
 * 踩过的错:一开始从文件末尾往回找 CREATE_GAME,想「只读最后一局」。结果最后一局的开局在文件
 * 开头、不在最后 2MB 里,搜索落空就退到文件末尾 —— 整局被跳过,状态永远是空的。
 *
 * 现在:一局的日志通常只有几 MB,直接从开头读,解析器遇到 CREATE_GAME 自己重置,最终就是最后一局
 * 的状态。只有文件特别大时才回看最后一段,避免启动时读几十 MB。
 */
/**
 * 启动时最多回看这么多。
 *
 * 原来是 32MB —— 那时日志到 10MB 就封顶,永远碰不到这个上限。现在上限关掉了,
 * 一份日志会一直长(一局约 2.5MB,一天可能上百 MB),32MB 意味着每次重启都要同步读
 * 32MB 再找开局,白白拖慢启动。8MB 能装三局,足够找到当前这一局的起点。
 */
const FULL_READ_CAP = 8 * 1024 * 1024;

function startOffsetFor(path: string, size: number): number {
  if (size <= 0) return 0;
  if (size <= FULL_READ_CAP) return 0;

  const start = size - FULL_READ_CAP;
  let text: string;
  try {
    const fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(FULL_READ_CAP);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return start;
  }
  const at = text.lastIndexOf('CREATE_GAME');
  if (at < 0) return start;
  const lineStart = text.lastIndexOf('\n', at);
  return start + (lineStart < 0 ? 0 : lineStart + 1);
}

/**
 * 这一行是炉石自己写的「日志写满」提示,不是对局日志。
 *
 * 实测原文:`Truncating log, which has reached the size limit of 10000KB`。
 * 它出现之后炉石就不再往这个文件里写了 —— 后面发生的事全丢。
 */
export function isLogFullLine(line: string): boolean {
  return /Truncating log/i.test(line);
}

export interface LogTailOptions {
  getPath(): { path: string; why: string } | null;
  /**
   * 读到的行。initial=true 表示这是刚接上文件时的补历史:解析器要重建状态,
   * 但调用方不该把这些当成新发生的事往外推。
   */
  onLines(lines: string[], initial: boolean): void;
  onSwitch?(path: string | null): void;
  /**
   * 日志写满了。
   *
   * 实测 2026-10-24:Power.log 到 10MB 之后炉石写下一行
   * 「Truncating log, which has reached the size limit of 10000KB」就**不再往里写**,
   * 而这一行不是 GameState 行,解析器根本看不见。于是那一局的后半段、包括怎么结束的,
   * 全丢了 —— 他输了,她一个字都没说,因为对她来说那局还停在 14:16。
   * 这行必须单独认。
   */
  onLogFull?(initial: boolean): void;
  pollMs(): number;
  log?: { warn(msg: string, data?: unknown): void; info(msg: string, data?: unknown): void };
}

export class PowerLogTail {
  private offset = 0;
  private decoder = new StringDecoder('utf8');
  private partial = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private current: string | null = null;
  private failures = 0;
  /** 上一次看到的修改时间:用来识别「文件被整体重写成同样大小」这种只比长度抓不到的情况。 */
  private lastMtimeMs = 0;
  /** 文件开头 256 字节的内容指纹。只在怀疑被整体重写时读一次，不是每轮都读。 */
  private headSig = '';
  /** 上次重新扫目录找日志的时刻。 */
  private lastResolveAt = 0;
  /** 上次定位的结果(含「没找到」)。缓存到下一次重扫。 */
  private found: { path: string; why: string } | null = null;
  private readonly opts: LogTailOptions;

  constructor(opts: LogTailOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 当前正在读的文件,没找到时为 null。 */
  get currentPath(): string | null {
    return this.current;
  }

  /** 立刻跳回文件末尾之后,丢掉已积累的半行。切换对局或换文件时用。 */
  skipToEnd(): void {
    if (!this.current) return;
    try {
      this.offset = statSync(this.current).size;
      this.decoder = new StringDecoder('utf8');
      this.partial = '';
    } catch {
      // 文件不在了,下一轮重新定位
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    const ms = Math.max(100, Math.min(5000, Number(this.opts.pollMs()) || 400));
    this.timer = setTimeout(() => this.tick(), ms);
    // 不要因为这个定时器把进程钉住
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.stopped) return;
    try {
      this.step();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      if (this.failures === 1 || this.failures % 50 === 0) {
        this.opts.log?.warn(`读炉石日志出错(第 ${this.failures} 次):${(error as Error).message}`);
      }
    } finally {
      this.schedule();
    }
  }

  private step(): void {
    // 路径不用每轮都重新扫:它只在炉石重启(换会话目录)或文件消失时才会变。
    // 每轮都 scan 一次是 2.4ms 的同步 IO,在 400ms 轮询下常年占着事件循环。
    const stale = !this.current
      || !existsSync(this.current)
      || Date.now() - this.lastResolveAt > RESCAN_MS;
    if (stale) {
      this.found = this.opts.getPath();
      this.lastResolveAt = Date.now();
    }
    const found = this.found;
    const nextPath = found?.path ?? null;
    if (nextPath !== this.current) {
      this.current = nextPath;
      if (nextPath) {
        const size = statSize(nextPath);
        this.offset = startOffsetFor(nextPath, size);
        this.decoder = new StringDecoder('utf8');
        this.partial = '';
        this.lastMtimeMs = 0;
        // 换了文件，旧指纹作废，下一轮重新取
        this.headSig = '';
        this.opts.log?.info(`开始读炉石日志:${nextPath}(${found?.why ?? ''},从第 ${this.offset} 字节起)`);
      }
      this.opts.onSwitch?.(nextPath);
      if (!nextPath) return;
      // 换文件后立刻读一次,把已有的这局补齐(标成补历史,别当成新事件)
      this.drain(nextPath, true);
      return;
    }
    if (!nextPath) return;
    this.drain(nextPath);
  }

  /** 读文件开头一小段当指纹。读不到返回空串（空串不会等于任何已有指纹，因此不会误起重写）。 */
  private headSignature(path: string): string {
    try {
      const size = statSize(path);
      if (size <= 0) return '';
      const fd = openSync(path, 'r');
      const buf = Buffer.allocUnsafe(Math.min(256, size));
      try {
        readSync(fd, buf, 0, buf.length, 0);
      } finally {
        closeSync(fd);
      }
      return buf.toString('latin1');
    } catch {
      return '';
    }
  }

  private drain(path: string, initial = false): void {
    const stat = statOrNull(path);
    if (!stat) return;
    const { size, mtimeMs } = stat;

    // 「文件变短」一定是被换掉了。
    //
    // 「长度没变但 mtime 动了」必须再确认**内容真的变了**才算重写，否则正常轮询会误判 ——
    // 读完 offset 正好等于 size 是常态，而炉石每写一次都会改 mtime。误判的代价是 offset 归零、
    // 整份日志同步重读一遍，而重读进来的回合早被解析器 `lastQueuedTurn` 去重挡掉，
    // **外面看着就是炉石这条链路突然不出声**（2026-10-27 实测：第 21、23 回合和结束事件
    // 就这么丢的）。所以这里加一道 256 字节的内容比对，只在可疑时读一次。
    const truncated = size < this.offset;
    if (!this.headSig) this.headSig = this.headSignature(path);
    const suspect = !truncated && size === this.offset && size > 0 && mtimeMs !== this.lastMtimeMs;
    const rewritten = truncated || (suspect && this.headSignature(path) !== this.headSig);
    if (rewritten && this.offset > 0) {
      this.offset = startOffsetFor(path, size);
      this.decoder = new StringDecoder('utf8');
      this.partial = '';
      this.headSig = this.headSignature(path);
    }
    this.lastMtimeMs = mtimeMs;

    if (size <= this.offset) return;

    const want = size - this.offset;
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    const fd = openSync(path, 'r');
    try {
      read = readSync(fd, buf, 0, want, this.offset);
    } finally {
      closeSync(fd);
    }
    if (read <= 0) return;
    this.offset += read;
    this.consume(this.decoder.write(buf.subarray(0, read)), initial);
  }

  /** 按行切开,末尾不完整的半行留到下一轮。 */
  private consume(text: string, initial: boolean): void {
    if (!text) return;
    const joined = this.partial + text;
    const parts = joined.split('\n');
    this.partial = parts.pop() ?? '';
    // 防止异常情况下半行无限增长
    if (this.partial.length > 1_000_000) this.partial = '';
    const lines = parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)).filter((line) => line.length > 0);
    // 「写满」那一行不是对局日志,解析器会忽略它 —— 但它之后的每一行都不会再有了,
    // 所以在这里单独拦一下。
    // initial=true 是启动/换文件时的补历史:那一行是旧账,不该当新闻播出去
    if (lines.some(isLogFullLine)) this.opts.onLogFull?.(initial);
    if (lines.length) this.opts.onLines(lines, initial);
  }
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function statOrNull(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** 只给诊断用:读整个文件,确认里面确实有对局数据。 */
export function looksLikePowerLog(path: string): boolean {
  try {
    const size = statSize(path);
    if (size <= 0) return false;
    const fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(Math.min(size, 65536));
    try {
      readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    const head = buf.toString('utf8');
    return head.includes('DebugPrintPower') || head.includes('CREATE_GAME');
  } catch {
    return false;
  }
}

/** 供诊断工具用:报告都找了哪些位置。 */
export function describeSearch(ctx: Ctx): string {
  const roots = [...(ctx.installDir.trim() ? [ctx.installDir.trim()] : []), ...DEFAULT_INSTALL_DIRS];
  return roots.map((r) => `${r}${existsSync(join(r, 'Logs')) ? '(有 Logs)' : ''}`).join('、');
}


