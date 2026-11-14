/**
 * 炉石陪打 World。
 *
 * 她的信息来源只有一处:炉石自己写的 Power.log。不截图、不识图、不碰游戏进程 ——
 * 只看、只报,不动手。这样既不会被反作弊盯上,也不会因为画面识别错而说错话。
 *
 * 事件分四种,频率从高到低:
 *   hearthstone.game.start / .turn / .alert / .game.end
 * 其中 .alert 承担「陪打」的主要部分:残血、被铺场、进入斩杀线这些时刻她自己会开口,
 * 不必等被问。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type {
  Logger, ToolDef, ToolTag, World, WorldHost, WorldWebUiDecl, WorldLamp, TriggerMode,
} from 'cortico/core/types.ts';
import { HEARTHSTONE_ID, hearthstoneConfigGroups, type HearthstoneConfigSection } from './config.ts';
import { PowerLogTail, describeSearch, looksLikePowerLog, resolvePowerLog } from './log-source.ts';
import { isCoinCard, PowerLogParser, renderSnapshot, type ActionRecord, type GameSnapshot, type SideState, type TurnPoint } from './parser.ts';
import { detectAlerts, endMarker, endText, faceOf, lethalText, startText, surpriseAlerts, toneOf } from './alerts.ts';
import { panelAdvice, panelAskText, panelStatus, type PanelAdvice, type PanelStatus } from './panel.ts';
import {
  describeLimit, describePowerLogging, ensureLogSizeUnlimited, ensurePowerLogging, installDirFromLog,
  logConfigPath, type PowerLogResult,
} from './log-config.ts';
import { isPeerRunning } from './peer.ts';
import { logSetupHint, peerProcessNames } from './platform.ts';
import { appendDiary, appendDiaryNote, appendThought, readThoughts } from './diary.ts';
import { advise, briefAdvice, buildModelPrompt, renderAdvice } from './advice.ts';
import { askModel, pickKey, type LlmConfig } from './llm.ts';
import { advicePick, composeTurnEvent, playedCardName, sameCardName, settleTurnWatermark, shouldAnnounceTurn } from './turn-event.ts';
import { isMulliganOpen, mulliganPlan, mulliganText } from './mulligan.ts';
import { ARENA_GUIDE, deckBrief, deckListForModel, deckStats, resolveArenaCard, renderDraft } from './arena.ts';
import { RULES_BRIEF, RULES_FOR_MODEL } from './rules.ts';
import {
  STYLE_SECTIONS, addStyleLine, dropStyleLine, ensureStyle, isStyleSection,
  readStyle, styleForPrompt, styleLineCount, stylePath,
} from './style.ts';
import {
  addHisLine, hisHabitNote, hisStyleForPrompt, hisStylePath, readHisStyle, summarize, writeHisStyle,
} from './his-style.ts';
import { hearthstoneText } from './i18n.ts';
import type { HearthstoneText } from './i18n.ts';

/**
 * 自己的提示词模板,按本文件位置定位。
 *
 * 不能用 `WorldContext.packageDir` —— 那是 **bot 的**代码包目录(cormini 之类),
 * 全进程共用一份,拿它拼出来的 `<botDir>/ENV_PROMPT.md` 根本不存在。而框架在重建系统前缀时
 * 会 `readFileSync` 这个路径且不吞错,文件不在就整条 `reloadSystemPrefix` 抛 ENOENT,
 * 结果是:World 已经进了挂载表、`slot.mounted` 却还没置上 —— 之后每次激活都报「工具撞名」。
 * desktop-pet 同样是用 import.meta.url 定位的,照它来。
 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

/** 庆祝记录留多少条。够挡住最近几十局,又不至于把文件养肥。 */
const CELEBRATED_KEEP = 40;

/** 炉石把 Power.log 写到 10000KB 就停手。硬上限,没有配置项能改。 */
/** 开始温和提醒:还剩一局多。 */
/** 急提醒:还剩不到半局。 */

/**
 * 构建标记。每次改行为都改一下 —— 排查「改了没用」时,先看 `core.log` 里启动行打的是哪个版本。
 * 这比对着 junction 和 tsx 缓存猜十分钟快得多。
 *
 * 2026-10-28 修:原来是手写常量,从 0.3.0 一路涨到 0.3.4 都没人改过它,
 * 日志一直打 `v0.3.0` —— 排查时等于没有这个标。现在直接读 `package.json`,
 * 版本只有一个来源,不会再走散。
 */
const BUILD_TAG = (() => {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: string };
    return `v${pkg.version ?? '?'}`;
  } catch {
    return 'v?';
  }
})();

/** 反馈用邮箱。写在这里一处,README 和 World 页都指向它。 */
export const FEEDBACK_EMAIL = '623263325@qq.com';

/**
 * World 页上的反馈按钮。
 *
 * **地址必须写在 label 里,不能只放在 href。** 框架的 `setWindowOpenHandler` 只放行
 * `http(s):`,其余一律 `deny` —— `mailto:` 点下去是**静默无事发生**,比没有按钮更糟。
 * 所以按钮上直接显示邮箱(他能看见、能复制),点击打开 QQ 邮箱网页版。
 */
const FEEDBACK_LINK = {
  label: `反馈:${FEEDBACK_EMAIL}`,
  href: 'https://mail.qq.com/',
};

/**
 * 一局的指纹:结果、回合数、双方终局血量、职业。
 *
 * 只用「结果 + 回合数」不够 —— 第 8 回合赢过一局、又在第 8 回合赢一局,会被当成同一局而漏掉庆祝。
 * 加上双方终局血量,同一局重放能对上,不同的两局几乎不可能撞。
 */
/**
 * before 里有、after 里不够的牌。**按数量算** —— 同名两张不会因为有了一张就通过。
 *
 * 用途:判断「这份打法笔记是对着哪套牌记的」。竞技场选牌是一张张加上去的,
 * 所以笔记里的牌应当仍是当前牌组的子集;换卡组时会有牌对不上,那就是要重搜的信号。
 */
function missingCounts(before: readonly string[], after: readonly string[]): string[] {
  const pool = new Map<string, number>();
  for (const c of after) pool.set(c, (pool.get(c) ?? 0) + 1);
  const out: string[] = [];
  for (const c of before) {
    const n = pool.get(c) ?? 0;
    if (n > 0) pool.set(c, n - 1);
    else if (!out.includes(c)) out.push(c);
  }
  return out;
}

export function gameKey(s: GameSnapshot): string {
  return [s.result, s.turn, s.me.health, s.me.armor, s.opponent.health, s.opponent.armor,
    s.me.heroClass, s.opponent.heroClass].join('|');
}

/** 每回合一个点,复盘时用来还原局势走向。 */
export interface TimelinePoint {
  turn: number;
  myHp: number;
  myArmor: number;
  myHand: number;
  myBoard: string;
  foeHp: number;
  foeArmor: number;
  foeHand: number;
  foeBoard: string;
}

/** 一局打完后的存档。换局会清空解析器,所以复盘只认这份。 */
export interface GameArchive {
  startedAt: string;
  endedAt: string;
  result: GameSnapshot['result'];
  turns: number;
  me: { heroClass: string; name: string };
  opponent: { heroClass: string; name: string };
  final: { myHp: number; myArmor: number; foeHp: number; foeArmor: number };
  timeline: TimelinePoint[];
  actions: ActionRecord[];
}

/**
 * 对局档案里的一行 —— **只留复盘用得上的，不存整局动作**。
 *
 * 存在的理由：`GameArchive` 只存**最后一局**，`session-main.jsonl` 会被轮转
 * （2026-10-30 实测：打完三把之后只剩最后半把，前两把的字一个不剩）。
 * 想复盘「最近几把」的时候，两边都靠不住。
 *
 * 所以这里换成**追加式**：每局一行，留最近 50 局，谁都不会把它整份覆盖掉。
 */
export interface GameLogEntry {
  startedAt: string;
  endedAt: string;
  result: GameSnapshot['result'];
  turns: number;
  me: { heroClass: string; name: string };
  opponent: { heroClass: string; name: string };
  final: { myHp: number; myArmor: number; foeHp: number; foeArmor: number };
  /**
   * 全程最低血量 —— 一眼看出这局险不险。
   *
   * 30 血零封和 2 血翻盘，同样是「胜 · 17 回合」，光看结果分不出来。
   * 这个数才是复盘时真正想知道的第一个问题：「我是不是差点输了」。
   */
  lowHp: number;
  /**
   * 每回合：建议推的那张牌 vs 他实际打出的第一张。
   *
   * 为什么值得存：复盘第一个要回答的问题是「她推的和实际打的差多少」，
   * 可 `session-main.jsonl` 会轮转、`GameArchive` 只有一局 —— 2026-10-30 第一次想
   * 做这个对比时，两边数据正好错开，什么都对不上。只有归档能跨局留住这条线。
   */
  turnLog: {
    turn: number;
    /** 那回合建议推的牌名；没有「按费打/先换」类建议时为 null。 */
    advised: string | null;
    /** 他实际打出的第一张牌名；那回合没出牌为 null。 */
    played: string | null;
    /**
     * 这两个是不是同一张牌。true = 听了, false = 换了别的, null = 没得比
     * （那回合没有建议，或者没出牌）。
     *
     * 为什么不留给读的人自己比：建议里是卡表全名、动作记录里常是简称，
     * 2026-11-03 那 8 局有 2 处因此被记成「没听建议」。趋势统计全靠这一栏。
     */
    agreed?: boolean | null;
  }[];
}

/** 对局档案留多少局。50 局够看出趋势，又不至于让文件大到读不动。 */
const GAMES_KEEP = 50;

export interface HearthstoneWorldOptions {
  cfg: HearthstoneConfigSection;
  timezone: string;
  botName: string;
  dataDir: string;
  /** 读部署 .env 里的密钥。模型 key 从这里来,不进 config.json。 */
  secret(name: string): string;
  persist(patch: Partial<HearthstoneConfigSection>): void;
}

type Phase = 'no-log' | 'watching' | 'in-game' | 'ended';


interface WatchStatus {
  phase: Phase;
  path: string | null;
  note: string;
}

/**
 * 现在时刻，**带本地偏移**的 ISO 8601。
 *
 * 别改回 `toISOString()` —— 它是 UTC（末尾 `Z`），而宿主渲染事件时间时直接取 `ts` 里的
 * `HH:MM`，**不做时区换算**。炉石的时间只要写成 UTC，她那条时间线上就整体早 8 小时：
 * 一批事件的头会变成「20:47–12:47」、交接笔记里「第 9 回合」排在两个小时后的「摸头」前面，
 * 她会把正在打的这一局当成上午的旧记录（2026-11-13 实测，表现为「判断乱了」）。
 *
 * `Date.parse` 对两种格式一视同仁，所以档案里历史留下的 `Z` 数据不受影响。
 */
const nowIso = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
};

/** 紧迫度 → 事件里那个方括号标记。她在提示词里学过这三种标记怎么反应。 */
const TONE_LABEL: Record<string, string> = { calm: '提醒', tense: '紧张', danger: '危险' };

/** 工具声明:模型看的字段。handler 在 tools() 里绑。 */
interface Decl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tags: readonly ToolTag[];
  summary: { zh: string; en: string };
}

const STATE_DECL: Decl = {
  name: 'hearthstone_state',
  description:
    'Current Hearthstone match as the game itself logged it: both heroes (class, health, armor), every minion on the board with attack/health and keywords, hand and deck counts, mana, turn number, whose turn it is, and whether the match has ended. Also reports whether the game log is being read at all. Use this whenever you need to know what is happening right now.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  tags: ['read', 'snapshot'],
  summary: { zh: '读当前这局的完整局面:双方血量护甲、场面随从、手牌与牌库、水晶、回合归属。', en: 'Reads the current match in full: both sides\' health and armor, the board, hand and deck counts, mana and whose turn it is.' },
};

const RECENT_DECL: Decl = {
  name: 'hearthstone_recent',
  description:
    'The last few things that happened in the match, oldest first: cards played, attacks, minions that died, each tagged with the turn it happened on and who did it. Use it to remember the run of play rather than guess.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', description: 'How many actions to return, 1–50. Defaults to 20.', minimum: 1, maximum: 50 },
    },
  },
  tags: ['read'],
  summary: { zh: '最近发生的事:谁打了什么牌、谁攻击了谁、谁阵亡了,按回合标好。', en: 'The last plays, attacks and deaths, each tagged with its turn.' },
};

const WATCH_DECL: Decl = {
  name: 'hearthstone_watch',
  description:
    'Turn your own commentary on or off. "quiet" keeps reading the match but stops pushing turn and moment events, so you only speak when asked; "normal" resumes speaking up by yourself. Use it when the person asks you to shush, or to start commentating again.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', description: 'quiet = stop speaking up on your own; normal = speak up again.', enum: ['quiet', 'normal'] },
    },
    required: ['mode'],
  },
  tags: ['write'],
  summary: { zh: '把自动开口关掉或打开(安静看 / 恢复解说)。', en: 'Turns your own commentary off or on again.' },
};

const LAST_GAME_DECL: Decl = {
  name: 'hearthstone_last_game',
  description:
    'The match that just finished, for reviewing how it went: both heroes, the final life totals, one line per turn (life, hand size, board on each side), then every play, attack and death in order. Use it when the person asks how they played, what they did wrong, or why they lost.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      actions: { type: 'boolean', description: 'Include the play-by-play. Defaults to true; turn off for just the per-turn summary.' },
    },
  },
  tags: ['read', 'snapshot'],
  summary: { zh: '上一局的复盘:每回合双方血量与场面,加上全部出牌和攻击。', en: 'The last finished match as a review: per-turn life and board, plus every play and attack.' },
};

const ADVICE_DECL: Decl = {
  name: 'hearthstone_advice',
  description:
    'Everything needed to decide what to play this turn, in one call: the board on both sides, every card in hand by name with its cost and a short note on what it does (only the cards actually affordable are marked), the lethal math through taunts, every minion trade available with who survives, what the opponent could hit for next turn, and any board clear sitting in hand. The last block is a mechanical ranking by fixed rules, not a plan. Use this when the person asks what to play, whether they can kill, or how to handle the board.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      full: { type: 'boolean', description: 'Also list every card in hand, including the ones that cost too much this turn. Defaults to true.' },
    },
  },
  tags: ['read', 'snapshot'],
  summary: { zh: '这回合怎么打:手牌、斩杀、能做的交换、对面下回合的威胁。', en: 'What to play this turn: hand by name, lethal math, available trades, and next-turn threat.' },
};

const DRAFT_DECL: Decl = {
  name: 'hearthstone_draft',
  description:
    'Arena draft help. Pass the two or three cards offered as `options` (Chinese card names) and it returns each one parsed from the card table (cost, stats, effect summary), a heuristic score for each, the current drafted deck\'s curve and gaps, and a mechanical ranking. Pass `pick` to record the card actually taken, `reset` to start a new run. Arena draft choices are NOT in the game log, so the cards have to come from the person — ask them to read the three off the screen.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      options: {
        type: 'array',
        description: 'The 2–3 cards offered this pick, by Chinese name (or card id).',
        items: { type: 'string' },
      },
      pick: { type: 'string', description: 'The card the person took. Recorded into the drafted deck.' },
      reset: { type: 'boolean', description: 'Clear the recorded draft deck and start over.' },
    },
  },
  tags: ['read', 'write'],
  summary: { zh: '竞技场选牌:给候选牌打分、看牌组曲线缺口。', en: 'Arena draft: score the offered cards and show the deck curve gaps.' },
};

