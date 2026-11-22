/**
 * 斩杀规划:把「这回合最多能打出多少脸伤」算成一份可解释的账。
 *
 * 三件事比单纯加攻击力麻烦:
 *
 * 1. **嘲讽**。攻击力不是全都能打到脸:每个嘲讽都需要被解掉,而且方法是「用某个随从撞一次」,
 *    一次攻击就没了。所以过墙会有浪费 —— 7 攻打 1 血嘲讽,那 6 点就白扔了。这里按
 *    「小的先去撞、刚好够的最好」贪心排,算出实际能穿过墙的那部分。
 * 2. **圣盾**。破盾那一下不掉血,所以一个带圣盾的嘲讽需要两次攻击:一次破盾、一次打血。
 * 3. **buff**。加攻击力的法术要占水晶,而且要有人能接 —— 场上没有能攻击的随从时,buff 一文不值。
 *
 * 水晶由直伤法术和 buff 共享,按「每点费用的收益」从高到低分配。
 *
 * 算不进去的(回执里会明说):冲锋随从召唤、条件不满足的战吼伤害、连击加成、无视嘲讽。
 * 宁可说少,不要给一个打不出来的数。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DarkGiftInfo, GameSnapshot, MinionView, SideState } from './parser.ts';
import { damageSpellsInHand, type DamageCard } from './damage.ts';
import {
  battlecryState, cardBody, cardCostOf, cardEffects, cardName, cardNote,
  cardTypeOf, darkGiftEffects, LEVELER_NOTE_RE, passiveOf, resolveHandAoeCard, type BattlecryContext,
} from './effects.ts';

/** 目标的称呼:日志名 → 卡表 → 「未知随从」。别把内部 id 拼进她念的句子。 */
const targetLabel = (m: { name?: string; cardId?: string }): string =>
  m.name || cardName(m.cardId ?? '') || '未知随从';

export interface BuffCard {
  cardId: string;
  name: string;
  cost: number;
  atk: number;
  /**
   * 顺带加多少生命（`+2/+2` 里的第二个 2）。
   *
   * **不参与斩杀计算** —— 血不加伤害。但它决定「贴完变成几比几」这句话说得对不对：
   * 加固是 `+2/+2`，说成「变 5/4」而实际是「5/6」，他会照着错的数判断该不该贴。
   * 2026-11-14 补。
   */
  health: number;
}

type BuffEntry = [string, number, number, number?];

let buffTable: Record<string, BuffEntry> | null = null;

function loadBuffs(): Record<string, BuffEntry> {
  if (buffTable) return buffTable;
  try {
    const file = fileURLToPath(new URL('./data/buff-spells.json', import.meta.url));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cards?: Record<string, BuffEntry> };
    buffTable = raw.cards ?? {};
  } catch {
    buffTable = {};
  }
  return buffTable;
}

function lookupBuff(cardId: string): BuffEntry | undefined {
  const table = loadBuffs();
  const bare = cardId.replace(/^(?:CORE_|VAN_|VANILLA_|TUTORIAL_)/, '');
  return table[cardId] ?? table[bare] ?? table[`CORE_${bare}`] ?? table[`VAN_${bare}`];
}

/** 查一张加攻牌。给「卡名兜底」用:衍生牌不在主卡表里,只在这张表里。 */
export function lookupBuffCard(cardId: string): BuffCard | undefined {
  const entry = lookupBuff(cardId);
  return entry ? { cardId, name: entry[0], cost: entry[1], atk: entry[2], health: entry[3] ?? 0 } : undefined;
}

/** 手牌里能给自己随从加攻击力的 buff。 */
export function buffsInHand(hand: readonly { cardId: string }[]): BuffCard[] {
  const out: BuffCard[] = [];
  for (const card of hand) {
    if (!card.cardId) continue;
    const entry = lookupBuff(card.cardId);
    if (!entry) continue;
    out.push({ cardId: card.cardId, name: entry[0], cost: entry[1], atk: entry[2] });
  }
  return out;
}

/** 一张打出去就掉血的战吼（或已激活连击）随从。 */
export interface BattlecryCard {
  cardId: string;
  name: string;
  cost: number;
  /** 这一张的战吼/连击伤害(打脸部分)。 */
  damage: number;
  /** 是否来自黑暗之赐双倍战吼或连击。 */
  tag?: string;
}

/** 一张当回合就能冲锋打脸的随从（自带冲锋或黑暗之赐冲锋）。 */
export interface ChargeCard {
  cardId: string;
  name: string;
  cost: number;
  damage: number;
  reason?: string;
}

type LethalHandCard = {
  id?: number;
  cardId: string;
  cost?: number;
  name?: string;
  darkGift?: DarkGiftInfo;
};

function isValidHandCost(card: { cardId: string; cost?: number }): boolean {
  if (typeof card.cost !== 'number') return false;
  if (card.cost === 0 && (cardCostOf(card.cardId) ?? 0) > 0) return false;
  return true;
}

function makeBattlecryCtx(me: SideState, deckHasDuplicates?: boolean): BattlecryContext {
  const hand = me.handCards ?? [];
  return {
    weapon: !!me.weapon,
    minionCount: me.minions.length,
    auras: me.auras?.length,
    imbueCount: me.imbueCount,
    hasDarkGiftInHand: hand.some((c) => Boolean(c.darkGift)),
    deckHasDuplicates,
  };
}

/**
 * 手牌里「打出去就能打到脸」的战吼伤害。
 */
