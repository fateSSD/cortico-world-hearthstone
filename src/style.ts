/**
 * 「我怎么打牌」——她自己的打牌立场，一份人也能直接改的 Markdown。
 *
 * 和旁边那几个文件的分界必须分清楚，否则这东西会退化成第三份战术笔记：
 *   hearthstone_advice → 这回合能打什么、斩杀多少、谁能换掉谁。**算出来的。**
 *   hearthstone_meta   → 这个职业怎么赢，联网搜来的。**别人的结论。**
 *   hearthstone_plan   → 这套牌靠什么赢，模型推演的。**针对这一副牌。**
 *   这份文件           → 我信哪一套、我看不惯什么、我嘴上是什么人。**第一人称，她写的。**
 *
 * 为什么她自己写、而不是我们从对局里归纳一版：
 * 归纳出来的第一版再准，也是"他的打法"，不是"她的"。她打出来的立场才算数；
 * 一开始空着不丢人 —— 空着说明她还没有立场，比塞一段漂亮话强。
 *
 * 为什么不能让它盖过算出来的东西：
 * 打牌跟听歌不一样。她说"我爱听肖邦"错了只是口味，说"这回合别上脸"错了是他掉分。
 * 所以这份档案在提示词里只被允许影响两件事 —— **怎么说**、**先推哪条**。
 * 斩杀、墙、群伤这些算出来的硬信息，风格一律不许碰。这条写死在 ENV_PROMPT 里。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STYLE_FILE = 'hearthstone-style.md';

/** 小节键 → 标题。键给工具参数用（模型填英文更稳），标题是人打开文件看到的那行。 */
export const STYLE_SECTIONS = {
  who: '我在牌桌上是什么人',
  push: '我倾向这么打',
  dislike: '我看不惯的打法',
  unsure: '还没想明白',
} as const;

export type StyleSection = keyof typeof STYLE_SECTIONS;

export function isStyleSection(v: unknown): v is StyleSection {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STYLE_SECTIONS, v);
}

/** 一条最多多少字。立场越短越像立场，写长了这份文件下次自己都不想读。 */
export const STYLE_LINE_MAX = 60;

/**
 * 每一节最多几条。
 *
 * 比音乐那边收得更紧（那边 12）：打牌的立场本来就该少。超过 8 条，
 * 写的多半是"这局我干了什么"，而不是"我是个什么样的牌友"。
 */
export const STYLE_SECTION_MAX = 8;

/** 注入提示词时的上限。超了截断并告诉她去看全文，别把系统前缀撑爆。 */
export const STYLE_INJECT_MAX = 1200;

export function stylePath(dir: string): string {
  return join(dir, STYLE_FILE);
}

/**
 * 空骨架。
 *
 * 刻意不写示范句子。给了示范她就会照抄，最后这份文件里全是我们的措辞
 * （同一个坑在音乐的段位文案上踩过三次）。
 */
export function styleSkeleton(): string {
  const parts = [
    '# 我怎么打牌',
    '',
    '这是我自己的打法，不是战术笔记。哪些牌强、这回合该打什么，那是 `hearthstone_advice` 算的。',
    '这里只写一件事：**我**在牌桌上是个什么样的人。',
    '',
  ];
  for (const title of Object.values(STYLE_SECTIONS)) {
    parts.push(`## ${title}`, '');
  }
  parts.push(
    '---',
    '',
    `写的时候：用第一人称；一条一行，不超过 ${STYLE_LINE_MAX} 个字；`,
    '写的是自己的立场，不是从攻略里抄来的结论。',
    '',
  );
  return parts.join('\n');
}