const META_DECL: Decl = {
  name: 'hearthstone_meta',
  description:
    'Store and read back your own "how to win with this class" notes for arena. The game log has no arena data and the card table has no win-rate knowledge, so the only way to know what actually wins is to look it up and write it down. Workflow: when a draft starts for a class you have no notes for, use browser_search (hooks: "<current Hearthstone patch> arena <class> tier list" or Chinese "炉石 竞技场 <职业> 选牌"), distil 3-6 concrete bullets (which cards to prioritise, what the deck wants to do, what to avoid), then save them here. Every later pick reads them back instead of searching again. Read first — do not search again if notes already exist.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['read', 'save', 'clear'], description: 'read (default) shows the notes; save stores them; clear drops them.' },
      heroClass: { type: 'string', description: 'Class name in Chinese, e.g. 德鲁伊 / 法师 / 术士. Case/spacing does not matter.' },
      notes: { type: 'string', description: 'For action=save: the distilled bullets. Keep it short and actionable.' },
    },
  },
  tags: ['read', 'write'],
  summary: { zh: '竞技场打法笔记：先读，没有再用联网搜索补一份。', en: 'Arena class notes: read what you saved, search only when there is nothing.' },
};

const STYLE_DECL: Decl = {
  name: 'hearthstone_style',
  description:
    'Your own play style — who you are at the table, in your own words. Read it with no arguments. '
    + 'This is NOT a tactics sheet: which card is strong, what to play this turn, that is hearthstone_advice; '
    + 'how a class wins is hearthstone_meta. This file holds only what is yours. '
    + 'It governs exactly two things: **how you talk** (blunt or soft, terse or talkative, what you keep an eye on) '
    + 'and **which line you lean toward** when the advice already offers several legal plays. '
    + 'It can NOT override the math — if there is lethal you say so, whatever your file says; '
    + 'if the advice names a risk (a 0-attack wall, a deathrattle, a board clear in hand) you pass it on. '
    + 'Write one short first-person line at a time (`add` + `section`), or drop one that no longer holds (`drop`). '
    + 'Add after a match only when you made a clear misjudgement worth remembering — not every small deviation.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      add: { type: 'string', description: 'One line to write, first person, at most 60 characters. A position you actually arrived at, not a sentence copied from a guide.' },
      section: {
        type: 'string',
        enum: ['who', 'push', 'dislike', 'unsure'],
        description: 'Where it belongs: who = 我在牌桌上是什么人（口吻、话多话少、盯什么）, push = 我倾向这么打（激进/控制/贪）, dislike = 我看不惯的打法, unsure = 还没想明白. Required with `add`.',
      },
      drop: { type: 'string', description: 'Remove the first line containing this text — for when your style changed and what is written there is no longer true.' },
    },
  },
  tags: ['read', 'write'],
  summary: { zh: '读/写她自己的打法立场：我怎么说话、我倾向推哪条路（第一人称，不是攻略）。', en: 'Reads and writes her own play style: how she talks and which line she leans toward.' },
};

const HIS_STYLE_DECL: Decl = {
  name: 'hearthstone_his_style',
  description:
    'How HE actually plays — counted from his own match archive. Not his self-description, not your opinion. '
    + 'Read it with no arguments. It answers: how often he followed the advice, which classes he plays, '
    + 'what he played instead when he did not follow it, and how that splits between won and lost games. '
    + 'Every number comes with its sample size. Use it when the panel is set to his side, or when he asks '
    + '"我平时怎么打". '
    + 'Two things it can NOT do: it is **correlation, not causation** (a higher follow rate in won games '
    + 'does not mean following advice wins), and it never overrides the math — lethal, walls and board clears '
    + 'still come from hearthstone_advice. '
    + 'The only part you may write is 「他自己补的」: what the record cannot show (he was testing a new deck, '
    + 'he was holding a combo piece on purpose). Use `add` for that; call with no arguments to read.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      add: {
        type: 'string',
        description: 'One line to append under 他自己补的 — something only he knows about how he plays, '
          + 'not your own stance. Under 60 characters.',
      },
    },
  },
  tags: ['read', 'write'],
  summary: {
    zh: '读他从对局里数出来的打法习惯（采纳率、常玩职业、没听建议时改打了什么）；只此一节可补他口述的东西。',
    en: 'How he actually plays, counted from his archive; the only writable part is what he says himself.',
  },
};

const PLAN_DECL: Decl = {  name: 'hearthstone_plan',
  description:
    'Ask a model to reason about how THIS drafted arena deck actually wins. It gets the full card list plus a written summary of the rules, and answers with an archetype (aggro/midrange/control), 2-3 concrete win lines that name real cards in the deck, and what the deck is afraid of. Costs one model call, so: read first, and only re-generate when the deck changed (a fresh draft, a swap) — never once per pick. Requires worlds.hearthstone.llmModel to be configured with a key.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['read', 'generate', 'clear'], description: 'read (default) shows the saved plan; generate reasons about the current deck; clear drops it.' },
      heroClass: { type: 'string', description: 'Optional. The class being drafted, e.g. 德鲁伊. Sharpens the answer.' },
      force: { type: 'boolean', description: 'For action=generate: re-run even if a plan already exists for this exact deck.' },
    },
  },
  tags: ['read', 'write', 'flow'],
  summary: { zh: '推演这套牌靠什么赢（模型算，卡表算不出来）。', en: 'How this deck actually wins, reasoned by a model.' },
};

/**
 * 她的复盘。
 *
 * 和日记文件的分工要说清（工具描述里也写了）：
 *   · **日记文件自动记事实** —— 结果、血量、哪几手她推的他没听。那些不用她说。
 *   · **这个工具只记判断** —— 为什么输、哪一手是关键、下次怎么看。
 *
 * 为什么要分开：让模型把已经记录在案的数字再抄一遍，它就会用数字把篇幅填满，
 * 而「为什么」那部分反而空着。工具描述里明写「不要复述数字」，就是为了逼它说人话。
 */
const DIARY_DECL: Decl = {
  name: 'hearthstone_diary',
  description:
    'Write the post-match review — why it went the way it did, in your own words. '
    + 'The diary file already records the facts automatically (result, both heroes\' hp, lowest hp, '
    + 'which turns your pick and his play diverged). **Do not restate those numbers** — say what the numbers '
    + 'cannot: why the game turned, which single turn was the hinge, what you would look at differently next time. '
    + 'One entry per match. Write it after a loss or after a clear misjudgement; skip it when nothing stands out — '
    + 'a diary full of "打完了" is worse than an empty one. '
    + 'First person, under 120 characters, no bullet points. This is also what the panel\'s 「她最近想到的」 shows.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: {
        type: 'string',
        description: '你的复盘，第一人称，120 字以内。说「为什么」，不要重复结果和血量。',
      },
      where: {
        type: 'string',
        description: '可选：当时的局面，一句带过（第几回合、对什么职业）。写了对以后翻回来有用。',
      },
    },
    required: ['text'],
  },
  tags: ['write'],
  summary: {
    zh: '每局打完记一段复盘（第一人称）：为什么赢/输、哪一手是关键。面板的感想栏读的就是这里。',
    en: 'Writes her own post-match review; the panel reads it back.',
  },
};

export const HEARTHSTONE_TOOL_DECLS: readonly Decl[] = [STATE_DECL, ADVICE_DECL, DRAFT_DECL, META_DECL, PLAN_DECL, STYLE_DECL, HIS_STYLE_DECL, DIARY_DECL, RECENT_DECL, LAST_GAME_DECL, WATCH_DECL];

export class HearthstoneWorld implements World {
  readonly id = HEARTHSTONE_ID;
  private host: WorldHost | null = null;
  private log: Logger | null = null;
  private readonly parser = new PowerLogParser(nowIso);
  private tail: PowerLogTail | null = null;
  private status: WatchStatus = { phase: 'no-log', path: null, note: '还没开始读日志。' };
  /**
   * start() 时处理 log.config 的结果。
   *
   * 补过（changed=true）就说明这次还没重启过炉石 —— 在用户重启之前，
   * 日志里不可能有对局数据，这时亮红灯是**如实报告**，不是误报。
   */
  private powerLog: PowerLogResult | null = null;
  /**
   * 播放器在不在跑（「听歌时让路」用）。
   *
   * 由定时器维护、`onLines` 里同步读 —— 那边是同步函数，不能在里面 await 列进程。
   * 开关没开时常为 false，探测也直接跳过，不白花这一两百毫秒。
   */
  private musicRunning = false;
  private peerTimer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private lastSnapshot: GameSnapshot | null = null;
  private announcedStart = false;
  private pushedEnd = false;
  /**
   * 这一局的换牌阶段说过了没有。
   *
   * **一局只有一次机会**:换牌窗口短则十几秒,过完 `MULLIGAN_STATE` 就变 DONE,
   * 之后再说「建议换掉哪张」纯属马后炮。所以宁可不提,也不在换完之后补一句。
   */
  private pushedMulligan = false;
  /** 面板「要建议」的序号,只用来让每条事件有自己的 senderKey。 */
  private askSeq = 0;
  /** 日志断供只报一次。轮询是每几百毫秒一次,不设这个会连珠炮。 */
  private logFullNoted = false;
  /** 查过日志上限的安装目录 —— 一次启动只查一遍,别每换一次日志就摸一次别人的配置文件。 */
  private readonly logLimitChecked = new Set<string>();
  /** 每回合记一个点,供复盘。 */
  private timeline: TimelinePoint[] = [];
  private lastRecordedTurn = -1;
  /** 已经报过「轮到我」的最大回合号,避免同回合重复开口。 */
  private lastAnnouncedTurn = -1;
  /**
   * 上一条建议推的是哪张牌，以及它连着被推了几个回合。
   *
   * 2026-10-30 实测：一局里 T11–T19 连着五个回合都推「大力扣杀」，她跟着说了五遍。
   * 根因在 `briefAdvice` —— 它每回合独立算，不知道上回合推过什么。这里在外面记一手，
   * 把「这是第几遍」写进事件正文，她才有依据换说法或者闭嘴。
   */
  private lastAdvicePick = '';
  private advicePickStreak = 0;
  /** 这一局每回合建议推了哪张牌。对局结束时和实际动作合并，写进归档。 */
  private turnAdvice = new Map<number, string>();
  /** 这一局是否已经写进存档,避免结束信号重复触发。 */
  private archivedThisGame = false;
  private readonly archivePath: string;
  /**
   * 风格档案放哪。
   *
   * 和存档、竞技场那些一样落 dataDir —— 这里**故意不引入可同步的记忆目录**：
   * 音乐那边有一份跨设备的口味档案，是因为它的逐日记录本来就要跨设备；
   * 炉石的状态(上一局、牌组、笔记)全在本机，单独给风格开一个同步口子，
   * 只会让「两台机器谁的档案算准」变成一个新问题。要同步的时候，跟这些一起做。
   */
  private readonly styleDir: string;
  /** 对局档案（追加式，留最近 50 局）。 */
  private readonly gamesPath: string;
  /**
   * 已经为她跳过的那几局(指纹)。**一局只庆祝一次。**
   *
   * 必须有这个集合:启动时 tail 会把整份 Power.log 从头放一遍,那一局的结束点必然再出现。
   * 只靠 `pushedEnd` 挡不住 —— 那个标志是内存里的,pushedEnd 一重启就是 false。
   * 结果是每次重启都对着同一场胜利再欢呼一次:第一次是惊喜,第三次是抽风。
   */
  private celebrated = new Set<string>();
  private readonly celebratedPath: string;
  /** 补历史读到的那一局结束,等补完之后再决定要不要为它跳(见 flushPendingEnd)。 */
  private pendingEnd: { result: GameSnapshot['result']; text: string; key: string } | null = null;
  /**
   * 上一次「惊讶」发生在第几回合。
   *
   * 一个回合只惊一次:实测对手一套随机召唤能连着落地三只跨职业随从,
   * 分批推送就是连环三条。惊讶是情绪,不是通报 —— 同一回合第二次就没意思了。
   */
  private lastSurpriseTurn = -1;
  private pendingTimer: ReturnType<typeof setInterval> | null = null;
  /** 已经提醒过日志余量的那几份日志(按路径),记已说到第几档。 */
  /** 已选的竞技场牌(卡 id 或原名),拼成一副牌用来算曲线。 */
  private arenaDeck: string[] = [];
  private readonly arenaPath: string;
  /** 她自己在竞技场里攒的打法笔记:职业 → 内容。见 `hearthstone_meta`。 */
  private arenaMeta: Record<string, { notes: string; savedAt: string }> = {};
  private readonly metaPath: string;
  /**
   * 「这套牌怎么赢」的推演结果 —— 由模型算,不是卡表算的。
   *
   * 存本地是因为它贵:一次调用几秒钟、一点钱。卡组没变就没理由重算,
   * 而选牌过程中她会问很多次「现在这套牌怎么样」。
   */
  private arenaPlan: { text: string; savedAt: string; model: string; heroClass: string; deck: string[] } | null = null;
  private readonly planPath: string;
  /**
   * 模型密钥。**不读 config.json** —— 只从部署 .env 取,和设置界面里存 key 的地方一致。
   * 优先自己的槽位,其次复用 browser 扩展已经填过的那个(用户不必再填一次)。
   */
  private readonly llmKey: string;
  private readonly opts: HearthstoneWorldOptions;

  constructor(opts: HearthstoneWorldOptions) {
    this.opts = opts;
    this.parser.setHistoryLimit(opts.cfg.historySize);
    this.archivePath = join(opts.dataDir, 'hearthstone-last-game.json');
    this.styleDir = opts.dataDir;
    this.gamesPath = join(opts.dataDir, 'hearthstone-games.jsonl');
    this.celebratedPath = join(opts.dataDir, 'hearthstone-celebrated.json');
    this.arenaPath = join(opts.dataDir, 'hearthstone-arena.json');
    this.metaPath = join(opts.dataDir, 'hearthstone-arena-meta.json');
    this.planPath = join(opts.dataDir, 'hearthstone-arena-plan.json');
    this.llmKey = pickKey(opts.secret, [
      'CORTICO_HEARTHSTONE_DEEPSEEK_API_KEY',
      'CORTICO_BROWSER_DEEPSEEK_API_KEY',
      'DEEPSEEK_API_KEY',
    ]);
    this.loadArenaDeck();
    this.loadArenaMeta();
    this.loadArenaPlan();
    this.loadCelebrated();
  }

  /* ---------- 生命周期 ---------- */