export function battlecriesInHand(
  hand: readonly LethalHandCard[],
  ctx: BattlecryContext,
): BattlecryCard[] {
  const out: BattlecryCard[] = [];
  for (const card of hand) {
    if (!card.cardId) continue;
    if (!isValidHandCost(card)) continue;
    const fx = cardEffects(card.cardId);
    if (fx.battlecry <= 0) continue;
    if (battlecryState(fx, ctx) !== 'ready') continue;
    const note = cardNote(card.cardId);
    if (/随机/.test(note)) continue;
    if (new RegExp(`伤害\\s*${fx.battlecry}[^\\s]*随从`).test(note)) continue;
    const dg = card.darkGift ? darkGiftEffects(card.darkGift.cardId, card.darkGift.note) : null;
    const mult = dg?.doubleBattlecry ? 2 : 1;
    out.push({
      cardId: card.cardId,
      name: card.name || cardName(card.cardId),
      cost: Math.max(0, card.cost!),
      damage: fx.battlecry * mult,
      ...(mult > 1 ? { tag: '双倍战吼' } : {}),
    });
  }
  return out;
}

/**
 * 英雄这一次攻击的有效攻击力。
 *
 * 武器攻击力和英雄的 ATK 是同一个数,不能相加 —— 装备武器后英雄的 ATK 就等于武器攻击。
 */
export function heroSwing(s: SideState): number {
  // 打不到脸的武器不算:装备武器之后英雄的攻击力**就是**那把武器给的,
  // 武器砍不到脸,英雄自然也砍不到。无穷之手 4/2「无法攻击英雄」实测踩过 ——
  // 她把它算成 4 点打脸威胁,其实那 4 点只能砍随从。
  if (s.weapon && s.weapon.hitsHero === false) return 0;
  return Math.max(s.heroAttack, s.weapon?.atk ?? 0);
}

/**
 * 下回合**最坏情况**下,我还能留下多少场攻。
 *
 * 斩杀线算的是「这回合能打出去多少」。可玩家经常问的是「下回合能不能收」——
 * 那个数字的前提是这些随从能活过对面的回合,而对面是先动手的那一方。
 *
 * 一个随从一回合只能攻击一次,所以对面 K 个能动手的最多换掉我 K 个;他会挑最贵的换。
 * 按攻击力降序扣掉 K 个,剩下的才是「最坏情况下还能打脸的量」。
 *
 * 实测 2026-10-24 第 19 回合:我场攻 17(六只),对面只有诺兹多姆 8/8 + 治疗图腾 ——
 * 他两个能动手的,最多换掉我最贵的两个(6/8 和 5/5),下回合实际只剩 6 点。
 * 按 17 去算斩杀,差的不是一点。
 */
export function worstCaseFaceAttack(me: SideState, foe: SideState): number {
  const total = me.minions.reduce((n, m) => n + Math.max(0, m.atk), 0);
  if (total === 0) return 0;
  // 能动手的:随从 + 武器(英雄自己也能打一刀)。冻结的打不出来。
  const attackers = foe.minions.filter((m) => m.atk > 0 && !m.frozen).length + (heroSwing(foe) > 0 ? 1 : 0);
  if (attackers === 0) return total;
  const atk = me.minions.map((m) => Math.max(0, m.atk)).sort((a, b) => b - a);
  return atk.slice(attackers).reduce((n, x) => n + x, 0);
}

/** 这一方这回合能打出去的所有攻击,一次一项;风怒算两次。 */
export function swingsOf(s: SideState): number[] {
  const out: number[] = [];
  for (const m of s.minions) {
    if (m.atk <= 0 || !m.canAttack) continue;
    out.push(m.atk);
    if (m.windfury) out.push(m.atk);
  }
  const hero = heroSwing(s);
  if (hero > 0) {
    out.push(hero);
    // 英雄风怒(武器风怒)能砍两刀。少这一下,「他还剩 6」就会被算成「只够 3 点」——
    // 2026-10-30 实测:她说「这回合只凑出 3 点,他还剩 6」,实际武器砍两刀正好 6 点够斩。
    if (s.heroWindfury) out.push(hero);
  }
  return out;
}

/** 一次攻击的「身份」:攻击力 + 有没有剧毒。过墙时剧毒能一刀解任意血量的嘲讽。 */
export interface SwingUnit {
  atk: number;
  poisonous: boolean;
}

/** 和 swingsOf 一样,但带着剧毒标记 —— 过墙要用这个。 */
export function swingUnits(s: SideState): SwingUnit[] {
  const out: SwingUnit[] = [];
  for (const m of s.minions) {
    if (m.atk <= 0 || !m.canAttack) continue;
    out.push({ atk: m.atk, poisonous: m.poisonous });
    if (m.windfury) out.push({ atk: m.atk, poisonous: m.poisonous });
  }
  const hero = heroSwing(s);
  if (hero > 0) {
    out.push({ atk: hero, poisonous: false });
    if (s.heroWindfury) out.push({ atk: hero, poisonous: false });
  }
  return out;
}

function normalizeSwings(swings: readonly (number | SwingUnit)[]): SwingUnit[] {
  return swings.map((x) => (typeof x === 'number' ? { atk: x, poisonous: false } : x));
}

export interface WallResult {
  cleared: boolean;
  /** 过墙用掉的攻击力(含过量浪费)。 */
  spent: number;
  /** 穿过墙之后还能打到脸的攻击力。 */
  leftover: number;
  steps: string[];
}

/**
 * 过墙:把嘲讽一个个解掉,剩下的攻击力才算能打到脸。
 *
 * 贪心两条:破盾用最小的一次攻击(浪费最小);解血时优先找「单个刚好够」的随从,
 * 找不到才用小的凑。这样接近真人打法,也不会因为一个 7 攻打 1 血怪就把 6 点算成剩余的。
 */
