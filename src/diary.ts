/**
 * 复盘日记：每局打完写一篇，一天一个文件。
 *
 * **放在哪可以改**（`diaryDir`）—— 填 OneDrive / 坚果云的同步目录就自动上云。
 * 扩展自己不做上传：那是同步盘的事，扩展去实现一遍只会多出账号、密钥、断点续传一堆麻烦。
 * 换位置才是这个功能的意义：换盘、换机器都能接着读。
 *
 * **内容只写事实。** 赢没赢、几回合、双方血量、她推的和他打的对不对得上 ——
 * 这些都能从对局记录里直接读出来。至于「为什么输」，那是判断，得她来说
 * （`hearthstone_diary` 工具让她补一段），这里不替她编。
 *
 * 为什么这么分：日记是给她自己攒的。全自动生成的「分析」看起来完整，
 * 但那是模板在说话，不是她的想法 —— 三个月后翻回去，一个字都记不住。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DiarySplit {
  turn: number;
  advised: string;
  played: string;
}

export interface DiaryEntry {
  /** 打完的时刻。 */
  at: string;
  result: 'won' | 'lost' | 'tied' | string;
  turns: number;
  me: { cls: string; hp: number; lowHp: number; armor?: number };
  foe: { cls: string; hp: number; armor?: number };
  /** 有得比的决策点 / 其中按建议打的。 */
  decisions: number;
  agreed: number;
  splits: DiarySplit[];
  /** 她写的那一段（可以没有）。 */
  words?: string;
}

const RESULT_ZH: Record<string, string> = {
  won: '赢',
  lost: '输',
  tied: '平',
  conceded: '对面跑了',
};

/** 复盘日记文件名规则（如 `炉石日记-2026-11-19.md`），供存储统计与清理复用。 */
export const DIARY_FILE_RE = /^炉石日记-\d{4}-\d{2}-\d{2}\.md$/;

/** 一天的日记放一个文件。换盘直接换目录，文件名只带日期，不带路径信息。 */
export function diaryFile(dir: string, at: string): string {
  const day = (at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  return join(dir, `炉石日记-${day}.md`);
}

/** 一局写成一段 Markdown。 */
export function renderDiary(e: DiaryEntry): string {
  const res = RESULT_ZH[e.result] ?? e.result;
  const head = `## ${(e.at || '').slice(11, 16)} · ${e.me.cls || '我'} vs ${e.foe.cls || '对面'} · ${res} · 第 ${e.turns} 回合`;
  const lines: string[] = [head, ''];

  const hp = [`我 ${e.me.hp} 血`, `他 ${e.foe.hp} 血`].join(' / ');
  const low = e.me.lowHp < e.me.hp ? `（这局最低掉到 ${e.me.lowHp}）` : '';
  lines.push(`**结果**：${hp}${low}`);

  if (e.decisions > 0) {
    const rate = Math.round((e.agreed / e.decisions) * 100);
    lines.push(`**分歧**：${e.decisions} 个决策点，按建议打 ${e.agreed} 次（${rate}%）`);
  }

  if (e.splits.length) {
    lines.push('');
    // 第一人称：这是**她**的日记，不是他的复盘报告。
    // 写成「她推的和他的」是站在旁观者角度记别人，翻回去看会像一份别人的成绩单。
    lines.push('**我推的，他打了别的**');
    for (const s of e.splits.slice(0, 6)) {
      lines.push(`- T${s.turn}：我说「${s.advised}」，他打了「${s.played}」`);
    }
    if (e.splits.length > 6) lines.push(`- …还有 ${e.splits.length - 6} 处`);
  }

  if (e.words && e.words.trim()) {
    lines.push('');
    lines.push(`**我记下的**：${e.words.trim()}`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * 追加一篇进当天的文件。
 *
 * 目录不存在就建（换到一个新同步盘时第一次必然是空的）。
 * 追加而不是覆盖 —— 一天打十几局，覆盖只剩最后一局。
 */
export function appendDiary(dir: string, e: DiaryEntry): { ok: boolean; path?: string; error?: string } {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = diaryFile(dir, e.at);
    // 新文件先写个标题，不然打开是一段没头没尾的「## 12:46」。
    if (!existsSync(path)) {
      const day = (e.at || '').slice(0, 10);
      writeFileSync(path, `# 炉石日记 · ${day}\n\n`, 'utf8');
    }
    appendFileSync(path, renderDiary(e), 'utf8');
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * 把她的一段话挂到当天日记的末尾。
 *
 * 为什么不是塞进某一局的段落里：局是自动归档的，写的时候她还没说话，
 * 事后要往「那一局的中间」插一行，得先把整份文件按局切开再拼回去 ——
 * 为了排版好看去改一份流水账，不值得。追加在末尾、带上时刻，读起来也顺。
 */
export function appendDiaryNote(dir: string, at: string, text: string): { ok: boolean; error?: string } {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = diaryFile(dir, at);
    if (!existsSync(path)) {
      const day = (at || '').slice(0, 10);
      writeFileSync(path, `# 炉石日记 · ${day}\n\n`, 'utf8');
    }
    appendFileSync(path, `**${(at || '').slice(11, 16)} 我记下的**：${text.trim()}\n\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 读最近的日记（给她回想用，只取尾部若干字）。 */
export function readRecentDiary(dir: string, maxChars = 2000): string {
  try {
    const path = diaryFile(dir, new Date().toISOString());
    if (!existsSync(path)) return '';
    const text = readFileSync(path, 'utf8');
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}

/* ---------------- 感想栏 ---------------- */

/**
 * 一条感想。
 *
 * 和日记的分工：**日记记整局**（结果、血量、哪几手对不上），**感想记她脑子里冒出来的那一句**
 * （「他手上三张牌一直没动，不是在等斩杀就是在等解场」）。
 * 日记是台账，感想是想法 —— 混在一起，台账会被想法冲散。
 */
export interface Thought {
  /** ISO 时刻。 */
  at: string;
  text: string;
  /** 当时的局面，一句带过（第几回合、打谁）。没有就空着。 */
  where?: string;
}

const THOUGHTS_MAX = 200;

function thoughtsFile(dir: string): string {
  return join(dir, '感想.jsonl');
}

/**
 * 记一条感想。
 *
 * 存 jsonl 而不是 markdown：面板要按条倒序取最近几条，
 * 从 markdown 里反解条目，格式一改就崩。
 * 超过 200 条裁掉最老的 —— 这是「最近在想什么」，不是档案，不需要留全部。
 */
export function appendThought(dir: string, t: Thought): { ok: boolean; path?: string; error?: string } {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = thoughtsFile(dir);
    let lines: string[] = [];
    try {
      if (existsSync(path)) lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    } catch { /* 读坏了就当空的，下面整份重写 */ }
    lines.push(JSON.stringify({ at: t.at, text: t.text, ...(t.where ? { where: t.where } : {}) }));
    if (lines.length > THOUGHTS_MAX) lines = lines.slice(-THOUGHTS_MAX);
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 最近 n 条，新的在前。坏行直接跳过 —— 一条坏了不该让整块面板空掉。 */
export function readThoughts(dir: string, n = 5): Thought[] {
  try {
    const path = thoughtsFile(dir);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    const out: Thought[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i -= 1) {
      try {
        const t = JSON.parse(lines[i]) as Thought;
        if (t && typeof t.text === 'string' && t.text.trim()) out.push(t);
      } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch {
    return [];
  }
}
