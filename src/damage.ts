/**
 * 直伤法术表与斩杀估算。
 *
 * 日志里只有卡牌 id,没有牌面伤害的数字。这张表由 HearthstoneJSON 的 zhCN 数据生成
 * (见 tools/build-damage-table.mjs),只收**能直接打脸的单次直伤法术**:
 * 群体、随机、多段、只能对随从的一律不收 —— 多算一张,就会给出一个打不出来的斩杀线。
 *
 * 非可收集牌里混着冒险/乱斗的 Boss 牌(「终结将近」0 费 30 伤),生成时已按伤害 >= 10 剔掉。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** [中文名, 费用, 伤害] */
type Entry = [string, number, number];

export interface DamageCard {
  cardId: string;
  name: string;
  cost: number;
  damage: number;
}

let cached: Record<string, Entry> | null = null;

function loadTable(): Record<string, Entry> {
  if (cached) return cached;
  try {
    const file = fileURLToPath(new URL('./data/damage-spells.json', import.meta.url));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cards?: Record<string, Entry> };
    cached = raw.cards ?? {};
  } catch {
    // 表读不到不该让整个 World 起不来:退化成「算不了直伤」,斩杀线只报场面
    cached = {};
  }
  return cached;
}

/** 日志里的卡牌 id 可能带 CORE_/VAN_ 这类前缀,来回试一下。 */
function lookup(cardId: string): Entry | undefined {
  const table = loadTable();
  const bare = cardId.replace(/^(?:CORE_|VAN_|VANILLA_|TUTORIAL_)/, '');
  return table[cardId] ?? table[bare] ?? table[`CORE_${bare}`] ?? table[`VAN_${bare}`];
}

/**
 * 查一张直伤牌。给 advice 之类需要「卡名兜底」的地方用 ——
 * 主卡表(cards.json)只收可收集牌,衍生牌只在这张表里,查不到就会显示成一串 id。
 */
export function lookupDamageCard(cardId: string): DamageCard | undefined {
  const entry = lookup(cardId);
  return entry ? { cardId, name: entry[0], cost: entry[1], damage: entry[2] } : undefined;
}

/** 手牌里能直接打脸的直伤法术。 */
export function damageSpellsInHand(hand: readonly { cardId: string }[]): DamageCard[] {
  const out: DamageCard[] = [];
  for (const card of hand) {
    if (!card.cardId) continue;
    const entry = lookup(card.cardId);
    if (!entry) continue;
    out.push({ cardId: card.cardId, name: entry[0], cost: entry[1], damage: entry[2] });
  }
  return out;
}

/**
 * 这点水晶最多能打出多少直伤。
 *
 * 贪心:按「每点费用的伤害」从高到低拿。严格最优是背包问题,但法术张数很少、费用都是小整数,
 * 贪心的结果在实战里和最优一致的时候占绝大多数;差也不会差到让判断翻面的程度。
 */
export function affordableBurst(
  hand: readonly { cardId: string }[],
  mana: number,
): { total: number; used: DamageCard[] } {
  const spells = damageSpellsInHand(hand)
    .filter((s) => s.cost <= mana)
    .sort((a, b) => b.damage / Math.max(1, b.cost) - a.damage / Math.max(1, a.cost) || a.cost - b.cost);

  let left = mana;
  let total = 0;
  const used: DamageCard[] = [];
  for (const spell of spells) {
    if (spell.cost > left) continue;
    left -= spell.cost;
    total += spell.damage;
    used.push(spell);
  }
  return { total, used };
}