export function breachTaunts(
  swings: readonly (number | SwingUnit)[],
  taunts: readonly MinionView[],
): WallResult {
  const pool = normalizeSwings(swings).sort((a, b) => a.atk - b.atk);
  const steps: string[] = [];
  let spent = 0;

  const items = taunts.map((t) => ({ t, need: Math.max(1, t.health), shield: t.divineShield }));

  // 1) 先破盾:圣盾不吃伤害,得单独用一次攻击
  for (const item of items) {
    if (!item.shield) continue;
    if (!pool.length) return { cleared: false, spent, leftover: 0, steps };
    const swing = pool.shift()!;
    spent += swing.atk;
    item.shield = false;
    steps.push(`用 ${swing.atk} 点攻击破「${targetLabel(item.t)}」的圣盾`);
  }

  // 2) 按血量从少到多解掉,便宜的先处理,减少浪费
  items.sort((a, b) => a.need - b.need);
  for (const item of items) {
    pool.sort((a, b) => a.atk - b.atk);

    // 剧毒:不管对面多少血,一刀就死。用最小的一次剧毒攻击,省下别的攻击力
    const poisonIdx = pool.findIndex((u) => u.poisonous);
    if (poisonIdx >= 0) {
      const unit = pool.splice(poisonIdx, 1)[0];
      spent += unit.atk;
      steps.push(`剧毒 ${unit.atk} 攻解「${targetLabel(item.t)}」(${item.need} 血,一刀) `);
      continue;
    }

    const idx = pool.findIndex((a) => a.atk >= item.need);
    if (idx >= 0) {
      const swing = pool.splice(idx, 1)[0];
      spent += swing.atk;
      steps.push(`${swing.atk} 点攻击解「${targetLabel(item.t)}」(${item.need} 血)`);
      continue;
    }
    // 没有单个够的,用小的凑
    let acc = 0;
    while (pool.length && acc < item.need) {
      const a = pool.shift()!;
      acc += a.atk;
      spent += a.atk;
    }
    if (acc < item.need) {
      steps.push(`攻击力不够解「${targetLabel(item.t)}」(${item.need} 血,只凑出 ${acc})`);
      return { cleared: false, spent, leftover: 0, steps };
    }
    steps.push(`几个随从合力解「${targetLabel(item.t)}」(${item.need} 血,用了 ${acc})`);
  }

  const leftover = pool.reduce((a, b) => a + b.atk, 0);
  return { cleared: true, spent, leftover, steps };
}

export interface LethalPlan {
  /** 所有能打出去的攻击力(未过墙)。 */
  swingsTotal: number;
  /** 过墙细节。 */
  wall: WallResult;
  /** 过墙后能打到脸的攻击力。 */
  faceAtk: number;
  /** 手牌直伤合计。 */
  spellDamage: number;
  /** buff 加的攻击力合计（含磁力）。 */
  buffDamage: number;
  /**
   * 手牌战吼（及已激活的随从连击直伤）能打到脸的伤害合计。
   */
  battlecryDamage: number;
  /** 手牌冲锋随从（或黑暗之赐冲锋）打到脸的伤害合计。 */
  chargeDamage: number;
  /** 总共能打到脸的伤害。 */
  total: number;
  /**
   * `faceAtk` 是靠「先把场面扫掉」拿到的，不是靠随从撞墙。
   */
  viaClear: boolean;
  spells: DamageCard[];
  buffs: BuffCard[];
  /** 用到的战吼/连击随从(逐张,同名两张各一条)。 */
  battlecries: BattlecryCard[];
  /** 用到的冲锋随从(逐张)。 */
  charges: ChargeCard[];
  /** 用掉了多少水晶。 */
  manaSpent: number;
  /** 用到的法术伤害加成。 */
  spellPower: number;
  /** 算不进去的东西,要一起讲出来。 */
  caveats: string[];
}

/* ---------- 清场组合：先把对面全变成 1 血，再扫一遍 -------------- */

export interface SweepPlan {
  /** 变形牌 + 群伤的合计费用。 */
  cost: number;
  /** 变形牌在手牌中的下标。 */
  levelerIndex: number;
  /** 变形牌名（生而平等这类）。 */
  leveler: string;
  /** 群伤来源在手牌中的下标。 */
  sweeperIndex: number;
  /** 群伤来源名。 */
  sweeper: string;
  /** 群伤来源的 cardId —— 要从费用背包里排掉，不能重复计价。 */
  sweeperId: string;
  /** 群伤来源类型：战吼随从或群伤法术。 */
  sweeperKind: 'battlecry' | 'spell';
  /** 群伤来源自己的费用（回执里要单独报出来，不能拿总费用顶上）。 */
  sweeperCost: number;
  /** 对随从造成的清场群伤点数。 */
  damage: number;
  /** 同时能打到敌方英雄脸上的伤害（只打随从的群伤为 0）。 */
  faceDamage: number;
  /** 群伤是否会扫到我方随从。 */
  hitsOwnMinions: boolean;
  /** 群伤是否会打到我方英雄。 */
  hitsOwnHero: boolean;
  /** 对我方英雄造成的自伤点数（0 = 安全）。 */
  selfHeroDamage: number;
  /** 清场后我方实际存活下来能打脸的场攻（含武器/英雄 + 带圣盾活下来的随从）。 */
  survivingFaceAtk: number;
  /** 清场后场上是否还剩能攻击的存活随从（决定剩余费用里还能不能贴随从 buff）。 */
  survivingMinionCanAttack: boolean;
  /** 清场时顺带烧死的我方随从数量（所有非圣盾随从都会被变 1 血后扫死）。 */
  ownLostCount: number;
  /** 挡路的原因；`null` 表示这条路走得通。 */
  blocked: string | null;
}

function handCardEffectiveCost(card: LethalHandCard, fallbackCost?: number | null): number | null {
  if (typeof card.cost === 'number') {
    return isValidHandCost(card) ? Math.max(0, card.cost) : null;
  }
  if (typeof fallbackCost === 'number') return Math.max(0, fallbackCost);
  const tableCost = cardCostOf(card.cardId);
  return typeof tableCost === 'number' ? Math.max(0, tableCost) : null;
}

/**
 * 手上有「全部随从变 1 血」+「群伤（战吼或法术）」时，能不能把对面的墙连人一起扫掉。
 *
 * 区分「只打敌方」与「敌我全打」：敌我全打时，变形牌会把己方随从也变 1 血，
 * 非圣盾己方随从会一并阵亡，绝不把死尸算作 survivingFaceAtk。
 */