/** 读全文。文件不在就返回 null —— 这时候别自作聪明替她造一份，交给 ensureStyle。 */
export function readStyle(dir: string): string | null {
  const file = stylePath(dir);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 文件不存在就建骨架，返回当前全文。
 *
 * 建骨架**不算她写东西**：它是容器，不是内容。所以这一步不受「允许她改风格档案」开关的限制 ——
 * 关了也得有地方给她读。
 */
export function ensureStyle(dir: string): string {
  const existing = readStyle(dir);
  if (existing !== null) return existing;
  const text = styleSkeleton();
  writeStyle(dir, text);
  return text;
}

/**
 * 原子写：先写临时文件再改名。
 *
 * 直接覆盖的话，写到一半断电/盘满/文件被占，留下的就是半份立场 ——
 * 而这份文件没有备份、也没有第二处能读回来（它不是逐日追加的）。
 * 临时名带 pid，两台机器同时写也不会互相踩。
 */
export function writeStyle(dir: string, text: string): boolean {
  const file = stylePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      writeFileSync(file, text, 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

interface Span {
  head: number;
  /** 插入点：这一节的正文末尾（尾部空行之前）。 */
  insertAt: number;
}

/** 找某一节的范围。认 `## 标题`，也容忍前后多打的空格。 */
function findSpan(lines: string[], title: string): Span | null {
  const want = `## ${title}`;
  const head = lines.findIndex((l) => l.trim() === want);
  if (head < 0) return null;
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('## ') || t === '---') {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt - 1 > head && lines[insertAt - 1].trim() === '') insertAt -= 1;
  return { head, insertAt };
}

export interface StyleWriteResult {
  ok: boolean;
  /** 给工具回执的一句话。成功了也要说清"加在哪一节"。 */
  message: string;
}

/**
 * 往某一节里加一条。
 *
 * 去重按"包含"：她写过「看不得水晶浪费」，再写「水晶用不完我就别扭」不该多出一条 ——
 * 换个词就重复，这份文件很快就没人看了。上限满了不加，但要明说为什么，让她自己去删。
 */
export function addStyleLine(dir: string, section: StyleSection, raw: string): StyleWriteResult {
  const line = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/^[-·•]\s*/, '');
  if (!line) return { ok: false, message: '没有内容可写。' };
  const clipped = line.length > STYLE_LINE_MAX ? `${line.slice(0, STYLE_LINE_MAX)}…` : line;

  const text = ensureStyle(dir);
  const lines = text.split(/\r?\n/);
  const title = STYLE_SECTIONS[section];
  const span = findSpan(lines, title);
  if (!span) {
    // 人可能把这一节删了。补回来，别默默丢她这一条。
    const next = [...lines, '', `## ${title}`, '', `- ${clipped}`, ''];
    return writeStyle(dir, next.join('\n'))
      ? { ok: true, message: `「${title}」这一节原来不在文件里，我补上了，写进第一条：${clipped}` }
      : { ok: false, message: '文件写不进去（盘满了、没权限，或者被别的程序占着）。' };
  }

  const body = lines.slice(span.head + 1, span.insertAt);
  const items = body.filter((l) => l.trim().startsWith('- '));
  const dup = items.find((l) => {
    const t = l.trim().replace(/^-\s*/, '');
    return t === clipped || t.includes(clipped) || clipped.includes(t);
  });
  if (dup) {
    return { ok: true, message: `「${title}」里已经有这条了（${dup.trim().replace(/^-\s*/, '')}），没重复写。` };
  }
  if (items.length >= STYLE_SECTION_MAX) {
    return {
      ok: false,
      message: `「${title}」已经有 ${items.length} 条，装不下了。先删一条再加 —— 这一节留的是最硬的几条，不是流水账。`,
    };
  }

  lines.splice(span.insertAt, 0, `- ${clipped}`);
  return writeStyle(dir, lines.join('\n'))
    ? { ok: true, message: `写进「${title}」：${clipped}（这一节现在 ${items.length + 1} 条）。` }
    : { ok: false, message: '文件写不进去（盘满了、没权限，或者被别的程序占着）。' };
}

/** 删掉第一条包含 `find` 的条目。改主意、打法变了都靠它。 */
export function dropStyleLine(dir: string, find: string): StyleWriteResult {
  const needle = String(find ?? '').replace(/\s+/g, ' ').trim();
  if (!needle) return { ok: false, message: '要说删哪一条。' };

  const text = readStyle(dir);
  if (text === null) return { ok: false, message: '还没有风格档案，没东西可删。' };

  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim().startsWith('- ') && l.includes(needle));
  if (idx < 0) return { ok: false, message: `没找到含「${needle}」的条目。` };

  const gone = lines[idx].trim().replace(/^-\s*/, '');
  lines.splice(idx, 1);
  return writeStyle(dir, lines.join('\n'))
    ? { ok: true, message: `删掉了：${gone}` }
    : { ok: false, message: '文件写不进去（盘满了、没权限，或者被别的程序占着）。' };
}

