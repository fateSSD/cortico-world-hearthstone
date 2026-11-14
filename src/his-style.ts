/**
 * 「他习惯怎么打」—— 从他自己的对局记录里数出来的东西。
 *
 * 和旁边那几份的分界，比 style.ts 那条还要紧，因为这一份**最容易说错话**：
 *   hearthstone_advice → 这回合能打什么。**算出来的。**
 *   hearthstone_meta   → 这个职业怎么赢。**别人的结论。**
 *   hearthstone_plan   → 这套牌靠什么赢。**模型推的。**
 *   hearthstone-style.md → 我信哪一套。**她自己的立场，她写的。**
 *   这份文件            → 他实际怎么打。**从 record 里数的，不是猜的。**
 *
 * 为什么要单独一份、而不是塞进她那份档案：
 * 她的档案是「她是什么人」，这份是「他是什么人」。混在一份文件里，她会把
 * 他的习惯当成自己的立场说出来 —— 那不是有性格，那是复读机。
 *
 * 为什么这份**不许自动变成结论**：
 * 打牌有对错，说错一句他就掉分。所以这里只写「数出来了什么」，样本量一起写；
 * 不下「所以你该怎样」的判断。判断留给看的人。
 *
 * 为什么机器段和人写段要分开：
 * 机器段每次重算都要覆盖（数据在涨），人写段一个字都不能动（那是他或她补的）。
 * 同一份文件里混着两种写入者，必须用标记隔开，否则一次重算就把人家的补充冲掉。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HIS_STYLE_FILE = 'hearthstone-his-style.md';

/** 机器段与人写段的分界。重算时只替换这两行之间的内容。 */
const AUTO_BEGIN = '<!-- 下面这段是数出来的，每次重算都会覆盖，别手改 -->';
const AUTO_END = '<!-- 上面这段结束 -->';

/** 人写段的标题。人把补充写在这一节下面。 */
export const HIS_MANUAL_TITLE = '他自己补的';

/** 注入提示词的上限。和她的档案同一档，别把系统前缀撑爆。 */
export const HIS_INJECT_MAX = 1200;

/** 样本不到这个量，就别拿它当规律 —— 三局两胜说明不了任何事。 */
const MIN_GAMES = 5;
const MIN_TURNS = 20;

/** 「能看出个大概」与「够说习惯」之间还有一段。到这条线才配说「你习惯这么打」。 */
const STRONG_GAMES = 10;
const STRONG_TURNS = 40;

/**
 * 一局短于这个秒数，就不可能是真的打了一局。
 *
 * 这条闸是 2026-11-06 加完功能后当场发现的：他的 `hearthstone-games.jsonl` 里
 * 50 局全是**测试写入**的（每局时长中位数 0.008 秒、同一个职业、49 胜 1 负）。
 * 局数和决策点数都过了原来的闸，于是那份「学习结果」会一本正经地说
 * 「你按建议打 33%」—— 而它学的是测试夹具。
 *
 * 判据只能是**可核的物理量**：真对局哪怕开局就认输，也不可能 10 毫秒结束。
 * 不猜「这条记录像不像真的」，只问「它花了多少时间」。
 */
const MIN_GAME_SECONDS = 60;

/** 一条决策点：那回合建议推什么、他实际打了什么。 */
export interface TurnDecision {
  turn: number;
  advised: string | null;
  played: string | null;
  agreed?: boolean | null;
}

/** 归档里一局的最小形状。只取这里会用到的字段，别的不管。 */
export interface GameRecord {
  startedAt?: string;
  endedAt?: string;
  result?: 'won' | 'lost' | 'tied' | 'conceded' | string;
  turns?: number;
  me?: { heroClass?: string; name?: string };
  opponent?: { heroClass?: string; name?: string };
  lowHp?: number;
  turnLog?: TurnDecision[];
}