export function detectSweep(
  me: SideState,
  foe: SideState,
  budget: number,
  deckHasDuplicates?: boolean,
): SweepPlan | null {
  const taunts = foe.minions.filter((m) => m.taunt);
  if (!taunts.length) return null;

  const hand = (me.handCards ?? []) as LethalHandCard[];

  // 变形牌：卡面写着「所有随从…生命值变为1」。必须是「所有」，单体变 1 血清不了场。
  let levelerIdx = -1;
  let levelerCost = 0;
  for (let i = 0; i < hand.length; i += 1) {
    const c = hand[i];
    if (!c.cardId) continue;
    const effCost = handCardEffectiveCost(c);
    if (effCost === null || effCost > budget) continue;
    if (LEVELER_NOTE_RE.test(cardNote(c.cardId))) {
      levelerIdx = i;
      levelerCost = effCost;
      break;
    }
  }
  if (levelerIdx < 0) return null;
  const leveler = hand[levelerIdx];

  const ctx = makeBattlecryCtx(me, deckHasDuplicates);
  const spellPower = me.spellPower ?? 0;
  const boardSlotsFree = Math.max(0, 7 - me.minions.length);
  const myEffHp = me.health + me.armor;
  const heroAtkBase = heroSwing(me);
  const survivingHeroAtk = heroAtkBase > 0 ? heroAtkBase * (me.heroWindfury ? 2 : 1) : 0;
  const fullSwingsTotal = swingUnits(me).reduce((a, b) => a + b.atk, 0);

  let best: SweepPlan | null = null;
  for (let i = 0; i < hand.length; i += 1) {
    if (i === levelerIdx) continue;
    const c = hand[i];
    if (!c.cardId) continue;
    const effCost = handCardEffectiveCost(c);
    if (effCost === null || levelerCost + effCost > budget) continue;

    const resolved = resolveHandAoeCard(c, { spellPower, battlecryCtx: ctx, boardSlotsFree });
    if (!resolved || resolved.spreads) continue;

    let survivingFaceAtk = fullSwingsTotal;
    let survivingMinionCanAttack = me.minions.some((m) => m.atk > 0 && m.canAttack);
    let ownLostCount = 0;

    if (resolved.hitsOwnMinions) {
      survivingFaceAtk = survivingHeroAtk;
      survivingMinionCanAttack = false;
      for (const m of me.minions) {
        if (m.divineShield) {
          // 圣盾挡掉这一下 1 血以上群伤仍能存活
          if (m.atk > 0 && m.canAttack) {
            survivingMinionCanAttack = true;
            survivingFaceAtk += m.atk * (m.windfury ? 2 : 1);
          }
        } else {
          ownLostCount += 1;
        }
      }
    }

    const cost = levelerCost + effCost;
    const selfKill = resolved.selfHeroDamage >= myEffHp && resolved.selfHeroDamage > 0;
    const candidate: SweepPlan = {
      cost,
      levelerIndex: levelerIdx,
      leveler: leveler.name || cardName(leveler.cardId) || '变形牌',
      sweeperIndex: i,
      sweeper: c.name || cardName(c.cardId) || '清场牌',
      sweeperId: c.cardId,
      sweeperKind: resolved.kind,
      sweeperCost: effCost,
      damage: resolved.damage,
      faceDamage: resolved.faceDamage,
      hitsOwnMinions: resolved.hitsOwnMinions,
      hitsOwnHero: resolved.hitsOwnHero,
      selfHeroDamage: resolved.selfHeroDamage,
      survivingFaceAtk,
      survivingMinionCanAttack,
      ownLostCount,
      blocked: selfKill ? `${c.name || cardName(c.cardId) || '清场牌'}会伤自己 ${resolved.selfHeroDamage} 血，放出去自己先死了` : null,
    };

    const bestSelfKill = Boolean(best && best.selfHeroDamage >= myEffHp && best.selfHeroDamage > 0);
    const candReach = candidate.survivingFaceAtk + candidate.faceDamage;
    const bestReach = best ? best.survivingFaceAtk + best.faceDamage : -1;
    if (
      !best
      || (bestSelfKill && !selfKill)
      || (bestSelfKill === selfKill && (
        candReach > bestReach
        || (candReach === bestReach && Number(candidate.hitsOwnMinions) < Number(best.hitsOwnMinions))
        || (candReach === bestReach && candidate.hitsOwnMinions === best.hitsOwnMinions && candidate.cost < best.cost)
      ))
    ) {
      best = candidate;
    }
  }
  if (!best) return null;

  if (!best.blocked) {
    const shielded = taunts.find((m) => m.divineShield);
    const reborn = foe.minions.find((m) => m.reborn);
    best.blocked = shielded
      ? `对面的「${targetLabel(shielded)}」带圣盾，群伤一次只破盾`
      : reborn
        ? `对面的「${targetLabel(reborn)}」带复生，扫完会以 1 血站起来`
        : null;
  }

  return best;
}

/* ---------- 费用背包 -------------------------------------------------- */

/** 单张手牌在背包里的条目（同槽位互斥/合并，绝不重复扣费）。 */
type PackItem = {
  handIndex: number;
  cost: number;
  value: number;
  spell?: DamageCard;
  buff?: BuffCard;
  battlecry?: BattlecryCard;
  charge?: ChargeCard;
};

function packBest(items: readonly PackItem[], cap: number): { value: number; picks: PackItem[] } {
  const limit = Math.max(0, Math.min(cap, 30));
  const dp: { value: number; picks: PackItem[] }[] = Array.from({ length: limit + 1 }, () => ({ value: 0, picks: [] }));
  for (const item of items) {
    if (item.cost > limit) continue;
    for (let m = limit; m >= item.cost; m -= 1) {
      const prev = dp[m - item.cost];
      const candidate = prev.value + item.value;
      if (candidate > dp[m].value) dp[m] = { value: candidate, picks: [...prev.picks, item] };
    }
  }
  return dp.reduce((a, b) => (b.value > a.value ? b : a), dp[0]);
}