  /**
   * 看一眼播放器在不在跑。只在「听歌时让路」打开时才真去查进程列表（win32 是 tasklist，macOS 是 ps）。
   *
   * 单独拿出来是因为 `onLines` 是同步的 —— 那边不能 await，只能读这里维护的字段。
   * 查询失败按「没在跑」处理：宁可多说几句，也不要因为一次查询失败整场闭麦。
   */
  private async probePeers(): Promise<void> {
    if (!this.cfg.yieldToMusic) {
      this.musicRunning = false;
      return;
    }
    this.musicRunning = await isPeerRunning(peerProcessNames());
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log;
    // Power 日志默认是**关的**：开关在用户目录的 log.config 里，很多人从来没建过。
    // 没开的时候炉石只往 Power.log 写错误行，扩展读到的是个空壳——而且不报错，
    // 用户只会看到「她一句话不说」。和上面关日志上限是同一类事：装完即用，别让人翻 ini。
    this.powerLog = ensurePowerLogging();
    if (this.powerLog.problem) {
      this.log?.warn(`炉石的 Power 日志开关没能处理:${this.powerLog.problem}`);
    } else {
      this.log?.info(`Power 日志:${describePowerLogging(this.powerLog)}`);
    }
    // 风格档案：容器先立起来。
    // 建骨架**不算她写东西**，所以这一步不看 styleWritable —— 关了也得有地方给她读，
    // 否则她连「我还没有立场」都不知道，只能临场编一个，比空着更糟。
    ensureStyle(this.styleDir);
    {
      const styleText = readStyle(this.styleDir);
      if (styleText === null) {
        this.log?.warn(`建不了打法档案（${stylePath(this.styleDir)}）：目录写不进去，她这一轮只能凭印象打。`);
      } else {
        const n = styleLineCount(styleText);
        this.log?.info(n
          ? `打法档案 ${n} 条：${stylePath(this.styleDir)}`
          : `打法档案还是空的：${stylePath(this.styleDir)}（她自己会往里添）`);
      }
    }
    // 他的那份：从已有的对局档案里数一遍。
    // 启动时也算一次，理由是跨版本 —— 老记录里没有 turnLog 的、或者归纳逻辑改过的，
    // 不重算就一直是旧结论。写盘那边做了内容比对，没变不会碰文件。
    this.refreshHisStyle();
    if (readHisStyle(this.styleDir) === null) {
      this.log?.warn(`他的打法档案还没建起来（${hisStylePath(this.styleDir)}）——对局档案可能是空的，或者是第一次装。`);
    }
    // 「听歌时让路」用：每 15 秒看一眼播放器在不在（开关没开就直接返回，不白跑进程查询）。
    void this.probePeers();
    this.peerTimer = setInterval(() => void this.probePeers(), 15_000);
    this.peerTimer.unref?.();
    this.parser.setHistoryLimit(this.opts.cfg.historySize);
    this.tail = new PowerLogTail({
      getPath: () => resolvePowerLog({ logPath: this.cfg.logPath, installDir: this.cfg.installDir }),
      onLines: (lines, initial) => this.onLines(lines, initial),
      onSwitch: (path) => this.onSwitch(path),
      onLogFull: (initial) => this.noteLogFull(initial),
      pollMs: () => this.cfg.pollMs,
      log: host.log,
    });
    this.tail.start();
    // 兜底:补历史跑完之后,日志往往就不再变了(那一局已经打完),后续批次不会来,
    // 挂在 pendingEnd 上的那句「赢了」会一直没有机会放出来。给一段宽限时间自己收尾。
    this.armPendingEndTimer();
    // tail 已经定位到文件时不要再调 onSwitch —— 它会二次清空 lastAnnouncedTurn/timeline,
    // 把刚补完的历史和刚算出的状态抹掉。只有它「从无到无」(找不到日志、不会回调)时才自己定位一次。
    if (!this.tail.currentPath) {
      this.onSwitch(resolvePowerLog({ logPath: this.cfg.logPath, installDir: this.cfg.installDir })?.path ?? null);
    }
    // 带版本号的启动行:改了代码但行为没变时,先看这一行就知道跑的到底是不是新代码
    host.log.info(`炉石陪打已启动:开始监视对局日志。(${BUILD_TAG})`);
  }

  async stop(): Promise<void> {
    if (this.peerTimer) {
      clearInterval(this.peerTimer);
      this.peerTimer = null;
    }
    this.tail?.stop();
    this.tail = null;
    this.clearPendingEndTimer();
    await this.chain.catch(() => undefined);
    this.host = null;
    this.log = null;
  }

  /**
   * 等 pendingEnd 出现再收尾,最多等 20 秒。
   *
   * 不用一次性 setTimeout:补历史要多久取决于 Power.log 有多大,写死一个数一定有一头不对。
   * 轮询的开销是每 2 秒看一个空值,忽略不计。
   */
  private armPendingEndTimer(): void {
    this.clearPendingEndTimer();
    let tries = 0;
    this.pendingTimer = setInterval(() => {
      if (this.pendingEnd) { this.flushPendingEnd(); this.clearPendingEndTimer(); return; }
      if (++tries >= 10) this.clearPendingEndTimer();
    }, 2_000);
    this.pendingTimer.unref?.();
  }

  private clearPendingEndTimer(): void {
    if (!this.pendingTimer) return;
    clearInterval(this.pendingTimer);
    this.pendingTimer = null;
  }

  /* ---------- 配置是活引用 ---------- */

  private get cfg(): HearthstoneConfigSection {
    return this.opts.cfg;
  }

  /* ---------- 日志 → 事件 ---------- */

  private onSwitch(path: string | null): void {
    // 换了日志文件:那是新的一局(或炉石重开了),把上一局的状态清干净
    this.lastSnapshot = null;
    this.announcedStart = false;
    this.pushedEnd = false;
    // 这三个也属于「上一局」。尤其是 lastAnnouncedTurn —— 它是严格递增的回合水位,
    // 不清掉的话新日志里第 1 回合落在「1 > 上一局最后回合」的假命题上,整局一句提醒都不会有。
    this.lastAnnouncedTurn = -1;
    this.lastRecordedTurn = -1;
    this.timeline = [];
    this.archivedThisGame = false;
    this.pendingEnd = null;
    // 「上一份日志写满了」是那份文件的事,新文件不该继承。
    // 不清的话:他重启炉石换了新日志,灯还红着,面板还写着「日志停在 14:16」——
    // 明明已经好了,却看起来像坏的。
    this.logFullNoted = false;
    if (path) this.ensureLogLimit(path);
    if (!path) {
      this.status = { phase: 'no-log', path: null, note: `没找到 Power.log。已找过:${describeSearch({ logPath: this.cfg.logPath, installDir: this.cfg.installDir })}` };
      return;
    }
    // 用快照判,不要用 parser.inGame —— 后者只表示「日志里有过一局」,
    // 那局已经打完它也是 true,于是灯一直亮成「进行中」,她也会以为自己还在牌桌上。
    const s = this.parser.snapshot();
    if (s) {
      this.status = {
        phase: s.ended ? 'ended' : 'in-game',
        path,
        note: s.ended ? '这局已经结束。' : `第 ${s.turn} 回合。`,
      };
      return;
    }
    // 文件在、却一行对局数据都没有:要么炉石刚启动还没进对局,要么 Power 日志根本没开。
    // 这两种必须分开 —— 前者一开打就恢复,后者得重启炉石,红灯不能乱亮。
    // 判据用 powerLog.changed:配置是这次才补上的,那就一定还没重启过,亮红灯是如实报告。
    if (looksLikePowerLog(path)) {
      this.status = { phase: 'watching', path, note: '已连上日志。' };
      return;
    }
    const waitingRestart = this.powerLog?.changed === true;
    this.status = {
      phase: waitingRestart ? 'no-log' : 'watching',
      path,
      note: waitingRestart
        ? 'Power 日志之前没开,配置已经补好,重启一次炉石就生效。'
        : '文件在,但里面还没有对局数据——炉石刚启动,或还没进对局。',
    };
  }

  /**
   * 把配置里的「哪一方是你」交给解析器。
   *
   * **这行以前是缺的。** 设置页有这一项、schema 声明了它、`diagnostics()` 里甚至
   * 写好了 `localDetectedBy: 'config'` 这个分支，但 world 从来没把 `cfg.localPlayerId`
   * 传给 parser —— 于是那个下拉框改什么都不发生。用户在身份判反时按提示改了它，
   * 一点用没有，而且没有任何报错。
   *
   * 放在喂日志之前同步，热改就地生效，不用重启。
   */
  private syncLocalPref(): void {
    const raw = this.cfg.localPlayerId;
    this.parser.setLocalPlayerId(raw === '1' ? 1 : raw === '2' ? 2 : null);
  }

  private onLines(lines: string[], initial = false): void {
    // 先同步「哪一方是你」这个配置 —— 热改要就地生效，不能等重启
    this.syncLocalPref();
    let delta;
    try {
      delta = this.parser.feed(lines);
    } catch (error) {
      this.log?.warn(`解析对局日志出错:${(error as Error).message}`);
      return;
    }
    // 补历史告一段落:如果最后那局是刚打完的胜仗,现在才为她跳一下
    if (!initial) this.flushPendingEnd();
    const snapshot = this.parser.snapshot();
    const before = this.lastSnapshot;
    this.lastSnapshot = snapshot;

    // 给桌宠的「现在是不是在打牌」心跳。
    //
    // 用 Symbol 挂在 globalThis 上：两个 World 同住一个 Core 进程，
    // 这是最轻的通道 —— 不用写文件，也不用让桌宠去猜炉石的 dataDir 在哪。
    //
    // 判据是「**快照真的变了**」，不是「快照存在且没结束」：
    // 上一局中途退出时不会留下结束记录，`ended` 会一直是 false，而 tick 会反复
    // 读到同一份快照 —— 只看 ended 的话，Core 一启动她就以为在打牌，
    // 禁行带白开一场（2026-10-29 实测：日志停在 21:46，桌宠那边 skip 仍非 null）。
    //
    // 回合号/血量/手牌数任一变了才算「有新进展」。对局中每回合都会变，
    // 所以心跳能持续；没在打牌时永远不变，心跳自然过期。
    // `initial` 是 Core 启动时的补历史，也不点亮。
    if (!initial) {
      const KEY = Symbol.for('coopanion.hearthstone.liveAt');
      // 判据是「日志尾部还在写回合」。
      //
      // 走过两条弯路,都记在这里:
      //   1. 只看 `ended` —— 中途退出的对局不会写结束记录,ended 一直是 false,
      //      而 tick 反复读同一份旧快照,于是「永远在打牌」。
      //   2. 改看日志文件 mtime —— 更糟:炉石进程开着就会持续写日志(心跳、网络),
      //      实测 22:15 停在主菜单时 Power.log 的 mtime 还是「刚刚」。
      //
      // 真正区分得开的只有内容:对局中每回合都写 `tag=TURN`,主菜单不写。
      // 所以读日志末尾 2KB,看有没有回合标记。打完一局回到菜单,TURN 就从尾部消失。
      // **不再要求快照字段变化。** 同一回合里快照本来就是不变的,
      // 加了那个条件等于「只有换回合才亮」,而心跳要靠每次 tick 续命 ——
      // 结果是一直续不上,禁行带永远不开(2026-10-29 实测:对局中 0 次跳跃)。
      // logTailHasTurn 本身已经足够区分「在对局中」和「在菜单」。
      const live = this.logTailHasTurn();
      (globalThis as Record<symbol, unknown>)[KEY] =
        snapshot && !snapshot.ended && live ? Date.now() : 0;
    }

    if (!snapshot) {
      this.status = { ...this.status, phase: 'watching', note: this.status.note || '日志在跟进,还没遇到对局。' };
      return;
    }

    // 回合号掉回去了 = 换了一局。
    //
    // `delta.gameStarted`（日志里出现 CREATE_GAME）不是总能抓到:启动补历史、或者炉石断线重连时,
    // 第一批进来就已经在一局的中段了。而回合号变小是逃不掉的铁证。
    //
    // 为什么必须清:`lastAnnouncedTurn` 是严格递增的水位,新局从第 1 回合开始,`1 > 16` 是假命题 ——
    // **整局一句提醒都不会有**,要等到回合数超过上一局才恢复。用户看到的就是「打着打着她就不说话了」。
    // 实测:一局打到第 16 回合结束,下一局从 1 到 16 全程哑火。
    this.lastAnnouncedTurn = settleTurnWatermark(this.lastAnnouncedTurn, snapshot.turn);
    if (snapshot.turn < this.lastRecordedTurn) {
      this.lastRecordedTurn = -1;
      this.timeline = [];
    }

    // 每进一个新回合记一个点,复盘时这就是局势曲线。
    // 用 > 而不是 !==:日志里的 TURN 会在结算/复制实体时短暂回退,严格递增才不会出现
    // 「第 16 回合」后面又冒出「第 8 回合」的时间线
    if (snapshot.turn > this.lastRecordedTurn && !snapshot.ended) {
      this.lastRecordedTurn = snapshot.turn;
      this.timeline.push({
        turn: snapshot.turn,
        myHp: snapshot.me.health, myArmor: snapshot.me.armor, myHand: snapshot.me.handCount, myBoard: boardLine(snapshot.me),
        foeHp: snapshot.opponent.health, foeArmor: snapshot.opponent.armor, foeHand: snapshot.opponent.handCount, foeBoard: boardLine(snapshot.opponent),
      });
    }

    const deltaTurn = delta.turnChanged;
    const gameStarted = delta.gameStarted;
    const gameEnded = delta.gameEnded || (snapshot.ended && !this.pushedEnd);

    this.status = {
      phase: snapshot.ended ? 'ended' : 'in-game',
      path: this.status.path,
      note: snapshot.ended ? '这局已经结束。' : `第 ${snapshot.turn} 回合。`,
    };

    // 开局:等双方职业都读出来再报,否则只能说「两个未知职业」
    if (gameStarted) {
      this.announcedStart = false;
      this.pushedEnd = false;
      this.timeline = [];
      this.lastRecordedTurn = -1;
      // 这一条曾经漏了,代价很大:新局的前 N 个回合全部静默(见上面「回合号掉回去」那段)
      this.lastAnnouncedTurn = -1;
      this.archivedThisGame = false;
      this.lastSurpriseTurn = -1;
      this.pushedMulligan = false;
    }
    // 启动时补历史不该开口:那局可能早就打完了,对着一局结束的牌说「对局开始」很怪
    if (!initial && !this.announcedStart && this.readyToAnnounce(snapshot)) {
      this.announcedStart = true;
      // 开局给个「精神起来」的脸:她在气泡里写成 <happy> 之类的行内标记
      this.enqueue(() => this.push('hearthstone.game.start', 'hearthstone.game.start', `[happy]${startText(snapshot)}`, 'flush'));
    }

    // 「听歌时让路」：播放器在跑就按安静处理。让的是**主动解说**这一层（回合提醒、告警），
    // 工具调用和被问时的回答不受影响 —— 让路不等于拒答。
    const quiet = initial || this.cfg.mode === 'quiet' || this.musicRunning;

    // 换牌阶段。**这是这一局唯一一次能改起手的机会**,而扩展以前整段没管:
    // 只在第 1 回合说「对局开始」,那时牌早换完了,她只能对着既成事实点评。
    //
    // 判据用 `MULLIGAN_STATE=INPUT`(起手手牌在那一刻已经全部解析出来,实测有 3-4 张)。
    // 抓不到这个窗口就不提 —— 换完之后再说「建议换掉哪张」是马后炮,比不说更糟。
    if (!quiet && !this.pushedMulligan && isMulliganOpen(snapshot)) {
      const opts = { keepCards: this.cfg.keepCards };
      const fact = mulliganText(snapshot, opts);
      if (fact) {
        const plan = mulliganPlan(snapshot, opts);
        this.pushedMulligan = true;
        const body = plan.text ? `${fact}\n${plan.text}` : fact;
        this.enqueue(() => this.push('hearthstone.mulligan', 'hearthstone.mulligan', `[thinking]${body}`, 'flush'));
      }
    }

    // 回合事件由解析器**逐回合**记下来（每进一次我的行动阶段就记一个点），这里逐个取走再开口。
    //
    // 不能拿「这一批结束时的快照」代表整批 —— 那是以前的写法，也是漏报的病根。
    // 同一份真实日志，只改批大小，实测：
    //   批   400 行 → 报 1,3,5,...,23 共 12 次，全对
    //   批  2000 行 → 只报 7 次，漏 5 个
    //   批  6000 行 → 只报 2 次
    //   批 15000 行 → 一次都不报
    // 因为批末早不是那些回合的局面了：批尾落在对方回合或已结束时，中间所有回合一起被吞。
    // 而 tail 一旦卡顿（文件被占用、休眠唤醒、大日志读得慢），积压就是几万行一起涌进来。
    // 按队列补报与批大小无关，才是稳的。
    if (!quiet && this.cfg.speakTurns && shouldAnnounceTurn(snapshot, this.lastAnnouncedTurn)) {
      const point: TurnPoint = {
        turn: snapshot.turn,
        myHp: snapshot.me.health, myArmor: snapshot.me.armor, myHand: snapshot.me.handCount, myBoard: boardLine(snapshot.me),
        foeHp: snapshot.opponent.health, foeArmor: snapshot.opponent.armor, foeHand: snapshot.opponent.handCount, foeBoard: boardLine(snapshot.opponent),
      };
      // 换局重置：回合数掉回 1 时，连着推的记录不该跨局继承（上一局劝了五遍的那张，
      // 新局第一回合不该接着算）。
      if (snapshot.turn <= 1) {
        this.lastAdvicePick = '';
        this.advicePickStreak = 0;
        this.turnAdvice.clear();
      }
      const composed = composeTurnEvent(point, snapshot, this.cfg.adviceInTurn !== false, this.cfg.keepCards);
      if (!composed.defer) {
        this.lastAnnouncedTurn = snapshot.turn;
        // 记下这回合推的是哪张，对局结束时和实际动作对齐写进归档。
        this.turnAdvice.set(snapshot.turn, advicePick(composed.text));
        const text = this.withRepeatNote(composed.text);
        this.log?.info(`回合提醒:第 ${snapshot.turn} 回合(水晶 ${snapshot.me.mana}/${snapshot.me.manaMax})`);
        this.enqueue(() => this.push('hearthstone.turn', `hearthstone.turn:${snapshot.turn}`, text, 'debounce'));
      }
    }
    // 事件不再从队列取,但队列要清空,免得长期运行堆对象
    this.parser.drainMyTurns();

    // 牌还没发完时快照是空的(双方 0 血、回合 0)。那一瞬间推「我只剩 0 血了」
    // 是纯噪音 —— 实测日志一开就凑齐「低血 + 濒死 + 空场 + 空手」四条。
    // 英雄血量上限读得到,才说明这局真的开始了。
    if (!quiet && this.cfg.speakAlerts && !snapshot.ended
        && snapshot.me.maxHealth > 0 && snapshot.opponent.maxHealth > 0) {
      // 「对手打出了出乎意料的牌」要单独算:它靠的是这一批的新动作 + 场面增量,
      // 快照对比看不出「他刚才做了什么」。一个回合只给一次。
      const surprises = snapshot.turn !== this.lastSurpriseTurn
        ? surpriseAlerts(delta.newActions, before, snapshot)
        : [];

      const fresh = [
        ...detectAlerts({
          before,
          now: snapshot,
          alertHealth: this.cfg.alertHealth,
          swarmCount: this.cfg.swarmCount,
        }),
        ...surprises,
      ].filter((a) => !this.parser.firedAlerts.has(a.id));
      if (surprises.length) this.lastSurpriseTurn = snapshot.turn;
      if (fresh.length) {
        for (const alert of fresh) this.parser.firedAlerts.add(alert.id);
        // 一批里同时发生几件事时合成一条,别把她刷成一串短消息。
        // 每条前面标紧迫度 —— 她据此决定用什么口吻:轻描淡写、上心、还是直说撑不住了。
        // 方括号里:语气·表情。「·」后面那个词是桌宠立绘的表情 id,
        // 她要用 `pet_say` 的 `<表情>` 语法把它插进话里,但不许念出来。
        const text = fresh.map((a) => `〔${TONE_LABEL[toneOf(a)]}·${faceOf(a)}〕${a.text}`).join('\n');
        this.enqueue(() => this.push('hearthstone.alert', `hearthstone.alert:${fresh[0].id}`, text, 'flush'));
      }
    }

    if (gameEnded && !this.pushedEnd) {
      this.pushedEnd = true;
      // 归档不受补历史影响:那一局的数据正是复盘要的
      this.archive(snapshot);
      this.appendGameLog(snapshot);
      const key = gameKey(snapshot);
      const text = endText(snapshot);
      if (initial) {
        // 补历史期间不开口(那局可能早就打完了),先记着,等补完再看日志还新不新鲜
        this.pendingEnd = { result: snapshot.result, text, key };
      } else if (!this.celebrated.has(key)) {
        this.celebrated.add(key);
        this.saveCelebrated();
        // endMarker 决定赢/输/平各用什么表情和动作 —— 输了还跳,比不跳更难看
        const body = `${endMarker(snapshot.result)}${text}${this.reviewPrompt(snapshot)}`;
        this.enqueue(() => this.push('hearthstone.game.end', `hearthstone.game.end:${key}`, body, 'flush'));
      }
    }
  }