export interface HisStats {
  games: number;
  /** 有得比的决策点数量（建议和实际都非空）。 */
  decisions: number;
  /** 采纳数。 */
  agreed: number;
  won: { games: number; decisions: number; agreed: number };
  lost: { games: number; decisions: number; agreed: number };
  /** 按阶段分的采纳率。前 5 回合 / 6–10 / 11 回合以后。 */
  phases: { label: string; decisions: number; agreed: number }[];
  /** 职业 → 局数与胜局。 */
  classes: { heroClass: string; games: number; won: number }[];
  /** 建议了但没打，出现最多的几张。 */
  ignored: { card: string; count: number }[];
  /** 最早与最晚一局的时间，用来标样本区间。 */
  from: string | null;
  to: string | null;
  /**
   * 因为「那回合第一张是硬币」而判不了的条数。
   *
   * 硬币是凑费的过渡动作，不是路线。这些记录两头都不算 —— 见主循环里的注释。
   * 单独计数，是因为「决策点怎么比上次数少了」必须有解释。
   */
  coinSkipped: number;
  /**
   * 因为「短得不像真对局」被跳过的局数。
   *
   * 这个数必须露出来。跳过之后如果只剩 0 局，她会读到「还没数出来」——
   * 而他会想知道「为什么我打了那么多局还是没有」。答案就是这个数。
   */
  skipped: number;
}

const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 100) : 0);

/**
 * 这张「牌」是不是硬币。
 *
 * 只按名字判，不查卡表 —— 硬币本来就不可收集，卡表里查不到（见 parser.ts 的 `isCoinCard`）。
 * 老记录里只留了牌名，没有 cardId，所以这里认名字就够了。
 */
const isCoinName = (name: string | null | undefined): boolean =>
  Boolean(name) && /幸运币|硬币|COIN|GAME_005/i.test(String(name));

/**
 * 这一局短得不像真打了一局，或者时间本身就是坏的。
 *
 * 判据只有一条：从 `startedAt` 到 `endedAt` 花了多久。两个字段有一个缺、或者
 * 解析不出来，就当作「判不出来」放过去 —— **宁可多算一条真的，也不拿缺字段去否定历史**。
 *
 * `endedAt < startedAt` 的也跳过：那是坏数据，不是「零秒打完」。留着它会算出负时长，
 * 让「最短一局」这一类判断全部失真。
 */