function sumPicks(picks: readonly PackItem[]) {
  let manaSpent = 0;
  let spellDamage = 0;
  let buffDamage = 0;
  let battlecryDamage = 0;
  let chargeDamage = 0;
  const spells: DamageCard[] = [];
  const buffs: BuffCard[] = [];
  const battlecries: BattlecryCard[] = [];
  const charges: ChargeCard[] = [];
  for (const p of picks) {
    manaSpent += p.cost;
    if (p.spell) {
      spellDamage += p.spell.damage;
      spells.push(p.spell);
    }
    if (p.buff) {
      buffDamage += p.buff.atk;
      buffs.push(p.buff);
    }
    if (p.battlecry) {
      battlecryDamage += p.battlecry.damage;
      battlecries.push(p.battlecry);
    }
    if (p.charge) {
      chargeDamage += p.charge.damage;
      charges.push(p.charge);
    }
  }
  return {
    manaSpent, spellDamage, buffDamage, battlecryDamage, chargeDamage,
    spells, buffs, battlecries, charges,
  };
}

/** 构造所有可进入斩杀背包的手牌候选（按墙是否已过区分冲锋/磁力可行性）。 */
function collectPackItems(
  me: SideState,
  wallCleared: boolean,
  ctx: BattlecryContext,
  excludeIndices?: Set<number>,
  canBuffOverride?: boolean,
): PackItem[] {
  const hand = (me.handCards ?? []) as LethalHandCard[];
  const spellPower = me.spellPower ?? 0;
  const comboActive = Boolean(me.comboActive);
  const canBuff = canBuffOverride ?? me.minions.some((m) => m.atk > 0 && m.canAttack);
  const readyMech = canBuffOverride === false
    ? false
    : me.minions.some((m) => m.atk > 0 && m.canAttack && m.race === 'MECHANICAL');
  const boardHasSlot = me.minions.length < 7;
  const myEffHp = me.health + me.armor;

  const out: PackItem[] = [];
  for (let idx = 0; idx < hand.length; idx += 1) {
    if (excludeIndices?.has(idx)) continue;
    const card = hand[idx];
    if (!card.cardId) continue;

    const fx = cardEffects(card.cardId);
    const note = cardNote(card.cardId);
    const type = cardTypeOf(card.cardId);
    const dg = card.darkGift ? darkGiftEffects(card.darkGift.cardId, card.darkGift.note) : null;

    let spellItem: DamageCard | undefined;
    let buffItem: BuffCard | undefined;
    let battlecryItem: BattlecryCard | undefined;
    let chargeItem: ChargeCard | undefined;
    let resolvedCost: number | null = null;

    // 1) 直伤法术（含连击增益替换而非叠加；烧死自己的自伤法术不计）
    const dCard = damageSpellsInHand([{ cardId: card.cardId }])[0];
    if (dCard && !(fx.selfHeroDamage > 0 && fx.selfHeroDamage + spellPower >= myEffHp)) {
      const c = handCardEffectiveCost(card, dCard.cost);
      if (c !== null) {
        resolvedCost = c;
        let baseDmg = dCard.damage;
        if (comboActive && fx.combo && fx.comboDamage > 0 && !/随机/.test(note) && !fx.aoeMinionsOnly) {
          baseDmg = Math.max(baseDmg, fx.comboDamage);
        }
        spellItem = {
          cardId: card.cardId,
          name: card.name || dCard.name || cardName(card.cardId),
          cost: c,
          damage: baseDmg + spellPower,
        };
      }
    } else if (
      type === 'S' && comboActive && fx.combo && fx.comboDamage > 0
      && !/随机/.test(note) && !fx.aoeMinionsOnly && !/伤害\s*\d+[^\s]*随从/.test(note)
      && !(fx.selfHeroDamage > 0 && fx.selfHeroDamage + spellPower >= myEffHp)
    ) {
      const c = handCardEffectiveCost(card);
      if (c !== null) {
        resolvedCost = c;
        spellItem = {
          cardId: card.cardId,
          name: card.name || cardName(card.cardId) || card.cardId,
          cost: c,
          damage: fx.comboDamage + spellPower,
        };
      }
    }

    // 2) 加攻 buff 法术或磁力贴机械
    const bCard = canBuff ? lookupBuffCard(card.cardId) : undefined;
    if (bCard) {
      const c = handCardEffectiveCost(card, bCard.cost);
      if (c !== null) {
        resolvedCost ??= c;
        const atk = comboActive && fx.combo && fx.comboBuffAtk > 0 ? Math.max(bCard.atk, fx.comboBuffAtk) : bCard.atk;
        if (atk > 0) {
          buffItem = {
            cardId: card.cardId,
            name: card.name || bCard.name || cardName(card.cardId),
            cost: c,
            atk,
            health: bCard.health,
          };
        }
      }
    } else if (type === 'M' && fx.magnetic && wallCleared && readyMech) {
      const c = handCardEffectiveCost(card);
      const body = cardBody(card.cardId);
      const atk = (body?.atk ?? 0) + (dg?.atkBonus ?? 0);
      if (c !== null && atk > 0) {
        resolvedCost ??= c;
        buffItem = {
          cardId: card.cardId,
          name: card.name || cardName(card.cardId) || card.cardId,
          cost: c,
          atk,
          health: (body?.health ?? 0) + (dg?.hpBonus ?? 0),
        };
      }
    }

    // 3) 随从战吼 / 随从连击直伤（受限于我方 7 格上限）
    if (boardHasSlot || type !== 'M') {
      const c = handCardEffectiveCost(card);
      if (c !== null) {
        if (
          fx.battlecry > 0
          && battlecryState(fx, ctx) === 'ready'
          && !/随机/.test(note)
          && !new RegExp(`伤害\\s*${fx.battlecry}[^\\s]*随从`).test(note)
        ) {
          const mult = dg?.doubleBattlecry ? 2 : 1;
          if (fx.selfHeroDamage > 0 && fx.selfHeroDamage * mult >= myEffHp) {
            // 自伤烧死自己不算斩杀
          } else {
            resolvedCost ??= c;
            battlecryItem = {
              cardId: card.cardId,
              name: card.name || cardName(card.cardId),
              cost: c,
              damage: fx.battlecry * mult,
              ...(mult > 1 ? { tag: '双倍战吼' } : {}),
            };
          }
        } else if (
          type === 'M' && comboActive && fx.combo && fx.comboDamage > 0
          && !/随机/.test(note) && !/伤害\s*\d+[^\s]*随从/.test(note)
        ) {
          resolvedCost ??= c;
          battlecryItem = {
            cardId: card.cardId,
            name: card.name || cardName(card.cardId),
            cost: c,
            damage: fx.comboDamage,
            tag: '连击',
          };
        }
      }
    }

    // 4) 冲锋随从打脸（磁力贴机械的情况已走 buff，不重复计算；墙未破则只有无视嘲讽才可过墙）
    if (
      type === 'M' && boardHasSlot && !buffItem
      && (wallCleared || fx.ignoreTaunt)
      && (/冲锋/.test(note) || !!dg?.charge)
      && !/(?:不能|无法)攻击/.test(note)
    ) {
      const c = handCardEffectiveCost(card);
      if (c !== null) {
        const body = cardBody(card.cardId);
        const selfComboAtk = comboActive && fx.combo && fx.comboBuffAtk > 0 ? fx.comboBuffAtk : 0;
        const atk = (body?.atk ?? 0) + (dg?.atkBonus ?? 0) + selfComboAtk;
        if (atk > 0) {
          resolvedCost ??= c;
          const swings = (dg?.windfury || /(?:^|\s)风怒(?:\s|$)/.test(note)) ? 2 : 1;
          chargeItem = {
            cardId: card.cardId,
            name: card.name || cardName(card.cardId) || card.cardId,
            cost: c,
            damage: atk * swings,
            ...(dg?.charge ? { reason: '黑暗之赐冲锋' } : {}),
          };
        }
      }
    }

    if (resolvedCost === null) continue;
    const value = (spellItem?.damage ?? 0) + (buffItem?.atk ?? 0) + (battlecryItem?.damage ?? 0) + (chargeItem?.damage ?? 0);
    if (value <= 0) continue;

    out.push({
      handIndex: idx,
      cost: resolvedCost,
      value,
      ...(spellItem ? { spell: spellItem } : {}),
      ...(buffItem ? { buff: buffItem } : {}),
      ...(battlecryItem ? { battlecry: battlecryItem } : {}),
      ...(chargeItem ? { charge: chargeItem } : {}),
    });
  }
  return out;
}