  /**
   * 补历史之后,把「刚打完的那一局」的收尾补上。
   *
   * 为什么需要这一条:她所有的开口都发生在日志**新增**的那一刻。而 core 重启时读到的是
   * 已经写完的日志 —— 那一局结束的行早就躺在里面了,不会「再次新增」。所以刚赢完就重启,
   * 她永远等不到那句「赢了」。
   *
   * 两个闸门缺一不可:`celebrated` 挡住重复(重启一次欢呼一次),`logIsFresh` 挡住旧账
   * (昨天赢的那局不该今天开机时突然庆祝)。
   */
  private flushPendingEnd(): void {
    const pending = this.pendingEnd;
    if (!pending) return;
    this.pendingEnd = null;
    if (pending.result !== 'won' || this.celebrated.has(pending.key) || !this.logIsFresh()) return;
    this.celebrated.add(pending.key);
    this.saveCelebrated();
    this.log?.info('补上报一次胜利(重启前刚打完的那局)。');
    // 「我刚重新连上」这句不是客套,是给她的**语义锚**:同一局她在重启前已经收过尾,
    // 不给这个解释,她会把这条判成「world 在重放旧事件」然后闭嘴 —— 实测两次都这样。
    // 说了这句,它才是一条诚实的新事实:她迟到了,现在补一句。
    const text = `我刚重新连上日志,补一句:${pending.text}`;
    this.enqueue(() => this.push('hearthstone.game.end', `hearthstone.game.end:${pending.key}:late`, `${endMarker('won')}${text}`, 'flush'));
  }

  /**
   * 日志最近还在写吗 —— 用来区分「刚打完」和「昨天的旧局」。
   *
   * 半小时是拍的,但有两个闸门兜着:`celebrated` 保证同一局不会再庆祝一次,
   * 所以这里宽一点只会多一次「刚打完就重启」的补报,不会翻出旧账。
   */
  private logIsFresh(minutes = 30): boolean {
    const path = this.status.path;
    if (!path) return false;
    try {
      return Date.now() - statSync(path).mtimeMs < minutes * 60_000;
    } catch {
      return false;
    }
  }

