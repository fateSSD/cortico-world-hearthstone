/**
 * 开局换牌（mulligan）。
 *
 * 这一段原来整个是空的 —— 扩展从 `MULLIGAN_STATE` 只取了「谁是我」，从未把
 * 「你现在可以换牌」这件事说出来，也没算过留哪张。于是她开局只能看着一份起手说
 * 「开局就这样」，而那三张本来是可以换的。
 *
 * 这里只做两件事：
 *   1. `mulliganText` —— 把事实摆清楚：起手几张、每张什么费、谁先手。
 *   2. `mulliganPlan` —— 给留/换的机械建议。
 *
 * 建议刻意保守。留牌是**概率**活儿（要赌后面抽什么），日志里没有牌库顺序，
 * 任何「这张一定留」的强断言都是编的。所以这里只按费用曲线和核心牌名单说话，
 * 措辞也用「建议 / 可以」，不写成定论。
 */
import type { GameSnapshot } from './parser.ts';
import { readHand, parseKeepCards, type AdviceOptions, type HandCardView } from './advice.ts';

/** 起手牌（已剔除硬币 —— 硬币是后手补偿，本来就不在可换范围里）。 */
export function openingHand(snapshot: GameSnapshot, opts: AdviceOptions = {}): HandCardView[] {
  const keep = parseKeepCards(opts.keepCards);
  return readHand(snapshot.me, keep).filter((c) => !/COIN|GAME_005/i.test(c.cardId));
}

/** 换牌窗口开没开。 */
export function isMulliganOpen(snapshot: GameSnapshot): boolean {
  const state = (snapshot.me.mulliganState ?? '').toUpperCase();
  // INPUT = 轮到我选牌。DEALING/WAITING/DONE 都已经过了。
  // 另外 `step=BEGIN_MULLIGAN` 而 MULLIGAN_STATE 还没写进来的那一两帧也算 —— 窗口正是那时候。
  return state === 'INPUT' || (state === '' && snapshot.step === 'BEGIN_MULLIGAN' && snapshot.turn <= 1);
}

const cardLabel = (c: HandCardView): string => `${c.name ?? '未知的牌'}（${c.cost} 费）`;

/**
 * 开局那句事实。
 *
 * 只报能核对的：张数、每张的名字与费用、先后手。**不报卡牌效果** —— 手牌在换牌阶段
 * 还没有 `note`，硬塞一句「战吼打 3」只会让她把记忆里的东西当成日志里的东西念出来。
 */
export function mulliganText(snapshot: GameSnapshot, opts: AdviceOptions = {}): string {
  const cards = openingHand(snapshot, opts);
  // 少于 2 张 = 手牌还没 dump 完(实测开局前一两批只到 1 张)。
  // 这时候报「起手 1 张」会让她以为真只有一张,不如不说。
  if (cards.length < 2) return '';
  const first = (snapshot.firstPlayerId || snapshot.activePlayerId) === snapshot.me.playerId;

  const coin = snapshot.me.coinCount ? `，另有 ${snapshot.me.coinCount} 张硬币（换不掉）` : '';
  const list = cards.map(cardLabel).join('、');
  return `换牌阶段：${first ? '我先手' : '对手先手'}，起手 ${cards.length} 张 —— ${list}${coin}。`;
}

export interface MulliganPlan {
  /** 建议留的牌。 */
  keep: HandCardView[];
  /** 建议换掉的牌。 */
  toss: HandCardView[];
  /** 一句话建议。 */
  text: string;
}

/**
 * 留牌打分。
 *
 * 只用费用和核心牌名单，不看卡牌效果 —— 换牌阶段手牌的 `note` 多为空，
 * 靠效果判断会变成猜。费用曲线是这一段里唯一硬得起来的信息。
 */
