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
 * 算不进去的(回执里会明说):冲锋随从召唤、战吼伤害、连击/法术伤害加成、无视嘲讽。
 * 宁可说少,不要给一个打不出来的数。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GameSnapshot, MinionView, SideState } from './parser.ts';
import { damageSpellsInHand, type DamageCard } from './damage.ts';
import { cardEffects, cardName } from './effects.ts';

/** 目标的称呼:日志名 → 卡表 → 「未知随从」。别把内部 id 拼进她念的句子。 */
const targetLabel = (m: { name?: string; cardId?: string }): string =>
  m.name || cardName(m.cardId ?? '') || '未知随从';

export interface BuffCard {
  cardId: string;
  name: string;
  cost: number;
  atk: number;
}

type BuffEntry = [string, number, number];

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
  return entry ? { cardId, name: entry[0], cost: entry[1], atk: entry[2] } : undefined;
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
  if (hero > 0) out.push({ atk: hero, poisonous: false });
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
  /** buff 加的攻击力合计。 */
  buffDamage: number;
  /** 总共能打到脸的伤害。 */
  total: number;
  spells: DamageCard[];
  buffs: BuffCard[];
  /** 用掉了多少水晶。 */
  manaSpent: number;
  /** 用到的法术伤害加成。 */
  spellPower: number;
  /** 算不进去的东西,要一起讲出来。 */
  caveats: string[];
}

/** 算这一回合的斩杀上限。 */
export function planLethal(snapshot: GameSnapshot): LethalPlan {
  const me = snapshot.me;
  const foe = snapshot.opponent;

  const units = swingUnits(me);
  const swingsTotal = units.reduce((a, b) => a + b.atk, 0);

  // 场上随从提供的法术伤害加成:所有直伤数字都要加它
  const spellPower = me.spellPower ?? 0;
  // 我方有没有「攻击无视嘲讽」的随从(如凯恩·日怒)。有的话,过墙这一步直接跳过 ——
  // 但墙还在场上,下回合照样是威胁,所以只影响攻击能不能打到脸。
  const ignoreTaunt = me.minions.some((m) => cardEffects(m.cardId).ignoreTaunt);
  const taunts = ignoreTaunt ? [] : foe.minions.filter((m) => m.taunt);
  const wall: WallResult = taunts.length
    ? breachTaunts(units, taunts)
    : { cleared: true, spent: 0, leftover: swingsTotal, steps: [] };

  const faceAtk = wall.cleared ? wall.leftover : 0;

  // 直伤和 buff 抢同一份水晶。
  //
  // 这里必须用背包精确解,不能用「按每点费用的伤害从高到低贪心」——
  // 实测踩过:手上有寒冰箭(2 费 3 伤)和火球术(4 费 6 伤)、只有 5 水晶时,
  // 两者单位伤害相同,贪心先拿便宜的寒冰箭,剩下 3 水晶打不出火球术,
  // 于是只报 3 点直伤 —— 而正确答案是单打火球术 6 点。差一倍。
  //
  // 水晶数很小(通常 ≤ 10),DP 一张表就够,没有性能顾虑。
  const spells = damageSpellsInHand(me.handCards ?? []);
  const canBuff = me.minions.some((m) => m.atk > 0 && m.canAttack);
  const buffs = canBuff ? buffsInHand(me.handCards ?? []) : [];

  // 硬币也是钱:手上有几个硬币,这一回合就多几点可花。
  // 不算它会把「5 水晶 + 硬币 + 火球」这种能斩杀的局面报成打不出来。
  // 硬币的净贡献,不是枚数 —— 被加费的硬币打出来换不到水晶(见 manaBudget)
  const budget = me.mana + (me.coinMana ?? me.coinCount ?? 0);

  const items = [
    ...spells.map((s) => ({ kind: 'spell' as const, card: s, value: s.damage + spellPower, cost: Math.max(0, s.cost) })),
    ...buffs.map((b) => ({ kind: 'buff' as const, card: b, value: b.atk, cost: Math.max(0, b.cost) })),
  ].filter((c) => c.cost <= budget);

  const cap = Math.max(0, Math.min(budget, 30));
  const dp: { value: number; picks: typeof items }[] = Array.from({ length: cap + 1 }, () => ({ value: 0, picks: [] }));
  for (const item of items) {
    for (let m = cap; m >= item.cost; m -= 1) {
      const prev = dp[m - item.cost];
      const candidate = prev.value + item.value;
      if (candidate > dp[m].value) dp[m] = { value: candidate, picks: [...prev.picks, item] };
    }
  }
  const best = dp.reduce((a, b) => (b.value > a.value ? b : a), dp[0]);

  let manaSpent = 0;
  let spellDamage = 0;
  let buffDamage = 0;
  const usedSpells: DamageCard[] = [];
  const usedBuffs: BuffCard[] = [];
  for (const pick of best.picks) {
    manaSpent += pick.cost;
    if (pick.kind === 'spell') {
      spellDamage += pick.value;
      usedSpells.push(pick.card);
    } else {
      buffDamage += pick.value;
      usedBuffs.push(pick.card);
    }
  }

  const total = faceAtk + spellDamage + buffDamage;

  const allBuffs = buffsInHand(me.handCards ?? []);
  const caveats: string[] = [];
  if (taunts.length) caveats.push('过墙按「用现有攻击力去解」算,没有考虑你先用法术解墙的情况');
  if (allBuffs.length && !canBuff) caveats.push('手上有加攻击的牌,但场上没有能攻击的随从,接不住');
  if (usedBuffs.length) caveats.push('buff 假设能加到能攻击的随从身上');
  if (spellPower > 0) caveats.push(`直伤已计入场上 +${spellPower} 法术伤害`);
  if (ignoreTaunt) caveats.push('我方有无视嘲讽的随从,过墙这一步按跳过算');
  caveats.push('战吼伤害、光环、随从亡语都没算进去');
  /*
   * **持续效果里会影响斩杀的那几张，逐一点名**（2026-11-14）。
   *
   * 上一句笼统说「光环没算」，模型看到等于没看到 —— 它不知道场上是哪张光环、
   * 也不知道那张光环值多少伤害。奥丁是最典型的：每点护甲变 1 点攻击力，
   * 有他在场，一张 3 费加 3 甲的牌等于白送 3 点打脸攻击。
   *
   * **只提示、不改 `total`**：护甲法术和直伤共享水晶，算进去要重排整条费用分配；
   * 而算错一次比说少一次糟得多（这个文件的开头就写着这条）。所以让它自己判断。
   */
  const odynOnBoard = me.minions.some((m) => (m.cardId || '').replace(/^(CORE_|VAN_)/, '') === 'TTN_811');
  if (odynOnBoard) {
    const armorSpell = (me.handCards ?? []).find((c) => cardEffects(c.cardId).armor > 0 && c.cost <= me.mana);
    caveats.push(armorSpell
      ? `场上有奥丁（每点护甲变等量攻击力）：手牌里的${armorSpell.name ?? '护甲牌'}能白送一份打脸攻击，这部分**没算进上面那个数**`
      : '场上有奥丁（每点护甲变等量攻击力）：这回合的护甲来源没算进去');
  }

  return {
    swingsTotal,
    wall,
    faceAtk,
    spellDamage,
    buffDamage,
    total,
    spells: usedSpells,
    buffs: usedBuffs,
    manaSpent,
    spellPower,
    caveats,
  };
}