  /** 一局结束就落盘。换局解析器会被清空,这是复盘唯一的来源。 */
  private archive(snapshot: GameSnapshot): void {
    if (this.archivedThisGame) return;
    this.archivedThisGame = true;
    const data: GameArchive = {
      startedAt: snapshot.startedAt,
      endedAt: nowIso(),
      result: snapshot.result,
      turns: snapshot.turn,
      me: { heroClass: snapshot.me.heroClass, name: snapshot.me.heroName },
      opponent: { heroClass: snapshot.opponent.heroClass, name: snapshot.opponent.heroName },
      final: {
        myHp: snapshot.me.health, myArmor: snapshot.me.armor,
        foeHp: snapshot.opponent.health, foeArmor: snapshot.opponent.armor,
      },
      timeline: [...this.timeline],
      actions: this.parser.recent(this.cfg.historySize),
    };
    try {
      writeFileSync(this.archivePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      this.log?.warn(`上一局没能存下来:${(error as Error).message}`);
    }
  }

  /**
   * 追加一行对局档案。
   *
   * **追加式，不是覆盖式** —— 这是它和 `GameArchive` 唯一的本质区别，也说清了为什么要有两份：
   * 存档要的是「上一局的全部细节」，只留一局；档案要的是「最近几十局的走势」，一局一行。
   *
   * 读完整个文件再重写，是因为要裁掉超过 50 局的老记录。50 行的文件，这点开销可以忽略；
   * 用真追加（appendFile）反而没法截断，文件会一年年长下去。
   */
  /**
   * 把「建议推的」和「实际打的」按回合对齐。
   *
   * 只取每回合**第一张**打出的牌：一回合的路线基本由第一张定下来，后面多是补位。
   * 存整串会把归档撑大几倍，而复盘想回答的只有一句 ——
   * 「她推的和他选的，是不是同一条路」。
   */
  private buildTurnLog(): GameLogEntry['turnLog'] {
    const played = new Map<number, string>();
    for (const a of this.parser.recent(this.cfg.historySize)) {
      if (a.who !== 'me' || a.kind !== 'play') continue;
      if (played.has(a.turn)) continue;
      const name = playedCardName(a.text);
      if (!name) continue;
      // **硬币不算「这回合打了什么」。** 它是凑费的过渡动作，不是路线。
      //
      // 2026-11-07 实测：建议「阿米图特，阿米图斯的守护者」(7 费)，他先打硬币再上那张 ——
      // 这是**照建议的第一步在执行**，可 `played` 取的是每回合第一张出的牌，
      // 于是记成「建议阿米图特 / 实际幸运币 / 未采纳」。三处一起坏：
      //   采纳率被系统性低估（他有 5 次打硬币被记成「改打」）；
      //   `his-style.md` 的「没听建议时先打的牌」里混进「幸运币 5 次」——
      //   硬币不体现任何打法偏好，它只是钱；
      //   复盘时看到「他改打幸运币」这种条目，会以为记录坏了。
      if (isCoinCard(a.cardId ?? '') || /幸运币|硬币/.test(name)) continue;
      played.set(a.turn, name);
    }
    const turns = new Set<number>([...this.turnAdvice.keys(), ...played.keys()]);
    return [...turns].sort((a, b) => a - b).map((turn) => {
      const advised = this.turnAdvice.get(turn) || null;
      const playedName = played.get(turn) ?? null;
      // 两张牌名一个来自建议、一个来自动作记录,长度常常不同(全名 vs 简称)——
      // 结论在这里算好,别留给读 json 的人自己比字符串。
      return { turn, advised, played: playedName, agreed: sameCardName(advised, playedName) };
    });
  }

  private appendGameLog(snapshot: GameSnapshot): void {
    let lowHp = snapshot.me.health;
    for (const t of this.timeline) if (t.myHp < lowHp) lowHp = t.myHp;

    const entry: GameLogEntry = {
      startedAt: snapshot.startedAt,
      endedAt: nowIso(),
      result: snapshot.result,
      turns: snapshot.turn,
      me: { heroClass: snapshot.me.heroClass, name: snapshot.me.heroName },
      opponent: { heroClass: snapshot.opponent.heroClass, name: snapshot.opponent.heroName },
      final: {
        myHp: snapshot.me.health, myArmor: snapshot.me.armor,
        foeHp: snapshot.opponent.health, foeArmor: snapshot.opponent.armor,
      },
      lowHp,
      turnLog: this.buildTurnLog(),
    };

    let lines: string[] = [];
    try {
      if (existsSync(this.gamesPath)) {
        lines = readFileSync(this.gamesPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      }
    } catch (error) {
      lines = [];
      this.log?.warn(`读对局档案失败（这次会覆盖写）:${(error as Error).message}`);
    }

    lines.push(JSON.stringify(entry));
    // 重复触发要挡住：启动补历史时 tail 会把整份 Power.log 从头放一遍，
    // 上一局的结束点必然再出现一次。存档那边靠 `archivedThisGame`（内存标志）挡，
    // 可那是进程级的 —— 重启之后标志清零，同一局会被再记一行。
    // 档案是长期累积的，多记一行不会报错，只会让「最近几局」越来越假。
    // 所以这里按「起始时刻 + 回合数」比对最后一行：同一局只会有一个这样的组合。
    if (lines.length >= 2) {
      try {
        const prev = JSON.parse(lines[lines.length - 2]) as GameLogEntry;
        if (prev?.startedAt === entry.startedAt && prev?.turns === entry.turns) {
          lines.pop();
          return;
        }
      } catch { /* 上一行坏了就不比对，照常记 */ }
    }
    if (lines.length > GAMES_KEEP) lines = lines.slice(-GAMES_KEEP);

    try {
      writeFileSync(this.gamesPath, `${lines.join('\n')}\n`, 'utf8');
    } catch (error) {
      // 存不下不能影响陪打 —— 这是复盘用的旁路，不是主路径。
      this.log?.warn(`对局档案没能追加:${(error as Error).message}`);
    }

    // 一局打完顺手重算「他习惯怎么打」。放在这里而不是每次读提示词时算：
    // 数出来的东西一局才变一次，没必要每轮巡检都过一遍 50 局。
    this.refreshHisStyle();
    this.writeDiary(entry);
  }

  /**
   * 输了才提一句「要不要记下来」。
   *
   * 为什么不每局都催：赢的局她本来就会说两句，再催就变成打卡；
   * 输的局才真有东西可复盘。而且「凑数的日记比空的好不了」这句必须写进去 ——
   * `hearthstone-style.md` 建了七天、打了五十局、一条没写，就是只给了「该写什么」、
   * 没给「现在该写了」；反过来天天催，又会攒出一堆「打完了」。
   */
  private reviewPrompt(snapshot: GameSnapshot): string {
    if (snapshot.result !== 'lost') return '';
    return '\n（这局输了。要是有值得记的，用 `hearthstone_diary` 写一句为什么 —— 没什么可说就别写，凑数的日记比空的好不了。）';
  }

  /**
   * 面板上按了「这局你来打」。
   *
   * **这不是授权，是叫她过来问一句。** 宿主的规矩把「用电脑的理由」限定在桌宠那边
   * 使用者的回答上，面板按钮属于炉石这个 World，算不了数。
   * 所以这里只推一个事件，她收到之后 `pet_ask`，他答了才算答应。
   *
   * 把当前局面带进事件里：她问的时候能顺口说「现在第 9 回合，我 12 血 / 他 20 血」，
   * 比光问一句「这局我来打？」有用得多 —— 他据此判断要不要交出去。
   */
  private panelSelfPlay(): { ok: boolean } {
    const snap = this.lastSnapshot ?? this.parser.snapshot();
    const live = snap && !snap.ended && snap.turn > 0;
    const where = live
      ? `现在是第 ${snap!.turn} 回合，我 ${snap!.me.health + snap!.me.armor} 血 / 对手 ${snap!.opponent.health + snap!.opponent.armor} 血。`
      : '现在没有进行中的对局 —— 跟他说一声，等开局再打。';
    const text = `${live ? '[eager]' : '[thinking]'}他在面板上按了「这局你来打」。${where}\n`
      + '先用 `pet_ask` 问一句（带上局面），他答应了再动手；没答应就当没这回事。';
    this.enqueue(() => this.push('hearthstone.selfplay', `hearthstone.selfplay:${Date.now()}`, text, 'flush'));
    return { ok: true };
  }

  /**
   * 复盘日记存哪：配置里填了就用它（通常是同步盘），否则放数据目录。 */
  private diaryDir(): string {    const configured = (this.cfg.diaryDir ?? '').trim();
    return configured || join(this.styleDir, 'hearthstone-diary');
  }

  /**
   * 写这一局的复盘。
   *
   * 只写**对局记录里读得出来的事实** —— 结果、血量、最低血、她推的和他打的哪几手对不上。
   * 「为什么输」那部分是判断，留给她的工具（`hearthstone_diary`）补，
   * 模板替她编一句，三个月后翻回来一个字都不认得。
   *
   * 失败只写日志：日记是旁路，不能影响陪打。
   */
  private writeDiary(entry: GameLogEntry): void {
    const log = entry.turnLog ?? [];
    const decided = log.filter((d) => d.agreed === true || d.agreed === false);
    const splits = log
      .filter((d) => d.agreed === false && d.advised && d.played)
      .map((d) => ({ turn: d.turn, advised: String(d.advised), played: String(d.played) }));
    const res = appendDiary(this.diaryDir(), {
      at: entry.endedAt,
      result: entry.result,
      turns: entry.turns,
      me: {
        cls: entry.me.heroClass ?? '',
        hp: entry.final.myHp,
        lowHp: entry.lowHp ?? entry.final.myHp,
        armor: entry.final.myArmor,
      },
      foe: { cls: entry.opponent.heroClass ?? '', hp: entry.final.foeHp, armor: entry.final.foeArmor },
      decisions: decided.length,
      agreed: decided.filter((d) => d.agreed === true).length,
      splits,
    });
    if (!res.ok) this.log?.warn(`复盘日记没写成：${res.error}`);
    else this.log?.info(`复盘日记 +1：${res.path}`);
  }

  /**
   * 她写一段复盘。
   *
   * 两处落：感想栏（面板读）+ 当天日记的末尾（人翻文件时看得见）。
   * 回执里报了「第几条」——她因此知道这份东西在累积，而不是说完就散了。
   */
  private diaryReceipt(args: Record<string, unknown>): string {
    const text = String(args?.text ?? '').trim();
    if (!text) return '没写内容。这里要记的是「为什么」，不是「打完了」。';
    // 工具描述里写了 120 字，但模型不总会守。超了不拒收 —— 拒收等于什么都不记。
    const body = text.length > 240 ? `${text.slice(0, 240)}…` : text;
    const dir = this.diaryDir();
    const at = nowIso();
    const where = String(args?.where ?? '').trim() || undefined;

    const saved = appendThought(dir, { at, text: body, where });
    if (!saved.ok) return `没存上：${saved.error}`;
    const noted = appendDiaryNote(dir, at, body);
    if (!noted.ok) this.log?.warn(`感想存了，但没挂进日记：${noted.error}`);

    const count = readThoughts(dir, 500).length;
    return `记下了（第 ${count} 条）。${where ? `局面：${where}。` : ''}面板「她最近想到的」和当天的日记里都能看到。`;
  }

  /**
   * 真实打过多少局（假数据已被 summarize 的时长闸挡掉）。
   *
   * 只给「该不该催她写立场」用。50 行 JSON 每轮解析一次可以忽略 ——
   * 提示词是几分钟才重建一次，不是每 400ms。
   */
  private playedGameCount(): number {
    return summarize(this.loadRecentGames()).games;
  }

  /**
   * 「他打牌是什么样」的侧写 —— 用**她自己的立场**说话时也带上。
   *
   * 挂在她那份后面，不挂在「他的立场」下面：知道对方是什么习惯，
   * 和「用对方的立场说话」是两件事。前者影响分寸，后者换掉判断权。
   */
  private habitNote(): string {
    const games = this.loadRecentGames();
    if (!games.length) return '';
    return hisHabitNote(summarize(games));
  }

  /**
   * 重算他的打法档案。
   *
   * 失败也不出声到对话里 —— 这是陪打的旁路。但日志要留痕，
   * 否则「切到他的立场却什么都没变」会被当成按钮坏了。
   */
  private refreshHisStyle(): void {
    const stats = summarize(this.loadRecentGames());
    const ok = writeHisStyle(this.styleDir, stats);
    if (!ok) {
      this.log?.warn(`他的打法档案写不进去（${hisStylePath(this.styleDir)}），「站在他的立场」这一档会读到旧数据。`);
    }
  }

  /** 读对局档案，新的在后。坏行直接跳过 —— 半行 JSON 不该让整份档案读不出来。 */
  private loadRecentGames(): GameLogEntry[] {
    try {
      if (!existsSync(this.gamesPath)) return [];
      const out: GameLogEntry[] = [];
      for (const line of readFileSync(this.gamesPath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as GameLogEntry;
          if (o && typeof o.turns === 'number' && typeof o.result === 'string') out.push(o);
        } catch { /* 跳过坏行 */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 最近几局的战绩，给提示词用。
   *
   * **只给摘要，不给整局明细** —— 她需要的是「他最近打得怎么样」这个判断，
   * 不是每局的出牌顺序。整局明细去 `hearthstone_last_game` 里取。
   */
  private recentGamesText(): string {
    const games = this.loadRecentGames();
    if (!games.length) return '还没打完过一局（或者档案是新建的）。';
    const label = (r: GameLogEntry['result']): string => (r === 'won' ? '胜' : r === 'lost' ? '负' : '平');
    const wins = games.filter((g) => g.result === 'won').length;
    const last5 = games.slice(-5).reverse().map((g) => {
      const foe = g.opponent.heroClass || '未知职业';
      return `  - ${label(g.result)} · ${g.turns} 回合 · 对${foe} · 最低 ${g.lowHp} 血`;
    });
    return `最近 ${games.length} 局里赢了 ${wins} 局（新的在上）：\n${last5.join('\n')}\n`
      + '（整局明细用 `hearthstone_last_game`；这里只有结果，别据此编过程。）';
  }

  /**
   * 同一张牌连着推了几个回合，就在正文末尾补一句「这是第几遍」。
   *
   * 为什么不只在提示词里定规矩：那条是抽象的（「同一个建议说两遍就够」），
   * 她得自己判断「这条算不算重复」。写进正文就变成具体事实 ——
   * 「大力扣杀你已经推了 3 个回合，他没打」—— 她照着做就行。
   *
   * 第 3 遍起才提示：前两遍本来就该说，第三遍开始才是唠叨。
   */
  private withRepeatNote(text: string): string {
    const pick = advicePick(text);
    // 这回合没有「按费打/先换」类建议（危险、空过、换牌），不算重复。
    // **但不清零** —— 中间插一个危险回合、之后又回到同一张牌，那仍然是连着劝。
    if (!pick) return text;

    if (pick === this.lastAdvicePick) {
      this.advicePickStreak += 1;
    } else {
      this.lastAdvicePick = pick;
      this.advicePickStreak = 1;
    }
    if (this.advicePickStreak < 3) return text;

    return `${text}\n（**「${pick}」你已经连着推了 ${this.advicePickStreak} 个回合，他没打。** `
      + '第二遍还能换个角度说，这一遍再念同一句就是唠叨了 —— '
      + '要么给他一个跟之前不同的理由，要么只说这回合的场面，把选择留给他。他真没听见会问你。）';
  }

  /**
   * 日志末尾还在不在「一局之中」。
   *
   * 这是判断「现在是不是真在打牌」唯一靠得住的办法 —— 见上面心跳处的注释,
   * `ended` 和文件 mtime 两条路都被实测证伪了（炉石开着主菜单也一直在写日志）。
   *
   * 判据不是「尾巴里有没有 TURN」,而是**最后一个 TURN 在最后一局结束之后**：
   *   · 对局中:上一个 COMPLETE 之后已经写了好多 TURN → 真
   *   · 打完回菜单:最后一条是 COMPLETE,后面没有 TURN → 假
   *
   * 窗口取 64KB。取 2KB 会误判 —— 日志单行就一两百字节,2KB 只有十几行,
   * 最近的 TURN 常常在窗口之外(2026-10-29 实测:明明还在对局中却判成 false)。
   */
  private logTailHasTurn(): boolean {
    const path = this.tail?.currentPath;
    if (!path) return false;
    const WINDOW = 65_536;
    let fd = -1;
    try {
      const size = statSync(path).size;
      const from = Math.max(0, size - WINDOW);
      const len = size - from;
      if (len <= 0) return false;
      const buf = Buffer.allocUnsafe(len);
      fd = openSync(path, 'r');
      readSync(fd, buf, 0, len, from);
      const tail = buf.toString('latin1');
      const turn = tail.lastIndexOf('tag=TURN value=');
      if (turn < 0) return false;
      const ended = tail.lastIndexOf('tag=STATE value=COMPLETE');
      return turn > ended;
    } catch {
      return false;
    } finally {
      if (fd >= 0) try { closeSync(fd); } catch { /* 关不掉就算了 */ }
    }
  }

  private readArchive(): GameArchive | null {
    try {
      return JSON.parse(readFileSync(this.archivePath, 'utf8')) as GameArchive;
    } catch {
      return null;
    }
  }

  private loadCelebrated(): void {
    try {
      const raw = JSON.parse(readFileSync(this.celebratedPath, 'utf8')) as { keys?: unknown };
      const keys = Array.isArray(raw.keys) ? raw.keys.filter((k): k is string => typeof k === 'string') : [];
      this.celebrated = new Set(keys.slice(-CELEBRATED_KEEP));
    } catch {
      this.celebrated = new Set();
    }
  }

  private saveCelebrated(): void {
    try {
      writeFileSync(this.celebratedPath, JSON.stringify({ keys: [...this.celebrated].slice(-CELEBRATED_KEEP) }, null, 2), 'utf8');
    } catch (error) {
      this.log?.warn(`庆祝记录没能存下来:${(error as Error).message}`);
    }
  }

  /* ---------- 竞技场选牌 ---------- */

  private loadArenaDeck(): void {
    try {
      const raw = JSON.parse(readFileSync(this.arenaPath, 'utf8')) as { cards?: string[] };
      this.arenaDeck = Array.isArray(raw.cards) ? raw.cards.filter((x) => typeof x === 'string') : [];
    } catch {
      this.arenaDeck = [];
    }
  }

  private saveArenaDeck(): void {
    try {
      writeFileSync(this.arenaPath, JSON.stringify({ cards: this.arenaDeck }, null, 2), 'utf8');
    } catch (error) {
      this.log?.warn(`竞技场牌组没能存下来:${(error as Error).message}`);
    }
  }

  /* ---------- 竞技场打法笔记 ---------- */

  private loadArenaMeta(): void {
    try {
      const raw = JSON.parse(readFileSync(this.metaPath, 'utf8')) as Record<string, unknown>;
      const next: Record<string, { notes: string; savedAt: string; deck: string[] }> = {};
      for (const [cls, value] of Object.entries(raw ?? {})) {
        const v = value as { notes?: unknown; savedAt?: unknown; deck?: unknown };
        if (typeof v?.notes !== 'string' || !v.notes.trim()) continue;
        next[cls] = {
          notes: v.notes,
          savedAt: typeof v.savedAt === 'string' ? v.savedAt : '',
          deck: Array.isArray(v.deck) ? v.deck.filter((x): x is string => typeof x === 'string') : [],
        };
      }
      this.arenaMeta = next;
    } catch {
      this.arenaMeta = {};
    }
  }

  private saveArenaMeta(): void {
    try {
      writeFileSync(this.metaPath, JSON.stringify(this.arenaMeta, null, 2), 'utf8');
    } catch (error) {
      this.log?.warn(`打法笔记没能存下来:${(error as Error).message}`);
    }
  }

  /**
   * 打法笔记的读写。
   *
   * 为什么要有这个东西:卡表里有费、有身材、有摘要,**唯独没有「什么牌真的能赢」**。
   * 那份知识只在网上,而她不联网就看不到。而每次选牌都搜一遍是不可能的:
   * 一个 run 三十来次选牌,搜三十次既慢又烧钱。
   *
   * 所以:搜一次 → 提炼成几条 → 存这里 → 之后每次选牌先读本地的。
   * 只有**同一套牌里的选牌**才复用;换了牌组或换了职业就得重搜 —— 那个判断由
   * 存下来的卡组快照做(见 `metaReceipt` 的时效检查)。
   */
  private metaReceipt(args: Record<string, unknown>): string {
    const action = typeof args.action === 'string' ? args.action : 'read';
    const cls = typeof args.heroClass === 'string' ? args.heroClass.trim() : '';

    if (action === 'clear') {
      if (!cls) {
        const had = Object.keys(this.arenaMeta).length;
        this.arenaMeta = {};
        this.saveArenaMeta();
        return had ? `已清掉全部 ${had} 份打法笔记。` : '本来就没有笔记。';
      }
      const gone = this.arenaMeta[cls];
      delete this.arenaMeta[cls];
      this.saveArenaMeta();
      return gone ? `已清掉「${cls}」的打法笔记。` : `「${cls}」本来就没有笔记。`;
    }

    if (action === 'save') {
      if (!cls) return 'save 要带上 heroClass（职业名，比如 德鲁伊）。';
      const notes = typeof args.notes === 'string' ? args.notes.trim() : '';
      if (!notes) return 'save 要带上 notes —— 你搜完之后提炼的那几条。空着存进来等于什么都没记。';
      this.arenaMeta[cls] = { notes, savedAt: new Date().toISOString(), deck: [...this.arenaDeck] };
      this.saveArenaMeta();
      const deckNote = this.arenaDeck.length ? `（同时记下当时的 ${this.arenaDeck.length} 张牌，用来判断以后是不是同一套）` : '（当前还没有牌组快照，以后读的时候没法核对是否同一套）';
      return `已存「${cls}」的打法笔记，${notes.length} 字。${deckNote}\n以后选这个职业先读这条，不用再搜。`;
    }

    // ---- read ----
    if (!cls) {
      const keys = Object.keys(this.arenaMeta);
      if (!keys.length) {
        return '还没有任何打法笔记。第一次选牌时：用 browser_search 搜一次「炉石 竞技场 <职业> 选牌/胜率」，'
          + '把能用的 3-6 条提炼出来，用 hearthstone_meta save 存下。之后都是读本地，不用重复搜。';
      }
      return `已有笔记：${keys.map((k) => `${k}（${this.arenaMeta[k].savedAt.slice(0, 10) || '时间未知'}）`).join('、')}。\n`
        + '带上 heroClass 读具体内容。';
    }

    const hit = this.arenaMeta[cls];
    if (!hit) {
      return `「${cls}」还没有打法笔记。\n`
        + '现在搜一次就够：browser_search 查「炉石 竞技场 ' + cls + ' 选牌」或「Hearthstone arena ' + cls + ' tier list」，'
        + '把能立刻用的 3-6 条提炼出来（哪些牌优先、这套牌想干什么、要避开什么），'
        + '然后 hearthstone_meta save 存进来。**一整个 run 只搜这一次**，之后都是读本地。';
    }

    const lines = [`【${cls} 打法笔记】存于 ${hit.savedAt ? hit.savedAt.slice(0, 16).replace('T', ' ') : '时间未知'}`, hit.notes, ''];

    // 时效检查:这份笔记是对着哪套牌记的,现在还作数吗
    if (!hit.deck.length) {
      lines.push('（这份笔记没留卡组快照，判断不了是不是同一套牌 —— 觉得对不上就重搜。）');
    } else if (!this.arenaDeck.length) {
      lines.push(`（这份笔记是上一套 ${hit.deck.length} 张牌时记的；现在还没有新牌组，思路先照着用。换了牌组记得重搜。）`);
    } else {
      // 牌组里存的是 cardId,给他看的必须是卡名 —— 冒一串 CS2_029 没有信息量
      const missing = missingCounts(hit.deck, this.arenaDeck)
        .map((id) => resolveArenaCard(id)?.name ?? id);
      if (missing.length) {
        lines.push(`⚠ 跟你现在的牌组对不上：记笔记时有的 ${missing.join('、')} 已经不在当前牌组里了。`
          + '要么用 hearthstone_meta save 重新存一份，要么只取里面跟具体牌无关的思路。');
      } else {
        lines.push(`✓ 同一套牌（记笔记时 ${hit.deck.length} 张，现在 ${this.arenaDeck.length} 张，都是它的组成部分）。直接按这份打。`);
      }
    }
    return lines.join('\n');
  }

  /* ---------- 「这套牌怎么赢」的推演 ---------- */

  private loadArenaPlan(): void {
    try {
      const raw = JSON.parse(readFileSync(this.planPath, 'utf8')) as Record<string, unknown>;
      if (typeof raw?.text !== 'string' || !raw.text.trim()) { this.arenaPlan = null; return; }
      this.arenaPlan = {
        text: raw.text,
        savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        heroClass: typeof raw.heroClass === 'string' ? raw.heroClass : '',
        deck: Array.isArray(raw.deck) ? raw.deck.filter((x): x is string => typeof x === 'string') : [],
      };
    } catch {
      this.arenaPlan = null;
    }
  }

  private saveArenaPlan(): void {
    try {
      writeFileSync(this.planPath, JSON.stringify(this.arenaPlan, null, 2), 'utf8');
    } catch (error) {
      this.log?.warn(`牌组推演没能存下来:${(error as Error).message}`);
    }
  }

  /**
   * 「这套牌靠什么赢」—— 交给模型推,卡表算不出来。
   *
   * 卡表能算平均费、数解场、看曲线,但算不出「这 30 张凑在一起是个什么东西」。
   * 那一步需要有人把每张牌放到一起看,再判断该往哪个方向打 —— 模型干这个比阈值判断强。
   *
   * **贵,所以只在需要时调**:牌组没变就直接给上次的结果,除非显式 force。
   * 选牌过程中她会问很多次「现在怎么样」,每次都重算既慢又烧钱。
   */
  /**
   * 她自己那份打法档案。
   *
   * 读的时候要把「它管不了什么」再说一遍 —— 光在提示词里说不够：她刚写完
   * 「我偏爱控制」，下一回合就容易拿这句去盖掉算出来的斩杀。两边都提，才压得住。
   */
  private styleReceipt(args: Record<string, unknown>): string {
    const add = typeof args.add === 'string' ? args.add.trim() : '';
    const drop = typeof args.drop === 'string' ? args.drop.trim() : '';

    if (add || drop) {
      if (!this.cfg.styleWritable) {
        return '使用者关掉了「允许她自己改打法档案」，所以没写。要开的话让他在设置里打开。';
      }
    }

    if (add) {
      const section = args.section;
      if (!isStyleSection(section)) {
        return '要写进哪一节？who（我在牌桌上是什么人）/ push（我倾向这么打）/ '
          + 'dislike（我看不惯的打法）/ unsure（还没想明白）—— 加上 section 再写一次。';
      }
      return addStyleLine(this.styleDir, section, add).message;
    }

    if (drop) return dropStyleLine(this.styleDir, drop).message;

    // 读的时候顺手把骨架立起来 —— 别依赖 start() 一定先跑过。
    // 否则在极端时序下她会读到一句「按说该建一个」，那看起来像故障，其实只是还没轮到。
    ensureStyle(this.styleDir);
    const text = readStyle(this.styleDir);
    if (text === null) {
      return `还没有打法档案，而且建不进去 —— 路径是 ${stylePath(this.styleDir)}。`
        + '写不进去的话她这一轮只能凭印象说，别装作有立场。';
    }
    const n = styleLineCount(text);
    if (n === 0) {
      return '【我怎么打牌】空的，一条都没写。\n\n'
        + '这不是故障：说明你还没有立场。别为了「有档案」临时编一条 —— 空着不丢人。\n'
        + '等哪一局你发现自己确实是这么想的，再写第一条：一条一行、第一人称、不超过 60 字，'
        + '选一节 who / push / dislike / unsure。\n'
        + '也别把 hearthstone_meta 的结论抄进来 —— 那是别人的结论，不是你的立场。\n\n'
        + `全文在 ${stylePath(this.styleDir)}，人也能直接改。`;
    }
    return `【我怎么打牌】${n} 条，第一人称\n\n${text}\n\n`
      + '这份东西只管两件事：**怎么说**、**先推哪条**。算出来的斩杀、墙、群伤它管不了 —— '
      + '别拿自己的偏好去盖数学。';
  }

  /**
   * 他那份「习惯怎么打」。
   *
   * 读的时候必须连样本量一起给 —— 「按建议打 68%」在一个 6 个决策点的样本上
   * 和在一个 400 个决策点上的样本上，完全是两回事。她会拿去说给人听，
   * 所以这个数怎么来的，也得一起说出来。
   */
  private hisStyleReceipt(args: Record<string, unknown>): string {
    const add = typeof args.add === 'string' ? args.add.trim() : '';
    if (add) {
      if (!this.cfg.styleWritable) {
        return '使用者关掉了「允许她自己改打法档案」，所以没写。要开的话让他在设置里打开。';
      }
      return addHisLine(this.styleDir, add).message;
    }

    const text = readHisStyle(this.styleDir);
    if (text === null) {
      return '他那份还没建起来 —— 没打完过一局就没有可数的东西。\n'
        + `（档案会在每局结束后自动生成，路径 ${hisStylePath(this.styleDir)}）\n`
        + '这时候别猜他习惯怎么打，直说「还没数出来」。';
    }
    const stats = summarize(this.loadRecentGames());
    // 够不够样本这件事不在这里再判一遍 —— 文件里已经写着（renderStats 会写「不够」或「偏少」）。
    // 两处各判一次，早晚会出现「文件说不够、回执说够」这种自相矛盾。
    return `【他习惯怎么打】从 ${stats.games} 局里数出来的\n\n${text}\n\n`
      + '这些是**相关，不是因果**：赢的局采纳率高，不等于听建议就能赢。'
      + '而且它只说明**他实际怎么选**，不说明那样选就对。\n'
      + '算出来的斩杀、墙、群伤照旧以 hearthstone_advice 为准，'
      + '他习惯怎么打不能拿来盖掉这一回合的数字。';
  }

  private async planReceipt(args: Record<string, unknown>): Promise<string> {
    const action = typeof args.action === 'string' ? args.action : 'read';

    if (action === 'clear') {
      const had = this.arenaPlan !== null;
      this.arenaPlan = null;
      this.saveArenaPlan();
      return had ? '已清掉上次的推演结果。' : '本来就没有推演结果。';
    }

    if (action !== 'generate') {
      if (!this.arenaPlan) {
        return '还没推过这套牌怎么赢。用 hearthstone_plan(action="generate") 跑一次 —— '
          + '它会把整套牌交给模型，按规则推一遍该往哪个方向打。一次调用几秒，卡组不变就不用重跑。';
      }
      const lines = [
        `【这套牌怎么赢】${this.arenaPlan.model || '模型'} 推的，不是卡表算的`
        + `（${this.arenaPlan.savedAt ? this.arenaPlan.savedAt.slice(0, 16).replace('T', ' ') : '时间未知'}`
        + `${this.arenaPlan.heroClass ? ` · ${this.arenaPlan.heroClass}` : ''}）`,
        '',
        this.arenaPlan.text,
        '',
      ];
      if (this.arenaPlan.deck.length && this.arenaDeck.length) {
        const missing = missingCounts(this.arenaPlan.deck, this.arenaDeck)
          .map((id) => resolveArenaCard(id)?.name ?? id);
        lines.push(missing.length
          ? `⚠ 牌组已经变了（推的时候有的 ${missing.join('、')} 现在不在了）。要按新牌组重推：hearthstone_plan action=generate force=true。`
          : `✓ 还是推这套牌时的牌组（推的时候 ${this.arenaPlan.deck.length} 张，现在 ${this.arenaDeck.length} 张）。`);
      } else {
        lines.push('（推的时候没有牌组快照，判断不了是不是同一套。）');
      }
      return lines.join('\n');
    }

    // ---- generate ----
    if (!this.arenaDeck.length) {
      return '还没有牌组快照 —— 先用 hearthstone_draft 把选到的牌记下来（一张张 pick），'
        + '有牌才能推「这套牌怎么赢」。';
    }

    const sameDeck = this.arenaPlan && this.arenaPlan.deck.length === this.arenaDeck.length
      && missingCounts(this.arenaPlan.deck, this.arenaDeck).length === 0;
    if (!args.force && sameDeck) {
      return '牌组跟上次推的时候一模一样，不重复花钱了。要重推就带 force=true。\n\n'
        + `【上次的结论】\n${this.arenaPlan!.text}`;
    }

    const cfg = this.llmConfig();
    if (!cfg) {
      return '模型没配（worlds.hearthstone.llmModel 和密钥）。没模型也能打 —— '
        + '只是「这套牌怎么赢」得靠你自己看牌组推，工具这边只给得出曲线和构成。';
    }

    const heroClass = typeof args.heroClass === 'string' ? args.heroClass.trim() : '';
    const built = deckListForModel(this.arenaDeck);
    const system = [
      '你是炉石传说竞技场教练。给你一套刚选完的牌，你要说清它靠什么赢。',
      RULES_FOR_MODEL,
      '输出要求：',
      '- 中文，250 字以内。不要客套，不要复述输入。',
      '- 第一句必须定性：快攻 / 中速 / 控制，并给一句理由（看曲线和单卡质量）。',
      '- 然后 2–3 条主线，每条都要落到**这套牌里真实存在的牌名**上，不要讲空道理。',
      '- 最后一句：这套牌最怕什么。',
      '- 不确定的牌效直说不确定，不要编。',
    ].join('\n');
    const user = [
      heroClass ? `职业：${heroClass}` : '职业：未知（按牌面判断）',
      `牌组 ${this.arenaDeck.length} 张：`,
      built.cards,
      '',
      `曲线：${built.curve}；平均 ${built.stats.averageCost} 费；随从 ${built.stats.minions} / 法术 ${built.stats.spells}；解场 ${built.stats.removal}（群体 ${built.stats.aoe}）。`,
      heroClass ? '' : '注意：竞技场卡组可能跨职业，别按单一职业的思路套。',
    ].filter((x) => x !== undefined).join('\n');

    const text = await askModel(cfg, { system, user, maxTokens: 800, temperature: 0.4, timeoutMs: 25000 });
    if (!text || !text.trim()) {
      return '模型没返回（超时、限流或网络问题）。这次没花钱存下任何结论 —— '
        + '稍后可以再试；规则给的对局建议不受影响。';
    }

    this.arenaPlan = {
      text: text.trim(),
      savedAt: new Date().toISOString(),
      model: cfg.model,
      heroClass,
      deck: [...this.arenaDeck],
    };
    this.saveArenaPlan();

    return [
      `【这套牌怎么赢】${cfg.model} 按炉石规则推的（已存本地，牌组不变不用重跑）`,
      '',
      this.arenaPlan.text,
      '',
      `依据：${this.arenaDeck.length} 张 · 平均 ${built.stats.averageCost} 费 · 随从 ${built.stats.minions} / 法术 ${built.stats.spells} · 解场 ${built.stats.removal}。`,
      '这是推演不是判决 —— 你不同意就说出为什么，别照着念。',
    ].join('\n');
  }

  /**
   * 选牌回执。
   *
   * 有一点必须守住:**候选牌是从用户那里来的,不是日志**。竞技场的选牌内容不进
   * Power.log(`[Arena]` 通道只记对局相关的元信息),所以这里不假装能自己读到。
   */
  private draftReceipt(args: Record<string, unknown>): string {
    if (args.reset === true) {
      this.arenaDeck = [];
      this.saveArenaDeck();
      return '竞技场牌组已清空,下一轮从头记。';
    }

    // 竞技场的完整流程跟着回执走，不占常驻提示词 —— 见 arena.ts 里 ARENA_GUIDE 的注释。
    // 每次都带：选牌是密集操作（一轮三十次），规则时刻在手边比「见第一次回执」可靠，
    // 而它只在选牌那几分钟出现。
    const lines: string[] = [ARENA_GUIDE, ''];

    const options = Array.isArray(args.options)
      ? args.options.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
      : [];
    const pick = typeof args.pick === 'string' && args.pick.trim() ? args.pick.trim() : null;

    if (options.length === 1) {
      lines.push('提示:只收到一张候选。竞技场是几选一,把另外两张也给我会比较有意义。');
    }

    // 先记下这一选,再渲染 —— 这样曲线里已经包含刚拿的这张
    if (pick) {
      const card = resolveArenaCard(pick);
      const stored = card?.found ? card.id : pick;
      this.arenaDeck.push(stored);
      this.saveArenaDeck();
      const stats = deckStats(this.arenaDeck);
      if (card?.found) {
        // 形近命中必须写清「你报的是 X，我按 Y 算的」—— 悄悄替换成另一张牌，
        // 比查不到更糟：他看不到改了什么，还以为记对了。
        const via = card.matchedBy === 'fuzzy' ? `——你报的是「${pick}」，按「${card.name}」算的` : '';
        lines.push(`已记下第 ${stats.count} 张:${card.name}(${card.cost} 费 ${card.type})${via}`);
      } else {
        // 查不到时给候选，别只丢一句「查不到」让他自己猜。
        const hint = card?.suggestions?.length
          ? `卡表里查不到。你说的可能是:${card.suggestions.join(' / ')}`
          : '卡表里查不到,按原样记';
        lines.push(`已记下第 ${stats.count} 张:${pick}(${hint})`);
      }
      lines.push('');
    }

    lines.push(renderDraft(options, this.arenaDeck));

    if (!pick && options.length) {
      lines.push('', '选完记得告诉我拿了哪张,不然曲线算不准。');
    }

    return lines.join('\n');
  }

  private readyToAnnounce(s: GameSnapshot): boolean {
    return Boolean(s.me.heroClass || s.opponent.heroClass) || s.turn > 0;
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((error: unknown) => {
      this.log?.warn(`推送炉石事件失败:${(error as Error).message}`);
    });
  }

  private async push(type: string, senderKey: string, text: string, trigger: TriggerMode): Promise<void> {
    const host = this.host;
    if (!host) return;
    await host.pushEvent({
      type,
      source: this.id,
      senderKey,
      ts: nowIso(),
      text,
    }, { trigger });
  }

  /* ---------- 工具 ---------- */

  tools(): ToolDef[] {
    return [
      {
        name: STATE_DECL.name,
        description: STATE_DECL.description,
        parameters: STATE_DECL.parameters,
        tags: STATE_DECL.tags,
        handler: async () => ({ text: this.stateReceipt() }),
      },
      {
        name: ADVICE_DECL.name,
        description: ADVICE_DECL.description,
        parameters: ADVICE_DECL.parameters,
        tags: ADVICE_DECL.tags,
        handler: async (args) => ({ text: await this.adviceReceipt(args.full !== false) }),
      },
      {
        name: DRAFT_DECL.name,
        description: DRAFT_DECL.description,
        parameters: DRAFT_DECL.parameters,
        tags: DRAFT_DECL.tags,
        handler: async (args) => ({ text: this.draftReceipt(args) }),
      },
      {
        name: META_DECL.name,
        description: META_DECL.description,
        parameters: META_DECL.parameters,
        tags: META_DECL.tags,
        handler: async (args) => ({ text: this.metaReceipt(args) }),
      },
      {
        name: PLAN_DECL.name,
        description: PLAN_DECL.description,
        parameters: PLAN_DECL.parameters,
        tags: PLAN_DECL.tags,
        handler: async (args) => ({ text: await this.planReceipt(args) }),
      },
      {
        name: STYLE_DECL.name,
        description: STYLE_DECL.description,
        parameters: STYLE_DECL.parameters,
        tags: STYLE_DECL.tags,
        handler: async (args) => ({ text: this.styleReceipt(args) }),
      },
      {
        name: HIS_STYLE_DECL.name,
        description: HIS_STYLE_DECL.description,
        parameters: HIS_STYLE_DECL.parameters,
        tags: HIS_STYLE_DECL.tags,
        handler: async (args) => ({ text: this.hisStyleReceipt(args) }),
      },
      {
        name: DIARY_DECL.name,
        description: DIARY_DECL.description,
        parameters: DIARY_DECL.parameters,
        tags: DIARY_DECL.tags,
        handler: async (args) => ({ text: this.diaryReceipt(args) }),
      },
      {
        name: RECENT_DECL.name,
        description: RECENT_DECL.description,
        parameters: RECENT_DECL.parameters,
        tags: RECENT_DECL.tags,
        handler: async (args) => ({ text: this.recentReceipt(args.limit) }),
      },
      {
        name: LAST_GAME_DECL.name,
        description: LAST_GAME_DECL.description,
        parameters: LAST_GAME_DECL.parameters,
        tags: LAST_GAME_DECL.tags,
        handler: async (args) => ({ text: this.lastGameReceipt(args.actions !== false) }),
      },
      {
        name: WATCH_DECL.name,
        description: WATCH_DECL.description,
        parameters: WATCH_DECL.parameters,
        tags: WATCH_DECL.tags,
        handler: async (args) => {
          const mode = args.mode === 'quiet' ? 'quiet' : 'normal';
          this.opts.persist({ mode });
          return { text: mode === 'quiet' ? '好,我安静看着,你要我说再问。' : '行,我继续解说。' };
        },
      },
    ];
  }

  private stateReceipt(): string {
    const snapshot = this.lastSnapshot ?? this.parser.snapshot();
    if (!snapshot) {
      return this.noGameReceipt();
    }
    const actions = this.parser.recent(5);
    const tailText = actions.length
      ? `\n最近:\n${actions.map((a) => `  第 ${a.turn} 回合 · ${a.text}`).join('\n')}`
      : '';
    const meta = snapshot.ended ? '这局已结束。' : snapshot.isMyTurn ? '现在轮到我。' : '现在轮到对手。';
    // 日志停写时先把这件事摆在最前面:下面的数字全是残影,不能当现在用
    const stalled = this.logStalled();
    const head = stalled ? `${stalled}\n\n` : '';
    return `${head}${renderSnapshot(snapshot)}\n${lethalText(snapshot)}\n${meta}${tailText}`;
  }

  private llmConfig(): LlmConfig | null {
    if (!this.llmKey) return null;
    return {
      apiKey: this.llmKey,
      baseUrl: this.cfg.llmBaseUrl || 'https://api.deepseek.com',
      model: this.cfg.llmModel || 'deepseek-chat',
    };
  }

  /**
   * 问一次模型,要一段独立判断。
   *
   * **默认关着**(`llmAdvice: false`)。原因很实在:她在回答之前本来就要过一遍回执,
   * 而这里再调一次模型等于让同一个问题排队等两个模型 —— 实测点一下要等 3–7 秒,
   * 体感就是「卡」。机械规则(斩杀、交换、墙、疲劳钟)已经够硬,第二意见的边际价值
   * 抵不上这几秒。
   *
   * 想开就在设置里打开;开了就把超时压到 3 秒,宁可拿不到也别堵着。
   * 每回合自动推的那句**永远不调** —— 那里必须零延迟。
   */
  private async modelSecondOpinion(snapshot: GameSnapshot, advice: ReturnType<typeof advise>): Promise<string | null> {
    const cfg = this.llmConfig();
    if (!cfg || this.cfg.llmAdvice === false) return null;

    const system = [
      '你在替一个炉石传说玩家决定这一回合怎么打。',
      '只输出建议本身:一句话结论 + 最多两句理由,总共不超过 90 字。',
      '不要客套,不要复述输入,不要列清单。只能使用输入里出现过的牌。',
      '如果关键信息不足(比如对手手牌看不到),就直说这一点,不要编。',
    ].join('');

    const user = [
      buildModelPrompt(snapshot, { keepCards: this.cfg.keepCards }),
      '',
      '机械算出的候选(仅供参考,可以推翻):',
      advice.candidates.map((c) => `- ${c}`).join('\n'),
    ].join('\n');

    const text = await askModel(cfg, { system, user, maxTokens: 200, temperature: 0.3, timeoutMs: 3000 });
    if (!text) this.log?.warn('模型第二意见没拿到,只给规则结果。');
    return text;
  }

  private async adviceReceipt(full: boolean): Promise<string> {
    const snapshot = this.lastSnapshot ?? this.parser.snapshot();
    if (!snapshot) return this.noGameReceipt();
    if (snapshot.ended) {
      return '这局已经结束了,没有「这回合打什么」。要看刚才打得怎么样,用 hearthstone_last_game。';
    }
    const advice = advise(snapshot, { keepCards: this.cfg.keepCards });
    if (!full) advice.hand = advice.hand.filter((c) => c.playable);
    const head = snapshot.isMyTurn
      ? ''
      // 「局面还会变」说得太轻了 —— 变的方向几乎总是对我不利:他会先动手,
      // 把场上最贵的几只换掉,我下回合的场攻比我现在的少。这句必须点明。
      : '注意:现在不是我的回合,下面这些是给下一个我的回合做参考的 —— **他会先动手**,'
        + '你现在看到的场攻,他有机会换掉,最好按「最坏情况」那个数算斩杀。\n\n';
    const base = head + renderAdvice(advice, snapshot);

    const second = await this.modelSecondOpinion(snapshot, advice);
    if (!second) return base;
    return `${base}\n\n【模型的判断】\n${second}`;
  }

  private lastGameReceipt(withActions: boolean): string {
    const data = this.readArchive();
    if (!data) {
      return '还没有留下上一局的记录。她只记录自己在运行时打完的局 —— 装扩展之前打的、或者中途重启过的,读不到。';
    }
    return renderArchive(data, withActions);
  }

  private recentReceipt(rawLimit: unknown): string {
    const limit = Math.max(1, Math.min(50, Number(rawLimit) || 20));
    const actions = this.parser.recent(limit);
    if (!actions.length) return this.parser.inGame ? '这局还没有可记的动作。' : this.noGameReceipt();
    return actions.map((a) => `第 ${a.turn} 回合 · ${a.who === 'me' ? '我' : a.who === 'opponent' ? '对手' : '某方'} · ${a.text}`).join('\n');
  }

  private noGameReceipt(): string {
    if (!this.status.path) {
      return [
        '现在看不到对局:没找到炉石的 Power.log。',
        `已找过:${describeSearch({ logPath: this.cfg.logPath, installDir: this.cfg.installDir })}`,
        logSetupHint(),
      ].join('\n');
    }
    // 日志文件在、但里面没有对局数据:最常见的原因不是「没在打」,是 Power 日志压根没开。
    // 这时候只说「现在没有进行中的对局」等于把用户往「我明明在打」的死胡同里带。
    if (this.powerLog?.changed) {
      const where = this.powerLog.configPath || logConfigPath();
      return [
        `现在看不到对局:日志在 ${this.status.path},但里面一行对局数据都没有。`,
        `原因是炉石的 Power 日志之前没开。已经补好 ${where}([Power] 段:LogLevel=1、FilePrinting=true),**重启一次炉石就生效**。`,
        '之前已经打的对局补不回来 —— 那段时间炉石根本没往文件里写。',
      ].join('\n');
    }
    return `现在没有进行中的对局。日志在:${this.status.path}。${this.status.note}`;
  }

  /* ---------- 提示词 ---------- */

  envPromptVars(): Record<string, string> {
    const t = hearthstoneText('zh');
    const snapshot = this.lastSnapshot ?? this.parser.snapshot();
    const stalled = this.logStalled();
    const status = this.status.path
      ? `正在读 ${this.status.path}。${this.status.note}${stalled ? `\n${stalled}` : ''}`
      : this.status.note;
    const game = snapshot
      ? `${renderSnapshot(snapshot)}${stalled ? `\n\n${stalled}` : ''}`
      : t.notInGame;
    // 竞技场牌组常驻可见 —— 选牌时最需要「我已经有什么、还缺什么」,
    // 而把它放进环境变量,她每一轮都看得到,不用为看一眼曲线去调一次工具。
    const deck = deckBrief(this.arenaDeck);
    return {
      'hs.status': status,
      'hs.game': game,
      'hs.mode': this.cfg.mode === 'quiet' ? t.modeQuiet : t.modeNormal,
      'hs.deck': deck ?? '没在选牌（牌组是空的）。竞技场开始选牌时用 hearthstone_draft 记牌，记下的牌会显示在这里。',
      'hs.rules': RULES_BRIEF,
      // 整篇塞进去，不是给她一个「去查」的入口 —— 她开口之前立场就得在。
      // 空档案会返回一句「还没长出来」，免得她以为读失败了然后开始编。
      //
      // 前缀那半句不是装饰：ENV_PROMPT 里把她那份档案描述成「你自己写的那份」，
      // 切到他的立场时那句话就错了。这里先把「现在用谁的」说在最前面，
      // 让她不至于拿旧说法去读新内容。
      //
      // 用【】而不是 **加粗**：模板那一行原来写成 `**{{hs.style}}**`，
      // 里面再带一层 `**` 就变成四颗星互相干扰，渲染出 `**（现在用**你自己**的立场…）**`。
      'hs.style': this.cfg.voice === 'his'
        ? `【现在站在他的立场上】下面是他的习惯，不是你的。用「你」说他。\n${hisStyleForPrompt(this.styleDir)}`
        : `【现在用你自己的立场】下面这份是你写的。\n${styleForPrompt(this.styleDir, this.playedGameCount())}${this.habitNote() ? `\n\n${this.habitNote()}` : ''}`,
      // 最近几十局的战绩。她说「你最近打得怎么样」时靠这个，不用去翻存档 ——
      // 而存档只有最后一局，session 还会轮转。
      'hs.recent': this.recentGamesText(),
    };
  }

  /**
   * 读到「Truncating log…」那一行 —— 日志到上限停笔了。
   *
   * **这现在属于异常,不是常态。** 上限已经由 `ensureLogLimit()` 改成无限制,
   * 正常不会再满;还能走到这里,基本只有一个原因:游戏更新/战网修复把 client.config
   * 重写回去了。所以文案要说「可能被覆盖回去了」,而不是「你该退炉石了」——
   * 前者是诊断,后者是让他承担一个本来不该由他承担的重复动作。
   *
   * 灯变红、core.log 留痕,这些照旧:真出了问题得能看出来。
   */
  private noteLogFull(quiet = false): void {
    if (this.logFullNoted) return;
    this.logFullNoted = true;
    const at = this.logStoppedAt();
    this.status = { ...this.status, note: `炉石日志停在 ${at},后面的事我看不到。` };
    this.log?.warn('炉石日志写到上限就停笔了 —— 上限本该已被关掉,可能被游戏更新覆盖回去了');

    // 补历史时不开口:那是旧账,现在说只会让他去翻一件早就过去的事
    if (quiet) return;
    this.enqueue(() => this.push(
      'hearthstone.alert',
      'hearthstone.log.stalled',
      `〔危险·worried〕炉石日志从 ${at} 起就没再写过。这局后面的事,包括最后怎么结束的,我一点都看不到。`
      + '上限本来是关掉的,会这样多半是炉石更新把配置覆盖回去了 —— 我下次启动会自己补上,这一次只能退一下炉石。',
      'flush',
    ));
  }

  /** 日志已经多少毫秒没被写过了。读不到就当作很久。 */
  private logIdleMs(): number {
    const path = this.status.path;
    if (!path) return Number.MAX_SAFE_INTEGER;
    try {
      return Date.now() - statSync(path).mtimeMs;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  /** 日志最后被写入的时刻(HH:MM)。读不到就说不准。 */
  private logStoppedAt(): string {
    const path = this.status.path;
    if (!path) return '刚才';
    try {
      const mtime = statSync(path).mtimeMs;
      return new Date(mtime).toTimeString().slice(0, 5);
    } catch {
      return '刚才';
    }
  }

  /**
   * 日志断供了 —— 对局中，文件却几分钟没长过。
   *
   * 不限大小的配置关掉之后，「写满 10MB」不再是原因，但**停写**这件事本身还可能发生:
   * 配置被更新覆盖、日志开关被别的工具关掉、炉石进程出问题。用户那边的感受都是
   * 「打着打着她就不推荐了」，而扩展这里一切正常：文件在、能读、只是没新内容。
   *
   * 判据是「对局中 + 5 分钟没动」。炉石每个回合有时限，正常打不会这么久不写日志；
   * 在主菜单挂着则本来就不写，所以先排除非对局状态。
   *
   * 这个状态必须**主动说出来**。不说的话，她会拿十分钟前的血量回答「现在该怎么打」，
   * 比不说话更糟。
   */
  private logStalled(): string | null {
    const path = this.status.path;
    if (!path) return null;
    // 不在对局里时日志本来就不动(在主菜单挂着),那不是异常
    if (this.status.phase !== 'in-game') return null;
    try {
      const st = statSync(path);
      const idle = Date.now() - st.mtimeMs;
      // 他在长回合里思考时也会停笔几分钟,5 分钟以上才怀疑
      if (idle < 5 * 60_000) return null;
      const at = new Date(st.mtimeMs).toTimeString().slice(0, 5);
      return `⚠ 日志从 ${at} 起就没再写过,已经 ${Math.round(idle / 60_000)} 分钟。`
        + '按说对局中不该这么久——后面发生的事我可能一点都不知道,下面的数字请当成那时候的残影。';
    } catch {
      return null;
    }
  }

  /**
   * 把炉石自己的日志上限关掉。
   *
   * 这是唯一能让「打到第三、四局就失明」不再发生的办法:上限是炉石的一个配置项
   * (`client.config` 里的 `Log.FileSizeLimit.Int`),默认 10000KB,`-1` 是它自己的「无限制」。
   * 记牌器工具都会写这个键,所以它们从不撞这件事。
   *
   * 两条从外部绕的路都堵死了,别再试:
   *   · 裁短文件:炉石独占写打开,`open(path,'r+b')` 直接 Permission denied
   *   · 就算能裁:它记着自己的写偏移,下一次写会定位回原位,中间变成几 MB 的 0 字节空洞
   *
   * 改完要**重启一次炉石**才生效 —— 它只在启动时读这个文件。所以这一次还是得退一次,
   * 之后永久不用再管。
   */
  private ensureLogLimit(logPath: string): void {
    const installDir = installDirFromLog(logPath);
    if (!installDir || this.logLimitChecked.has(installDir)) return;
    this.logLimitChecked.add(installDir);

    const result = ensureLogSizeUnlimited(installDir);
    if (result.problem) {
      this.log?.warn(`日志上限没改成功:${result.problem}(目录 ${installDir})`);
      return;
    }
    if (result.changed) {
      this.log?.info(`炉石日志上限已关掉(${describeLimit(result.before)} → 无限制),下次启动炉石生效`);
      // **补上了不代表这一局就生效。** 炉石只在启动时读 client.config，
      // 现在跑着的那个进程已经读过旧文件了 —— 这一局照样会在 10MB 处停笔。
      //
      // 一位 mac 用户实测过三份日志：炉石先启动、扩展后补配置的那次，
      // 文件正好停在 10242459 字节并打印 `Truncating log...`；完全退出炉石再启动，
      // 两份日志分别长到 248MB 和 195MB，全程可读。
      //
      // 不说一句的话，他只会看到「打到第三局就失明」，然后以为扩展坏了。
      this.notifyLogLimitRestart();
    } else if (result.unlimited) {
      this.log?.info(`炉石日志上限已经是无限制(${describeLimit(result.before)})`);
    }
  }

  /**
   * 告诉他要退一次炉石。
   *
   * 只在**刚刚改动**时推（`logLimitChecked` 保证每个安装目录只走一次），
   * 而且尊重 quiet 模式 —— 这是他明确要求别吵的时候。
   */
  private notifyLogLimitRestart(): void {
    if (this.cfg.mode === 'quiet') return;
    const text = '刚把炉石的日志上限关掉了（原来 10MB，打到第三四局就断供）。\n'
      + '**但炉石只在启动时读这个设置** —— 现在这一局还是会停在 10MB，得退一次炉石再开才生效。\n'
      + '退完之后就不用再管了。';
    void this.host?.pushEvent({
      type: 'hearthstone.setup',
      ts: nowIso(),
      source: HEARTHSTONE_ID,
      text: `[${nowIso().slice(11, 16)}] ${text}`,
    }).catch((err: unknown) => {
      this.log?.warn(`日志上限提醒没推出去：${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /* ---------- 面板数据面 ---------- */

  /**
   * 面板只有三个动作:看状态、要建议、切开关。
   *
   * 刻意不把设置项搬进来 —— 面板不是第二套设置页。日志路径那类接入项留在设置页,
   * 面板只放他一天要点几十次的东西。
   */
  private async panelInvoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel !== 'main') throw new Error(`没有这块面板:${panel}`);
    if (method === 'status') return this.panelPayload();
    if (method === 'ask') return this.panelAsk();
    if (method === 'auto') return this.panelAuto(String(args[0] ?? ''), Boolean(args[1]));
    if (method === 'voice') return this.panelVoice(String(args[0] ?? ''));
    if (method === 'selfplay') return this.panelSelfPlay();
    throw new Error(`面板 main 没有这个方法:${method}`);
  }

  private panelPayload(): { status: PanelStatus; advice: PanelAdvice | null } {
    const snapshot = this.lastSnapshot ?? this.parser.snapshot();
    const status = panelStatus(snapshot, this.status, {
      mode: this.cfg.mode,
      speakTurns: this.cfg.speakTurns,
      speakAlerts: this.cfg.speakAlerts,
      keepCards: this.cfg.keepCards,
      voice: this.cfg.voice,
      // 每 2 秒读一次路径判断，比读全文便宜；面板要的是「那边到底有没有东西」。
      hisReady: existsSync(hisStylePath(this.styleDir)),
    });
    // 感想栏挂在状态外面：它不属于「这局打得怎么样」，是跨对局的东西。
    // 只取 3 条 —— 面板是「一眼看」，不是日志页。
    status.thoughts = readThoughts(this.diaryDir(), 3);
    return {
      status,
      advice: panelAdvice(snapshot, this.cfg.keepCards),
    };
  }

  /**
   * 他点了「让她看这回合」。
   *
   * 这条不受 mode=quiet 限制:quiet 关掉的是「她主动开口」,而这是他在问。
   * 同时把机械建议先还给面板 —— 面板立刻有字,不用等模型绕一圈。
   */
  private panelAsk(): { status: PanelStatus; advice: PanelAdvice | null } {
    const payload = this.panelPayload();
    const snapshot = this.lastSnapshot ?? this.parser.snapshot();
    const advice = payload.advice;
    if (!snapshot || !advice) return payload;
    this.askSeq += 1;
    const key = `hearthstone.ask:${snapshot.turn}:${this.askSeq}`;
    this.log?.info(`面板要建议:第 ${snapshot.turn} 回合`);
    this.enqueue(() => this.push('hearthstone.ask', key, panelAskText(snapshot, advice), 'flush'));
    return payload;
  }

  /**
   * 切开关。只认面板上那三个,别的键一律拒 ——
   * 让面板能改任意配置,等于绕开设置页做出一套没人知道的旁路。
   */
  private panelAuto(key: string, on: boolean): { status: PanelStatus; advice: PanelAdvice | null } {
    const payload = this.panelPayload();
    if (key === 'mode') {
      const mode = on ? 'normal' : 'quiet';
      this.opts.persist({ mode });
      payload.status.auto.mode = mode;
    } else if (key === 'speakTurns') {
      this.opts.persist({ speakTurns: on });
      payload.status.auto.speakTurns = on;
    } else if (key === 'speakAlerts') {
      this.opts.persist({ speakAlerts: on });
      payload.status.auto.speakAlerts = on;
    } else {
      throw new Error(`这个开关不归面板管:${key}`);
    }
    this.log?.info(`面板开关:${key} → ${on ? '开' : '关'}`);
    return payload;
  }

  /**
   * 面板上那个「用她的 / 用你的」按钮。
   *
   * 为什么不给模型一个工具来切：切的是「她想以谁的身份说话」，
   * 那是他的选择。开成工具之后，模型可以替他决定 —— 一个明确的开关就变成了概率。
   *
   * 切到 `his` 时如果那份档案还不存在（没打过局），不报错也不要装作切成功了：
   * 照切，同时把话说清楚 —— 她会读到「还没建起来」那句，开口时会老实说。
   */
  private panelVoice(to: string): { status: PanelStatus; advice: PanelAdvice | null } {
    const want = to === 'his' ? 'his' : to === 'mine' ? 'mine' : null;
    if (!want) throw new Error(`voice 只认 mine / his，收到的是「${to}」`);
    this.opts.persist({ voice: want });
    const payload = this.panelPayload();
    payload.status.voice = want;

    const exists = readHisStyle(this.styleDir) !== null;
    if (want === 'his' && !exists) {
      this.log?.warn(`切到他的立场，但 ${hisStylePath(this.styleDir)} 还没有 —— 他还没打完过一局。`);
    } else {
      this.log?.info(`面板切换解说立场:${want === 'his' ? '按他的习惯' : '按她自己的'}`);
    }
    return payload;
  }

  /* ---------- 设置页 ---------- */

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = hearthstoneText(language);
    const snapshot = this.lastSnapshot ?? this.parser.snapshot();
    const connected = this.status.path !== null;
    const phaseState = !connected || this.logFullNoted
      ? 'error'
      : this.status.phase === 'in-game' ? 'online' : this.status.phase === 'ended' ? 'offline' : 'loading';
    return {
      label: t.label,
      lamps: [
        {
          label: t.lamp.log,
          state: phaseState,
          hint: connected
            ? `${this.status.path}${snapshot ? ` · 第 ${snapshot.turn} 回合` : ''}`
            : t.lampNoLog,
        },
        {
          label: t.lamp.mode,
          state: this.cfg.mode === 'quiet' ? 'offline' : 'online',
          hint: this.cfg.mode === 'quiet' ? t.lampQuiet : t.lampNormal,
        },
      ],
      // 一块面板,只干三件事:看局面、要建议、切开关。
      // 非自动模式(mode=quiet)下这就是唯一的问法 —— 他不用再去聊天框打字。
      panels: [{
        id: 'main',
        title: '陪打',
        description: '一眼看局面,点一下让她说这回合怎么打。',
        defaultOpen: true,
      }],
      invoke: (panel, method, args) => this.panelInvoke(panel, method, args),
      config: hearthstoneConfigGroups(),
      promptDocs: [{
        key: `worlds.${HEARTHSTONE_ID}.envPrompt`,
        title: t.promptTitle,
        description: t.promptDescription,
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'hs.status', description: t.varStatus },
          { name: 'hs.game', description: t.varGame, multiline: true },
          { name: 'hs.mode', description: t.varMode },
          { name: 'hs.deck', description: '当前竞技场牌组的构成与曲线缺口；没在选牌时说明如何开始记录。', multiline: true },
          { name: 'hs.rules', description: '炉石核心规则摘要——判断一条建议在规则上站不站得住脚时用。', multiline: true },
        ],
      }],
      // 反馈入口:点开进 QQ 邮箱,地址写在按钮上可以直接抄。
      // 放在 World 页比藏在 README 里管用 —— 想反馈的人那时正盯着这个页面。
      links: [FEEDBACK_LINK],
    };
  }
}

/** 场面的简短描述,给复盘用。 */
function boardLine(side: SideState): string {
  if (!side.minions.length) return '空场';
  const atk = side.minions.reduce((sum, m) => sum + m.atk, 0);
  const hp = side.minions.reduce((sum, m) => sum + m.health, 0);
  return `${side.minions.length} 个(攻 ${atk}/血 ${hp})`;
}

/** 把存档渲染成模型能读的复盘文本。 */
export function renderArchive(a: GameArchive, withActions: boolean): string {
  const label = a.result === 'won' ? '我赢' : a.result === 'lost' ? '我输' : a.result === 'tied' ? '平局' : '结果未知';
  const meName = a.me.heroClass ? `${a.me.heroClass}${a.me.name ? `·${a.me.name}` : ''}` : '职业未知';
  const foeName = a.opponent.heroClass ? `${a.opponent.heroClass}${a.opponent.name ? `·${a.opponent.name}` : ''}` : '职业未知';
  const lines: string[] = [
    `上一局:我是 ${meName},对手 ${foeName},打到第 ${a.turns} 回合,${label}。`,
    `结束时:我 ${a.final.myHp} 血${a.final.myArmor ? ` + ${a.final.myArmor} 护甲` : ''},对手 ${a.final.foeHp} 血${a.final.foeArmor ? ` + ${a.final.foeArmor} 护甲` : ''}。`,
  ];

  if (a.timeline.length) {
    lines.push('', '每回合开局时:');
    for (const p of a.timeline) {
      lines.push(`  第 ${p.turn} 回合 · 我 ${p.myHp}${p.myArmor ? `+${p.myArmor}` : ''}血 手${p.myHand} 场:${p.myBoard} | 对手 ${p.foeHp}${p.foeArmor ? `+${p.foeArmor}` : ''}血 手${p.foeHand} 场:${p.foeBoard}`);
    }
  }

  if (withActions && a.actions.length) {
    lines.push('', `动作(${a.actions.length} 条,按发生顺序):`);
    for (const act of a.actions) {
      const who = act.who === 'me' ? '我' : act.who === 'opponent' ? '对手' : '某方';
      lines.push(`  第 ${act.turn} 回合 · ${who} · ${act.text}`);
    }
  } else if (withActions) {
    lines.push('', '没有记到动作。');
  }

  return lines.join('\n');
}

/**
 * 给 definition 用的自描述:可能出现的全部工具与事件,不含 handler。
 * 手写而不用框架的 describeTools —— 这样整个包对框架只剩 type-only 依赖,
 * 框架那边的函数签名怎么改都不会把扩展拖下水。
 */
export const HEARTHSTONE_DESCRIBE = {
  tools: HEARTHSTONE_TOOL_DECLS.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters,
    tags: d.tags,
    summary: d.summary,
  })),
  events: [
    { type: 'hearthstone.game.start', description: { zh: '一局开始:双方职业与先后手。', en: 'A match started: both classes and who goes first.' }, trigger: 'flush' as const },
    // 换牌阶段。和 game.start 分开是因为它**有时效**:只在起手还没确定时才有意义,
    // 而且这一局只推一次。她要给的是「留哪张、换哪张」,不是「开局感想」。
    { type: 'hearthstone.mulligan', description: { zh: '开局换牌阶段:起手手牌与留换建议。这一局只出现一次,过时不补。', en: 'Opening mulligan: the starting hand and which cards to keep or toss. Once per game, and never repeated late.' }, trigger: 'flush' as const },
    // 面板上按了「这局你来打」。
    //
    // 这个事件**不是授权**，是一次请求：宿主的规矩只认桌宠那边使用者的回答，
    // 面板按钮属于炉石这个 World，算不了「用电脑的理由」。
    // 所以她收到之后要做的是 `pet_ask` 问一句，等他答了才动。
    { type: 'hearthstone.selfplay', description: { zh: '他在面板上按了「这局你来打」。收到后先用 pet_ask 问一句，他答应了才动手。', en: 'He pressed "you take this one" on the panel. Ask him in a bubble first; act only after he agrees.' }, trigger: 'flush' as const },
    { type: 'hearthstone.turn', description: { zh: '轮到本地玩家行动,附当前双方状态。', en: "It is the operator's turn, with both sides' state." }, trigger: 'debounce' as const },
    { type: 'hearthstone.alert', description: { zh: '关键节点:残血、被铺场、进入斩杀线、牌库见底之类。', en: 'A moment that matters: low health, being swarmed, lethal range, running out of cards.' }, trigger: 'flush' as const },
    { type: 'hearthstone.game.end', description: { zh: '这局结束和结果。', en: 'The match ended, and how.' }, trigger: 'flush' as const },
    // 面板上那个按钮推的就是这一条。它是**他主动问的**,不是自动播报,
    // 所以和 turn / alert 分开:她该用回答的口气,不是解说的口气。
    { type: 'hearthstone.ask', description: { zh: '他在扩展页上点了「让她看这回合」,附当前局面与机械建议。', en: 'The operator clicked "ask about this turn" on the panel, with the board and the mechanical advice.' }, trigger: 'flush' as const },
    // 环境没准备好：Coopani 版本太旧、宿主补丁打不上、或找不到宿主包。
    // 存在的理由是**只有她能让人抬头** —— 设置页那盏红灯他不一定会去看，
    // 简介里的版本要求他也不一定读。启动后说一句，是他唯一会注意到的渠道。
    { type: 'hearthstone.setup', description: { zh: '这台机器的环境不对:Coopani 版本太旧、宿主动作补丁打不上,或者找不到宿主包。附一句该怎么跟他说。', en: 'Something about this machine is off: Coopani too old, host patch blocked, or host pack missing. Carries what to tell the operator.' }, trigger: 'flush' as const },
  ],
};