/**
 * 检测「无穷攻武器（无穷之手）+ 吃武器攻战吼随从（血帆袭击者）+ 全场属性同步（审判）」联动 OTK。
 *
 * 2026-11-22 实战第 12 回合：圣骑士 6 费空场对 30 血牧师，手牌 无穷之手(3)+血帆袭击者(2)+审判(1)，
 * 场上两只可攻击随从，旧逻辑把三张牌平铺在「按费打」里说「场上 4 点推脸 30→26」，漏掉直接斩杀。
 */
function detectInfSyncOtk(
  me: SideState,
  foe: SideState,
  budget: number,
  ignoreTaunt: boolean,
): { cost: number; weaponName: string; weaponCost: number; minionName: string; minionCost: number; syncCardId: string; syncName: string; syncCost: number; tauntHits: number; readySwings: number } | null {
  if (me.minions.length >= 7) return null;
  const readySwings = me.minions.reduce((n, m) => n + (m.canAttack ? (m.windfury ? 2 : 1) : 0), 0);
  if (readySwings <= 0) return null;

  const tauntHits = ignoreTaunt
    ? 0
    : foe.minions
      .filter((m) => m.taunt)
      .reduce((n, m) => n + 1 + (m.divineShield ? 1 : 0) + (m.reborn ? 1 : 0), 0);
  if (readySwings <= tauntHits) return null;

  const hand = (me.handCards ?? []) as LethalHandCard[];
  let wIdx = -1, wCost = 0;
  let mIdx = -1, mCost = 0;
  let sIdx = -1, sCost = 0;

  for (let i = 0; i < hand.length; i += 1) {
    const c = hand[i];
    if (!c.cardId) continue;
    const eff = handCardEffectiveCost(c);
    if (eff === null) continue;
    const note = cardNote(c.cardId);
    const type = cardTypeOf(c.cardId);
    if (wIdx < 0 && type === 'W' && /攻击力变为?无穷大/.test(note)) {
      wIdx = i; wCost = eff;
    } else if (mIdx < 0 && type === 'M' && /获得等同于你的武器攻击力的攻击力/.test(note)) {
      mIdx = i; mCost = eff;
    } else if (sIdx < 0 && type === 'S' && /将所有随从的属性值变为与该随从相同/.test(note)) {
      sIdx = i; sCost = eff;
    }
  }
  if (wIdx < 0 || mIdx < 0 || sIdx < 0) return null;
  const cost = wCost + mCost + sCost;
  if (cost > budget) return null;

  const w = hand[wIdx], m = hand[mIdx], s = hand[sIdx];
  return {
    cost,
    weaponName: w.name || cardName(w.cardId) || '无穷攻武器',
    weaponCost: wCost,
    minionName: m.name || cardName(m.cardId) || '吃武器攻随从',
    minionCost: mCost,
    syncCardId: s.cardId,
    syncName: s.name || cardName(s.cardId) || '属性同步法术',
    syncCost: sCost,
    tauntHits,
    readySwings,
  };
}

