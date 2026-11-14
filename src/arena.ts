/**
 * 竞技场选牌。
 *
 * 先把一件事说清楚:**选牌那三张牌，日志里读不到。**
 * `[Arena]` 通道确实存在，Arena Tracker 那类工具的说明里也写着「选牌要截图识别、
 * 选完把鼠标移开才能读下一张」—— 也就是说这条信息不在文本日志里。所以这里不做
 * 「自动读取三个选项」这种假装能做的事:读不到就老实让用户把三张牌名报过来。
 *
 * 那这里给的是什么:
 *   · 卡名 → 卡表(deprecated 名/别名都能试)解析出费用、身材、效果摘要
 *   · 一副**启发式评分**,按身材效率、关键词、效果量算,并叠加当前曲线缺口
 *   · 当前牌组的曲线、随从/法术比、解场牌数量
 *
 * 评分的定位是**平局时的参考**,不是天梯榜。真正的竞技场强弱要看环境、职业和当期补丁,
 * 那些只有她(模型)的知识能判断。所以回执明确标「机械分」,并且要求她把分歧讲出来。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type CardEntry = [string, number, string, string];

const TYPE_NAME: Record<string, string> = { S: '法术', M: '随从', W: '武器', H: '英雄', L: '地标' };

let cardTable: Record<string, CardEntry> | null = null;
let nameIndex: Map<string, string> | null = null;

function loadCards(): Record<string, CardEntry> {
  if (cardTable) return cardTable;
  try {
    const file = fileURLToPath(new URL('./data/cards.json', import.meta.url));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cards?: Record<string, CardEntry> };
    cardTable = raw.cards ?? {};
  } catch {
    cardTable = {};
  }
  return cardTable;
}

/** 名字 → id。重名(不同扩展的同名卡)取第一条,竞技场里数值基本一致。 */
function getNameIndex(): Map<string, string> {
  if (nameIndex) return nameIndex;
  const index = new Map<string, string>();
  for (const [id, entry] of Object.entries(loadCards())) {
    const name = entry[0];
    if (!name) continue;
    const current = index.get(name);
    // 优先留不带 CORE_/VAN_ 前缀的原始版本
    if (!current || (/^(?:CORE_|VAN_|VANILLA_|TUTORIAL_)/.test(current) && !/^(?:CORE_|VAN_|VANILLA_|TUTORIAL_)/.test(id))) {
      index.set(name, id);
    }
  }
  nameIndex = index;
  return index;
}

/**
 * 卡名规范化：去掉空格和常见标点，全角转半角。
 *
 * 用户报牌是手打或语音转的，同一张牌能写成「游学生」「游学 生」「遊學生」。
 * 标点、空格、全角括号这些**不携带信息**，比之前先抹掉再比。
 */