/** 只数条目（`- ` 开头的行），别把标题和小节名算进去。给设置页显示规模。 */
export function styleLineCount(text: string | null): number {
  if (!text) return 0;
  return text.split(/\r?\n/).filter((l) => l.trim().startsWith('- ')).length;
}

/**
 * 拼成注入系统提示词的那一段。
 *
 * **整篇塞进去**，不是给她一个"去查"的入口 —— 她开口之前偏好就得在，
 * 否则每回合都要为了看一眼立场多跑一次工具，那就不叫性格，叫查资料。
 *
 * 空档案要明说"还没长出来"，不然她会以为读失败了，然后开始编。
 *
 * `playedGames` 只用来判断该不该催她写（见 `styleGapNote`）—— 这个模块不读对局档案，
 * 局数由调用方给。不传就是「不知道打了多少局」，那就不催。
 */
export function styleForPrompt(dir: string, playedGames = 0): string {
  const raw = readStyle(dir) ?? '';
  const body = raw.trim();
  if (!body) {
    return '（风格档案还没建起来，空的。这一轮你没有既定立场 —— 别编一个，正常解说就行。）';
  }
  const count = styleLineCount(body);
  if (count === 0) {
    // 一条都没写，正是最该催的那一种 —— 早退分支里也得带上，否则催办永远发不出去
    // （2026-11-06：第一版就漏在这儿，测试当场拦下来）。
    const gap = styleGapNote(body, playedGames);
    // 催办放在括号**外面**：括号里说的是「档案什么状态」，催办是另一件事。
    // 塞在一起会读成「档案是空的，另外你已经打了 14 局…」，像同一句里的第二个从句。
    return `（风格档案是空的 —— 你还没长出立场。别编。真要写的时候用 hearthstone_style，全文在 ${stylePath(dir)}）`
      + (gap ? `\n\n${gap}` : '');
  }
  const clipped = body.length > STYLE_INJECT_MAX
    ? `${body.slice(0, STYLE_INJECT_MAX)}\n…（后面还有，全文在 ${stylePath(dir)}）`
    : body;
  const gap = styleGapNote(body, playedGames);
  return `${clipped}\n\n（一共 ${count} 条。这份东西**只管两件事**：怎么说、先推哪条。算出来的斩杀、墙、群伤，它管不了 —— 别拿自己的偏好去盖数学。）`
    + (gap ? `\n\n${gap}` : '');
}

/** 打够多少局才催她写。一局就催像逼人交作业。 */
export const STYLE_GAP_MIN_GAMES = 5;

/**
 * 「打了这么多局还一条没写」的催办。返回空串 = 不用催。
 *
 * 2026-11-06 实测：这份档案 2026-10-30 建好，到 11-06 晚上 50 局打完，**一条都没写**。
 * 而她那一晚在气泡里说过不少立场（「这局怪游戏不怪你」「他手牌攒到八张没动，在等一套」
 * 「这条我判断不了」）—— 全是说完就散的。原因不是她不愿意写，是**没有任何东西推她**：
 * 提示词里只写了「什么时候该写」，那是规则，不是提醒。
 *
 * 三条门槛，跟音乐那份 `soulGapNote` 同一套道理：
 *   - 已经有任何一条就不催（她写过就说明她知道这回事）；
 *   - 没打够 STYLE_GAP_MIN_GAMES 局不催；
 *   - **只提「哪几类算立场」，绝不给现成的判断** —— 给了她就会编一条来交差。
 *     连她自己的原话都不引：引了等于我替她定了要写什么。
 *
 * 催办不进文件（文件是她的），只在提示词正文后面跟一句。
 */
export function styleGapNote(text: string | null, playedGames: number): string {
  if (text === null) return '';
  if (styleLineCount(text) > 0) return '';
  if (playedGames < STYLE_GAP_MIN_GAMES) return '';
  return `另外：你已经打了 ${playedGames} 局，这四节一条都没写。`
    + '你对局里说过的那些话 —— 哪一回合该压、哪次算错了、哪样打法你看不上 —— 说完就散了，'
    + '下一局我又得从零开始想。想留就挑一条写进去；**不为填满而编**，写不出来空着也行。';
}