/** 算这一回合的斩杀上限。 */
export function planLethal(
  snapshot: GameSnapshot,
  opts?: { deckHasDuplicates?: boolean },
): LethalPlan {
  const me = snapshot.me;
  const foe = snapshot.opponent;
  const target = foe.health + foe.armor;

  const units = swingUnits(me);
  const swingsTotal = units.reduce((a, b) => a + b.atk, 0);

  const spellPower = me.spellPower ?? 0;
  const ignoreTaunt = me.minions.some((m) => cardEffects(m.cardId).ignoreTaunt);
  const taunts = ignoreTaunt ? [] : foe.minions.filter((m) => m.taunt);
  let wall: WallResult = taunts.length
    ? breachTaunts(units, taunts)
    : { cleared: true, spent: 0, leftover: swingsTotal, steps: [] };

  let faceAtk = wall.cleared ? wall.leftover : 0;

  const budget = me.mana + (me.coinMana ?? me.coinCount ?? 0);
  const ctx = makeBattlecryCtx(me, opts?.deckHasDuplicates);
  const canBuff = me.minions.some((m) => m.atk > 0 && m.canAttack);
  const readyMech = me.minions.some((m) => m.atk > 0 && m.canAttack && m.race === 'MECHANICAL');

  const items = collectPackItems(me, wall.cleared, ctx).filter((c) => c.cost <= budget);
  const best = packBest(items, budget);
  let chosen = sumPicks(best.picks);
  let total = faceAtk + chosen.spellDamage + chosen.buffDamage + chosen.battlecryDamage + chosen.chargeDamage;

  // 清场组合：先把对面嘲讽扫干净，再算清场后实际存活的场攻 + 剩余预算
  const sweep = detectSweep(me, foe, budget, opts?.deckHasDuplicates);
  let sweepTook = false;
  if (sweep && !sweep.blocked) {
    const exclude = new Set<number>([sweep.levelerIndex, sweep.sweeperIndex]);
    const restItems = collectPackItems(me, true, ctx, exclude, sweep.survivingMinionCanAttack)
      .filter((c) => c.cost <= budget - sweep.cost);
    const restSum = sumPicks(packBest(restItems, budget - sweep.cost).picks);
    const sweepTotal = sweep.survivingFaceAtk + sweep.faceDamage
      + restSum.spellDamage + restSum.buffDamage + restSum.battlecryDamage + restSum.chargeDamage;

    if (sweepTotal > total && total < target && sweepTotal >= target) {
      sweepTook = true;
      total = sweepTotal;
      faceAtk = sweep.survivingFaceAtk;
      const lossNote = sweep.ownLostCount > 0 ? `（我方 ${sweep.ownLostCount} 只非圣盾随从一并阵亡）` : '';
      const atkStep = sweep.survivingFaceAtk > 0
        ? `${sweep.survivingFaceAtk} 点场攻${sweep.ownLostCount > 0 ? '存活' : '全部'}打脸`
        : '我方随从一并阵亡，剩余伤害直接砸脸';
      wall = {
        cleared: true,
        spent: 0,
        leftover: sweep.survivingFaceAtk,
        steps: [
          `先打${sweep.leveler}，把全场变成 1 血，再打${sweep.sweeper}扫 ${sweep.damage} 点 —— `
          + `嘲讽随从跟着一起清掉${lossNote}，${atkStep}`,
        ],
      };
      if (sweep.sweeperKind === 'spell') {
        chosen = {
          manaSpent: restSum.manaSpent + sweep.cost,
          spellDamage: restSum.spellDamage + sweep.faceDamage,
          buffDamage: restSum.buffDamage,
          battlecryDamage: restSum.battlecryDamage,
          chargeDamage: restSum.chargeDamage,
          spells: sweep.faceDamage > 0
            ? [...restSum.spells, { cardId: sweep.sweeperId, name: sweep.sweeper, cost: sweep.sweeperCost, damage: sweep.faceDamage }]
            : restSum.spells,
          buffs: restSum.buffs,
          battlecries: restSum.battlecries,
          charges: restSum.charges,
        };
      } else {
        chosen = {
          manaSpent: restSum.manaSpent + sweep.cost,
          spellDamage: restSum.spellDamage,
          buffDamage: restSum.buffDamage,
          battlecryDamage: restSum.battlecryDamage + sweep.faceDamage,
          chargeDamage: restSum.chargeDamage,
          spells: restSum.spells,
          buffs: restSum.buffs,
          battlecries: sweep.faceDamage > 0
            ? [...restSum.battlecries, { cardId: sweep.sweeperId, name: sweep.sweeper, cost: sweep.sweeperCost, damage: sweep.faceDamage }]
            : restSum.battlecries,
          charges: restSum.charges,
        };
      }
    }
  }

  // 联动 OTK：无穷之手 + 血帆袭击者 + 审判（场上至少剩 1 次可过墙踢脸的随从攻击）
  let infOtkNote = '';
  if (total < target) {
    const infOtk = detectInfSyncOtk(me, foe, budget, ignoreTaunt);
    if (infOtk) {
      const otkAtk = Math.max(target, 999);
      faceAtk = 0;
      total = otkAtk;
      wall = {
        cleared: true,
        spent: 0,
        leftover: 0,
        steps: [
          `先打${infOtk.weaponName}(${infOtk.weaponCost}费) → ${infOtk.minionName}(${infOtk.minionCost}费 战吼吃无穷武器攻) → ${infOtk.syncName}(${infOtk.syncCost}费 同步全场攻击力)${infOtk.tauntHits > 0 ? `，${infOtk.tauntHits} 次撞墙后` : '，'}场上可攻击随从直接踢脸`,
        ],
      };
      chosen = {
        manaSpent: infOtk.cost,
        spellDamage: 0,
        buffDamage: otkAtk,
        battlecryDamage: 0,
        chargeDamage: 0,
        spells: [],
        buffs: [{
          cardId: infOtk.syncCardId,
          name: `${infOtk.weaponName}→${infOtk.minionName}→${infOtk.syncName}(无穷攻联动)`,
          cost: infOtk.cost,
          atk: otkAtk,
          health: 0,
        }],
        battlecries: [],
        charges: [],
      };
      infOtkNote = `${infOtk.weaponName} + ${infOtk.minionName} + ${infOtk.syncName} 合计 ${infOtk.cost} 费，同步后场上 ${infOtk.readySwings} 次可攻击（过墙需 ${infOtk.tauntHits} 次），直接斩杀`;
    }
  }

  const {
    manaSpent, spellDamage, buffDamage, battlecryDamage, chargeDamage,
    spells: usedSpells, buffs: usedBuffs, battlecries: usedBattlecries, charges: usedCharges,
  } = chosen;

  const hand = (me.handCards ?? []) as LethalHandCard[];
  const allBuffs = buffsInHand(hand);
  const caveats: string[] = [];
  if (infOtkNote) caveats.push(infOtkNote);
  if (taunts.length && !sweepTook) caveats.push('过墙按「用现有攻击力去解」算,没有考虑你先用法术解墙的情况');
  if (sweepTook && sweep) {
    const selfHeroNote = sweep.selfHeroDamage > 0 ? `（注意会伤己方英雄 ${sweep.selfHeroDamage} 血）` : '';
    const ownLossNote = sweep.ownLostCount > 0 ? `（连带烧死我方 ${sweep.ownLostCount} 只非圣盾随从，仅计存活场攻）` : '';
    caveats.push(`清场组合按「${sweep.leveler}把全场变 1 血、${sweep.sweeper}扫 ${sweep.damage} 点」且对面无圣盾或复生随从的前提算${selfHeroNote}${ownLossNote}`);
  }
  if (sweep?.blocked) caveats.push(`本来能先清场过墙,但${sweep.blocked}`);
  if (allBuffs.length && !canBuff) caveats.push('手上有加攻击的牌,但场上没有能攻击的随从,接不住');
  if (usedBuffs.length) caveats.push('buff 假设能加到能攻击的随从身上');
  if (spellPower > 0) caveats.push(`直伤已计入场上 +${spellPower} 法术伤害`);
  if (ignoreTaunt) caveats.push('我方有无视嘲讽的随从,过墙这一步按跳过算');

  if (!wall.cleared && readyMech && hand.some((c) => cardTypeOf(c.cardId) === 'M' && cardEffects(c.cardId).magnetic)) {
    caveats.push('手上有磁力随从可贴给场上机械加攻，但需先过对面嘲讽墙');
  }

  // 战吼与连击提醒
  const pendingBattlecries = hand.filter((c) => {
    const fx = cardEffects(c.cardId);
    if (fx.battlecry <= 0) return false;
    return !usedBattlecries.some((u) => u.cardId === c.cardId)
      && battlecryState(fx, ctx) !== 'ready';
  });
  if (usedBattlecries.length) {
    caveats.push(`战吼已计入 ${battlecryDamage} 点(${usedBattlecries.map((b) => `${b.name}${b.tag ? `[${b.tag}]` : ''} ${b.damage}`).join(' + ')})`);
  }
  if (usedCharges.length) {
    caveats.push(`冲锋已计入 ${chargeDamage} 点(${usedCharges.map((c) => `${c.name} ${c.damage}`).join(' + ')})`);
  }
  if (pendingBattlecries.length) {
    caveats.push('还有战吼因为前提不满足、或我判断不了前提,没算进上面那个数');
  }
  if (!usedBattlecries.length && !pendingBattlecries.length) {
    caveats.push('随从亡语等非确定来源未算进去');
  }

  // 未激活连击时，如果手里有连击输出牌且存在便宜启动牌，提示先启动连击
  if (!me.comboActive) {
    const comboPayoffs = hand.filter((c) => {
      const fx = cardEffects(c.cardId);
      return fx.combo && (fx.comboDamage > 0 || fx.comboBuffAtk > 0);
    });
    if (comboPayoffs.length) {
      const hasStarter = hand.some((c) => {
        const ec = handCardEffectiveCost(c);
        return ec !== null && ec < budget && !comboPayoffs.includes(c);
      }) || (me.coinMana ?? me.coinCount ?? 0) > 0;
      if (hasStarter) {
        const names = comboPayoffs.slice(0, 2).map((c) => c.name || cardName(c.cardId)).filter(Boolean);
        caveats.push(`连击尚未激活：先打一张低费牌（或硬币）再出${names.join('/')}，连击部分没算进上面总数`);
      }
    }
  }

  const odynOnBoard = me.minions.some((m) => (m.cardId || '').replace(/^(CORE_|VAN_)/, '') === 'TTN_811');
  if (odynOnBoard) {
    const armorSpell = hand.find((c) => cardEffects(c.cardId).armor > 0 && (c.cost ?? 99) <= me.mana);
    caveats.push(armorSpell
      ? `场上有奥丁（每点护甲变等量攻击力）：手牌里的${armorSpell.name ?? '护甲牌'}能白送一份打脸攻击，这部分**没算进上面那个数**`
      : '场上有奥丁（每点护甲变等量攻击力）：这回合的护甲来源没算进去');
  }

  const otherPassives = me.minions
    .filter((m) => (m.cardId || '').replace(/^(CORE_|VAN_)/, '') !== 'TTN_811')
    .map((m) => ({ name: m.name || '场上随从', text: passiveOf(m.cardId || '') }))
    .filter((x) => x.text)
    .slice(0, 2);
  for (const x of otherPassives) {
    caveats.push(`${x.name}:${x.text.replace(/^持续:/, '')} —— 这部分没算进去`);
  }

  return {
    swingsTotal,
    wall,
    faceAtk,
    viaClear: sweepTook,
    spellDamage,
    buffDamage,
    battlecryDamage,
    chargeDamage,
    total,
    spells: usedSpells,
    buffs: usedBuffs,
    battlecries: usedBattlecries,
    charges: usedCharges,
    manaSpent,
    spellPower,
    caveats,
  };
}