function normName(s: string): string {
  return s
    .replace(/[\s\u3000]/g, '')
    .replace(/[·・.,，。、:：;；!！?？'"'"`´()（）【】\[\]《》<>]/g, '')
    .toLowerCase();
}

/** Levenshtein 距离，滚动数组，短字符串够用。 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 规范化后最近的名字，按距离升序。首字不同的直接跳过 —— 省掉九成比较。 */
function nearestNames(q: string, limit = 3): { name: string; id: string; dist: number }[] {
  const nq = normName(q);
  if (!nq) return [];
  const head = nq[0];
  const out: { name: string; id: string; dist: number }[] = [];
  for (const [name, id] of getNameIndex()) {
    const nn = normName(name);
    if (!nn || nn[0] !== head) continue;
    // 长度差太大就不可能编辑距离小，先挡掉
    if (Math.abs(nn.length - nq.length) > 2) continue;
    const dist = editDistance(nq, nn);
    if (dist <= 2) out.push({ name, id, dist });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, limit);
}

export interface ArenaCard {
  /** 用户/模型给的原字符串。 */
  query: string;
  id: string;
  name: string;
  cost: number;
  type: string;
  note: string;
  /** 卡表里查不到时为 false —— 这时不给分,直说查不到。 */
  found: boolean;
  /**
   * 怎么命中的。
   *
   * `fuzzy` 是 2026-11-12 加的：一位用户把「巡游船长萝拉」念成「巡游船长罗拉」，
   * 精确和子串都对不上，那一手就没出分。所以要能认形近字 ——
   * **但认了必须说**，不能悄悄替换成另一张牌。
   */
  matchedBy?: 'exact' | 'loose' | 'fuzzy';
  /** 没命中时给候选（最多 3 个），回执里拼成「你说的可能是 X」。 */
  suggestions?: string[];
}

/** 按 cardId 或中文名找牌。查不到返回 null(调用方要如实说,不要猜)。 */
export function resolveArenaCard(query: string): ArenaCard | null {
  const q = query.trim();
  if (!q) return null;

  const table = loadCards();
  const pick = (id: string, how: 'exact' | 'loose' | 'fuzzy'): ArenaCard => {
    const [name, cost, letter, note] = table[id];
    return { query, id, name, cost, type: TYPE_NAME[letter] ?? '未知', note, found: true, matchedBy: how };
  };

  // ① cardId 原样
  if (table[q]) return pick(q, 'exact');

  // ② 卡名原样
  const id = getNameIndex().get(q);
  if (id) return pick(id, 'exact');

  // ③ 规范化后相等（抹掉空格、标点、全角括号再比）
  const nq = normName(q);
  if (nq) {
    for (const [name, hid] of getNameIndex()) {
      if (normName(name) === nq) return pick(hid, 'loose');
    }
  }

  // ④ 子串包含（少打几个字、或者带了「的」之类）
  const hits = [...getNameIndex().entries()].filter(([name]) => name.includes(q) || q.includes(name));
  if (hits.length === 1) return pick(hits[0][1], 'loose');

  // ⑤ 形近兜底：规范化后编辑距离 1、且**唯一**最近。
  //
  // 为什么卡在「距离 1 且唯一」这么窄：中文卡名里形近但完全不同的牌是存在的
  // （「游学生」和「游学者」就是距离 1 的两张牌）。放宽到 2、或者允许并列，
  // 就会替用户改成另一张牌 —— 那是比「查不到」更糟的错，因为他看不到。
  // 所以距离 1 且唯一才认，并且**回执里必须写出「按 X 算的」**。
  const cands = nearestNames(q, 3);
  const top = cands[0];
  if (top && top.dist === 1 && (cands[1]?.dist ?? 99) > 1) return pick(top.id, 'fuzzy');

  return {
    query, id: '', name: '', cost: 0, type: '未知', note: '', found: false,
    ...(cands.length ? { suggestions: cands.map((c) => c.name) } : {}),
  };
}

/** 名字模糊匹配到多张时,把候选名字报出来让用户确认。 */
export function ambiguousNames(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  return [...getNameIndex().keys()].filter((name) => name.includes(q)).slice(0, 8);
}

export interface DeckStats {
  count: number;
  minions: number;
  spells: number;
  weapons: number;
  /** 能直接解掉随从的牌(伤害类 + 消灭类)。 */
  removal: number;
  /** 群体伤害。 */
  aoe: number;
  taunts: number;
  /** 1..7+(7 表示 7 费及以上)。 */
  curve: Record<number, number>;
  averageCost: number;
}

const COST_BUCKETS = [1, 2, 3, 4, 5, 6, 7];

function bucketOf(cost: number): number {
  return Math.min(7, Math.max(1, cost));
}

/** 统计一副牌(按卡 id 或名字都能进,会各自解析)。 */
export function deckStats(cards: readonly string[]): DeckStats {
  const stats: DeckStats = {
    count: 0, minions: 0, spells: 0, weapons: 0, removal: 0, aoe: 0, taunts: 0,
    curve: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
    averageCost: 0,
  };
  let costSum = 0;

  for (const raw of cards) {
    const card = resolveArenaCard(raw);
    if (!card?.found) continue;
    stats.count += 1;
    costSum += card.cost;
    stats.curve[bucketOf(card.cost)] += 1;
    if (card.type === '随从') stats.minions += 1;
    else if (card.type === '法术') stats.spells += 1;
    else if (card.type === '武器') stats.weapons += 1;
    if (/嘲讽/.test(card.note)) stats.taunts += 1;
    if (/伤害\d+群/.test(card.note)) { stats.aoe += 1; stats.removal += 1; }
    else if (/伤害\d+/.test(card.note) || /消灭|剧毒/.test(card.note)) stats.removal += 1;
  }

  stats.averageCost = stats.count ? Number((costSum / stats.count).toFixed(2)) : 0;
  return stats;
}

/** 竞技场 30 张的参考曲线。只作对比基线,不是硬指标。 */
const TARGET_CURVE: Record<number, [number, number]> = {
  1: [1, 3],
  2: [5, 7],
  3: [4, 6],
  4: [4, 6],
  5: [3, 5],
  6: [2, 4],
  7: [1, 4],
};

/** 曲线缺口:哪一档偏少、哪一档堆太多。 */
export function curveGaps(stats: DeckStats): string[] {
  const out: string[] = [];
  if (stats.count < 10) return out;   // 牌太少,谈曲线没意义
  const scale = stats.count / 30;
  for (const cost of COST_BUCKETS) {
    const have = stats.curve[cost];
    const [lo, hi] = TARGET_CURVE[cost];
    const wantLo = Math.max(1, Math.round(lo * scale));
    const wantHi = Math.max(wantLo + 1, Math.round(hi * scale));
    if (have < wantLo) out.push(`${cost === 7 ? '7 费以上' : `${cost} 费`}偏少(现在 ${have},一般要 ${wantLo}–${wantHi})`);
    else if (have > wantHi + 1) out.push(`${cost === 7 ? '7 费以上' : `${cost} 费`}堆了 ${have} 张,有点多`);
  }
  return out;
}

export interface CardScore {
  total: number;
  parts: string[];
}

const KEYWORD_VALUE: [RegExp, number, string][] = [
  [/嘲讽/, 1.5, '嘲讽'],
  [/圣盾/, 3, '圣盾'],
  [/突袭/, 2, '突袭'],
  [/冲锋/, 2.5, '冲锋'],
  [/风怒/, 2, '风怒'],
  [/剧毒/, 3, '剧毒'],
  [/亡语/, 1.5, '亡语'],
  [/吸血/, 1.5, '吸血'],
  [/潜行/, 1, '潜行'],
  [/冻结/, 1.5, '冻结'],
];

/**
 * 启发式评分。
 *
 * 基准是**同费白板**:一个 N 费随从的"标准身材"按 `2N + 1` 点算
 * (2 费 2/3 = 5 点、4 费 4/5 = 9 点、6 费 6/7 = 13 点,都对得上)。
 * 分数 = 6(基准) + 超出白板的点数 + 关键词 + 效果,再按费用折一点价。
 *
 * 为什么要这么算:先前用「每费效率」,结果 3 费 1/4 的银背族长(1.25/费) 排到了
 * 6 费 6/7 的石拳食人魔(1.86/费) 前面 —— 因为公式奖励"低费小身材"。改成
 * 「超出白板多少」之后,1/4 是 −2 点、6/7 是 0 点,顺序才对。
 *
 * 折价那一步是因为竞技场里**便宜且当下就能用的牌**更值:同样的强度,4 费比 7 费好用。
 * 分数没有绝对意义,只用于同一批候选里排序。
 */
export function scoreCard(card: ArenaCard, stats: DeckStats | null): CardScore | null {
  if (!card.found) return null;
  const parts: string[] = [];
  const cost = Math.max(1, card.cost);
  const vanilla = 2 * cost + 1;
  // 基准:随从/武器自带一个「生物」,法术只有效果。法术给 3,是因为它占一张牌、换一次节奏;
  // 曾经所有牌都给 6,结果 1 费的「+2 血抽一张」排到了火球术旁边 —— 那张牌其实很平庸。
  let total = card.type === '法术' ? 3 : 6;

  if (card.type === '随从') {
    const m = /^(\d+)\/(\d+)/.exec(card.note);
    if (m) {
      const atk = Number(m[1]);
      const hp = Number(m[2]);
      const over = atk + hp - vanilla;
      total += over;
      parts.push(`身材 ${atk}/${hp}(${over >= 0 ? '+' : ''}${over} 相对同费白板)`);
    }
  } else if (card.type === '武器') {
    const m = /^(\d+)\/(\d+)/.exec(card.note);
    if (m) {
      const atk = Number(m[1]);
      const dur = Number(m[2]);
      // 武器的「点数」按攻击力 × 前两次挥击算,耐久再长就边际递减
      const value = atk * Math.min(dur, 2) + atk;
      total += value - vanilla;
      parts.push(`武器 ${atk} 攻 ${dur} 耐久`);
    }
  }

  for (const [re, value, label] of KEYWORD_VALUE) {
    if (!re.test(card.note)) continue;
    total += value;
    parts.push(label);
  }

  const aoe = /伤害(\d+)群/.exec(card.note);
  if (aoe) {
    const d = Number(aoe[1]);
    // 群体伤害按「至少打中两个」估值,竞技场里这是翻盘牌
    total += d * 2.2;
    parts.push(`群体 ${d} 伤`);
  } else {
    const dmg = /伤害(\d+)/.exec(card.note);
    if (dmg) {
      const d = Number(dmg[1]);
      // 直伤在竞技场比同等身材值钱:能解场也能补刀
      total += d * 1.4;
      parts.push(`直伤 ${d}`);
    }
  }

  const draw = /抽(\d+)/.exec(card.note);
  if (draw) {
    const n = Number(draw[1]);
    total += n * 2;
    parts.push(`抽 ${n}`);
  }

  const buff = /\+(\d+)\/\+(\d+)/.exec(card.note);
  if (buff) {
    total += (Number(buff[1]) + Number(buff[2])) * 0.9;
    parts.push(`+${buff[1]}/+${buff[2]}`);
  } else {
    const atkBuff = /\+(\d+)攻/.exec(card.note);
    if (atkBuff) {
      total += Number(atkBuff[1]) * 0.8;
      parts.push(`+${atkBuff[1]} 攻`);
    }
    const hpBuff = /\+(\d+)血/.exec(card.note);
    if (hpBuff) {
      total += Number(hpBuff[1]) * 0.6;
      parts.push(`+${hpBuff[1]} 血`);
    }
  }

  const armor = /甲(\d+)/.exec(card.note);
  if (armor) {
    total += Number(armor[1]) * 0.6;
    parts.push(`护甲 ${armor[1]}`);
  }

  if (/消灭/.test(card.note)) { total += 5; parts.push('消灭'); }
  if (/沉默/.test(card.note)) { total += 2; parts.push('沉默'); }

  // 费用折价:只对特别贵的牌打折。折得太狠会把 4 费 4/5 压到 2 费 2/3 下面 ——
  // 竞技场里大随从是更值钱的,不能按每费效率算
  const discount = cost >= 7 ? 0.9 : cost === 6 ? 0.95 : 1;
  total *= discount;

  // 曲线调整:牌组缺这一档就加分,已经堆满就减分
  if (stats && stats.count >= 8) {
    const bucket = bucketOf(card.cost);
    const have = stats.curve[bucket] ?? 0;
    const scale = stats.count / 30;
    const [lo, hi] = TARGET_CURVE[bucket];
    const wantLo = Math.max(1, Math.round(lo * scale));
    const wantHi = Math.max(wantLo + 1, Math.round(hi * scale));
    if (have < wantLo) { total += 1.2; parts.push(`补 ${bucket === 7 ? '7+' : bucket} 费缺口`); }
    else if (have > wantHi + 1) { total -= 1; parts.push(`${bucket === 7 ? '7+' : bucket} 费已经很多`); }
  }

  return { total: Number(total.toFixed(2)), parts };
}

export interface RankedOption {
  card: ArenaCard;
  score: number | null;
  parts: string[];
}

/** 给三张候选打分并排序。分数只是排序参考,不是结论。 */
export function rankOptions(queries: readonly string[], stats: DeckStats | null): RankedOption[] {
  const out: RankedOption[] = [];
  for (const q of queries) {
    const card = resolveArenaCard(q);
    if (!card) continue;
    const score = scoreCard(card, stats);
    out.push({ card, score: score?.total ?? null, parts: score?.parts ?? [] });
  }
  return out.sort((a, b) => (b.score ?? -999) - (a.score ?? -999));
}

/** 渲染成她读得懂的一段。 */
export function renderDraft(
  options: readonly string[],
  deck: readonly string[],
): string {
  const stats = deckStats(deck);
  const lines: string[] = [];

  lines.push(`【当前牌组】${stats.count} 张 · 随从 ${stats.minions} / 法术 ${stats.spells}${stats.weapons ? ` / 武器 ${stats.weapons}` : ''} · 解场 ${stats.removal}(其中群体 ${stats.aoe}) · 嘲讽 ${stats.taunts} · 平均费用 ${stats.averageCost}`);
  if (stats.count) {
    const curve = [1, 2, 3, 4, 5, 6, 7].map((c) => `${c === 7 ? '7+' : c}:${stats.curve[c]}`).join(' ');
    lines.push(`  曲线 ${curve}`);
    const gaps = curveGaps(stats);
    if (gaps.length) lines.push(`  缺口:${gaps.join(';')}`);
  }

  if (!options.length) {
    lines.push('', '【这次没有给候选】');
    lines.push('  竞技场的三张候选读不到日志(Arena 通道不发选牌内容),要他念给你,或者截图念出来。');
    return lines.join('\n');
  }

  const ranked = rankOptions(options, stats.count >= 8 ? stats : null);
  lines.push('', `【候选】${ranked.length} 张`);
  for (const r of ranked) {
    if (!r.card.found) {
      lines.push(`  ? ${r.card.query} —— 卡表里查不到这张,别猜它的效果,按你知道的说`);
      continue;
    }
    const scoreText = r.score === null ? '无法评分' : `机械分 ${r.score}`;
    lines.push(`  ${r.card.name} · ${r.card.cost} 费 · ${r.card.type}${r.card.note ? ` · ${r.card.note}` : ''}`);
    lines.push(`      ${scoreText}${r.parts.length ? ` | ${r.parts.join('、')}` : ''}`);
  }

  const scored = ranked.filter((r) => r.score !== null);
  if (scored.length >= 2) {
    const [first, second] = scored;
    const gap = Number((first.score! - second.score!).toFixed(2));
    lines.push('', `【机械排序】${scored.map((r) => r.card.name).join(' > ')}`);
    lines.push(gap < 1
      ? `  头两名只差 ${gap} 分,基本平手 —— 这时候按牌组缺什么、以及你对牌面的判断选,别把这个排序当结论。`
      : `  头名领先 ${gap} 分。这个分只看身材/效果量/曲线,不看环境和对局思路,可以推翻,但要说出理由。`);
  }

  return lines.join('\n');
}

/**
 * 卡组的一句话摘要,塞进环境变量。
 *
 * 竞技场选牌时她不调 `hearthstone_draft` 就看不见牌组 —— 而选牌这件事最需要的
 * 恰恰是「我已经有什么、还缺什么」。放进环境变量之后,每一轮她都能看到,
 * 不用为了看一眼曲线而调一次工具。
 *
 * 没在选牌(牌组空)时返回 null,由调用方决定写"没在选牌"。
 */
export function deckBrief(deck: readonly string[]): string | null {
  if (!deck.length) return null;
  const stats = deckStats(deck);
  const head = [
    `已选 ${stats.count} 张`,
    `随从 ${stats.minions} / 法术 ${stats.spells}${stats.weapons ? ` / 武器 ${stats.weapons}` : ''}`,
    `解场 ${stats.removal}(群体 ${stats.aoe})`,
    `嘲讽 ${stats.taunts}`,
    `平均 ${stats.averageCost} 费`,
  ].join(' · ');
  const curve = [1, 2, 3, 4, 5, 6, 7].map((c) => `${c === 7 ? '7+' : c}:${stats.curve[c]}`).join(' ');
  const lines = [head, `  曲线 ${curve}`];
  const gaps = curveGaps(stats);
  if (gaps.length) lines.push(`  缺口:${gaps.join(';')}`);
  return lines.join('\n');
}

/**
 * 按费用分组的卡组清单,给推理模型看。
 *
 * 为什么不用 `deckBrief`:那个是给人看的一句话摘要,**模型需要看到每一张牌**。
 * 「30 张牌里有什么」是判断这套牌怎么赢的唯一依据 —— 只给平均费和曲线,
 * 它只能给出「多下随从」这种说了等于没说的话。
 */
export function deckListForModel(deck: readonly string[]): { cards: string; curve: string; stats: DeckStats } {
  const stats = deckStats(deck);
  const byCost = new Map<number, string[]>();
  let unknown = 0;
  for (const raw of deck) {
    const card = resolveArenaCard(raw);
    if (!card || !card.found) {
      unknown += 1;
      continue;
    }
    const cost = Math.min(7, Math.max(0, card.cost));
    const detail = card.note ? `${card.name}(${card.cost}费 ${card.note})` : `${card.name}(${card.cost}费 ${card.type})`;
    const bucket = byCost.get(cost) ?? [];
    bucket.push(detail);
    byCost.set(cost, bucket);
  }
  const lines: string[] = [];
  for (const cost of [...byCost.keys()].sort((a, b) => a - b)) {
    lines.push(`${cost === 7 ? '7+' : cost} 费：${byCost.get(cost)!.join('、')}`);
  }
  if (unknown) lines.push(`（另有 ${unknown} 张卡表里查不到，按名字判断）`);
  const curve = [1, 2, 3, 4, 5, 6, 7].map((c) => `${c === 7 ? '7+' : c}:${stats.curve[c]}`).join(' ');
  return { cards: lines.join('\n'), curve, stats };
}

/**
 * 竞技场的完整操作流程 —— **不放在 ENV_PROMPT 里，跟 `hearthstone_draft` 的回执走。**
 *
 * 为什么：这 60 行只有选牌那几分钟用得上，天梯对局一个字都不沾。而系统前缀是每轮
 * 都要重塞一遍的 —— 让它常驻，等于每天为了一年用几次的东西付几百次上下文。
 *
 * 移进回执之后，她**真去选牌的时候**才看到这份流程，而且那时正是她需要的时刻。
 * ENV_PROMPT 里只留一句「要选牌就调 hearthstone_draft，流程在回执里」。
 */
export const ARENA_GUIDE = `【竞技场流程】先说清一件事：**选牌那三张，日志里读不到。** 炉石的 [Arena] 通道不发选牌内容，
所以要他念牌名或者截图给你，别干等他问「帮我选」。

**三张到手** → 调 \`hearthstone_draft\`，\`options\` 传三张牌名。回执里有每张的费用、效果、**机械分**，
和他当前牌组的曲线与缺口。**机械分只是排序参考** —— 它只看身材、效果量、曲线，不看环境、职业搭配和
当期补丁。你的判断优先；跟它差得远就明说「我不同意这个排序」并给理由。
他选完用 \`pick\` 记下来（不记曲线就错了），新一轮用 \`reset\`。

**动手之前先看有没有这个职业的赢法。** 卡表只知道牌多胖多瘦，不知道「这个版本竞技场里德鲁伊靠什么赢」。
那份知识在 \`hearthstone_meta\` 里：不带参数读，没有再用 \`browser_search\` 搜一次
（中文「炉石 竞技场 <职业> 选牌」，英文「Hearthstone arena <class> tier list」），
把**能立刻用的**提炼成 3–6 条存进去。**整个 run 只搜一次**，之后每次选牌先 read。
回执出现「⚠ 跟你现在的牌组对不上」才重搜；写着「✓ 同一套牌」就直接用。

**网上说的可能过时。** 没写版本号、或者明显是几个版本前的，别照抄 —— 直说「这个信息可能过时」，然后按牌面判断。

**选完之后：这套牌靠什么赢，用 \`hearthstone_plan\` 推一次。** 曲线和曲线下的东西告诉你的只是形状，不是方向 ——
同样「中速 3.4 费」的两套牌，一套该打脸一套该换牌。先 \`read\`，卡组没变它会直接返回上次结论，重推带 \`force=true\`。
牌选到 15 张以上再推，刚拿三张推出来跟「多下随从」没区别。

推出来的怎么用：**是方向，不是每一步**。它点名的牌是核心，对局里优先保护；它说「最怕什么」那句，进对局后留意对面是不是那一路。
**你不同意就说出来** —— 它看不到你的对局。但要给理由（「2 费只有两张，铺不起来」）。
跟 \`hearthstone_meta\` 冲突时以 plan 为准（它按你这 30 张算的），但「这个版本什么牌强」那种信息 plan 给不了。
`;