function score(card: HandCardView, first: boolean, seen: Map<string, number>): number {
  if (card.keep) return 100; // 核心牌名单里的，无条件留
  const dup = seen.get(card.cardId) ?? 0;
  seen.set(card.cardId, dup + 1);
  let base: number;
  if (card.cost <= 1) base = 72;
  else if (card.cost === 2) base = 66;
  else if (card.cost === 3) base = first ? 42 : 52;
  else if (card.cost === 4) base = first ? 18 : 32;
  else base = 0;
  // 同名重复：第二张起大幅降权。起手两张一样的 2 费，留一张就够，
  // 另一张换掉换来的期望比留着高 —— 除非它是核心牌（上面已经提前 return）。
  if (dup > 0) base -= 34;
  return base;
}

/**
 * 留/换建议。
 *
 * 判据三条，都能从日志直接读到，不含推测：
 *   - 先手留 2 张、后手留 3 张（后手多一张牌、还多一枚硬币，容得下多留一张）；
 *   - 单张分数门槛 40：低于它的（4 费以上、或同名第二张）默认换；
 *   - 一张都留不住时（起手全是高费），明说「全换」。
 */
export function mulliganPlan(snapshot: GameSnapshot, opts: AdviceOptions = {}): MulliganPlan {
  const cards = openingHand(snapshot, opts);
  const first = (snapshot.firstPlayerId || snapshot.activePlayerId) === snapshot.me.playerId;

  if (cards.length < 2) return { keep: [], toss: [], text: '' };

  const seen = new Map<string, number>();
  const scored = cards.map((card) => ({ card, s: score(card, first, seen) }));
  // 留牌名额只数**普通牌**。核心牌是额外的一张，不占名额。
  //
  // 踩过：核心牌也占名额时，一局起手「1费、1费、2费、核心7费」会算成
  // 「留 1、1、核心，换掉 2 费」—— 把一张好牌换出去，换来一张未知牌。
  // 他已经指定了核心必留，剩下那几张便宜牌本来就该留，两者不该互相挤。
  const cap = first ? 2 : 3;
  const sorted = [...scored].sort((a, b) => b.s - a.s);
  const keepSet = new Set<HandCardView>();
  let normalKept = 0;
  for (const { card, s } of sorted) {
    if (card.keep) {
      keepSet.add(card);
      continue;
    }
    if (normalKept >= cap) break;
    if (s >= 40) {
      keepSet.add(card);
      normalKept += 1;
    }
  }
  const keep = cards.filter((c) => keepSet.has(c));
  const toss = cards.filter((c) => !keepSet.has(c));

  const keepText = keep.length ? keep.map(cardLabel).join('、') : '';
  const tossText = toss.length ? toss.map(cardLabel).join('、') : '';

  // 理由只从事实里取，不解释卡牌效果。
  const cheap = keep.filter((c) => c.cost <= 2).length;
  const core = keep.filter((c) => c.keep).length;
  const reasons: string[] = [];
  if (!keep.length) {
    const cheapest = Math.min(...cards.map((c) => c.cost));
    reasons.push(`这几张里最便宜的也要 ${cheapest} 费，${first ? '先手' : '后手'}会空过前期`);
  } else {
    if (core) reasons.push(`${core} 张在核心名单里`);
    if (cheap) reasons.push(`${cheap} 张是 2 费以内，开局有事可做`);
    if (!cheap && keep.length) reasons.push('这批里没有 2 费以内的牌，留着只能算将就');
  }
  if (toss.length && keep.length) {
    const dear = toss.filter((c) => c.cost >= 4);
    if (dear.length) reasons.push(`换掉的 ${dear.length} 张在 4 费以上，前期指望不上`);
  }
  const reasonText = reasons.length ? `（${reasons.join('；')}）` : '';

  const text = !keep.length
    ? `建议全换：这三张一张都撑不起前期${reasonText}。换牌找低费，别心疼。`
    : toss.length
      ? `建议留 ${keepText}，换掉 ${tossText}${reasonText}。`
      : `建议都留着：${keepText}${reasonText}。`;

  return { keep, toss, text };
}