function isTooShort(g: GameRecord): boolean {
  const a = Date.parse(g.startedAt ?? '');
  const b = Date.parse(g.endedAt ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (b < a) return true;
  return (b - a) / 1000 < MIN_GAME_SECONDS;
}

/**
 * 从归档记录里数。
 *
 * 纯函数，不读盘 —— 测试直接喂假数据就能验，不用起 World 实例。
 * 所有字段都可能缺（老版本写的记录没有 turnLog），缺了就当没有，不猜。
 */
export function summarize(records: GameRecord[]): HisStats {
  const empty = { games: 0, decisions: 0, agreed: 0 };
  const stats: HisStats = {
    games: 0,
    decisions: 0,
    agreed: 0,
    won: { ...empty },
    lost: { ...empty },
    phases: [
      { label: '前 5 回合', decisions: 0, agreed: 0 },
      { label: '6–10 回合', decisions: 0, agreed: 0 },
      { label: '11 回合以后', decisions: 0, agreed: 0 },
    ],
    classes: [],
    ignored: [],
    from: null,
    to: null,
    skipped: 0,
    coinSkipped: 0,
  };

  const classMap = new Map<string, { games: number; won: number }>();
  const ignoredMap = new Map<string, number>();
  const times: string[] = [];

  for (const g of records) {
    if (!g || typeof g !== 'object') continue;
    // 短得不像真对局的，整局不算 —— 局数、胜负、决策点全都不进。
    // 只跳过「缺 endedAt 的判不出来」的那一半：老记录没有这个字段时照收，
    // 宁可多算一条真的，也不能因为字段缺失就把他的历史全扔掉。
    if (isTooShort(g)) {
      stats.skipped += 1;
      continue;
    }
    stats.games += 1;
    if (typeof g.startedAt === 'string' && g.startedAt) times.push(g.startedAt);

    const cls = g.me?.heroClass;
    if (cls) {
      const cur = classMap.get(cls) ?? { games: 0, won: 0 };
      cur.games += 1;
      if (g.result === 'won') cur.won += 1;
      classMap.set(cls, cur);
    }

    // 胜负分桶。认不出的结果算「没分到桶里」，不倒进输那一栏 ——
    // 平局和对手掉线混进「输」，会让「输的局采纳率」这个数偏掉。
    const bucket = g.result === 'won' ? stats.won : g.result === 'lost' ? stats.lost : null;
    if (bucket) bucket.games += 1;

    const log = Array.isArray(g.turnLog) ? g.turnLog : [];
    for (const d of log) {
      if (!d) continue;
      // agreed 可能是 null（没得比）。只有明确的 true/false 才算一个决策点。
      if (d.agreed !== true && d.agreed !== false) continue;
      // **硬币当道的「不一致」不可判，跳过。**
      //
      // 2026-11-07 之前的记录里，有 5 次被记成「建议 X / 实际幸运币 / 没听」——
      // 那多半是「先打硬币凑费，再上那张」的第一步，也就是**照建议在执行**。
      // 判成「没听」是错的（会低估采纳率、还会让「幸运币」混进他的偏好榜）；
      // 判成「听了」也没有根据（不知道他打完硬币之后到底打了什么）。
      // 所以两头都不算 —— 单独计数，在渲染时说明，不装作没这回事。
      if (d.agreed === false && isCoinName(d.played)) {
        stats.coinSkipped += 1;
        continue;
      }
      stats.decisions += 1;
      if (bucket) bucket.decisions += 1;

      const phase = d.turn <= 5 ? 0 : d.turn <= 10 ? 1 : 2;
      stats.phases[phase].decisions += 1;

      if (d.agreed === true) {
        stats.agreed += 1;
        if (bucket) bucket.agreed += 1;
        stats.phases[phase].agreed += 1;
      } else if (d.advised) {
        // 建议了 A、他打了 B —— 记 B 是「他没听建议时改打的那张」。
        // 记 played（他实际的选择）而不是 advised（被放弃的那个）：
        // 想知道的正是「他自己会往哪儿偏」。
        //
        // 那一回合**根本没出牌**的，不进这张表：那不是「改打」，是没动作。
        // 混进来会让他看起来「经常改打一张叫『没出牌』的牌」。
        // （真实数据里这类记录的 agreed 是 null，走不到这一支；这里是防它哪天变了。）
        if (d.played) ignoredMap.set(d.played, (ignoredMap.get(d.played) ?? 0) + 1);
      }
    }
  }

  stats.classes = [...classMap.entries()]
    .map(([heroClass, v]) => ({ heroClass, games: v.games, won: v.won }))
    .sort((a, b) => b.games - a.games);

  stats.ignored = [...ignoredMap.entries()]
    .map(([card, count]) => ({ card, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  times.sort();
  stats.from = times[0] ?? null;
  stats.to = times[times.length - 1] ?? null;
  return stats;
}

/** `2026-11-05T05:30:28.306Z` → `11-05`。只给人看，不参与计算。 */
function dayOf(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}-${m[3]}` : null;
}

/**
 * 数出来那一段的正文。
 *
 * 三条写法上的硬规矩，破了这份文件就没用了：
 *   1. 每个数都带样本量（「68%（350/512）」），让人能自己判断可信度。
 *   2. 不下「你该怎样」的判断。只陈述数出来什么。
 *   3. 样本不够就明说不够，不硬编一条看起来像规律的句子。
 */
/**
 * 给她的一条「他打牌是什么样」的侧写，用**她自己的立场**说话时也带上。
 *
 * 为什么要有（2026-11-07）：31 局统计出来一个很干净的梯度 ——
 * 前 5 回合 62% 按建议打，11 回合以后只剩 27%；没听的时候最常先打加速光环、誓缚光环。
 * 这说明两件事，她原来都不知道：
 *   1. 他中后期基本自己拿主意，那时候她的话要更短、更点到为止，别当裁判；
 *   2. 他这套是光环铺场，而规则把光环判成「不产场面的资源牌」排在随从后面 ——
 *      所以她推随从、他打光环，不是他不听，是判据不认识这套牌。
 *
 * **但这是他的习惯，不是对错标准。** 末尾那句「别拿它去迎合他」是必要的：
 * 一旦她开始说「你上次打的是加速光环」，就从「了解一个人」变成了「顺着一个人」。
 *
 * 样本不够就直接不给 —— 10 局以下说「他习惯怎么打」是编。
 */
export function hisHabitNote(stats: HisStats): string {
  if (stats.games < 10 || stats.decisions < 30) return '';
  const early = stats.phases[0];
  const late = stats.phases[2];
  const top = stats.ignored.slice(0, 2).map((i) => i.card).filter((c) => !isCoinName(c));
  const bits: string[] = [];
  if (early.decisions >= 5 && late.decisions >= 5) {
    bits.push(
      `前 5 回合有 ${pct(early.agreed, early.decisions)}% 按建议打，11 回合以后只有 ${pct(late.agreed, late.decisions)}%`,
    );
  }
  if (top.length) bits.push(`没听的时候最常先打${top.join('、')}`);
  if (!bits.length) return '';
  return `（顺带：他最近 ${stats.games} 局里，${bits.join('；')}。`
    + '这是他的习惯，不是你判断对错的标准 —— 别拿它去迎合他，也别拿它当他不听劝的证据。）';
}

export function renderStats(stats: HisStats): string[] {
  const out: string[] = [];
  const from = dayOf(stats.from);
  const to = dayOf(stats.to);
  // 同一天别写成「11-06 ~ 11-06」，读起来像跨了两天。
  const span = !from ? '' : from === to ? from : `${from} ~ ${to}`;

  // 一条都不剩的时候，最要紧的是说清「为什么没有」，而不是给一句空话。
  if (stats.games === 0) {
    out.push(stats.skipped > 0
      ? `记录里有 ${stats.skipped} 条，但每一条都短于 ${MIN_GAME_SECONDS} 秒 —— `
        + '那不是真的对局（测试、回放，或者日志里同一局的重复结束点）。一条都没算进来。'
      : '还没有记录。真的打完一局之后这里才会有东西。');
    return out;
  }

  out.push(
    `一共 ${stats.games} 局${span ? `（${span}）` : ''}，其中有得比的决策点 ${stats.decisions} 个。`,
  );

  // 跳过多少条也要说 —— 否则他会奇怪「我明明打了 N 局，为什么只算 M 局」。
  if (stats.skipped > 0) {
    out.push(
      `另有 ${stats.skipped} 条短于 ${MIN_GAME_SECONDS} 秒，不像真打了一局，没算（测试、回放，`
      + '或者日志里同一局的重复结束点）。',
    );
  }

  // 硬币那条同理：不给解释的话，他会发现「决策点比上次少」，以为是统计坏了。
  if (stats.coinSkipped > 0) {
    out.push(
      `还有 ${stats.coinSkipped} 条是「先打硬币凑费」的那种回合 —— 判不出那手算不算听了建议，两头都没算。`,
    );
  }

  if (stats.games < MIN_GAMES || stats.decisions < MIN_TURNS) {
    out.push(
      `样本还不够（至少 ${MIN_GAMES} 局、${MIN_TURNS} 个决策点才看得出东西），`
      + '现在这些数只能当参考，别当规律。',
    );
  } else if (stats.games < STRONG_GAMES || stats.decisions < STRONG_TURNS) {
    // 「刚好过线」和「够用」是两回事。5 局能看出个大概，但那只是大概 ——
    // 说成「你就是这样」会让他照着一条 5 局的规律改自己的打法。
    out.push(
      `样本偏少（${stats.games} 局、${stats.decisions} 个决策点；`
      + `攒到 ${STRONG_GAMES} 局以上再说「习惯」比较稳），现在只能当个大概。`,
    );
  }

  if (stats.decisions > 0) {
    out.push(
      `按建议打的占 ${pct(stats.agreed, stats.decisions)}%（${stats.agreed}/${stats.decisions}）。`,
    );
  }

  // 胜负分栏只在两栏都有料时才写 —— 一边空的对比会读成「另一边的规律」。
  // 分母必须写清是「决策点」：前面刚说过「赢的 N 局」，紧跟一个 (8/24) 会被读成 24 局。
  if (stats.won.decisions > 0 && stats.lost.decisions > 0) {
    out.push(
      `赢的 ${stats.won.games} 局里，按建议打 ${pct(stats.won.agreed, stats.won.decisions)}%`
      + `（${stats.won.decisions} 个决策点里 ${stats.won.agreed} 个）；`
      + `输的 ${stats.lost.games} 局里 ${pct(stats.lost.agreed, stats.lost.decisions)}%`
      + `（${stats.lost.decisions} 个里 ${stats.lost.agreed} 个）。`,
    );
  }

  // 阶段分布：只在至少两段有料时写，一段独大说明不了「偏向」。
  const filled = stats.phases.filter((p) => p.decisions >= 3);
  if (filled.length >= 2) {
    out.push(
      `按建议打的比例，${filled.map((p) => `${p.label} ${pct(p.agreed, p.decisions)}%（${p.decisions} 个决策点）`).join('，')}。`,
    );
  }

  if (stats.classes.length > 0) {
    const top = stats.classes.slice(0, 4);
    out.push(
      `常玩的职业：${top.map((c) => `${c.heroClass} ${c.games} 局（赢 ${c.won}）`).join('，')}。`,
    );
  }

  if (stats.ignored.length > 0 && stats.decisions > 0) {
    // 口径必须写明「那回合第一张出的牌」：记录只留每回合第一张，
    // 所以硬币这类过渡动作也会出现在这里 —— 不写清楚会被读成「他偏爱打硬币」。
    out.push(
      `没按建议走的时候，他先打的是（那回合第一张出的牌，硬币这类过渡也算）：`
      + `${stats.ignored.map((i) => `${i.card} ${i.count} 次`).join('，')}。`,
    );
  }

  return out;
}

/** 空骨架 / 重算后重建。机器段在标记之间，人写段永远保留。 */
function composeFile(auto: string[], manual: string[]): string {
  return [
    '# 他习惯怎么打',
    '',
    '这是从对局记录里数出来的，**不是他的自述，也不是我的立场**。',
    '哪些牌强、这回合该打什么，那是 `hearthstone_advice` 算的；这里只记一个事实：他实际怎么选。',
    '',
    AUTO_BEGIN,
    ...auto.map((l) => (l.startsWith('- ') ? l : `- ${l}`)),
    AUTO_END,
    '',
    `## ${HIS_MANUAL_TITLE}`,
    '',
    ...manual,
    '',
    '---',
    '',
    '写的时候：一条一行；写的是从他记录里看不出、只有他自己知道的东西（为什么这么打、这局的打算）。',
    '机器数出来的部分不用重复 —— 那一节每次都会重算。',
    '',
  ].join('\n');
}

export function hisStylePath(dir: string): string {
  return join(dir, HIS_STYLE_FILE);
}

export function readHisStyle(dir: string): string | null {
  const file = hisStylePath(dir);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 取出人写段（`## 他自己补的` 之下、`---` 之前的非空行）。重算时要原样搬过去。 */
function readManual(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const head = lines.findIndex((l) => l.trim() === `## ${HIS_MANUAL_TITLE}`);
  if (head < 0) return [];
  const body: string[] = [];
  for (let i = head + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '---' || t.startsWith('## ')) break;
    if (t) body.push(lines[i]);
  }
  return body;
}

/**
 * 重算并落盘。返回是否写成功。
 *
 * 人写段从旧文件里抠出来原样搬过去 —— 不做去重、不做格式化，
 * 那是他/她写的东西，机器只负责别弄丢。
 */
export function writeHisStyle(dir: string, stats: HisStats): boolean {
  const old = readHisStyle(dir);
  const manual = readManual(old);
  const text = composeFile(renderStats(stats), manual);
  // 内容没变就不碰文件 —— 启动时也会重算一次，否则每开一次 Coopani
  // 这份文件的修改时间都往前跳，看起来像"刚被人改过"。
  if (old === text) return true;
  const file = hisStylePath(dir);
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

/**
 * 往里加一条他自己补的。去重按「包含」，和她的档案同一套规矩。
 *
 * 为什么允许写：有些事记录里永远看不到 —— 「这局我在试新卡组」「我故意留着等配合」。
 * 那些只有他知道。但样本段不许他改，那是数出来的。
 */
export function addHisLine(dir: string, raw: string, lineMax = 60): { ok: boolean; message: string } {
  const line = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/^[-·•]\s*/, '');
  if (!line) return { ok: false, message: '没有内容可写。' };
  const clipped = line.length > lineMax ? `${line.slice(0, lineMax)}…` : line;

  const old = readHisStyle(dir);
  if (old === null) return { ok: false, message: '还没有他的打法档案 —— 先打一局，我数完了自然会建。' };

  const lines = old.split(/\r?\n/);
  const head = lines.findIndex((l) => l.trim() === `## ${HIS_MANUAL_TITLE}`);
  if (head < 0) {
    // 人可能把这一节删了。补回来，别默默把这条扔了。
    lines.push('', `## ${HIS_MANUAL_TITLE}`, '', `- ${clipped}`, '');
  } else {
    const manual = readManual(old);
    const dup = manual.find((l) => {
      const t = l.trim().replace(/^-\s*/, '');
      return t === clipped || t.includes(clipped) || clipped.includes(t);
    });
    if (dup) return { ok: true, message: `已经有这条了（${dup.trim().replace(/^-\s*/, '')}），没重复写。` };
    // 插在这一节标题下面第一条之前：新的在上，顺序稳定。
    lines.splice(head + 1, 0, '', `- ${clipped}`);
  }

  const file = hisStylePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const text = lines.join('\n');
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
    return { ok: true, message: `写进「${HIS_MANUAL_TITLE}」：${clipped}` };
  } catch {
    try {
      writeFileSync(file, text, 'utf8');
      return { ok: true, message: `写进「${HIS_MANUAL_TITLE}」：${clipped}` };
    } catch {
      return { ok: false, message: '文件写不进去（盘满了、没权限，或者被别的程序占着）。' };
    }
  }
}

/**
 * 拼成注入系统提示词的那一段。
 *
 * 和她的档案**同一套注入位置**，但话必须不一样：
 * 这一份不是她的立场，是「他习惯怎么打」。第一句就得把这件事说死，
 * 否则她会用第一人称把它复述出来 —— 那就成了「我习惯这么打」，而他根本没说过。
 *
 * **只给机器段和人写段，不给文件尾部那几句使用说明。** 那些是写给编辑文件的人看的，
 * 塞进提示词只是白占长度 —— 而且一旦超了上限，被切掉的会是末尾的人写段，
 * 偏偏那一段是可信度最高的（他自己说的）。
 */
export function hisStyleForPrompt(dir: string): string {
  const raw = readHisStyle(dir) ?? '';
  const body = raw.trim();
  if (!body) {
    return '（他的打法档案还没建起来 —— 打完一局我才会数。这一轮别猜他习惯怎么打。）';
  }

  const autoStart = body.indexOf(AUTO_BEGIN);
  const autoEnd = body.indexOf(AUTO_END);
  const autoPart = autoStart >= 0 && autoEnd > autoStart
    ? body.slice(autoStart + AUTO_BEGIN.length, autoEnd).trim()
    : '';
  const manual = readManual(body);

  if (!autoPart && manual.length === 0) {
    return '（他的打法档案还是空的 —— 没有可数的对局，他也没说过什么。这一轮别猜他习惯怎么打。）';
  }

  const parts: string[] = [];
  if (autoPart) parts.push(autoPart);
  if (manual.length > 0) {
    parts.push(`## ${HIS_MANUAL_TITLE}（他自己说的，比数出来的更该当真）`, ...manual);
  }
  let text = parts.join('\n\n');
  if (text.length > HIS_INJECT_MAX) {
    text = `${text.slice(0, HIS_INJECT_MAX)}\n…（后面还有，全文在 ${hisStylePath(dir)}）`;
  }

  return `${text}\n\n`
    + '（这是**他的**习惯，不是你的立场。说的时候用「你」指他，别用「我」—— '
    + '你要是用第一人称复述，他会以为那是你自己的主张。'
    + '另外它管不了算出来的东西：斩杀、墙、群伤一律以 `hearthstone_advice` 为准，'
    + '他习惯怎么打不能拿来盖掉这一回合的数字。）';
}
