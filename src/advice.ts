/**
 * 这回合打什么。
 *
 * 这里只做**能算准的部分**:手里有什么、水晶够不够、每个随从能换掉谁、对面下回合能砸多少。
 * 牌面效果的取舍(该不该贪、对面可能捏着什么、要不要留资源)不在这算 —— 那是她的判断。
 *
 * 所以回执里明确分两块:上面是事实,下面一份「按固定规则机械排出的候选」,标着是机械排的。
 * 不标清楚,她会把机械排序当成结论念给用户听,那就成了算命。
 *
 * 有一条刻意没做:不去猜对手手牌。日志里对手手牌是空的(不到揭示不给 cardId),
 * 硬猜只会给出一个看起来精确、实际是编的数。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DarkGiftInfo, GameSnapshot, MinionView, SideState } from './parser.ts';
import { planLethal, heroSwing, lookupBuffCard, swingsOf, type LethalPlan } from './lethal.ts';
import { damageSpellsInHand, lookupDamageCard } from './damage.ts';
import {
  battlecryState, cardBody, cardEffects, cardName, cardNote, cardTypeOf,
  conditionalBattlecries, darkGiftEffects, LEVELER_NOTE_RE, passiveOf, resolveHandAoeCard,
  type BattlecryContext,
} from './effects.ts';
import type { FaceId } from './alerts.ts';
import type { TrackerSnapshot } from './tracker.ts';

/** 紧凑表里的条目:[名称, 费用, 类型字母, 摘要, 标签(含 f=可锻造 / p=可预备 / x=可交易), 职业, L=传说] */
type CardEntry = [string, number, string, string, string?, string?, string?];

const TYPE_NAME: Record<string, string> = { S: '法术', M: '随从', W: '武器', H: '英雄', L: '地标' };

let cardTable: Record<string, CardEntry> | null = null;

function loadCards(): Record<string, CardEntry> {
  if (cardTable) return cardTable;
  try {
    const file = fileURLToPath(new URL('./data/cards.json', import.meta.url));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cards?: Record<string, CardEntry> };
    cardTable = raw.cards ?? {};
  } catch {
    // 表读不到不该让 World 起不来:退化成「只报 cardId」
    cardTable = {};
  }
  return cardTable;
}

function lookupCard(cardId: string): CardEntry | undefined {
  const table = loadCards();
  const bare = cardId.replace(/^(?:CORE_|VAN_|VANILLA_|TUTORIAL_)/, '');
  return table[cardId] ?? table[bare] ?? table[`CORE_${bare}`] ?? table[`VAN_${bare}`];
}

/**
 * 场面上一只随从在文本里怎么称呼。
 *
 * `m.name` 经常是空的 —— 出牌那一瞬间实体的 NAME 标签还没 dump 完。原来直接落到
 * `m.cardId`,于是她读到的是「场面 …FIR_953 5/8」,而卡表里它叫「熔岩猎犬」。
 * 2026-10-28 实测抓到一次,她只能照着念内部 id。
 *
 * 卡表也没有的(衍生物、新版本 token),**不露 id** —— `CATA_190t14` 对她零信息量,
 * 递过去只会让她以为自己漏读了什么。老实说「没认出来」,她反而不会硬猜。
 */
const minionLabel = (m: { name?: string; cardId?: string; id?: number }): string => {
  if (m.name) return m.name;
  const fromTable = lookupCard(m.cardId ?? '')?.[0];
  if (fromTable) return fromTable;
  // 最后这一档原来给的是 `#${m.id}` —— 实测回执里真的漏出过「换掉 #201」这种。
  // 内部实体编号对读的人(和模型)都是零信息量,还会让她以为自己漏读了什么。
  // 认不出来就直说认不出来。
  return m.cardId ? '未知随从' : '未认出的随从';
};

/**
 * 锻造后的牌 id(`原 id + t`)对应的原卡 id;不是锻造变体就返回 null。
 *
 * `T[xxx_t]` 在卡表里查不到(它不是可收集牌),不回落的话手牌里那张牌
 * 名字、费用、摘要全丢,她只能念出「TTN_458t」。规则与 effects.ts 的 `forgedBaseOf` 一致:
 * 表里本来就有的一律先认自己(`TTN_855t` 提尔之涕就是一张独立卡);
 * **并且只有本体卡面写着「可锻造」的,`_t` 才当锻造形态** —— 其余 `_t` 是衍生物
 * (`WW_816t` 是「飞向天空」召出来的 1/1 雏龙),回落到本体就成了另一张牌。
 */
function forgedBaseOf(cardId: string): string | null {
  const table = loadCards();
  if (!cardId || !cardId.endsWith('t')) return null;
  const base = cardId.slice(0, -1);
  const entry = table[base];
  if (!entry) return null;
  // 本体必须写着「可锻造」—— 否则这不是锻造形态。
  // 不这么卡的话，所有衍生物都会被回落成本体：`WW_816t` 是「飞向天空」召出来的
  // 1/2 雏龙，回落到 `WW_816` 就成了德鲁伊法术。
  if (!/(?:^|\s)f(?:\s|$)/.test(entry[4] ?? '')) return null;

  // 2026-11-06：卡表开始收衍生 token 之后，`TTN_458t` 这种自己在表里了。
  // 原来「表里有就认自己」那条会让锻造态被当成独立卡，`forged` 永远是 false。
  // 判据改成**同名 + 自己没有 f**（规则与 effects.ts 的 forgedBaseOf 一致）：
  //   · `TTN_458t` 同名、无 f → 已锻造那版，回落到本体；
  //   · `TTN_855t`「提尔之涕」同名但**自己带 f**，它是未锻造态 → 认自己。
  const self = table[cardId];
  if (!self) return base;
  return self[0] === entry[0] && !/(?:^|\s)f(?:\s|$)/.test(self[4] ?? '') ? base : null;
}

/** 这张牌的卡面带不带锻造词条(`f` 标签,来自卡牌数据的 mechanics)。 */
function isForgeable(cardId: string): boolean {
  const entry = lookupCard(cardId) ?? lookupCard(forgedBaseOf(cardId) ?? '');
  return Boolean(entry && /(?:^|\s)f(?:\s|$)/.test(entry[4] ?? ''));
}

/**
 * 一张牌的说明。三级兜底:
 *   1. 主卡表(可收集牌,带身材和摘要)
 *   2. 直伤表   3. 加攻表 —— 这两张收的是非可收集的衍生牌,主卡表里没有
 * 都查不到就返回 null,调用方老实显示 cardId,不猜效果。
 */
function describeCard(cardId: string): { name: string; baseCost: number; type: string; note: string; forge: boolean; forged: boolean; prepare: boolean; tradeable: boolean } | null {
  const base = forgedBaseOf(cardId);
  const entry = lookupCard(cardId) ?? (base ? lookupCard(base) : undefined);
  if (entry) {
    const forged = base !== null;
    /*
     * 摘要后面接持续效果（2026-11-14）。`entry[3]` 只有一次性效果 ——
     * 奥丁的「每当你获得护甲,获得等量攻击力」不在里面，不接这一句，
     * 模型看到的就是一张普通的 8/8。
     */
    const passive = passiveOf(cardId);
    const rawNote = passive ? `${entry[3]} ${passive}` : entry[3];
    // 已锻造时摘要要重写一遍,不然她会照念牌面上那些已经不存在的代价:
    //   · 去掉「(锻造后免)」—— 括号里那笔代价已经免了,留着就是误导
    //   · 去掉独立的「锻造」词 —— 锻造过的牌不能再锻造一次
    // 名字保持卡面原名:已锻造是**状态**,不是另一个名字,所以标在摘要开头
    // (渲染格式是「名字(费用 note)」,摘要一定跟着名字出现)。
    const freed = /锻造后免/.test(rawNote);
    const note = forged
      ? `${freed ? '已锻造,代价已免' : '已锻造'}·${rawNote.replace(/\(锻造后免\)\s*/g, '').replace(/(?:^|\s)锻造(?=\s|$)/g, ' ').trim()}`
      : rawNote;
    return {
      name: entry[0],
      baseCost: entry[1],
      type: TYPE_NAME[entry[2]] ?? '未知',
      note,
      forge: /(?:^|\s)f(?:\s|$)/.test(entry[4] ?? '') || forged,
      forged,
      prepare: /(?:^|\s)p(?:\s|$)/.test(entry[4] ?? ''),
      tradeable: /(?:^|\s)x(?:\s|$)/.test(entry[4] ?? ''),
    };
  }

  const dmg = lookupDamageCard(cardId);
  if (dmg) return { name: dmg.name, baseCost: dmg.cost, type: '法术', note: `伤害${dmg.damage}`, forge: false, forged: false, prepare: false, tradeable: false };

  const buff = lookupBuffCard(cardId);
  if (buff) {
    /*
     * `+2/+2` 要写成两边（2026-11-14）。原来只写「+2攻」，
     * 而加固那种牌的实际效果是同时加 2 血 —— 他照着摘要判断该不该贴，会低估。
     */
    const note = buff.health > 0 ? `+${buff.atk}/+${buff.health}` : `+${buff.atk}攻`;
    return { name: buff.name, baseCost: buff.cost, type: '法术', note, forge: false, forged: false, prepare: false, tradeable: false };
  }

  return null;
}

/**
 * 手牌摘要 + 状态标记。
 *
 * 抽成一处是因为**同一条事实有三条出口**:回合事件那句、工具回执的候选清单、
 * 给模型的局面摘要。上一轮「已锻造」只在前两处生效,给模型的那份还是原摘要 ——
 * 于是她自己算对了、第二个模型却照旧建议「打出去要弃两张牌」。
 * 状态标记只写在这里,三处就同时一致。
 */
function describeDarkGift(dg: DarkGiftInfo): string {
  const fx = darkGiftEffects(dg.cardId, dg.note);
  const parts: string[] = [];
  if (fx.charge) parts.push('冲锋');
  if (fx.doubleBattlecry) parts.push('双倍战吼');
  if (fx.windfury) parts.push('风怒');
  if (fx.divineShield) parts.push('圣盾');
  if (fx.taunt) parts.push('嘲讽');
  if (fx.lifesteal) parts.push('吸血');
  if (fx.reborn) parts.push('复生');
  if (fx.elusive) parts.push('扰魔');
  if (fx.atkBonus !== 0 || fx.hpBonus !== 0) {
    const a = fx.atkBonus >= 0 ? `+${fx.atkBonus}` : `${fx.atkBonus}`;
    const h = fx.hpBonus >= 0 ? `+${fx.hpBonus}` : `${fx.hpBonus}`;
    parts.push(`${a}/${h}`);
  }
  const detail = parts.length ? parts.join('·') : (dg.note || dg.name || '已强化');
  return `〔黑暗之赐:${detail}〕`;
}

function handNote(cardId: string, prepared: boolean, darkGift?: DarkGiftInfo): string {
  const note = describeCard(cardId)?.note ?? '';
  const plain = note.replace(/甲(\d+)/g, '$1 点护甲');
  const preparedText = !prepared || !plain
    ? plain
    : `已预备,费用已减·${plain.replace(/(?:^|\s)预备(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()}`;
  if (!darkGift) return preparedText;
  const giftText = describeDarkGift(darkGift);
  return preparedText ? `${preparedText} ${giftText}` : giftText;
}

/**
 * 这一手打出去的附带伤害,现在到底能不能用。
 *
 * 只看被选中的那几张 —— 这是一句补丁,不是播报。
 */
function pickDamageNote(picks: HandCardView[], snapshot: GameSnapshot): string {
  for (const c of picks) {
    const pd = playDamage(c, snapshot.me.spellPower ?? 0, { comboActive: snapshot.me.comboActive });
    if (!pd) continue;
    const name = c.name ?? c.cardId;
    if (!pd.ready) {
      if (pd.quickdraw) return `;${name}的快枪没生效(要本回合到手),那 ${pd.damage} 点别算进去`;
      if (pd.combo) return `;${name}需要先出过一张牌触发连击,否则只有基础效果`;
      continue;
    }
    const foe = snapshot.opponent.minions;
    const src = pd.battlecry ? '战吼' : pd.quickdraw ? '快枪' : pd.combo ? '连击' : '';
    const label = src ? `${name}的${src}` : name;
    const how = src ? `${label} ` : `${label}的 `;
    if (pd.minionOnly) {
      if (!foe.length) return `;${label}现在没目标(对面空场),下去就是个白板`;
      const killable = foe.filter((m) => m.health <= pd.damage);
      if (!killable.length) {
        const thinnest = Math.min(...foe.map((m) => m.health));
        return `;${how}${pd.damage} 点伤不到对面任何一只(最薄的也 ${thinnest} 血)`;
      }
      const best = killable.reduce((a, b) => (a.health <= b.health ? a : b));
      return `;${how}${pd.damage} 点能解掉${minionLabel(best)}(${best.atk}/${best.health})`;
    }
    const killable = foe.filter((m) => m.health <= pd.damage);
    if (killable.length) {
      const best = killable.reduce((a, b) => (a.health <= b.health ? a : b));
      return `;${src ? `${name}的${src}` : name} ${pd.damage} 点能先点掉${minionLabel(best)}(${best.atk}/${best.health})`;
    }
    if (/群/.test(c.note)) continue;
    return `;${name}打出去还能顺带 ${pd.damage} 点直伤`;
  }
  return '';
}

export interface HandCardView {
  cardId: string;
  /** 卡名;三张表都查不到时为 null,渲染时退回 cardId —— 不能假装知道。 */
  name: string | null;
  /** 实际费用(日志里的 COST 标签,可能被减费改过)。 */
  cost: number;
  /**
   * 这是一枚换水晶的硬币。
   *
   * 硬币**永远不该出现在「按费打」里** —— 它不产出场面,只是把 1 费换成 1 水晶。
   * 原来靠「0 费牌不进推荐位」间接挡住,可硬币被加费成 1 费之后就不算 0 费了:
   * 实测 2026-10-29 第 6 回合推出「按费打:加速光环(3费)、幸运币(1费)」,
   * 3 水晶打这两张要 4 点,而且那枚硬币花 1 费只换回 1 费,纯浪费一次出牌。
   */
  isCoin: boolean;
  /** 基础费用(牌表里的),和 cost 不同说明被减过费。 */
  baseCost: number | null;
  type: string;
  note: string;
  /**
   * 这回合打不打得出来。
   *
   * **算上了手牌里的硬币** —— 5 水晶 + 1 个硬币能打 6 费牌。用不用得起是两件事:
   * 打硬币是白送 1 点水晶,但那张硬币本身也有机会成本(留着给更关键的回合)。
   */
  playable: boolean;
  /**
   * 要花掉硬币才够。
   *
   * 真实踩过:5 水晶、手上一个硬币、一张 6 费随从,建议说「差 1 费就能打」——
   * 其实打出硬币就能上。这里把「要硬币才够」标出来,让她能说清代价。
   */
  needsCoin: boolean;
  /**
   * 是不是他标的核心牌(配置里的 `keepCards`)。
   *
   * 机械规则永远看不出「这张牌是为了下一步铺垫」——「按费打」只看得出费用和攻击力,
   * 于是把卡组核心当普通随从推了出去。实测第 7 回合 4 水晶,原文推荐
   * 「按费打:德雷阿佳丝(3费)」,而那张牌是要靠别的牌复制/触发亡语的combo 核心。
   * 谁该留、谁该上,只有他知道,所以只能由配置输入。
   */
  keep: boolean;
  /**
   * 这张牌可以锻造(卡面带锻造词条)。
   *
   * 日志只给「已经锻造完了」(`cardId` 变成 `xxx_t`),不告诉你「这是一张锻造牌」。
   * 要判断「手上这张还没锻造、打出去要不要先付代价」,只能靠卡面词条。
   */
  forge: boolean;
  /**
   * 已经锻造过了。
   *
   * 判据是 `cardId` 末尾那个 `t` —— 实测锻造那一刻日志写的是
   * `CHANGE_ENTITY ... cardId=TTN_458` → `CardID=TTN_458t`,人还在 zone=HAND。
   * 已锻造 = 卡面上的代价已经付过,不能再提醒他「打出去要弃两张牌」。
   */
  forged: boolean;
  /**
   * 这张牌可以预备(卡面关键词)。
   *
   * 预备 = 把牌拖进牌库,花掉**全部**剩余法力,换「消耗的法力 + 1」点减费,
   * 但当回合不能再打出、每张牌只能预备一次。所以它真正的用处是:
   * **这回合花不掉的剩水,换成下回合的折扣**。
   */
  prepare: boolean;
  /** 已经预备过了(`tag=PREPARE`)—— 费用已经减过,而且不能再预备。 */
  prepared: boolean;
  /** 可交易:花 1 费换一张。剩水的另一个去处。 */
  tradeable: boolean;
  /** 第几回合进的手牌。快枪要「本回合到手」才生效 —— 权威判据是下面的 poweredUp。 */
  enteredTurn?: number;
  /** 快枪此刻生不生效(日志里的 POWERED_UP)。 */
  poweredUp?: boolean;
  /** 附加的黑暗之赐效果（若有）。 */
  darkGift?: DarkGiftInfo;
}

/**
 * 这张牌**自己**带某个关键词吗(嘲讽 / 吸血 …)。
 *
 * 不能直接 `/嘲讽/.test(note)` —— 摘要里出现「嘲讽」有两个来源:它自己带,
 * 或者它在**给别人**加、召唤带嘲讽的东西。后者的误判代价很实:
 *
 * 2026-11-03 第 2 回合,「雏龙牧人」(2/3,回合结束获取一张 1/2 嘲讽雏龙)被当成墙,
 * 对面空场时 `rank()` 把它排到 3(墙在白板场合不值得下),于是建议写成
 * 「这回合手上能出的只有 雏龙牧人(2费);不值得当普通牌打,这回合宁可空过」。
 * 那张是标准的 2 费铺场牌,他自己第 6 回合就打了。T20 那句
 * 「手上没有嘲讽牌」也是同一个判据在另一头的输出。
 *
 * 判据两条:
 *   1. 关键词得在摘要的**头一段**(身材 + 关键词那一截),不在效果描述里;
 *   2. 头一段里还得不是「拥有 / 获得 / 具有 / 使」—— 那是给别人的说法。
 *
 * 拿 8328 张卡表验过:含「嘲讽」的 534 张里,头一段命中 505 张是真本体;
 * 被排除的 29 张里只有战争古树、圣光楷模这类**条件性**嘲讽 —— 当成没有是对的,
 * 少算一面墙不致命,多算一面墙(说「你有墙能挡」)会让他把命押上去。
 */
export function selfKeyword(note: string | undefined, kw: string): boolean {
  if (!note || !note.includes(kw)) return false;
  const head = note.split(/[。，；]/)[0];
  if (!head.includes(kw)) return false;
  return !new RegExp(`(?:拥有|获得|具有|使用|使)[^。，；]{0,12}${kw}`).test(head);
}

/**
 * 这张牌是不是「不产场面的法术」—— 加速光环、誓缚光环、投身战争这一类。
 *
 * 判据只看牌面摘要里有没有**当场就能看见效果**的词（伤害、抽牌、消灭、变形、
 * 嘲讽、圣盾、+X/+X）。都没有，那它就是花水晶买资源/买光环，这一手场上什么都不会多。
 *
 * 为什么重要:2026-11-03 那 8 局里,「加速光环」被推了 4 次他一次没打,
 * 「投身战争」被推了 8 次只打了 1 次 —— 每次都改成下随从。系统当时把它们和随从
 * 排在同一个档位,谁前面看手牌顺序,于是纯资源牌反复挤掉场面牌。
 *
 * 「召唤」**不在**排除词里:这套牌里的誓缚光环、时序光环、投身战争都写着「召唤」,
 * 但它们是光环,落地不产随从。真能召唤随从的法术会被误判成资源牌 —— 那只让它
 * 排在随从后面一位,代价比反过来(资源牌挤掉随从)小得多。
 */
export function plainSpellNote(card: { type: string; note: string }): boolean {
  if (card.type !== '法术') return false;
  // 「抽」留在排除列表里 —— 抽牌**不产场面，但产节奏**：补进来的牌让后面几个回合更顺。
  // 纯 plain（加速光环那种）打了基本等于白过一手，抽牌不是。
  //
  // 但「不是 plain」不等于「任何时候都该排在随从前面」 —— 那个分寸在 `rank()` 里单独判，
  // 见「抽牌什么时候让位」那一段。两个问题分开处理，别用一个布尔值硬扛。
  return !/伤害|抽|消灭|变形|嘲讽|圣盾|\+\d+\/\+\d+/.test(card.note);
}

/**
 * 打出去那一刻附带的伤害 —— 战吼、快枪、连击那些。
 *
 * 为什么单独抽出来:卡表摘要里只有一句「伤害2群随机随从」,原来这句话只当描述显示,
 * 不参与任何判断。于是 2026-10-24 那两手全错:
 *   · 第 5 回合对面**空场**,还推蹄铁发射机(战吼随机打敌方随从 —— 没目标,白扔);
 *   · 第 11 回合手上的日斑巨龙快枪 6 伤(当回合到手,能用),建议一个字没提。
 */
/**
 * 抽牌要不要给场面让位。
 *
 * 抽牌**不产场面但产节奏**（补进来的牌让后面几回合更顺），所以它不是 plain spell，
 * 不能无条件压。但在**被压着打**的局面里，抽牌等于把这一手让出去 ——
 * 抽进来的牌当回合用不上，场面一分没变。
 *
 * 2026-11-09 实测：她连着推「龙鳞军备」（1 费抽两张法术），他每次都改成下随从；
 * 她自己在复盘里写「早几轮该抢的是场面，不是抽牌」。事后清醒、当下推抽牌。
 *
 * 三个条件同时成立才让位，缺一个都不动：
 *   · 对面两回合内能打死我（场攻 × 2 ≥ 有效血）—— 真有压力，不是看着像；
 *   · 手上还有牌（≥4）—— 牌快空了那抽牌是救命，不能压；
 *   · 这一手只抽不打（不含伤害 / 召唤）—— 顺带能打的抽牌是产场面的。
 *
 * 抽成独立函数是为了能单测：靠构造整局去碰这条排序，会先被「危险」分支拦走
 * （2026-11-09 当场踩过：8 血对场攻 6，两条测试其实都走的 danger，一条过一条挂，
 * 过的那个也是误打误撞）。
 */
export function drawShouldYield(opts: {
  note: string;
  enemyAttack: number;
  myEffectiveHp: number;
  handSize: number;
}): boolean {
  if (!/抽/.test(opts.note)) return false;
  if (/伤害|召唤/.test(opts.note)) return false;
  const pressed = opts.enemyAttack * 2 >= opts.myEffectiveHp;
  const roomy = opts.handSize >= 4;
  return pressed && roomy;
}

export interface PlayDamage {
  /** 伤害点数。 */
  damage: number;
  /** 只能打随从(对面空场就等于没有)。 */
  minionOnly: boolean;
  /** 带快枪。 */
  quickdraw: boolean;
  /** 这段伤害是战吼给的(打了就生效),不是挂在快枪上。 */
  battlecry: boolean;
  /** 连击给的伤害。 */
  combo?: boolean;
  /** 这一手到底能不能炸出来。 */
  ready: boolean;
}

export function playDamage(
  card: HandCardView,
  spellPower = 0,
  ctx?: { comboActive?: boolean; battlecry?: BattlecryContext },
): PlayDamage | null {
  const m = /伤害\s*(\d+)/.exec(card.note);
  if (!m) return null;
  const fx = cardEffects(card.cardId);
  const dg = card.darkGift ? darkGiftEffects(card.darkGift.cardId, card.darkGift.note) : null;
  const isSpell = card.type === '法术';
  const spBonus = isSpell ? spellPower : 0;
  const minionOnly = new RegExp(`伤害\\s*${m[1]}[^\\s]*随从`).test(card.note);
  const quickdraw = /快枪/.test(card.note);
  const battlecry = /战吼/.test(card.note);
  const combo = !battlecry && fx.combo && fx.comboDamage > 0;

  if (/战吼需/.test(card.note)) {
    if (!ctx?.battlecry) return null;
    if (battlecryState(fx, ctx.battlecry) !== 'ready') return null;
  }

  let baseDamage = Number(m[1]);
  let ready = battlecry || !quickdraw || card.poweredUp === true;
  if (combo) {
    if (ctx?.comboActive) {
      baseDamage = fx.comboDamage;
      ready = true;
    } else if (isSpell) {
      const baseSpell = lookupDamageCard(card.cardId);
      if (baseSpell) baseDamage = baseSpell.damage;
      else ready = false;
    } else {
      ready = false;
    }
  }
  if (battlecry && dg?.doubleBattlecry) baseDamage *= 2;

  return { damage: baseDamage + spBonus, minionOnly, quickdraw, battlecry, ...(combo ? { combo: true } : {}), ready };
}

/**
 * 把配置里的核心牌名单拆成数组。
 *
 * 手写名单的人不会讲究分隔符:中文逗号、英文逗号、顿号、分号、换行都会出现。
 * 全部认,并且允许他顺手写卡牌 ID(`BE_703`)。
 */
export function parseKeepCards(raw: string | string[] | undefined | null): string[] {
  const src = Array.isArray(raw) ? raw.join('\n') : (raw ?? '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of src.split(/[,，、;；\n\r]+/)) {
    const key = piece.trim();
    if (!key) continue;
    const norm = key.toUpperCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(key);
  }
  return out;
}

/**
 * 这张牌在不在核心牌名单里。
 *
 * 名字按「去空白后包含」匹配,这样写「德雷阿佳丝」能命中全名「德雷阿佳丝」,
 * 写短了也不至于漏。但**单字不放开**:只做精确比较,否则写个「龙」会命中半个牌库。
 */
function isKept(cardId: string, name: string | null, keep: string[]): boolean {
  if (!keep.length) return false;
  const id = (cardId ?? '').trim().toUpperCase();
  const flatName = (name ?? '').replace(/\s+/g, '');
  for (const raw of keep) {
    const key = raw.replace(/\s+/g, '');
    if (!key) continue;
    if (key.toUpperCase() === id) return true;
    if (!flatName) continue;
    if (key.length < 2) {
      if (flatName === key) return true;
      continue;
    }
    if (flatName.includes(key) || key.includes(flatName)) return true;
  }
  return false;
}

/** 把手牌读成能看懂的清单。 */
/**
 * 这张牌是不是换水晶的硬币。
 *
 * 规则与 `parser.ts` 的 `isCoinCard` 一致:硬币查不到卡表(它是衍生物),
 * 只能按 id 认 —— `ETC_COIN1`(幸运币)、`GAME_005`、`MUDAN_COIN1` 都含 COIN。
 */
const isCoinId = (cardId: string): boolean => /COIN|GAME_005/i.test(cardId);

export function readHand(side: SideState, keep: string[] = [], avoid: string[] = []): HandCardView[] {
  const out: HandCardView[] = [];
  // 硬币也是钱:手上有几个硬币,这一回合就多几点可花。
  const coins = side.coinMana ?? side.coinCount ?? 0;
  const budget = side.mana + coins;
  for (const card of side.handCards ?? []) {
    const info = describeCard(card.cardId);
    // 卡表只收可收集牌,衍生物(`BE_327t`、`VAC_323t2`)查不到 —— 那就用日志里的实体名。
    // 只用 cardId 的话她会念出「BE_327t(4费)」这种,读的人一头雾水(2026-10-24 实测)。
    const displayName = info?.name ?? (card.name || null);
    out.push({
      cardId: card.cardId,
      name: displayName,
      cost: card.cost,
      isCoin: isCoinId(card.cardId),
      baseCost: info?.baseCost ?? null,
      type: info?.type ?? '未知',
      note: handNote(card.cardId, card.prepared === true, card.darkGift),
      playable: card.cost <= budget,
      needsCoin: card.cost > side.mana && card.cost <= budget,
      keep: isKept(card.cardId, displayName, keep),
      forge: info?.forge ?? false,
      forged: info?.forged ?? false,
      prepare: info?.prepare ?? false,
      prepared: card.prepared === true,
      tradeable: info?.tradeable ?? false,
      enteredTurn: card.enteredTurn,
      poweredUp: card.poweredUp === true,
      ...(card.darkGift ? { darkGift: card.darkGift } : {}),
    });
  }
  // 能打出的排前面,同组里核心牌往后让、贵的在前(优先考虑把水晶用满)
  //
  // **被避开的牌排到最前一组之外（2026-11-14）**：他连着两回合没打的那张，
  // 第三回合不该还是它 —— 原来只在文本后面加一句「你已经推了 N 个回合」，
  // 建议本身没变，等于劝得更勤而已。用户的原话是「别这样连续推」。
  //
  // 放在 playable 之后、keep 之前：能打的照样优先（不能因为要避开它而推一张打不起的），
  // 但同样能打的里面，换一张。
  const avoided = (n: string | null | undefined): number =>
    n && avoid.some((x) => x && (n === x || n.includes(x) || x.includes(n))) ? 1 : 0;
  return out.sort((a, b) =>
    Number(b.playable) - Number(a.playable)
    || avoided(a.name) - avoided(b.name)
    || Number(a.keep) - Number(b.keep)
    || b.cost - a.cost,
  );
}

/** 这回合真正能花的水晶(含硬币)。 */
export function manaBudget(side: SideState): number {
  // **硬币数是「几枚」,不是「多几点水晶」。** 一枚硬币打出去换 1 点,可它自己也有费用:
  // 0 费硬币净赚 1,被「手牌费用 +1」照成 1 费之后净赚 0 —— 打它等于花 1 换 1。
  // 2026-10-29 20:56:59 实测同一条 COST 变化里,加速光环 2→3、幸运币 0→1;
  // 当时给的建议是「按费打:加速光环(3费·要打硬币)」,而那一枚硬币什么也换不到。
  return side.mana + (side.coinMana ?? side.coinCount ?? 0);
}

/**
 * 打掉一个随从需要的有效血量。
 *
 * 有圣盾时,第一下伤害被吃掉、不掉血,所以要么两下,要么一次足够大的伤害也只算破盾。
 * 这里只回答「总共需要多少点攻击力分几次」,具体能不能凑出来交给调用方判断。
 */
export function effectiveHp(m: MinionView): number {
  return Math.max(1, m.health);
}

export interface TradeOption {
  mine: MinionView;
  theirs: MinionView;
  /** 我能不能杀死它。 */
  kills: boolean;
  /** 杀死之后我自己活不活。 */
  survives: boolean;
  /** 我掉多少血(活不下来就是掉光)。 */
  myLoss: number;
  text: string;
  score: number;
}

/**
 * 场面交换的选项。
 *
 * 近战交换是**同时结算**的:两边互相吃对方攻击力。所以「我 5/5 打他 6/6」的结果是
 * 我死他活 —— 这不是能做的交换。算法就是按这个算,不美化。
 *
 * 圣盾这边单独处理:有盾的一方第一下不吃伤害,所以带盾的随从去撞人基本能活。
 */
export function tradeOptions(snapshot: GameSnapshot): TradeOption[] {
  const mine = snapshot.me.minions.filter((m) => m.canAttack && m.atk > 0);
  const theirs = snapshot.opponent.minions;
  const out: TradeOption[] = [];

  for (const m of mine) {
    const hits = m.windfury ? 2 : 1;
    for (const t of theirs) {
      // 圣盾:先破盾(消耗一次命中、不掉血),再打血
      let hitsLeft = hits;
      let hadShield = t.divineShield;
      let shield = t.divineShield;
      let dealt = 0;
      while (hitsLeft > 0 && dealt < effectiveHp(t)) {
        hitsLeft -= 1;
        if (shield) { shield = false; continue; }
        // 剧毒:只要伤害落地就致死,不管对面多少血
        if (m.poisonous) { dealt = effectiveHp(t); break; }
        dealt += m.atk;
      }
      const killsReal = dealt >= effectiveHp(t);

      // 对方的反击:近战是**同时结算**的,所以它就算被打死也会把攻击力打出来。
      // 曾经写成「打死了就不反击」,结果每一次交换都显示「我毫发无伤」——那是错的。
      // 被剧毒随从反咬一口,不管我有多少血都会死
      const retaliate = t.poisonous ? m.health : t.atk;
      const myLoss = m.divineShield ? 0 : retaliate;
      const survives = myLoss < m.health;

      const label = (x: MinionView) => minionLabel(x);
      const myStats = `${m.atk}/${m.health}${m.divineShield ? '圣盾' : ''}${m.windfury ? '风怒' : ''}${m.poisonous ? '剧毒' : ''}`;
      const itsStats = `${t.atk}/${t.health}${t.divineShield ? '圣盾' : ''}${t.taunt ? '嘲讽' : ''}${t.poisonous ? '剧毒' : ''}`;
      /*
       * 主语必须带随从名，不能只有身材（2026-11-20）。
       *
       * 原来这里直接拿 `myStats` 当句子开头，于是回合事件里出现
       * 「先换:8/8 打 滑行者巨怪(6/7嘲讽) → 换掉它」——
       * 场上有两只 8/8（灭世信徒、瓦尼尔士兵圣盾）时根本分不清推的是哪只；
       * 更要命的是下游 `advicePick` 从「先换:」后面抓第一个 token，
       * 抓到的是身材不是牌名，日记就记成「我说『8/8』，他打了『谦恭审判』」，
       * 再被算进「推了他没听」的分歧统计。2026-11-20 那局第 17 回合就是这么记的，
       * 历史上还有 4 处同型（「2/3」「2/1圣盾」「2/2」）。
       */
      const myLabel = `${label(m)}(${myStats})`;

      let text: string;
      const remain = Math.max(0, m.health - myLoss);
      const shieldNote = m.divineShield ? '(圣盾挡掉反击)' : '';
      if (killsReal && survives) {
        text = `${myLabel} 打 ${label(t)}(${itsStats}) → 换掉它,我的随从剩 ${remain} 血${shieldNote}`;
      } else if (killsReal) {
        text = `${myLabel} 打 ${label(t)}(${itsStats}) → 换掉它,但我的也死`;
      } else if (!killsReal && !survives) {
        text = `${myLabel} 打 ${label(t)}(${itsStats}) → 打不死还被反杀,别这么换`;
      } else if (hadShield && dealt === 0) {
        text = `${myLabel} 打 ${label(t)}(${itsStats}) → 只破盾,它没掉血,我被咬 ${myLoss}`;
      } else {
        text = `${myLabel} 打 ${label(t)}(${itsStats}) → 打掉 ${dealt} 血、它剩 ${Math.max(0, effectiveHp(t) - dealt)},我剩 ${remain} 血${shieldNote}`;
      }

      // 这三个词条不改变血量计算,但改变「这一手划不划算」
      const itsFx = cardEffects(t.cardId);
      const notes: string[] = [];
      let bonus = 0;
      if (killsReal && t.reborn) {
        // 复生:打死了还会以 1 血站起来,等于没换干净
        notes.push('它复生,死了还会留 1 血');
        bonus -= 4;
      }
      if (killsReal && itsFx.deathrattle > 0) {
        notes.push(`它亡语还会打 ${itsFx.deathrattle} 点`);
        bonus -= 3;
      }
      if (m.lifesteal) {
        notes.push(`我吸血,能回 ${m.atk} 血`);
        bonus += 1;
      }
      // 打 0 攻随从基本是白给:它本来就打不出伤害,换掉它场攻一点没减,
      // 只是把我这张牌的一次攻击浪费掉。
      //
      // 实测 2026-10-24 第 11 回合:5/3 的毁焚火凤被推荐去撞对面的 0/1 不稳定的原型机
      // (复生)。理由写着「它复生了会留 1 血」—— 听着像在解决问题,实际对面 13 点场攻
      // 一点没动,下一轮他的 7/7 吸血 + 两道 3/5 嘲讽原封不动压过来,他就这么空场了。
      // 例外:剧毒(碰到就死,必须处理)和亡语伤害(拖下去要吃亏)。
      if (killsReal && t.atk <= 0 && !t.poisonous && itsFx.deathrattle <= 0) {
        bonus -= 8;
      }
      // 对面的剧毒随从要早处理 —— 不换掉它,我一个随从碰一下就没了
      if (killsReal && t.poisonous) bonus += 3;
      if (notes.length) text += `(${notes.join(';')})`;

      // 评分:换掉活的 > 换掉同归于尽 > 磨血 > 送死。同档里比身材差
      const theirValue = t.atk + t.health + (t.taunt ? 2 : 0);
      const myValue = m.atk + m.health;
      let score: number;
      if (killsReal && survives) score = 20 + (theirValue - myValue) + (t.taunt ? 3 : 0);
      else if (killsReal) score = 10 + (theirValue - myValue);
      else if (!survives) score = -20;
      else score = dealt - 2;
      if (t.taunt) score += 2;
      score += bonus;

      out.push({ mine: m, theirs: t, kills: killsReal, survives, myLoss, text, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface CombinedTrade {
  target: MinionView;
  kills: boolean;
  /** 用掉几个随从。 */
  used: number;
  /** 我会死几个。 */
  lost: number;
  steps: string[];
  text: string;
}

/**
 * 多个随从合力解一个。
 *
 * 为什么必须单独算:单看一对一,「3/3 打 4/5」是换不掉;但 3/3 顶一下、2/3 补刀就是解掉了。
 * 只报「换不掉」会让她给出错误的判断。
 *
 * 按**顺序模拟**,因为伤害是逐步累加的:先打的那只把对面血磨下去,后打的才够得着;
 * 而每一下都要吃对面的反击(同时结算),所以中间会死人。不模拟就会把「两个换一个」
 * 说成「轻松解掉」——那是在骗人。
 */
export function combinedTrades(snapshot: GameSnapshot): CombinedTrade[] {
  const attackers = snapshot.me.minions
    .filter((m) => m.canAttack && m.atk > 0)
    .sort((a, b) => b.atk - a.atk || b.health - a.health);

  const out: CombinedTrade[] = [];
  for (const target of snapshot.opponent.minions) {
    let hp = target.health;
    let shield = target.divineShield;
    let lost = 0;
    let used = 0;
    const steps: string[] = [];
    const label = minionLabel(target);

    for (const m of attackers) {
      if (hp <= 0) break;
      used += 1;
      const meLabel = minionLabel(m);

      if (shield) {
        shield = false;
        steps.push(`${meLabel} 破盾`);
      } else if (m.poisonous) {
        hp = 0;
        steps.push(`${meLabel} 剧毒`);
      } else {
        hp -= m.atk;
        steps.push(`${meLabel} 打 ${m.atk}`);
      }
      // 同时结算:对面就算这一下要死,也会把攻击力打出来;对面有剧毒则必死
      const took = m.divineShield ? 0 : target.poisonous ? m.health : target.atk;
      if (took >= m.health) lost += 1;
    }

    const kills = hp <= 0;
    if (!kills) continue;
    out.push({
      target,
      kills,
      used,
      lost,
      steps,
      text:
        `${steps.join(' → ')} → 解掉 ${label}(${target.atk}/${target.health}` +
        `${target.taunt ? ' 嘲讽' : ''}${target.divineShield ? ' 圣盾' : ''}),` +
        `用了 ${used} 个随从${lost ? `,其中 ${lost} 个会死` : ',一个都不死'}`,
    });
  }
  return out.sort((a, b) => a.lost - b.lost || a.used - b.used);
}

export interface ThreatInfo {
  /**
   * 对手场上的武器(没有就是 null)。
   *
   * 单列出来的理由:武器**不占场面**,0 攻的武器连场攻都不进 ——
   * 实测 2026-10-24 第 4 回合,牧师挂上黑暗帝国之刃(0/3),场上空场,
   * 建议老老实实写「对面打不到我」。数字全对,可他之后每回合都在掉血,
   * 她解释不了为什么。武器必须在话里出现,哪怕只是报一句它挂着。
   */
  foeWeapon: { cardId: string; name: string; atk: number; durability: number } | null;
  /**
   * 我身上的「疲劳钟」—— 牌库还没空、疲劳层数却在涨,说明有外部疲劳源在追杀
   * (实测:牧师那把黑暗帝国之刃每回合给敌方英雄一次疲劳伤害)。
   *
   * 它必须单独算:疲劳伤害**不看场面、不吃嘲讽**,下一轮 N+1 层、再下一轮 N+2 层,
   * 越扣越狠。实测第 9 个回合我 16 血、疲劳第 6 层、对面场攻 8,
   * 建议只说「还有点余量但别拖」—— 他照着去架墙,可这个钟架墙根本挡不住。
   */
  fatigueClock: { next: number; turns: number } | null;
  /** 对面下回合场上能打出的攻击力(含武器/英雄)。 */
  enemyAttack: number;
  /**
   * 对面场上**打不出来**的攻击力合计:无法攻击(上古看守者 2 费 4/5)、休眠。
   *
   * 单独报出来是为了解释「为什么场攻是 0」。不报的话,一只 4/5 杵在那里、
   * 她却说对面没威胁,读的人只会觉得她漏看了。
   */
  idleAttack: number;
  /** 其中随从那部分。 */
  minionAttack: number;
  /** 其中英雄/武器那部分。 */
  heroAttack: number;
  /** 其中英雄技能补的那部分(能当回合打到脸的才算)。 */
  heroPowerDamage: number;
  /**
   * 对面场攻里**带吸血**的那部分。
   *
   * 它不改「我掉多少血」,改的是「这一轮换完血差是多少」—— 他打我 7 点会先回 7 点,
   * 我掉的血他补回去了。实测 2026-10-24 第 11 回合:对面 13 场攻里有 7/7 破命之龙吸血,
   * 建议只报「对面场攻 13,还压不到我」—— 数字没错,但那一轮下来 28:18 的领先会变成 15:25。
   * 抢血的人必须知道这件事,否则他以为自己还领先 10 点。
   */
  lifestealAttack: number;
  /**
   * 对面场上的嘲讽数量。
   *
   * 0 攻的嘲讽不产生任何伤害,但它是**另一方向的威胁**:挡住我打脸。
   * 实测第 3 回合对面两个 0/3 嘲讽,系统只说「对面打不到我」——
   * 那是真的,可他也打不进去,而建议里一个字没提。
   */
  tauntCount: number;
  /** 嘲讽随从的血量合计(过墙得先打掉这些血)。 */
  tauntHealth: number;
  /** 我的有效血量(血 + 护甲)。 */
  myEffectiveHp: number;
  /** 不解场的话,下回合就会被斩杀。 */
  lethalNextTurn: boolean;
  /**
   * 离死只差一点。
   *
   * 加这一档是因为踩过实打实的错:第 20 回合我 17 血、对面场攻 14,
   * `lethalNextTurn` 判 false,建议就写成「对面场攻 14 不足为惧」——
   * 差 3 点血还说不足为惧,他照这句话不解场,下回合就死了。
   *
   * 临场还要算两笔不能忽略的:对面通常还有手牌(可能再下一个随从),
   * 以及我方下回合的血量不会比现在多。所以「差 5 点以内」就该当成必须处理。
   */
  closeCall: boolean;
  /** 差的点数(为正表示还撑得住多少)。 */
  margin: number;
}

/**
 * 对面**下回合**的威胁。只算场面,不猜手牌 —— 手牌在日志里是空的(不揭示就没有 cardId)。
 *
 * 关键区别:不能只算「现在能攻击的」随从。对面刚打出来的随从这一刻因为召唤失调打不了,
 * 到它自己的回合就能打了。只看 canAttack 会把一整排刚铺下来的随从算成 0,
 * 然后报出「对面空场」——实测踩过,那时候对面场上站着 4 个随从。
 *
 * 反过来,被冻结的随从下回合照样打不出来,要排除。
 */
/**
 * 差多少点以内算「贴着斩杀线」。
 *
 * 5 点是有依据的:对面手里多半还捏着东西,一个 2 费随从就是 2–3 点,
 * 一张直伤法术 3–6 点。留 5 点余量等于把「对面有牌」这层不确定性算进去。
 */
export const CLOSE_CALL_MARGIN = 5;

/**
 * 「先换」这条建议的最低分。
 *
 * `tradeOptions` 的评分口径:换掉且自己活着 = 20 + 身材差;换掉但同归于尽 = 10 + 身材差;
 * 磨血 = 打掉的血 - 2;送死 = -20。8 这条线刚好把「白吃」「值得的互换」「磨掉剧毒」留下,
 * 把「用大随从换小随从」和「撞 0 攻随从」挡在外面。
 *
 * 低于这条线时宁可走「按费打」——**一个没意义的交换比不给建议更糟**:它占掉了这轮唯一的
 * 攻击机会,还让人以为自己在解题。
 */
export const TRADE_MIN_SCORE = 8;

/**
 * 「先换」什么时候才压过「铺场」:血余量小于这个数。
 *
 * 余量大(对面压不到我)的时候,主动送随从去换是最常见的自毁方式 ——
 * 换完是「不亏不赚」,但你场上从此是空的,下回合对面想怎么打就怎么打。
 * 2026-10-24 第 11 回合就是这么走的:28 血对 13 场攻(余量 15),
 * 「先换」把唯一那只 5/3 送掉,第 13 回合开始空场。
 */
export const TRADE_TRIGGER_MARGIN = 10;

/**
 * 英雄技能在他下一个回合能**直接打到脸**的伤害。
 *
 * 为什么必须算:2026-10-23 实测,对手死亡骑士 10 费,场攻算完说「还差 2 点,撑得住」——
 * 他一个「食尸鬼冲锋」召唤 1/1 **冲锋**食尸鬼,正好补上那 1 点。差一点,结论就反了。
 * 用户的原话是「对方十费的时候斩杀没算对面的英雄技能」。
 *
 * 只收「当回合就能打出去」的:
 *   算 —— 猎人 稳固射击 2;法师 火焰冲击 1;潜行者 1/2 匕首(当回合可攻击)1;
 *         德鲁伊 变形 +1 攻击 1;恶魔猎手 恶魔之咬 +1 攻击 1;死亡骑士 1/1 冲锋 1
 *   不算 —— 圣骑士 1/1 白银之手新兵(无冲锋,这回合打不出来)、萨满图腾(0 攻)、
 *         术士生命分流(抽牌自伤)、牧师治疗、战士加护甲
 *
 * 没收录的职业(武僧之类)按 1 算:这一栏宁可多算一点 —— 漏算会让他以为还撑得住,
 * 那是拿命换的错。
 */
const HERO_POWER_HIT: ReadonlyArray<readonly [RegExp, number]> = [
  [/猎人|hunter/i, 2],
  [/法师|mage/i, 1],
  [/潜行者|盗贼|rogue/i, 1],
  [/德鲁伊|druid/i, 1],
  [/恶魔猎手|demon\s*hunter|demonhunter/i, 1],
  [/死亡骑士|death\s*knight|deathknight/i, 1],
  [/圣骑士|paladin/i, 0],
  [/萨满|shaman/i, 0],
  [/术士|warlock/i, 0],
  [/牧师|priest/i, 0],
  [/战士|warrior/i, 0],
];

export function heroPowerHit(heroClass: string | undefined): number {
  const name = (heroClass ?? '').trim();
  // 职业还没读出来:不猜。这一栏是精确计算,不是估个大概 —— 数据没到就报没有。
  if (!name) return 0;
  for (const [pattern, hit] of HERO_POWER_HIT) if (pattern.test(name)) return hit;
  // 具名但表里没有(武僧之类新职业):保守给 1。承认表不全,偏向安全。
  return 1;
}

export function threatInfo(snapshot: GameSnapshot): ThreatInfo {
  const foe = snapshot.opponent;
  const minionAttack = foe.minions.reduce((sum, m) => {
    if (m.atk <= 0 || m.frozen || m.cantAttack) return sum;
    return sum + m.atk * (m.windfury ? 2 : 1);
  }, 0);
  const hero = heroSwing(foe);
  // 吸血:跟 minionAttack 同一口径(冻结的打不出来、风怒算两次、打不出来的不算),逐条对得上才对。
  // 英雄/武器也可能带吸血,但武器那一路的吸血在日志里没有可靠标签,先只算随从。
  const lifestealAttack = foe.minions.reduce((sum, m) => {
    if (!m.lifesteal || m.atk <= 0 || m.frozen || m.cantAttack) return sum;
    return sum + m.atk * (m.windfury ? 2 : 1);
  }, 0);
  // 下回合水晶会刷新(上限 +1)。落后一整回合的话本轮 1 水晶也可能下轮凑到 2,
  // 所以只要不是开局那一轮,技能基本都用得出来。
  //
  // **但潜行者的技能是「装备一把 1/2 匕首」** —— 他手上已经有一把武器的时候,
  // 技能只是换一把,不会再额外砍出 1 点。技能这 1 点和武器那 1 点加在一起就是重复计算:
  // 实测 2026-10-24 第 9 回合对面挂着邪恶短刀(1/2),她报「场攻 4(随从 2 + 武器/英雄 1 + 技能 1)」,
  // 实际只有 3 —— 那个「技能 1」是把同一把刀数了两遍。
  const weaponPower = foe.weapon && /潜行者|盗贼|rogue/i.test(foe.heroClass) ? 0 : heroPowerHit(foe.heroClass);
  const heroPower = foe.manaMax >= 1 ? weaponPower : 0;
  const enemyAttack = minionAttack + hero + heroPower;
  const idleAttack = foe.minions.reduce((sum, m) => (m.cantAttack ? sum + m.atk : sum), 0);
  const myEffectiveHp = snapshot.me.health + snapshot.me.armor;
  const margin = myEffectiveHp - enemyAttack;
  // 牌库没空、疲劳却在涨 = 有外部疲劳源。这一路伤害不吃场面,得单独算它几回合能清场。
  // 疲劳规则:下一轮扣「当前层数 + 1」,再下一轮 +2 …… 所以是 k 次之和,不是简单除法。
  let fatigueClock: ThreatInfo['fatigueClock'] = null;
  if (snapshot.me.fatigue > 0 && snapshot.me.deckCount > 0 && myEffectiveHp > 0) {
    let dealt = 0;
    let turns = 0;
    while (dealt < myEffectiveHp && turns < 20) {
      turns += 1;
      dealt += snapshot.me.fatigue + turns;
    }
    fatigueClock = { next: snapshot.me.fatigue + 1, turns };
  }
  // 嘲讽墙不算伤害,但挡进攻 —— 单独数出来
  const taunts = foe.minions.filter((m) => m.taunt);
  return {
    foeWeapon: foe.weapon,
    fatigueClock,
    enemyAttack,
    idleAttack,
    minionAttack,
    heroAttack: hero,
    heroPowerDamage: heroPower,
    lifestealAttack,
    tauntCount: taunts.length,
    tauntHealth: taunts.reduce((sum, m) => sum + Math.max(0, m.health), 0),
    myEffectiveHp,
    lethalNextTurn: enemyAttack >= myEffectiveHp && enemyAttack > 0,
    closeCall: enemyAttack > 0 && margin > 0 && margin <= CLOSE_CALL_MARGIN,
    margin,
  };
}

export interface AoeOption {
  name: string;
  cost: number;
  damage: number;
  /**
   * 这一下**最多**能清掉的对方随从。
   *
   * 随机分配的群伤(`伤害8群随机随从`)这里是上界,不是保证 —— 见 `cutMin`。
   */
  clears: MinionView[];
  /** 伤害是「总量分配」还是「每只各吃一份」。前者落点不确定,不能说成清场。 */
  spreads: boolean;
  /** 最多能削掉多少场攻(上界,渲染用)。 */
  cutMax: number;
  /** **保证**能削掉多少场攻(下界,判「活不活得下来」只能用这个)。 */
  cutMin: number;
  /** 吸血牌能回多少血(0 = 不是吸血牌)。按保守值算,见 aoeOptions 里的注释。 */
  heal: number;
  /** 只打随从,碰不到脸。 */
  minionsOnly: boolean;
  /** 群伤是否会打到我方随从。 */
  hitsOwnMinions: boolean;
  /** 群伤是否会打到我方英雄。 */
  hitsOwnHero: boolean;
  /** 对我方英雄造成的确定自伤点数（0 = 无）。 */
  selfHeroDamage: number;
  /** 确定会被连带烧死的我方随从（非圣盾且血量 <= damage）。 */
  ownLost: MinionView[];
  /** 连带烧死的我方随从总攻击力。 */
  ownLostAtk: number;
  text: string;
}

/**
 * 「伤害 N 群随机随从」最多能清掉哪几只。
 *
 * 这类牌的总伤害是 N 点,**分配**给随机的目标 —— 不是每只各吃 N 点。
 * 原来两种结构共用同一个判据(`血量 <= N`),于是一张 8 点随机伤害的牌,会把
 * 对面 4 只血 20 的随从全算成清掉。实测 2026-10-29 第 15 回合的真话是:
 *
 *   「用 起源大厅 清场,能削 15 点、回 8 血(我 8→16),对面剩 0 点场攻,死不了」
 *
 * 对面 4 只合计 20 血,8 点伤害连两只都未必杀得掉。他照着这条当真活路打,
 * 下一回合就被打死了 —— **给出一条不存在的活路,比不给建议更糟**。
 *
 * 这里给的是上界:血量从低到高贪心分配,总伤害够得着的才算。
 * 下界在 `aoeOptions` 里单独算(随机可能全砸一只,保证值通常是 0)。
 */
function spreadClears(minions: readonly MinionView[], damage: number): MinionView[] {
  let left = damage;
  const out: MinionView[] = [];
  for (const m of [...minions].sort((a, b) => a.health - b.health)) {
    if (m.divineShield) continue;          // 圣盾吃满一下不死,先破盾
    if (m.health <= 0) { out.push(m); continue; }
    if (m.health > left) break;
    left -= m.health;
    out.push(m);
  }
  return out;
}

function makeBattlecryCtx(snapshot: GameSnapshot, deckHasDuplicates?: boolean): BattlecryContext {
  return {
    weapon: !!snapshot.me.weapon,
    minionCount: snapshot.me.minions.length,
    auras: snapshot.me.auras?.length,
    imbueCount: snapshot.me.imbueCount,
    hasDarkGiftInHand: (snapshot.me.handCards ?? []).some((c) => Boolean(c.darkGift)),
    deckHasDuplicates,
  };
}

/** 手里能打出的群体伤害（法术 + 前提满足的战吼随从），以及它能清掉什么、会否自伤。 */
export function aoeOptions(snapshot: GameSnapshot, deckHasDuplicates?: boolean): AoeOption[] {
  const out: AoeOption[] = [];
  const foe = snapshot.opponent;
  const ctx = makeBattlecryCtx(snapshot, deckHasDuplicates);
  const sp = snapshot.me.spellPower ?? 0;
  const boardSlotsFree = Math.max(0, 7 - snapshot.me.minions.length);
  const myEffectiveHp = snapshot.me.health + snapshot.me.armor;

  for (const card of snapshot.me.handCards ?? []) {
    if (card.cost > snapshot.me.mana) continue;
    const entry = lookupCard(card.cardId);
    const name = entry?.[0] || card.name || '未知群伤牌';
    const resolved = resolveHandAoeCard(card, { spellPower: sp, battlecryCtx: ctx, boardSlotsFree });
    if (!resolved) continue;

    const { damage, spreads, minionsOnly, hitsOwnMinions, hitsOwnHero, selfHeroDamage, lifesteal } = resolved;
    const srcTag = resolved.kind === 'battlecry'
      ? `·战吼${resolved.doubleBattlecry ? '×2' : ''}`
      : (sp ? `(含法强 +${sp})` : '');

    const clears = spreads
      ? spreadClears(foe.minions, damage)
      : foe.minions.filter((x) => !x.divineShield && x.health <= damage);
    if (!clears.length) continue;

    const cutMax = clears.reduce((sum, x) => sum + (x.cantAttack ? 0 : x.atk), 0);
    const totalHealth = foe.minions.reduce((sum, x) => sum + Math.max(0, x.health), 0);
    const allGuaranteed = foe.minions.length > 0
      && foe.minions.every((x) => !x.divineShield)
      && totalHealth <= damage;
    const cutMin = spreads ? (allGuaranteed ? cutMax : 0) : cutMax;

    const dealt = clears.reduce((sum, x) => sum + Math.min(damage, x.health), 0);
    const totalCap = spreads ? damage : damage * clears.length;
    const heal = lifesteal ? Math.min(totalCap, dealt) : 0;

    const ownLost = !spreads && hitsOwnMinions
      ? snapshot.me.minions.filter((x) => !x.divineShield && x.health <= damage)
      : [];
    const ownLostAtk = ownLost.reduce((sum, x) => sum + Math.max(0, x.atk), 0);

    const healNote = heal > 0 ? `,吸血回 ${heal} 血` : '';
    const selfHeroNote = selfHeroDamage > 0
      ? (selfHeroDamage >= myEffectiveHp ? `·会烧死自己!(伤己英雄${selfHeroDamage}血)` : `·伤己英雄${selfHeroDamage}血`)
      : '';
    const ownLossNote = ownLost.length
      ? `,会连带烧死我方 ${ownLost.map((x) => `${minionLabel(x)} ${x.atk}/${x.health}`).join('、')}`
      : (hitsOwnMinions && spreads ? ',也会随机打到我方随从' : '');
    const clearsNote = spreads
      ? `最多清掉 ${clears.map((x) => `${minionLabel(x)} ${x.atk}/${x.health}`).join('、')}(伤害随机分配,不保证)`
      : `能清掉 ${clears.map((x) => `${minionLabel(x)} ${x.atk}/${x.health}`).join('、')}`;

    out.push({
      name,
      cost: card.cost,
      damage,
      clears,
      spreads,
      cutMax,
      cutMin,
      heal,
      minionsOnly,
      hitsOwnMinions,
      hitsOwnHero,
      selfHeroDamage,
      ownLost,
      ownLostAtk,
      text: `${name}(${card.cost}费 ${damage} 伤群体${srcTag}${spreads ? '·随机分配' : ''}${minionsOnly ? '·只打随从' : ''}${selfHeroNote}${healNote})${clearsNote}${ownLossNote}`,
    });
  }
  return out.sort((a, b) =>
    (Number(a.selfHeroDamage >= myEffectiveHp) - Number(b.selfHeroDamage >= myEffectiveHp))
    || b.cutMin - a.cutMin
    || b.clears.length - a.clears.length
    || (a.selfHeroDamage + a.ownLostAtk) - (b.selfHeroDamage + b.ownLostAtk)
    || a.cost - b.cost,
  );
}

/** 手里一张群伤牌的原始数据(组合用,不做「能不能清掉」的过滤)。 */
interface HandAoe {
  handIndex: number;
  name: string;
  cost: number;
  damage: number;
  spreads: boolean;
  isMinion: boolean;
  hitsOwnMinions: boolean;
  selfHeroDamage: number;
}

function handAoe(snapshot: GameSnapshot, deckHasDuplicates?: boolean): HandAoe[] {
  const out: HandAoe[] = [];
  const seen = new Set<string>();
  const ctx = makeBattlecryCtx(snapshot, deckHasDuplicates);
  const sp = snapshot.me.spellPower ?? 0;
  const boardSlotsFree = Math.max(0, 7 - snapshot.me.minions.length);
  const hand = snapshot.me.handCards ?? [];

  for (let i = 0; i < hand.length; i += 1) {
    const card = hand[i];
    const resolved = resolveHandAoeCard(card, { spellPower: sp, battlecryCtx: ctx, boardSlotsFree });
    if (!resolved) continue;

    const key = `${card.id ?? ''}|${card.cardId}`;
    if (card.id !== undefined && seen.has(key)) continue;
    seen.add(key);

    const entry = lookupCard(card.cardId);
    out.push({
      handIndex: i,
      name: entry?.[0] || card.name || '未知群伤牌',
      cost: card.cost,
      damage: resolved.damage,
      spreads: resolved.spreads,
      isMinion: resolved.kind === 'battlecry',
      hitsOwnMinions: resolved.hitsOwnMinions,
      selfHeroDamage: resolved.selfHeroDamage,
    });
  }
  return out;
}

export interface AoeCombo {
  /** 一句话说清这组牌、多少费、能清掉谁。 */
  text: string;
  cost: number;
  damage: number;
  /** 清掉的随从攻击力合计 —— 也就是「这么打能砍掉多少场攻」。 */
  cut: number;
  cleared: number;
  /** 对己方英雄造成的合计自伤（0 = 无）。 */
  selfHeroDamage: number;
  /** 这组用了哪几张牌(牌名,同名牌重复出现)。用来判断「是不是已经在按费打里推过了」。 */
  names: string[];
  /** 这组清掉的随从里**含嘲讽** —— 也就是「这组能过墙」。 */
  clearsTaunt: boolean;
}

export function aoeCombos(snapshot: GameSnapshot, deckHasDuplicates?: boolean): AoeCombo[] {
  const pool = handAoe(snapshot, deckHasDuplicates).filter((c) => !c.spreads);
  if (!pool.length) return [];
  const budget = manaBudget(snapshot.me);
  const foe = snapshot.opponent.minions.filter((m) => !m.divineShield && m.health > 0);
  if (!foe.length) return [];
  const freeSlots = Math.max(0, 7 - snapshot.me.minions.length);
  const myEffectiveHp = snapshot.me.health + snapshot.me.armor;

  const out: AoeCombo[] = [];
  const sp = snapshot.me.spellPower ?? 0;
  const spNote = sp ? `(含法强 +${sp})` : '';
  const combos: HandAoe[][] = [];
  for (let mask = 1; mask < 1 << pool.length; mask += 1) {
    const combo: HandAoe[] = [];
    for (let i = 0; i < pool.length; i += 1) if (mask & (1 << i)) combo.push(pool[i]);
    if (combo.reduce((n, c) => n + c.cost, 0) > budget) continue;
    if (combo.filter((c) => c.isMinion).length > freeSlots) continue;
    combos.push(combo);
  }
  for (const combo of combos) {
    const cost = combo.reduce((n, c) => n + c.cost, 0);
    const damage = combo.reduce((n, c) => n + c.damage, 0);
    const selfHeroDamage = combo.reduce((n, c) => n + c.selfHeroDamage, 0);
    if (selfHeroDamage >= myEffectiveHp && selfHeroDamage > 0) continue;

    const cleared = foe.filter((m) => damage >= m.health);
    if (!cleared.length) continue;
    const cut = cleared.reduce((n, m) => n + m.atk, 0);
    const hitsOwn = combo.some((c) => c.hitsOwnMinions);
    const ownLostCount = hitsOwn
      ? snapshot.me.minions.filter((m) => !m.divineShield && m.health <= damage).length
      : 0;
    const tally = new Map<string, { n: number; cost: number; damage: number }>();
    for (const c of combo) {
      const t = tally.get(c.name) ?? { n: 0, cost: 0, damage: 0 };
      tally.set(c.name, { n: t.n + 1, cost: t.cost + c.cost, damage: t.damage + c.damage });
    }
    const names = [...tally.entries()]
      .map(([name, t]) => `${name}${t.n > 1 ? ` ×${t.n}` : ''}`)
      .join(' + ');
    const selfWarn = [
      selfHeroDamage > 0 ? `自伤 ${selfHeroDamage} 血` : '',
      ownLostCount > 0 ? `连带烧死我方 ${ownLostCount} 只` : '',
    ].filter(Boolean).join('、');
    out.push({
      text: `${names} = ${damage} 点${spNote}、${cost} 费${selfWarn ? `(${selfWarn})` : ''},能清掉 ${cleared.map(minionLabel).join('、')}(砍掉 ${cut} 点场攻)`,
      cost,
      damage,
      cut,
      cleared: cleared.length,
      selfHeroDamage,
      names: combo.map((c) => c.name),
      clearsTaunt: cleared.some((m) => m.taunt),
    });
  }

  // 共用 LEVELER_NOTE_RE：把手上的「全场变 1 血 + 单张群伤」也纳入清场组合判据
  const hasShieldOrReborn = snapshot.opponent.minions.some((m) => m.divineShield || m.reborn);
  const hand = snapshot.me.handCards ?? [];
  if (!hasShieldOrReborn) {
    for (let li = 0; li < hand.length; li += 1) {
      const lc = hand[li];
      if (!lc.cardId || !LEVELER_NOTE_RE.test(cardNote(lc.cardId))) continue;
      const lName = lc.name || cardName(lc.cardId) || '变形牌';
      for (const aoeCard of pool) {
        if (aoeCard.handIndex === li) continue;
        const cost = lc.cost + aoeCard.cost;
        if (cost > budget) continue;
        if (aoeCard.isMinion && freeSlots <= 0) continue;
        if (aoeCard.selfHeroDamage >= myEffectiveHp && aoeCard.selfHeroDamage > 0) continue;
        const cut = foe.reduce((n, m) => n + m.atk, 0);
        const ownLostCount = aoeCard.hitsOwnMinions
          ? snapshot.me.minions.filter((m) => !m.divineShield).length
          : 0;
        const selfWarn = [
          aoeCard.selfHeroDamage > 0 ? `自伤 ${aoeCard.selfHeroDamage} 血` : '',
          ownLostCount > 0 ? `连带烧死我方 ${ownLostCount} 只` : '',
        ].filter(Boolean).join('、');
        out.push({
          text: `${lName} + ${aoeCard.name}(全场变 1 血再扫 ${aoeCard.damage} 点)、${cost} 费${selfWarn ? `(${selfWarn})` : ''},能清掉 ${foe.map(minionLabel).join('、')}(砍掉 ${cut} 点场攻)`,
          cost,
          damage: aoeCard.damage,
          cut,
          cleared: foe.length,
          selfHeroDamage: aoeCard.selfHeroDamage,
          names: [lName, aoeCard.name],
          clearsTaunt: foe.some((m) => m.taunt),
        });
      }
      break;
    }
  }

  return out.sort((a, b) =>
    b.cut - a.cut
    || b.cleared - a.cleared
    || a.selfHeroDamage - b.selfHeroDamage
    || a.cost - b.cost,
  );
}

export interface SingleRemoval {
  name: string;
  cardId: string;
  cost: number;
  kind: 'spell' | 'battlecry' | 'combo' | 'destroy' | 'transform' | 'silence' | 'freeze' | 'rush' | 'heal';
  target: MinionView | null;
  cutSafe: number;
  heal: number;
  text: string;
}

const foeAtkContribution = (m: MinionView): number =>
  (m.cantAttack || m.frozen || m.atk <= 0) ? 0 : m.atk * (m.windfury ? 2 : 1);

/**
 * 扫描当前费内（不含硬币）可出的单解、控场与保命牌。
 *
 * 保守边界：跳过已归入 `aoeOptions` 的群伤牌，跳过随机落点，跳过带未确认前提的牌；
 * 消灭复生怪不计保底减攻，只给确定降低的下回合场攻或确定回复的血/甲。
 */
export function singleRemovals(snapshot: GameSnapshot, deckHasDuplicates?: boolean): SingleRemoval[] {
  const out: SingleRemoval[] = [];
  const foe = snapshot.opponent.minions;
  const ctx = makeBattlecryCtx(snapshot, deckHasDuplicates);
  const sp = snapshot.me.spellPower ?? 0;
  const comboActive = Boolean(snapshot.me.comboActive);
  const freeSlots = Math.max(0, 7 - snapshot.me.minions.length);

  for (const card of snapshot.me.handCards ?? []) {
    if (!card.cardId || card.cost > snapshot.me.mana) continue;
    if (isCoinId(card.cardId)) continue;
    const fx = cardEffects(card.cardId);
    // 群伤牌由 aoeOptions 负责，不重复计一次
    if (fx.aoeDamage > 0) continue;

    const note = cardNote(card.cardId);
    if (/随机/.test(note)) continue;

    const type = cardTypeOf(card.cardId);
    const isMinion = type === 'M';
    if (isMinion && freeSlots <= 0) continue;
    if (fx.battlecryConditional && battlecryState(fx, ctx) !== 'ready') continue;

    const info = describeCard(card.cardId);
    const forged = info?.forged ?? false;
    if (!forged && COSTLY_NOTE.test(note)) continue;

    const dg = card.darkGift ? darkGiftEffects(card.darkGift.cardId, card.darkGift.note) : null;
    const name = card.name || cardName(card.cardId) || '未知卡牌';
    const baseSustain = (fx.armor || 0) + (/奶\s*\d+[^\s]*随从/.test(note) ? 0 : fx.heal || 0);

    let bestRemoval: SingleRemoval | null = null;
    const consider = (cand: SingleRemoval) => {
      if (!bestRemoval || (cand.cutSafe + cand.heal) > (bestRemoval.cutSafe + bestRemoval.heal)) {
        bestRemoval = cand;
      }
    };

    // 1) 变形单解（连复生/亡语一起变掉，确定削攻）
    if (fx.transform && !/所有/.test(note) && foe.length) {
      const target = [...foe].sort((a, b) => foeAtkContribution(b) - foeAtkContribution(a) || b.health - a.health)[0];
      if (target) {
        const cut = foeAtkContribution(target);
        consider({
          name, cardId: card.cardId, cost: card.cost, kind: 'transform', target,
          cutSafe: cut, heal: baseSustain,
          text: `${name}(${card.cost}费) 变形 ${minionLabel(target)}(${target.atk}/${target.health})${cut ? `,削掉 ${cut} 点场攻` : ''}`,
        });
      }
    }

    // 2) 消灭单解（过滤掉「所有」「牌/法力值」等非干净条件；「受伤」限定受伤随从）
    if (fx.destroy && !/所有/.test(note) && !/攻击力|生命值|法力值|武器/.test(note) && foe.length) {
      const injuredOnly = /受伤/.test(note);
      const pool = foe.filter((m) => !injuredOnly || m.health < m.maxHealth);
      const target = [...pool].sort((a, b) => foeAtkContribution(b) - foeAtkContribution(a) || b.health - a.health)[0];
      if (target) {
        const cut = target.reborn ? 0 : foeAtkContribution(target);
        consider({
          name, cardId: card.cardId, cost: card.cost, kind: 'destroy', target,
          cutSafe: cut, heal: baseSustain,
          text: `${name}(${card.cost}费) 消灭 ${minionLabel(target)}(${target.atk}/${target.health})${cut ? `,削掉 ${cut} 点场攻` : target.reborn ? '(对方复生仍留 1 血)' : ''}`,
        });
      }
    }

    // 3) 冻结控制（冰环全体冻结或单冻最高威胁）
    if (fx.freeze && (type === 'S' || (isMinion && fx.battlecry > 0) || /冻结/.test(note))) {
      const freezePool = foe.filter((m) => !m.cantAttack && !m.frozen && m.atk > 0);
      if (/所有/.test(note) && /敌方/.test(note) && freezePool.length) {
        const cut = freezePool.reduce((sum, m) => sum + foeAtkContribution(m), 0);
        consider({
          name, cardId: card.cardId, cost: card.cost, kind: 'freeze', target: freezePool[0],
          cutSafe: cut, heal: baseSustain,
          text: `${name}(${card.cost}费) 冻结敌方全体随从,下回合少挨 ${cut} 点`,
        });
      } else if (!/所有/.test(note) && freezePool.length) {
        const target = [...freezePool].sort((a, b) => foeAtkContribution(b) - foeAtkContribution(a))[0];
        const cut = foeAtkContribution(target);
        consider({
          name, cardId: card.cardId, cost: card.cost, kind: 'freeze', target,
          cutSafe: cut, heal: baseSustain,
          text: `${name}(${card.cost}费) 冻结 ${minionLabel(target)}(${target.atk}/${target.health}),下回合少挨 ${cut} 点`,
        });
      }
    }

    // 4) 单伤点杀（法术 / 战吼 / 已激活连击）
    let singleDmg = 0;
    let dmgKind: SingleRemoval['kind'] = 'spell';
    if (type === 'S') {
      const dCard = lookupDamageCard(card.cardId);
      let base = dCard?.damage ?? 0;
      if (!base) {
        const dm = /伤害\s*(\d+)/.exec(note);
        if (dm && !/自己|友方/.test(note)) base = Number(dm[1]) || 0;
      }
      if (comboActive && fx.combo && fx.comboDamage > 0) base = Math.max(base, fx.comboDamage);
      if (base > 0) singleDmg = base + sp;
    } else if (isMinion) {
      if (fx.battlecry > 0) {
        singleDmg = fx.battlecry * (dg?.doubleBattlecry ? 2 : 1);
        dmgKind = 'battlecry';
      } else if (comboActive && fx.combo && fx.comboDamage > 0) {
        singleDmg = fx.comboDamage;
        dmgKind = 'combo';
      }
    }
    if (singleDmg > 0 && foe.length) {
      const killable = foe
        .filter((m) => !m.divineShield && m.health <= singleDmg)
        .sort((a, b) => foeAtkContribution(b) - foeAtkContribution(a) || b.health - a.health);
      const target = killable[0] ?? null;
      if (target) {
        const cut = target.reborn ? 0 : foeAtkContribution(target);
        const lsHeal = fx.lifesteal ? Math.min(singleDmg, target.health) : 0;
        consider({
          name, cardId: card.cardId, cost: card.cost, kind: dmgKind, target,
          cutSafe: cut, heal: Math.max(baseSustain, lsHeal),
          text: `${name}(${card.cost}费 ${singleDmg} 伤) 点掉 ${minionLabel(target)}(${target.atk}/${target.health})${cut ? `,削 ${cut} 场攻` : ''}`,
        });
      }
    }

    // 5) 突袭 / 冲锋随从当回合解场
    if (isMinion && (/突袭/.test(note) || /冲锋/.test(note) || !!dg?.charge) && foe.length) {
      const body = cardBody(card.cardId);
      const atk = (body?.atk ?? 0) + (dg?.atkBonus ?? 0) + (comboActive && fx.combo ? fx.comboBuffAtk : 0);
      if (atk > 0) {
        const poisonous = /剧毒/.test(note);
        const killable = foe
          .filter((m) => !m.divineShield && (poisonous || atk >= m.health))
          .sort((a, b) => foeAtkContribution(b) - foeAtkContribution(a));
        const target = killable[0] ?? null;
        if (target) {
          const cut = target.reborn ? 0 : foeAtkContribution(target);
          const lsHeal = (fx.lifesteal || dg?.lifesteal) ? Math.min(atk, target.health) : 0;
          consider({
            name, cardId: card.cardId, cost: card.cost, kind: 'rush', target,
            cutSafe: cut, heal: Math.max(baseSustain, lsHeal),
            text: `${name}(${card.cost}费 ${atk}攻${poisonous ? '剧毒' : '突袭'}) 撞掉 ${minionLabel(target)}(${target.atk}/${target.health})${cut ? `,削 ${cut} 场攻` : ''}`,
          });
        }
      }
    }

    // 6) 纯回血 / 叠甲保命（仅当无更好解场选项时，且至少回 3 点才值回票价）
    if (!bestRemoval && baseSustain >= 3) {
      consider({
        name, cardId: card.cardId, cost: card.cost, kind: 'heal', target: null,
        cutSafe: 0, heal: baseSustain,
        text: `${name}(${card.cost}费) 补回 ${baseSustain} 点有效血量`,
      });
    }

    if (bestRemoval) out.push(bestRemoval);
  }

  return out.sort((a, b) => (b.cutSafe + b.heal) - (a.cutSafe + a.heal) || a.cost - b.cost);
}

/** 算建议时需要的外部知识(配置)。全可选,不传就是纯机械规则。 */
export interface AdviceOptions {
  /** 核心牌名单:牌名或卡牌 ID,逗号分隔。见 `parseKeepCards`。 */
  keepCards?: string | string[];
  /**
   * 这回合要避开的牌名 —— 上一张连推了两次、他没打的。
   */
  avoid?: string[];
  /** 记牌器快照（由 world 注入，用于反哺宇宙判断、余牌概率与对手已交 key 牌）。 */
  tracker?: TrackerSnapshot | null;
  /** 对手主流卡组匹配摘要文本（由 world 注入）。 */
  matchupHint?: string;
}

export interface Advice {
  lethal: LethalPlan;
  hand: HandCardView[];
  trades: TradeOption[];
  /** 多随从合力解一个。 */
  combined: CombinedTrade[];
  threat: ThreatInfo;
  aoe: AoeOption[];
  singleRemovals: SingleRemoval[];
  /** 按固定规则排出的候选,不是结论。 */
  candidates: string[];
}

/** 算这一回合的全部可用信息。 */
export function advise(snapshot: GameSnapshot, opts: AdviceOptions = {}): Advice {
  const keep = parseKeepCards(opts.keepCards);
  const deckHasDup = opts.tracker?.me.hasDuplicates;
  const lethal = planLethal(snapshot, { deckHasDuplicates: deckHasDup });
  const hand = readHand(snapshot.me, keep, opts.avoid ?? []);
  const trades = tradeOptions(snapshot);
  const combined = combinedTrades(snapshot);
  const threat = threatInfo(snapshot);
  const aoe = aoeOptions(snapshot, deckHasDup);
  const removals = singleRemovals(snapshot, deckHasDup);
  const target = snapshot.opponent.health + snapshot.opponent.armor;
  const taunts = snapshot.opponent.minions.filter((m) => m.taunt);

  const candidates: string[] = [];

  // 1. 能斩杀就先看斩杀
  if (lethal.total > 0 && lethal.total >= target) {
    const seq: string[] = [];
    if (taunts.length && lethal.faceAtk > 0) seq.push(...lethal.wall.steps);
    for (const s of lethal.spells) seq.push(`打 ${s.name}(${s.cost}费 ${s.damage} 伤)`);
    for (const b of lethal.buffs) seq.push(`给随从贴 ${b.name}(${b.cost}费 +${b.atk}攻)`);
    for (const b of lethal.battlecries) seq.push(`打 ${b.name}(${b.cost}费 ${b.tag ? b.tag : '战吼'} ${b.damage} 伤打脸)`);
    for (const c of lethal.charges) seq.push(`打 ${c.name}(${c.cost}费 冲锋 ${c.damage} 伤打脸)`);
    if (lethal.faceAtk > 0) seq.push(`剩下的 ${lethal.faceAtk} 点攻击力打脸`);
    candidates.push(`可以斩杀:按 ${seq.join(' → ')} 的顺序走,合计 ${lethal.total} ≥ 对面 ${target}。`);
  }

  // 2. 会被斩杀 → 必须先解场
  if (threat.lethalNextTurn) {
    const removable = trades.filter((t) => t.kills).reduce((sum, t) => sum + (t.theirs.cantAttack ? 0 : t.theirs.atk), 0);
    const aoeCut = aoe.filter((x) => x.selfHeroDamage < threat.myEffectiveHp).reduce((sum, a) => sum + a.cutMin, 0);
    const singleCut = removals[0]?.cutSafe ?? 0;
    candidates.push(
      `危险:对面场攻 ${threat.enemyAttack}(${threatText(threat)}),我只有 ${threat.myEffectiveHp} 有效血 —— 不处理下回合就死。` +
      ` 现在的攻击力能打掉对面 ${removable} 点场攻${aoeCut ? `,群体伤害还能再削 ${aoeCut}` : ''}${!aoeCut && singleCut > 0 ? `,单解/控制还能再削 ${singleCut}` : ''}。`,
    );
    const coinPlays = hand.filter((c) => c.needsCoin && c.playable).slice(0, 2);
    if (coinPlays.length) {
      candidates[candidates.length - 1] +=
        ` 手上有 ${coinPlays.map((c) => `${c.name ?? c.cardId}(${c.cost}费)`).join('、')},打个硬币就能上。`;
    }
  } else if (threat.enemyAttack > 0) {
    candidates.push(`对面场攻 ${threat.enemyAttack}(${threatText(threat)}),我有 ${threat.myEffectiveHp} 有效血,下回合还撑得住(余 ${threat.margin})。`);
  } else if (threat.enemyAttack === 0) {
    const board = snapshot.opponent.minions;
    const idle = board.filter((m) => m.cantAttack);
    const label = (m: GameSnapshot['opponent']['minions'][number]) => `${minionLabel(m)} ${m.atk}/${m.health}`;
    if (!board.length) {
      candidates.push('对面空场,这回合不用防,可以按自己的节奏走。');
    } else if (board.every((m) => m.frozen)) {
      candidates.push(`对面 ${board.length} 个随从全被冻结,这回合打不出来,不用急着解。`);
    } else if (idle.length === board.length) {
      candidates.push(`对面 ${idle.length} 个随从打不出来(${idle.map(label).join('、')}),挂着攻击力但动不了,这回合不用管它们。`);
    } else if (board.every((m) => m.atk <= 0 || m.cantAttack)) {
      const wall = threat.tauntCount > 0 ? `,其中 ${threat.tauntCount} 个是嘲讽(共 ${threat.tauntHealth} 血)挡住你的攻击` : '';
      candidates.push(`对面 ${board.length} 个随从打不出伤害${wall}。`);
    } else {
      candidates.push(`对面 ${board.length} 个随从下回合能打出攻击,这回合不用立刻解,但别拖太久。`);
    }
  }

  // 2.5 身材之外的威胁
  const notable = notableThreats(snapshot);
  if (notable.length) {
    const list = notable
      .map((n) => `${minionLabel(n.minion)} ${n.minion.atk}/${n.minion.health}(${n.reasons.join('、')})`)
      .join(';');
    candidates.push(`对面场上要留意的:${list}。`);
  }

  // 2.6 可交易
  const tradable = hand.filter((c) => c.tradeable && !c.playable && c.cost > 0);
  if (tradable.length) {
    candidates.push(
      `可交易:${tradable.map((c) => `${c.name ?? c.cardId}(${c.cost}费,这回合打不出)`).join('、')} —— 花 1 费洗回牌库换一张,换来的那张费用够的话当回合就能打。`,
    );
  }

  // 3. 有利交换
  const bestPerMinion = new Map<number, TradeOption>();
  for (const t of trades) {
    const key = t.mine.id;
    const prev = bestPerMinion.get(key);
    if (!prev || t.score > prev.score) bestPerMinion.set(key, t);
  }
  const unique = [...bestPerMinion.values()].sort((a, b) => b.score - a.score);

  const good = unique.filter((t) => t.kills && t.survives).slice(0, 3);
  if (good.length) {
    candidates.push(`有利交换:${good.map((t) => t.text).join(';')}。`);
  } else if (snapshot.opponent.minions.length) {
    const even = unique.filter((t) => t.kills).slice(0, 2);
    if (even.length) candidates.push(`只能同归于尽:${even.map((t) => t.text).join(';')}。`);
    else if (combined.length) {
      candidates.push(`单个换不掉,但合力可以:${combined[0].text}。`);
    } else candidates.push('现有攻击力换不掉对面任何一个随从,别硬撞。');
  }

  // 4. 群体伤害
  if (aoe.length) candidates.push(`群体伤害:${aoe[0].text}。`);
  const manyAoe = aoeCombos(snapshot, deckHasDup)[0];
  if (manyAoe && manyAoe.cut > (aoe[0]?.cutMin ?? 0)) {
    candidates.push(`群体伤害叠起来:${manyAoe.text}。`);
  }

  // 4.2 单解与保命牌
  if (removals.length) {
    candidates.push(`手牌单解与保命:${removals.slice(0, 3).map((r) => r.text).join(';')}。`);
  }

  // 4.5 手上能当回合就打的冲锋/突袭
  const impact = hand.filter((c) => c.playable && /突袭|冲锋/.test(c.note));
  if (impact.length) {
    candidates.push(
      `能当回合冲击的牌:${impact.map((c) => `${c.name ?? c.cardId}(${c.cost}费 ${c.note}${c.keep ? '·核心牌' : ''})`).join('、')} —— 打出来当回合就能攻击,等于多一份解场或打脸的手段。`,
    );
  }

  // 5. 这回合打得出的牌与词条状态
  const playable = hand.filter((c) => c.playable);
  const me = makeBattlecryCtx(snapshot, deckHasDup);
  const bcOnly = lethal.battlecries.filter((b) => b.tag !== '连击');
  const comboHits = lethal.battlecries.filter((b) => b.tag === '连击');
  if (bcOnly.length) {
    const totalBc = bcOnly.reduce((n, b) => n + b.damage, 0);
    const names = bcOnly.map((b) => `${b.name}(${b.cost}费 ${b.damage} 伤)`).join('、');
    candidates.push(`手上 ${names} 的战吼能打 ${totalBc} 点 —— 已经算进上面的斩杀线了。`);
  }
  if (comboHits.length) {
    const totalCb = comboHits.reduce((n, b) => n + b.damage, 0);
    const names = comboHits.map((b) => `${b.name}(${b.cost}费 ${b.damage} 伤)`).join('、');
    candidates.push(`手上 ${names} 的连击能打 ${totalCb} 点 —— 已经算进上面的斩杀线了。`);
  }
  if (lethal.charges.length) {
    const totalCg = lethal.charges.reduce((n, c) => n + c.damage, 0);
    const names = lethal.charges.map((c) => `${c.name}(${c.cost}费 ${c.damage} 伤)`).join('、');
    candidates.push(`手上 ${names} 的冲锋能打 ${totalCg} 点 —— 已经算进上面的斩杀线了。`);
  }
  for (const bc of conditionalBattlecries(playable.map((c) => c.cardId), me)) {
    const name = playable.find((c) => c.cardId === bc.cardId)?.name ?? bc.cardId;
    if (bc.state === 'blocked') {
      candidates.push(`手上 ${name} 的战吼要「${bc.condition}」才有 ${bc.damage} 点伤害 —— 现在不满足,打出去只是个随从。`);
    } else if (bc.state === 'unknown') {
      candidates.push(`手上 ${name} 的战吼要「${bc.condition}」才有 ${bc.damage} 点伤害 —— 这一条我判断不了,你自己看一眼。`);
    }
  }
  if ((snapshot.me.imbueCount ?? 0) > 0) {
    const hp = snapshot.me.heroPower;
    const hpPart = hp && (hp.name || hp.note)
      ? `,英雄技能${hp.name ? `「${hp.name}」` : ''}(${hp.cost}费${hp.note ? ` ${hp.note}` : ''})`
      : '';
    candidates.push(`灌注进度:我方已灌注 ${snapshot.me.imbueCount ?? 0} 次${hpPart}。`);
  }
  if (playable.some((c) => cardEffects(c.cardId).combo)) {
    candidates.push(snapshot.me.comboActive
      ? '连击状态:本回合已出过牌，连击词条已激活。'
      : '连击状态:尚未出牌，打连击牌前记得先垫一张低费牌或硬币。');
  }
  if (playable.length) {
    const list = playable.map((c) => `${c.name ?? c.cardId}(${c.cost}费${c.needsCoin ? '·要打硬币' : ''}${c.note ? ` ${c.note}` : ''}${c.keep ? '·核心牌' : ''})`);
    const budget = manaBudget(snapshot.me);
    const coinNote = budget > snapshot.me.mana ? `(含硬币,实打实能花 ${budget} 点水晶)` : '';
    candidates.push(`打得出的牌 ${playable.length} 张,水晶 ${snapshot.me.mana}${coinNote}:${list.join('、')}。能同时出几张要看费用怎么凑。`);
    const keepPlayable = playable.filter((c) => c.keep);
    if (keepPlayable.length) {
      candidates.push(
        `其中 ${keepPlayable.map((c) => c.name ?? c.cardId).join('、')} 是玩家标的核心牌 —— 要靠别的牌复制/触发,`
        + '配合没到位先留着。除非现在就能斩杀,否则别建议提前打出去。',
      );
    }
  } else if (hand.length && snapshot.me.mana > 0) {
    const cheapest = Math.min(...hand.map((c) => c.cost));
    candidates.push(`手上的牌一张都打不出:水晶 ${snapshot.me.mana},最便宜的 ${cheapest} 费。`);
  }

  // 6. 资源提醒
  if (snapshot.me.deckCount <= 5) candidates.push(`牌库只剩 ${snapshot.me.deckCount} 张,快见底了。`);
  if (snapshot.me.handCount === 0) candidates.push('手牌空了,后面只能靠抽。');

  // 7. 记牌器与对手情报（仅在有效记牌/匹配信息到达时补充，绝不虚构）
  if (opts.tracker) {
    if (opts.tracker.deckSource !== 'none') {
      const m = opts.tracker.me;
      const parts: string[] = [];
      if (m.remainingBurstCount > 0) parts.push(`剩余直伤 ${m.remainingBurstCount} 张(${m.remainingBurstDamage}点)`);
      if (m.remainingAoe.length) {
        const topAoe = m.remainingAoe.slice(0, 2).map((x) => `${x.name}×${x.left}(${Math.round(x.drawProb * 100)}%)`).join('、');
        parts.push(`剩余清场:${topAoe}`);
      }
      if (m.hasDuplicates === false) parts.push('牌库已无重复(宇宙前提就绪)');
      if (parts.length) candidates.push(`记牌器(${m.deckCount}张余):${parts.join(' · ')}。`);
    }
    if (opts.tracker.opponent.keyCardsUsed.length) {
      const used = opts.tracker.opponent.keyCardsUsed.slice(0, 4).map((x) => `${x.name}×${x.count}`).join('、');
      candidates.push(`对手已交解牌/关键牌:${used}。`);
    }
  }
  if (opts.matchupHint) candidates.push(opts.matchupHint);

  return { lethal, hand, trades, combined, threat, aoe, singleRemovals: removals, candidates };
}

/** 把场攻拆开说:随从多少、武器/英雄多少 —— 分开写才知道先解哪个。 */
function threatText(t: ThreatInfo): string {
  const parts: string[] = [];
  if (t.minionAttack > 0) {
    parts.push(t.lifestealAttack > 0
      ? `随从 ${t.minionAttack}(其中 ${t.lifestealAttack} 吸血)`
      : `随从 ${t.minionAttack}`);
  }
  if (t.heroAttack > 0) parts.push(`武器/英雄 ${t.heroAttack}`);
  if (t.heroPowerDamage > 0) parts.push(`技能 ${t.heroPowerDamage}`);
  // 打不出来的单说一句:不然一只 4/5 杵在场上、场攻却是 0,读的人以为她漏看了
  const idle = t.idleAttack > 0 ? `另有 ${t.idleAttack} 点打不出来` : '';
  if (!parts.length) return idle ? `${idle}(无法攻击/休眠,醒不来就不用管)` : '没有能打出来的东西';
  return idle ? `${parts.join(' + ')},${idle}` : parts.join(' + ');
}

/** 把关照渲染成她能读的一段文字。 */
export function renderAdvice(a: Advice, s: GameSnapshot): string {
  const lines: string[] = [];
  /*
   * 两侧的「能不能攻击」不是一个口径，别混用（2026-11-19）。
   *
   * 我方看的是**这回合**：`canAttack` 为假（刚上、冻结、攻击过了）就该标出来，
   * 因为这句话是给这一手用的。
   *
   * 对手看的是**下回合**：他刚铺下来的随从这一刻 `canAttack` 也是假，
   * 可到了他自己的回合全能打。按 `canAttack` 标「不能攻击」，而场攻合计里
   * 又把这几只的攻击力算进去了 —— 同一句话里两套口径，读的人会以为对面打不出来。
   * 实测这一把就是这么显示的：「场攻 15(随从 15)」配「4 个都(不能攻击)」。
   * 所以对手只标**永久**打不了的那种（`cantAttack`，如休眠、无法攻击）。
   */
  const mark = (m: SideState['minions'][number], enemy: boolean): string =>
    enemy
      ? (m.cantAttack ? '(打不了)' : '')
      : (m.canAttack ? '' : '(不能攻击)');

  const side = (x: SideState, who: string, enemy: boolean) => {
    const board = x.minions.length
      ? x.minions.map((m) => `${minionLabel(m)} ${m.atk}/${m.health}${m.taunt ? '嘲讽' : ''}${m.divineShield ? '圣盾' : ''}${m.frozen ? '冻结' : ''}${mark(m, enemy)}`).join('、')
      : '空场';
    return `${who}:${x.heroClass || '职业未知'} ${x.health} 血${x.armor ? ` ${x.armor} 护甲` : ''} · 场面 ${board} · 手牌 ${Math.max(x.handCount, x.handCards?.length ?? 0)} 张 · 牌库 ${x.deckCount}`;
  };

  const comboTag = s.me.comboActive ? ' · 连击已激活' : '';
  const imbueTag = (s.me.imbueCount ?? 0) > 0
    ? ` · 灌注${s.me.imbueCount ?? 0}次${s.me.heroPower?.name ? `(${s.me.heroPower.name})` : ''}`
    : '';
  lines.push(`第 ${s.turn} 回合${s.isMyTurn ? '(轮到我)' : '(轮到对手)'} · 我的水晶 ${s.me.mana}/${s.me.manaMax}${comboTag}${imbueTag}`);
  lines.push(side(s.me, '我', false));
  lines.push(side(s.opponent, '对手', true));

  lines.push('', '【手牌】' + (a.hand.length ? '' : '(看不到,空)'));
  for (const c of a.hand) {
    const costNote = c.baseCost !== null && c.baseCost !== c.cost ? `${c.cost}费(原${c.baseCost})` : `${c.cost}费`;
    const name = c.name ?? `${c.cardId}(牌库表里没有,别猜它的效果)`;
    lines.push(`  ${c.playable ? '*' : '-'} ${name} · ${costNote} · ${c.type}${c.note ? ` · ${c.note}` : ''}${c.keep ? ' · 【核心牌,别当普通随从打】' : ''}`);
  }

  lines.push('', '【斩杀线】');
  lines.push('  ' + lethalSummary(a.lethal, s));

  if (a.trades.length) {
    // 一个随从一回合只能打一次,所以这里按「我的随从」去重,只列它最好的那个目标
    const seen = new Set<number>();
    const picked = a.trades.filter((t) => (seen.has(t.mine.id) ? false : (seen.add(t.mine.id), true))).slice(0, 5);
    lines.push('', '【能做的交换】(打随从是同时结算,两边互相吃攻击力)');
    for (const t of picked) lines.push(`  ${t.score >= 10 ? '+' : t.score >= 0 ? '·' : '-'} ${t.text}`);
  }

  lines.push('', '【机械排出的候选】(按固定规则排的,不是最优解;牌面细节要你自己判断)');
  for (const c of a.candidates) lines.push(`  ${c}`);

  return lines.join('\n');
}

/**
 * 「这些攻全打脸能压到多少」。
 *
 * 2026-10-28 实测:他场上有随从、对面从第 6 回合起一直空场,对手血量九个回合停在 29。
 * 而回合正文只报了「对面场攻 1,还压不到我」——**只报了要挨打的那一半,没报能打出去的那一半**。
 * 她手上没有这个数,只能说「你随从是不是没往脸上打?」,一句疑问,笑一笑就过去了。
 * 数字在手才有分量:「全打脸他 29 掉到 24」比「是不是没打脸」难忽略。
 *
 * 只在**对面完全空场**时才说:有随从时"该换还是该打脸"是另一个判断,
 * 混在这一句里会把人带偏(而对面空场时,打脸本来就是唯一选择,说它零风险)。
 */
function facePushNote(s: GameSnapshot): string {
  if (s.opponent.minions.length) return '';
  const atk = swingsOf(s.me).reduce((n, x) => n + x, 0);
  if (atk < 2) return '';                    // 1 点攻不值得占一句话
  const foeTotal = s.opponent.health + s.opponent.armor;
  if (foeTotal <= 0) return '';
  const after = Math.max(0, foeTotal - atk);
  return after === 0
    ? `;你这边 ${atk} 点攻这个回合还没动过,对面空场,全打脸正好带走`
    : `;你这边 ${atk} 点攻这个回合还没动过,对面空场,全打脸他 ${foeTotal} 血掉到 ${after}`;
}

/** 斩杀线那一行的文字版。 */
function lethalSummary(p: LethalPlan, s: GameSnapshot): string {
  const target = s.opponent.health + s.opponent.armor;
  const taunts = s.opponent.minions.filter((m) => m.taunt);
  const bits: string[] = [];
  // 清场组合下「过墙后可打脸」是错的说法：墙是被扫掉的，没有攻击力去撞。
  bits.push(taunts.length
    ? (p.viaClear ? `先清场后 ${p.faceAtk} 全打脸` : `过墙后可打脸 ${p.faceAtk}`)
    : `场攻 ${p.faceAtk}`);
  if (p.spellDamage) bits.push(`直伤 ${p.spellDamage}(${p.spells.map((x) => `${x.name} ${x.cost}费`).join('+')})`);
  if (p.buffDamage) bits.push(`buff ${p.buffDamage}(${p.buffs.map((x) => x.name).join('+')})`);
  if (p.battlecryDamage) bits.push(`战吼 ${p.battlecryDamage}(${p.battlecries.map((x) => `${x.name} ${x.cost}费`).join('+')})`);
  if (p.chargeDamage) bits.push(`冲锋 ${p.chargeDamage}(${p.charges.map((x) => `${x.name} ${x.cost}费`).join('+')})`);
  const total = p.total;
  const verdict = total >= target && total > 0 ? `够斩杀(对面 ${target})` : total > 0 ? `差 ${target - total},对面 ${target}` : `打不到脸(对面 ${target})`;
  return `${bits.join(' + ')} = ${total} → ${verdict}`;
}

/**
 * 「先换」之外还有没有别的路 —— 只点那些能改变判断、但那句正文里没提到的牌。
 *
 * 2026-11-20 那局第 17 回合：我 30 血、19 点场攻，对面 15 血两道嘲讽（5/6、6/7），
 * 手上 6 张：坚韧的托雷斯、飞龙机动、谦恭审判、血色斗士、生而平等、龙鳞军备。
 * 建议只写了「两只 8/8 各撞一只，剩下两费下血色斗士，别贪着打脸」——
 * 谦恭审判（3 费抽三张）和生而平等（2 费全场变 1 血）一个字没提。
 * 而那两张正是当回合的钥匙：抽到群伤 → 平等 + 群伤把两道墙一起清掉 →
 * 19 点场攻全部打脸，当回合就斩。按建议打，这一回合斩不了。
 *
 * **只报三类**：抽牌、全场变 1 血、群体伤害。共同点是「本身不产生伤害，
 * 但能改变局面」—— 也正是斩杀线那套账看不见的东西。
 * 加攻、直伤、随从不在里面：它们在「斩杀线」和「按费打」里各有位置，
 * 这里再念一遍是凑字数。
 */
function openersInHand(a: Advice): string {
  const isOpener = (c: HandCardView): boolean =>
    c.playable && !c.isCoin && c.cost > 0
    && ((/抽\s*\d+/.test(c.note) || (/抽/.test(c.note) && /牌/.test(c.note)))
      || LEVELER_NOTE_RE.test(c.note)
      || /伤害\s*\d+\s*群/.test(c.note));
  const list = a.hand.filter(isOpener).slice(0, 2);
  if (!list.length) return '';
  return `手上还有${list.map((c) => `${c.name ?? c.cardId}(${c.cost}费)`).join('、')}`
    + ' —— 别急着把攻击力全撞在墙上,先看它能不能把墙直接解决掉。';
}

/* ---------- 给回合事件用的紧凑建议 ---------- */

export interface BriefAdvice {
  /** 这一句属于哪一类判断,便于测试和后续统计。 */
  kind: 'lethal' | 'danger' | 'trade' | 'develop' | 'hold' | 'idle';
  text: string;
  /**
   * 这一刻该摆什么脸(桌宠立绘的表情 id)。
   *
   * 只在**局势真有变化**时给:能斩杀、快死了、要动手换。平常回合不给 ——
   * 每回合换一张脸不叫有反应,叫抽风。
   */
  face?: FaceId;
  /**
   * 这一手具体是哪个动作 —— 给「她自己打牌」用的结构化结果。
   *
   * **为什么不让调用方从 text 里抠牌名**：那句话是给人读的中文，
   * 随时会为了措辞改一个字，而抠错了就是**点错牌**。
   * 文案和动作必须在同一处产生，改文案时动作跟着走，不会分家。
   *
   * 只给「能直接执行的那一种」：
   *   · `play` —— 把第 `handIndex` 张牌拖到场上 / 对面脸上；
   *   · 没有这个字段就代表**这一手没法自动执行**（要选目标、要交换、要留着），
   *     调用方必须老实放弃，不许猜。
   */
  pick?: {
    kind: 'play';
    /** 在手牌数组里的下标（0 起）。 */
    handIndex: number;
    cardId: string;
    name: string;
    /** 拖到对面脸上还是场上。 */
    toFace: boolean;
  };
}

/**
 * 一句话建议,塞进 `hearthstone.turn` 事件里。
 *
 * 为什么要这个:他每回合都要问一次「打什么」,每次都要一次工具往返,慢。
 * 把结论直接放进回合事件,她收到就能开口。
 *
 * 只给**一条主线 + 依据**,不铺开 —— 铺开她就会照着念,那是播报不是陪打。
 * 细节(全部手牌、每一笔交换)仍然留给 `hearthstone_advice`。
 */
export function briefAdvice(snapshot: GameSnapshot, opts: AdviceOptions = {}): BriefAdvice {
  const a = advise(snapshot, opts);
  const foe = snapshot.opponent;
  const target = foe.health + foe.armor;
  const swings = swingsOf(snapshot.me);

  // 1) 能斩杀 —— 别的都不用说了
  if (a.lethal.total > 0 && a.lethal.total >= target) {
    const bits: string[] = [];
    if (a.lethal.faceAtk > 0) {
      // 过墙吃掉的那部分必须说出来（2026-11-06）。
      // 原来只写「场攻 21 打脸 = 21」—— 数字是对的（21 已经扣过墙），
      // 可它听起来像「21 点全砸在脸上」，而实际上有一只随从是去撞墙的。
      // 他照着这句话决定「全推脸」的时候，中间那一步是看不见的。
      //
      // 清场组合（viaClear）是另一回事：墙是被扫掉的，没有任何随从去撞，
      // 这时候再写「N 点去撞墙」就是反的，得单独说一句。
      const walled = a.lethal.swingsTotal - a.lethal.faceAtk;
      bits.push(a.lethal.viaClear
        ? `先清场，场攻 ${a.lethal.faceAtk} 全打脸`
        : walled > 0
          ? `总攻 ${a.lethal.swingsTotal}，${walled} 点去撞墙，剩 ${a.lethal.faceAtk} 打脸`
          : `场攻 ${a.lethal.faceAtk} 打脸`);
    }
    for (const s of a.lethal.spells) bits.push(`${s.name} ${s.damage} 伤`);
    for (const b of a.lethal.buffs) bits.push(`${b.name} +${b.atk} 攻`);
    if (a.lethal.battlecryDamage) {
      bits.push(`战吼 ${a.lethal.battlecries.map((b) => `${b.name} ${b.damage}`).join('+')}`);
    }
    if (a.lethal.chargeDamage) {
      bits.push(`冲锋 ${a.lethal.charges.map((c) => `${c.name} ${c.damage}`).join('+')}`);
    }
    return {
      kind: 'lethal',
      face: 'excited',
      text: `能斩杀:${bits.join(' + ')} = ${a.lethal.total},对面 ${target}。`,
    };
  }

  // 2) 下回合会被打死 —— 先解场,并说清能削掉多少
  if (a.threat.lethalNextTurn || a.threat.closeCall) {
    const removal = pickRemoval(a);
    const cut = removal.cut;
    const heal = removal.heal;
    // 活不活得下来要一起看三笔:削掉多少场攻、回多少血、还剩多少场攻打脸。
    // 只比「cut >= enemyAttack」会漏掉吸血牌 —— 实测 9 血面对 8 点场攻,
    // 起源大厅清 8 场攻还回 8 血,是稳活的一手,而旧逻辑只说「能削 8 点」。
    //
    // **但「能削多少」必须用保守值判。** 这张牌上面那条 2026-10-24 的注记是对的
    // (吸血牌确实常是保命的那一手),而 2026-10-29 第 15 回合证明它也能反过来出事:
    // 「起源大厅」是 `伤害8群随机随从`,旧逻辑按「每只各吃 8 点」判,把对面 4 只
    // 合计 20 血全算成清掉,于是输出「能削 15 点、对面剩 0 点场攻、死不了」——
    // 他当成活路打,下一回合就被打死。随机分配的下界是 0,判生死了不能拿上界。
    const remaining = Math.max(0, a.threat.enemyAttack - removal.cutSafe);
    const hpAfter = a.threat.myEffectiveHp + heal - removal.selfHeroDamage;
    // 「这回合不死」不等于「安全」:血是会被一点点磨掉的,对面下回合还能再下随从。
    // 同时必须扣除 AOE 的自伤（比如地狱烈焰打自己 3 血）。
    const safe = hpAfter > 0 && (remaining <= 0 || hpAfter - remaining > CLOSE_CALL_MARGIN);
    const netDiff = heal - removal.selfHeroDamage;
    const selfDamageNote = removal.selfHeroDamage > 0
      ? (heal > 0
        ? `、回 ${heal} / 自伤 ${removal.selfHeroDamage} 血(我 ${a.threat.myEffectiveHp}→${hpAfter})`
        : `、自伤 ${removal.selfHeroDamage} 血(我 ${a.threat.myEffectiveHp}→${hpAfter})`)
      : (heal > 0 ? `、回 ${heal} 血(我 ${a.threat.myEffectiveHp}→${hpAfter})` : '');
    // 削 1–2 点不值得单独说 —— 「能削 1 点,还差 25 点」读起来像在凑字数。
    // 但有回血或自伤就必须报,那是真能改写生死的信息。
    const cutNote = cut >= 3 || heal > 0 || removal.selfHeroDamage > 0
      ? `${removal.uncertain ? '最多' : ''}能削 ${cut} 点${selfDamageNote}`
      : '';
    // 「还差 N 点」是拿保守值算的,随机牌要说清这是最坏情况,否则和「最多削」对不上账
    const verdict = safe
      ? `对面剩 ${remaining} 点场攻,死不了`
      : `${removal.uncertain && cut > 0 ? '最坏情况' : ''}还差 ${Math.max(0, remaining - netDiff)} 点`;
    // 手里有突袭/冲锋的牌,打出来当回合就能参与解场 —— 这是最容易被漏掉的一手
    const rush = a.hand.filter((c) => c.playable && /突袭|冲锋/.test(c.note));
    const rushNote = rush.length ? `;另外手上 ${rush[0].name} 打出来当回合就能补刀` : '';
    // 得靠硬币才上得去的牌也要说。8 水晶这回合,9 费的尤格-萨隆其实打得出来 ——
    // 只按 mana 算,它整排看着都是打不出的,他会以为这轮只剩挨打的份。
    // 实测 2026-10-24 第 16 回合:手上就那一张,建议一个字没提。
    const coin = a.hand.filter((c) => c.needsCoin && c.playable);
    const coinNote = coin.length
      ? `;手上 ${coin[0].name ?? coin[0].cardId}(${coin[0].cost}费)打个硬币就能上`
      : '';
    // 差得还多(不是马上就要死)时说清「还撑得住多少」,别把话说得像已经输了
    const urgency = a.threat.lethalNextTurn
      ? '不解就死'
      : `只差 ${a.threat.margin} 点就死了`;

    // 削不掉时**必须给一个能做的事**,不能只报噩耗。
    // 实测第 20 回合:空场、手上最大 3/3、对面 7/7+7/2,原文只写了
    // 「能削 0 点,还差 14」—— 等于告诉他「你完了」,却没提手上那两张
    // 圣盾+召唤的随从还能挡一刀。那种建议不如不给。
    const defense = !safe ? defensivePlays(a, cut, snapshot) : '';
    const tail = defense ? `;${defense}` : '';
    // 一句「削了多少、还剩多少」只有在**真削到了**或**回血了**的时候才有信息量。
    // 什么都没削到时 `cutNote` 是空串,原来会在句号后面留下一个孤零零的逗号:
    // 「危险:对面场攻 30,我 30 有效血,不解就死。,还差 30 点;…」
    // 而且那个「还差 30 点」只是把场攻抄了一遍 —— 什么都没削,说它等于凑字数。
    // 逗号跟着 cutNote 走。之前写成 `${plan}${cutNote},${verdict}`,而 plan 自带尾逗号、
    // cutNote 又常常是空串(削 1–2 点时故意不报),于是拼出「用 麦芽岩浆 清场,,还差 15 点」——
    // 双逗号,实测 2026-10-24 第 17、19 回合连着出现两次。
    const cutPart = cut > 0 || heal > 0
      ? `。${[removal.text, cutNote].filter(Boolean).join(',')},${verdict}`
      : '';

    return {
      kind: 'danger',
      // 脸要跟结论一致:算出来「死不了」还摆出担心的脸,那是自相矛盾;
      // 「稳住这一手」才是 determined 该有的样子。真会死才是 scared。
      face: safe ? 'determined' : 'scared',
      text: `危险:${attackLabel(a.threat)},我 ${a.threat.myEffectiveHp} 有效血,${urgency}${cutPart}${rushNote}${coinNote}${tail}。`,
    };
  }

  // 3) 有能做的交换,且对面场面有威胁 —— 先换
  //
  // 这里原来要求 `t.kills && t.survives`,等于只认「换完我还活着」的白吃。
  // 实测 2026-10-24 第 11 回合:我 5/3,对面 7/7 吸血 + 两道 3/5 嘲讽 + 0/1 复生。
  // 5/3 撞 3/5 嘲讽是同归于尽 —— 清掉一道墙、场攻减 3,值得,但被 survives 滤掉了;
  // 唯一「白吃」的是那个 0 攻的复生原型机。于是建议变成「先去撞那个 0 攻的」:
  // 挑了个最不疼的,还把这轮唯一的攻击浪费掉,下一轮他两道墙原封不动压过来。
  //
  // 现在按 score 挑,但设下限 —— 没意义的交换不如不给(见 TRADE_MIN_SCORE)。
  //
  // 还有一道闸:**血还厚的时候不要抢着换。**
  // 原来只要对面场攻 > 0 就优先交换。实测 2026-10-24 第 11 回合:我 28 血、对面 13 场攻
  // (余量 15),她给的是「5/3 打 3/5 嘲讽 → 换掉它,但我的也死」。那一手交换不亏也不赚,
  // 可是我把唯一的随从送掉了 —— 到第 13 回合就是「我场上空了」。
  // 余量够的时候,这轮该做的是铺场/抢血,随从留着下回合用。
  const seen = new Set<number>();
  const best = a.trades
    .filter((t) => t.kills && t.score >= TRADE_MIN_SCORE)
    .filter((t) => (seen.has(t.mine.id) ? false : (seen.add(t.mine.id), true)))[0];
  if (best && a.threat.enemyAttack > 0 && a.threat.margin <= TRADE_TRIGGER_MARGIN) {
    // 后面这句是 2026-11-20 补的：只推「撞墙」而不提手上的抽牌/变形/群伤，
    // 等于替他把「先把墙解决掉」这条路封了。见 openersInHand 的注释。
    return {
      kind: 'trade',
      face: 'determined',
      text: `先换:${best.text}。换完对面场攻剩 ${Math.max(0, a.threat.enemyAttack - best.theirs.atk)}。${openersInHand(a)}`,
    };
  }

  // 3.5) 非濒死但对手至少 2 只随从且有确定清场（能扫 ≥2 只并砍至少 5 场攻，或直接全清）：
  //      绝不能选会烧死自己、把自己烧进危险线、或烧光我方更大场面的自伤群伤。
  if (foe.minions.length >= 2) {
    const avoidList = opts.avoid ?? [];
    const avoidedName = (n: string) => avoidList.some((x) => x && (n === x || n.includes(x) || x.includes(n)));
    const bigClear = a.aoe.find((x) =>
      !x.spreads
      && !avoidedName(x.name)
      && x.selfHeroDamage < a.threat.myEffectiveHp
      && (x.selfHeroDamage === 0 || (a.threat.myEffectiveHp - x.selfHeroDamage) > CLOSE_CALL_MARGIN)
      && x.ownLostAtk < x.cutMin
      && x.clears.length >= 2
      && (x.cutMin >= 5 || x.clears.length === foe.minions.length));
    if (bigClear) {
      return {
        kind: 'trade',
        face: 'determined',
        text: `清场:${bigClear.text}。`,
      };
    }
  }

  // 4) 不用解场 —— 按费出牌
  //
  // 0 费牌不进推荐位:它不占费用、随时能打,列进来只是噪音(实测曾推荐「按费打:硬币」)。
  // 但**硬币的价值不能一起排掉** —— 它换的是 1 点水晶,能让本来差 1 费的牌打出来。
  // readHand 里已经把硬币算进预算,这里只负责把「要花硬币」这个代价标出来。
  const playable = a.hand.filter((c) => c.playable && c.cost > 0 && !c.isCoin);
  if (playable.length) {
    // 优先能当回合影响场面的:冲锋 > 突袭/嘲讽 > 其余
    //
    // **突袭在对面空场时等于白板。** 它只能打随从,没随从就只能站着等下回合,
    // 而且这类牌往往血很薄(3/1 之类),对手一个 2 费随从就换掉,净亏一张牌。
    // 实测第 3 回合:对面死亡骑士空场,建议把「红鳃锋颚战士 2费 3/1 突袭」排在
    // 「半稳定的传送门 2费」前面 —— 用户当场就问「让 3/1 站场对吗」。
    // 冲锋不受这个限制:它能直接打脸,空场照样有输出。
    const foeHasMinions = snapshot.opponent.minions.length > 0;
    const rank = (c: HandCardView) => {
      if (hasCost(c)) return 4;
      if (c.type === '法术' && /圣盾/.test(c.note) && snapshot.me.minions.length === 0) return 4;
      const fx = cardEffects(c.cardId);
      const pd = playDamage(c, 0, {
        comboActive: snapshot.me.comboActive,
        battlecry: makeBattlecryCtx(snapshot, opts.tracker?.me.hasDuplicates),
      });
      if (pd && pd.battlecry && pd.minionOnly && !foeHasMinions) return 3.5;
      if (/冲锋/.test(c.note)) return 0;
      if (/突袭/.test(c.note)) return foeHasMinions ? 0 : 3;
      // 战吼能确定点杀敌方随从：当回合即时收益高，提权到普通随从前面
      if (c.type === '随从' && pd && pd.battlecry && pd.ready && foeHasMinions
        && foe.minions.some((m) => !m.divineShield && m.health <= pd.damage)) {
        return 1.2;
      }
      if (selfKeyword(c.note, '嘲讽')) {
        if (a.threat.enemyAttack <= 0) {
          const body = cardBody(c.cardId);
          return c.cost <= 3 || (body?.atk ?? 0) >= 3 ? 2 : 3;
        }
        return a.threat.myEffectiveHp <= a.threat.enemyAttack * 2 ? 1 : 2;
      }
      // 灌注牌不视作纯空法术降权，适度提权帮助英雄技能升级
      if (fx.imbue) return 1.6;
      // 「把所有随从的生命值变为 1」这类牌不是普通填充。
      //
      // 生而平等打出去对自己的场面同样生效 —— 它要么是清场的前半手,要么是斩杀组合,
      // 但绝不是「这回合 2 费正好」。2026-11-03 那 8 局里它被推了 3 次,他一次没打,
      // 每次都改下 1 费随从或抽牌。
      // 判据只看「把全场改成某个值」,不看「+X/+X」那种增益 —— 增益是场面,该正常推。
      if (/(?:所有|全部)随从/.test(c.note) && /变为|变成/.test(c.note)) return 3;
      // 群伤牌留着清场,不当「按费打」的填充牌。它真能清掉东西的时候,
      // 会单独出现在「用 X 清场」那一条里;排进按费打就是教他拿清场资源换 1 点脸伤。
      // 实测 2026-10-24 第 10 回合:「按费打:…、麦芽岩浆(2费 伤害1群);麦芽岩浆打出去
      // 还能顺带 1 点直伤」—— 他当场反问「麦芽我要留着清场,打一点血没意义啊」。
      if (/群/.test(c.note)) return 3;
      // **不产场面的法术排在随从后面。**
      //
      // 「加速光环」是纯资源牌(每回合多一个临时水晶),牌面上不产任何场面。
      // 原来它和随从同为 rank 2,同费时靠先后顺序排 —— 它在手里排前面就被推出去。
      // 2026-11-03 那 8 局:「加速光环」被推了 4 次,他一次都没打,每次都改下随从。
      // 对面场上有东西的时候尤其明显 —— 那一手换不来任何场面,意味着这回合白过。
      //
      // 只在**对面有随从**时降权:对面空场时 ramp 是对的(先手铺资源),
      // 那时候它和随从的差别不大,不必特意压。
      // **抽牌什么时候让位。**
      //
      // 抽牌不是 plain spell（它产节奏），所以不走上面那条降权。但在**被压着打**的局面里，
      // 抽牌这一手等于把回合让出去 —— 抽进来的牌当回合用不上，场面一分没变。
      //
      // 2026-11-09 实测：她连着推「龙鳞军备」（1 费抽两张法术），他每次都改成下随从；
      // 她自己在复盘里写「早几轮该抢的是场面，不是抽牌」。**事后清醒、当下推抽牌**，
      // 说明这句判断没进到规则里。
      //
      // 三个条件同时成立才降权，缺一个都不动：
      //   · 对面两回合内能把我打死（场攻 × 2 ≥ 有效血）—— 真有压力，不是看着像；
      //   · 手上还有牌（≥4）—— 牌快空了那抽牌是真的在救命，不能压；
      //   · 这一手只抽不打（不含伤害/召唤）—— 「抽牌还顺带打一下」的牌是产场面的。
      if (drawShouldYield({
        note: c.note,
        enemyAttack: a.threat.enemyAttack,
        myEffectiveHp: a.threat.myEffectiveHp,
        handSize: snapshot.me.handCards.length,
      })) return 2.6;
      if (c.type === '法术' && foeHasMinions && plainSpellNote(c)) return 2.6;
      return 2;
    };
    // 核心牌不当普通按费牌打。
    //
    // 「按费打:德雷阿佳丝(3费)」—— 这句话的潜台词是「正好配上费用,现在下」。
    // 可那张牌是卡组的核心,要靠别的牌复制/触发它。它的价值不在「几点攻站场」,
    // 而在「等配合到位」。机械规则读不出这一层,只能靠配置告诉他。
    const keepNow = playable.filter((c) => c.keep);
    const spare = playable.filter((c) => !c.keep);

    // 能打的只剩核心牌 —— 这时候**不能**再写「按费打」。
    // 那三个字是在教他拆 combo:4 水晶手上只有那张 3 费的组合核心,「按费打:XX」
    // 读起来就是「打它正好」。可他要的是「这回合空着,等下一张牌」。
    //
    // 但也不能一句「宁可空过」完事:手上没牌不等于没动作。
    // 场上那些随从还能换、还能打脸,这时候叫他空过是错的建议。
    if (!spare.length) {
      const names = keepNow.map((c) => `${c.name ?? c.cardId}(${c.cost}费)`).join('、');
      const boardAtk = swings.reduce((n, x) => n + x, 0);
      const boardNote = boardAtk > 0 ? `场上还有 ${boardAtk} 点攻击能动,这回合让它们去干活;` : '';
      const idle = boardAtk > 0 ? '手上留着等下一张' : '宁可空过';
      return {
        kind: 'hold',
        text: `${threatHead(a.threat)},${boardNote}手上没别的牌可出,能打的只有你标的核心牌 ${names} —— 配合没到位就别拆,${idle};真被压住了再拿它换场面。`,
      };
    }

    // 同档、同费时比身材。
    //
    // 实测 2026-10-29 第 14 回合:手上有「日斑巨龙(6费 6/6 吸血)」和「风领主的管号(6费 3/0 风怒)」,
    // 两张都是 6 费、都不带嘲讽突袭冲锋,rank 并列 2 —— 排序退化成「保持原顺序」,
    // 于是 3/0 排在了 6/6 前面。他打了日斑巨龙,那才是对的。
    // 身材是白板价值最直接的代理:一点攻一点血都是实的。
    const bulk = (c: HandCardView) => {
      const b = cardBody(c.cardId);
      return b ? b.atk + b.health : null;
    };
    // 身高只在**两边都是随从**时才比身材。法术没有身材,拿 0 去比会被 3/0 的随从压掉 ——
    // 实测第 12 回合就这么翻车了一次:大力扣杀(6费 伤害4 +4/+4)输给了风领主的管号(6费 3/0 风怒)。
    //
    // 加一条:**只有「不产场面的法术」让位给随从**(加速光环那种纯资源牌)。
    // 产场面的法术(伤害 / 抽牌 / buff)不让 —— 上面那条教训就是它们被误压的先例。
    const bulkGap = (x: HandCardView, y: HandCardView) => {
      const a = bulk(x), b = bulk(y);
      if (a !== null && b !== null) return b - a;
      if (plainSpellNote(x) && b !== null) return 1;
      if (a !== null && plainSpellNote(y)) return -1;
      return 0;
    };
    const sorted = [...spare].sort((x, y) => rank(x) - rank(y) || y.cost - x.cost || bulkGap(x, y));

    // 首选落在「不值得当普通牌打」那一档(群伤留着清场 / 突袭空场 / 战吼没目标)时,
    // 不能说「按费打」。那三个字的意思就是「正好配上费用,现在下」。
    //
    // 实测 2026-10-29 第 3、5 回合,原文是:
    //   「按费打:阳炎清算(2费 伤害1群随从);阳炎清算的快枪现在没目标(对面空场),下去就是个白板」
    // 一句话里先劝他打,再告诉他打出去是白板 —— 他只能理解成「这条建议是凑数的」。
    // 排序是 rank 升序,所以首选 ≥ 3 就等于**全部**都不值得推。
    // **上界卡在 4 之前**:rank 4 是「有代价的牌」(暗石守卫 6/8 嘲讽),它不是白板 ——
    // 打出去照样站场,只是要先付代价,那条照旧走「按费打 + 写明代价」。
    //
    // **随从一律不进这一支**(2026-11-06)。这一支说的是「打出去没有效果,不如留着」,
    // 而随从打出去**永远有身材**:对面空场时一张 6/7 站着,下回合就是 6 点攻,
    // 跟「空过」不是一回事。原来的判据只按 rank 分档,于是
    // 「5 水晶 + 硬币、手上只有滑行者巨怪」被写成「不值得当普通牌打,这回合宁可空过」——
    // 那条建议等于让他白扔一回合。对面空场时墙的 rank 确实是 3(有意的,
    // 别在有别的牌时先把进攻让出去),但**只剩它**的时候,下它比空过好。
    // 也就是说:rank 管「先推哪条」,不该管「要不要出随从」。
    if (rank(sorted[0]) >= 3 && rank(sorted[0]) < 4 && sorted[0].type !== '随从') {
      const only = sorted[0];
      const why = pickDamageNote([only], snapshot).replace(/^;/, '');
      // 「为什么不该当普通牌打」有两种,不能共用一句:
      //   · 打出去**真的没用**(没目标 / 伤不到任何一只)→ 留着,这回合空过;
      //   · 打出去**能顺手清掉点东西**,但它是留给清场那一下的牌 → 把两边的账都摆出来,
      //     让他自己掂量。写成「能解掉 X;不值得当普通牌打」是先说能、再说别,自相矛盾。
      // 判据取自同一份 playDamage,不靠文案里有没有「能解掉」三个字。
      const pd = playDamage(only, snapshot.me.spellPower ?? 0);
      const killsSomething = Boolean(pd) && snapshot.opponent.minions.some(
        (m) => !m.divineShield && m.health <= pd!.damage,
      );
      const boardAtk = swings.reduce((n, x) => n + x, 0);
      const rest = boardAtk > 0 ? `场上 ${boardAtk} 点攻照常干活` : '这回合宁可空过';
      const head = `${threatHead(a.threat)},这回合手上能出的只有 ${only.name ?? only.cardId}(${only.cost}费${only.note ? ` ${only.note}` : ''})`;
      const tail = killsSomething
        ? '但它是留着清场那一下的牌,现在打就是当填充用,你自己掂量'
        : `不值得当普通牌打,${rest}`;
      return {
        kind: 'hold',
        text: `${head}${why ? ` —— ${why}` : ''};${tail}。`,
      };
    }

    // 第二张必须能在**剩下的水**里打出来。
    //
    // 「按费打:A、B」读起来就是「这两张都打」—— 实测第 7 回合 4 水晶,给了
    // 「德雷阿佳丝(3费)、淘金客(2费)」,3+2=5,这句话直接教人超费。
    // 用户当场说「4费回合不能上德雷阿佳斯」:他要的不是两张并列的候选,是一句能照做的账。
    const mana = manaBudget(snapshot.me);
    const first = sorted[0];
    let picks = [first];
    let left = mana - first.cost;
    for (const c of sorted.slice(1)) {
      if (picks.length >= 3) break;
      if (rank(c) >= 3) continue;
      if (c.needsCoin) continue;
      if (c.cost > left) continue;
      picks.push(c);
      left -= c.cost;
    }

    // 未激活连击时：若选出的手牌同时含连击牌与非连击启动牌，确保先打启动牌触发连击
    let comboOrderNote = '';
    if (!snapshot.me.comboActive) {
      const isCombo = (c: HandCardView) => cardEffects(c.cardId).combo;
      const comboPicks = picks.filter(isCombo);
      const starters = picks.filter((c) => !isCombo(c));
      if (comboPicks.length && starters.length && isCombo(picks[0])) {
        picks = [starters[0], ...picks.filter((c) => c !== starters[0])];
        comboOrderNote = `;先出${starters[0].name ?? starters[0].cardId}垫费激活连击,再打${comboPicks.map((c) => c.name ?? c.cardId).join('、')}`;
      } else if (comboPicks.length && !starters.length) {
        const hasExtraStarter = a.hand.some((c) => !c.isCoin && !isCombo(c) && !picks.includes(c) && c.cost <= left)
          || a.hand.some((c) => c.isCoin && c.cost <= left);
        if (hasExtraStarter) {
          comboOrderNote = `;出${comboPicks[0].name ?? comboPicks[0].cardId}前记得先垫一张低费牌/硬币触发连击`;
        }
      }
    }
    const lead = picks[0];

    const list = picks.map((c) => `${c.name ?? c.cardId}(${c.cost}费${c.needsCoin ? '·要打硬币' : ''}${plainSpellNote(c) ? '·资源牌' : ''}${c.note ? ` ${c.note}` : ''})`).join('、');
    let spareNote = '';
    if (left > 0) {
      const affordable = sorted.slice(1).filter(
        (c) => c.playable && !c.needsCoin && c.cost <= left && !picks.includes(c),
      );
      const why = !affordable.length
        ? '(没有更便宜的了)'
        : affordable.every((c) => rank(c) >= 3)
          ? '(剩下的都是留着清场的,不当填充)'
          : '(手上还有能打的,先打这几张)';
      spareNote = `,剩 ${left} 费${why}`;
    }
    const keepNote = keepNoteText(keepNow);
    const costlyIn = picks.filter((c) => hasCost(c));
    const costlyOut = sorted.filter((c) => hasCost(c) && !picks.includes(c));
    const costNote = costlyIn.length
      ? ';括号里那几条是要付的代价,没想好就换一张'
      : costlyOut.length
        ? `;${costlyOut.map((c) => c.name ?? c.cardId).join('、')} 这回合也打得出来,但要先付代价(卡面上写着),值不值你自己掂`
        : '';
    const damageNote = pickDamageNote(picks, snapshot);
    const spent = picks.reduce((n, c) => n + c.cost, 0);
    const wallNote = wallBreakerNote(a, snapshot, picks, spent);
    const handIndex = a.hand.indexOf(lead);
    const pick = lead.type === '随从' && handIndex >= 0
      ? {
        kind: 'play' as const,
        handIndex,
        cardId: lead.cardId,
        name: lead.name ?? lead.cardId,
        toFace: false,
      }
      : undefined;
    return {
      kind: 'develop',
      text: `${threatHead(a.threat)},按费打:${list}${spareNote}${keepNote}${wallNote}${costNote}${comboOrderNote}${damageNote}${facePushNote(snapshot)}${sneakyNote(snapshot)}${prepareNote(a.hand, snapshot.me, spent)}。`,
      ...(pick ? { pick } : {}),
    };
  }

  // 4.5 正经牌一张都打不出,只剩 0 费牌(硬币之类)
  // 这里**不排硬币**:这一条说的是「正经牌一张都打不出,只剩零费动作」,
  // 硬币确实是能做的动作之一,文案也不叫「按费打」,只是提醒它留着更值。
  const zeroCost = a.hand.filter((c) => c.playable && c.cost === 0);
  if (zeroCost.length) {
    return {
      kind: 'develop',
      text: `${threatHead(a.threat)},手上的牌这回合都打不出(${snapshot.me.mana} 水晶);`
        + `${zeroCost.map((c) => c.name ?? c.cardId).join('、')} 可以现在换费用,也可以留着给关键回合。`,
    };
  }

  // 5) 什么都做不了
  if (swings.length === 0 && !playable.length) {
    // 但「没事干」不等于「没动作」:剩水可以预备掉换成下回合的折扣。
    // 这是预备牌唯一的用处 —— 它不该被当成普通手牌躺着。
    return { kind: 'idle', text: `${threatHead(a.threat)},这回合没牌可打也没随从能动${prepareNote(a.hand, snapshot.me)},过。` };
  }
  // 前面几条都不成立,不等于局面没事 —— 威胁要照说。
  // 原来这里只写「没有必须做的事,按你的节奏来」:对面 13 场攻里有 7 点吸血压着,
  // 这句话读起来像是「随便打」。
  return { kind: 'idle', text: `${threatHead(a.threat)},没有必须做的事,水晶 ${snapshot.me.mana},按你的节奏来。` };
}

/**
 * 「核心牌留着」那句,接在「按费打」后面。
 *
 * 存在的理由是一句错误建议:第 7 回合 4 水晶,原文写「按费打:德雷阿佳丝(3费)」——
 * 从费用看没毛病,可那张牌是他卡组的核心,要靠别的牌复制/触发,当场扔出去只是
 * 一个 6/4 的靶子。他的原话:「这个牌是我卡组的核心牌,要让其他卡复制或者触发这张卡的效果的」。
 *
 * 只说一句「留着」,不替他决定 —— 下回合他可能有自己的打算。
 * 「能打的只剩核心牌」那种真为难的时刻不走这里,见 `hold` 分支。
 */
function keepNoteText(keepNow: HandCardView[]): string {
  if (!keepNow.length) return '';
  const names = keepNow.map((c) => c.name ?? c.cardId).join('、');
  // 措辞不能写「别当普通随从扔」—— 核心牌也可能是法术或武器,那就说不通了
  return `;${names} 是你标的核心牌,这回合先留着等配合,别当普通牌打掉`;
}

/**
 * 剩水往哪放。
 *
 * 手上有两类牌可以把「这回合花不掉的水」换成东西,而机械建议本来只会说「过」:
 *   · 预备牌:花掉全部剩水,换等量 +1 的减费(下次更便宜)
 *   · 可交易牌:花 1 费洗回牌库再抽一张(把打不出的废牌换掉)
 *
 * 两条都只在「这张牌这回合打不出 + 手里还有水」时提 —— 打得出就不提,
 * 因为这两个操作都会占用这回合的行动,能打的时候用是纯亏。
 * 剩水 0 提不了(两个操作都至少 1 点法力)。
 */
function prepareNote(hand: HandCardView[], side: SideState, spent = 0): string {
  // **剩水要用「这回合还剩多少」,不是回合总水晶。**
  // 原来直接拿 `side.mana`,于是在「按费打:A(1费),剩 2 费」后面接一句
  // 「还剩 3 点水晶,可以把黑骑士交易掉」—— 同一句话里两个数差了一费。
  // 2026-11-04 复现确认。
  const spare = side.mana - spent;
  if (spare < 1) return '';
  // 打不出 = 按**这回合总水晶**就够不着（`!c.playable`），不是「按现在剩水够不着」。
  // 这两种不一样：一张 3 费牌在 5 水晶回合是打得出的，只是按费打之后剩 2 费打不动它 ——
  // 那时候劝他预备/交易，等于把一张本来能用的牌锁起来。实测（测试抓到的）：
  // 「按费打:迪菲亚私运者(3费)…还剩 2 点水晶,可以把迪菲亚私运者预备掉」—— 同一句话里
  // 一边劝打一边劝锁。
  const blocked = (c: HandCardView) => !c.playable;
  const pick = hand.find((c) => c.prepare && !c.prepared && blocked(c) && c.cost > 0);
  if (pick) {
    // 实际减费要封顶:规则写的是「剩余法力多于降到 0 所需的量时,只花到 0 为止」。
    // 所以 3 费的牌配 5 点剩水,不是「便宜 6 费」,是直接变 0 费。
    const cut = Math.min(spare + 1, pick.cost);
    const after = pick.cost - cut;
    const gain = after === 0 ? `从 ${pick.cost} 费直接降到 0 费` : `从 ${pick.cost} 费降到 ${after} 费`;
    // 不说「这些水晶全花掉」—— 降到 0 时只花掉一部分,说死了就是错数
    return `;还剩 ${spare} 点水晶,可以把${pick.name ?? pick.cardId}预备掉:${gain},代价是这回合不能再打它`;
  }

  // 没有预备牌,再看看可交易的:花 1 费把一张打不出的牌换掉。
  // 只提一张 —— 一句话里塞两张牌就成播报了。
  //
  // 「换一张」不是终点:换来的那张只要费用够,当回合就能打。原来那句只写到
  // 「它这回合反正打不出来」,读起来像认输 —— 交易的价值恰恰是**把它换成能用的**。
  const trade = hand.find((c) => c.tradeable && blocked(c) && c.cost > 0);
  if (trade) {
    const rest = spare - 1;
    return `;还剩 ${spare} 点水晶,可以花 1 费把${trade.name ?? trade.cardId}交易掉换一张 —— 它这回合反正打不出来${rest > 0 ? `,换来的那张 ${rest} 费以内当回合就能打` : ''}`;
  }
  return '';
}

/**
 * 这张牌打出去要先付代价。
 *
 * 机械规则只看得懂「费」——它算不出「这张牌要弃两张才下得来」。
 * 实测 2026-10-24 第 7 回合:4 水晶手上就一张暗石守卫(4 费 6/8 嘲讽),
 * 建议写「按费打:暗石守卫(4费 6/8 嘲讽 摧毁)」—— 他当时没锻造过,
 * 打出去必须二选一:弃两张牌,或者毁掉一个法力水晶。建议里一个代价的字都没有。
 *
 * 判据收得窄,宁可漏报:只认**明确对自己不利**的写法。
 * 「摧毁」单独出现不算 —— 酸性沼泽软泥怪是「战吼 摧毁」对手武器,那是好事;
 * 「弃掉抽到的所有随从牌」也不算,那是收益的一部分。
 */
const COSTLY_NOTE = /抉择|弃手牌|弃\s*\d+\s*张牌|摧毁你的|毁\s*\d+\s*个法力水晶/;

function hasCost(card: HandCardView): boolean {
  // 已锻造 = 牌面上的代价已经付过。暗石守卫锻造之后就是一张干净的 6/8 嘲讽,
  // 这时候还提醒「打出去要弃两张牌」,是把她自己的账算错。
  if (card.forged) return false;
  return COSTLY_NOTE.test(card.note);
}

/**
 * 「对面场攻 N」这个标签。
 *
 * 场攻里混了两样**在场上数不出来**的东西:武器/英雄攻击力(看英雄底下那把刀能看出来,
 * 但不显眼)和英雄技能那 1–2 点(完全看不见)。直接报总数,他会拿自己数出来的随从去对,
 * 对不上就以为她说错了 —— 实测 2026-10-24:对面场上两个 2 攻随从,她说「对面场攻 3」。
 *
 * 工具回执那条出口(`threatText`)本来就是拆开写的,这里补上,两条出口才对得上。
 */
function attackLabel(t: ThreatInfo): string {
  // 打不出来的随从(无法攻击/休眠)单说一句:那只 4/5 杵在场上、场攻却只有技能那 1 点,
  // 不点明他会以为数字算漏了
  const idle = t.idleAttack > 0 ? `,另有 ${t.idleAttack} 点打不出来(无法攻击/休眠)` : '';
  if (t.heroPowerDamage <= 0 && t.heroAttack <= 0) return `对面场攻 ${t.enemyAttack}${idle}`;
  const parts: string[] = [];
  if (t.minionAttack > 0) parts.push(`随从 ${t.minionAttack}`);
  if (t.heroAttack > 0) parts.push(`武器/英雄 ${t.heroAttack}`);
  if (t.heroPowerDamage > 0) parts.push(`技能 ${t.heroPowerDamage}`);
  return `对面场攻 ${t.enemyAttack}(${parts.join(' + ')})${idle}`;
}

/**
 * 铺场建议开头那句威胁评价。
 *
 * 以前是硬编码「对面场攻 N 不足为惧」——只要不到斩杀线就这么说。
 * 实测第 20 回合:我 17 血、对面场攻 14,差 3 点,它还是说「不足为惧」。
 * 现在按余量分三档说话,把「还差多少」摆到明面上。
 */
function threatHead(t: ThreatInfo): string {
  // 有嘲讽就得说,哪怕对面一点伤害都没有 —— 墙挡的是**我**的进攻。
  // 实测第 3 回合对面两个 0/3 嘲讽,系统只说「对面打不到我」:那是真的,
  // 但他也打不进去,而这句话会让他以为可以随便打脸。
  const wall = t.tauntCount > 0
    ? `;不过对面有 ${t.tauntCount} 个嘲讽挡着(共 ${t.tauntHealth} 血),你的攻击得先过墙`
    : '';

  // 武器单说一句。它挂在英雄身上、不占场面:0 攻的武器不进敌人的场攻,
  // 但它的效果照样每回合生效(黑暗帝国之刃 0/3,每回合扣疲劳)。
  // 所以「对面打不到我」这句在有武器的时候不能说 —— 换个说法,把武器摆到明面上。
  //
  // 「无法攻击英雄」的武器(无穷之手)另说:它挂着 4 点攻击力,但那 4 点只砍随从。
  // 说成「也算在场攻里」就是说我下回合要挨 4 点,而实际一点都挨不到。
  const gear = !t.foeWeapon
    ? ''
    : t.foeWeapon.hitsHero === false
      ? `;他那把${t.foeWeapon.name}(${t.foeWeapon.atk}/${t.foeWeapon.durability})写着「无法攻击英雄」,只能砍随从,打不到你的脸`
      : t.foeWeapon.atk > 0
        ? `;他那把${t.foeWeapon.name}(${t.foeWeapon.atk}/${t.foeWeapon.durability})也算在场攻里`
        : `;他还挂着把${t.foeWeapon.name}(0/${t.foeWeapon.durability}),0 攻打不出伤害,效果不算在场攻里`;

  // 疲劳钟要说在明面上,而且要带「挡不住」这半句 ——
  // 「还有点余量」会让他以为靠架墙拖一拖就能过,可疲劳不认嘲讽。
  const clock = t.fatigueClock
    ? `;疲劳在追杀:下一轮第 ${t.fatigueClock.next} 层,之后每轮更狠,约 ${t.fatigueClock.turns} 个回合就能把你清空 —— 架墙挡不住它`
    : '';

  if (t.enemyAttack === 0) {
    const base = t.minionAttack === 0 && t.heroAttack === 0 && (!t.foeWeapon || t.foeWeapon.hitsHero === false)
      ? '对面打不到我'
      : '对面这回合打不出攻击';
    // 场上还杵着打不出来的随从(无法攻击/休眠):数字是对的,但一只 4/5 摆在那里
    // 却只说「打不到我」,读的人会以为漏看了 —— 点名一句,省得他跟你对不上账
    const idle = t.idleAttack > 0 ? `;场上那 ${t.idleAttack} 点攻击力打不出来(无法攻击/休眠),不用管` : '';
    return base + idle + gear + clock + wall;
  }

  // 吸血必须单列,它不改「我掉多少血」,改的是「这轮换完谁领先」。
  //
  // 实测 2026-10-24 第 11 回合:对面 13 场攻里有 7/7 破命之龙带吸血,建议只写
  // 「对面场攻 13,还压不到我」。数字全对,可他 28 血对 18 血的那 10 点领先,
  // 被那一轮打成 15:25 —— 吸血鬼就是「抢血抢不过」四个字。
  const drain = t.lifestealAttack > 0
    ? `,其中 ${t.lifestealAttack} 点是吸血(打你会回同样多的血,跟他换血不划算)`
    : '';

  const label = attackLabel(t);
  if (t.margin > 10) return `${label}${drain},还压不到我${gear}${clock}${wall}`;
  if (t.margin > CLOSE_CALL_MARGIN) return `${label}${drain},我 ${t.myEffectiveHp} 血,还有点余量但别拖${gear}${clock}${wall}`;
  return `${label}${drain},我 ${t.myEffectiveHp} 血,只差 ${t.margin} 点就危险${gear}${clock}${wall}`;
}

/**
 * 解不掉的时候,这回合做什么能多活一会儿。
 *
 * 判据就一条:**能不能吃掉对面一次攻击**。圣盾、嘲讽、召唤都算(召唤出来的随从
 * 下回合能挡),纯粹的身材不算 —— 一个 3/3 面对 7/7 什么也挡不住。
 *
 * 这一段存在的理由:只报「还差 N 点」等于告诉他认输。真实对局里第 20 回合
 * 场上空场、手上两张「坦克机械师 2/1 圣盾亡语召唤」,那是能挡一刀的牌,
 * 上一版完全没提。
 */
/**
 * 挡不挡得住。
 *
 * 嘲讽**每只只能吃掉一次攻击**。对面 5 个攻击者共 31 点、我 3 血时,
 * 挡掉最大那只还剩 23 点打脸 —— 这一手挡了等于没挡,该说的是「守不住」，
 * 不是「能吃掉对面一次攻击」。
 *
 * 风怒按两次攻击算(挡掉一次,另一次照样打脸)。
 */
function wallOutlook(snapshot: GameSnapshot, threat: ThreatInfo, extraBlocker: boolean) {
  const attackers: number[] = [];
  for (const m of snapshot.opponent.minions) {
    // 打不出来的(无法攻击/休眠)不是攻击者:算进来会把「挡掉几只还剩多少」全说错
    if (m.atk <= 0 || m.frozen || m.cantAttack) continue;
    attackers.push(m.atk);
    if (m.windfury) attackers.push(m.atk);
  }
  attackers.sort((x, y) => y - x);
  const mine = snapshot.me.minions.filter((m) => m.taunt && m.health > 0).length;
  const blocks = Math.min(mine + (extraBlocker ? 1 : 0), attackers.length);
  const total = attackers.reduce((sum, x) => sum + x, 0);
  const rest = attackers.slice(blocks).reduce((sum, x) => sum + x, 0);
  return { count: attackers.length, blocks, total, rest, hp: threat.myEffectiveHp };
}

/**
 * 脸被墙挡住的时候,手上有没有「拆墙」这一手。
 *
 * 2026-11-03 第 18 回合:对面三面嘲讽共 21 血,建议说的是「你的攻击得先过墙」,
 * 然后照常按费下随从。这句话没错,但只报了一半 —— 过墙既有代价,也有办法;
 * 系统当时只说了代价,办法那半句一直是空的。
 *
 * 只在**打不到脸**的时候提(`lethal.faceAtk == 0`)。打得进去还教过墙,是废话。
 */
function wallBreakerNote(a: Advice, snapshot: GameSnapshot, picks: HandCardView[], spent: number): string {
  const taunts = snapshot.opponent.minions.filter((m) => m.taunt && m.health > 0);
  if (!taunts.length) return '';
  if (a.lethal.faceAtk > 0) return '';
  const inPicks = new Set(picks.map((c) => c.name ?? c.cardId));
  // 已经在「按费打」里推过的牌不算 —— 那句话会变成「打完这些再过墙」,读起来像能全做。
  const combo = aoeCombos(snapshot).find((c) => c.clearsTaunt && c.names.every((n) => !inPicks.has(n)));
  if (!combo) return '';
  const budget = manaBudget(snapshot.me);
  return spent + combo.cost <= budget
    ? `;顺带还能过墙:${combo.text}`
    : `;这回合想拆墙就得改打法(和上面加起来超费,二选一):${combo.text}`;
}

/**
 * 削不掉的时候给一句「还能怎么守」。
 *
 * 这里只认**嘲讽**。原来把「圣盾 / 召唤 / 亡语」也算进来,那是错的 ——
 * 没有嘲讽的随从挡不住任何攻击,对面照样打脸。
 * 实测 2026-10-24 第 18 回合:手上那张羁押装置是 6/6 亡语 磁力 召唤,一个嘲讽都没有,
 * 建议却写「能吃掉对面一次攻击」。他照着打出去,被剩下四只直接打死,
 * 回头只说了一句「9 费回合……架墙也没用了」。
 */
function defensivePlays(a: Advice, cut: number, snapshot: GameSnapshot): string {
  const taunts = a.hand.filter((c) => c.playable && selfKeyword(c.note, '嘲讽'));
  if (!taunts.length) {
    // 没嘲讽就别许诺墙。铺出来的随从只是身子,拦不住打脸 ——
    // 但也不能只报噩耗,得告诉他这回合还剩什么事可做。
    //
    // **吸血不是墙,是回血**:它拦不住打脸,但能把血拉回来,在「血不够」的处境里同样是活路。
    // 实测 2026-10-24 第 17 回合:我 19 血、对面 17 点场攻、只差 2 点就死,手上正好一张
    // 步移山丘(9 费 4/16 突袭 吸血)。她一句「别指望挡,直接抢脸」把整张牌略过了 ——
    // 那张牌落地打一只随从就回 4 血,还留个 16 血的肉盾。
    const drain = a.hand.filter((c) => c.playable && selfKeyword(c.note, '吸血'));
    if (drain.length) {
      const d = drain[0];
      const atk = Number(/^(\d+)\//.exec(d.note ?? '')?.[1] ?? 0);
      return `手上没有嘲讽牌,拦不住打脸;但 ${d.name} 带吸血${atk ? `,换掉一只随从就能回 ${atk} 血` : ''} —— 挡不住也得先把血拉回来`;
    }
    // **几张群伤叠起来,常常才是真正的解。**
    //
    // 2026-11-03 第 20 回合:对面 5 个随从(3 面嘲讽、场攻 29),我 20 血,手上没有嘲讽牌。
    // 系统的结论是「直接抢脸」,而真正的答案是奉献 + 棱彩光束 + 两张阳炎清算叠 7 点、9 费,
    // 正好清掉 5/7、5/5、5/7。那一手她自己调工具、手算出来的 —— 系统一个字没提,
    // 等于把最要紧的一步留给了她的临场发挥。
    //
    // 只在**比单张更好**时才说(`combo.cut > cut`),否则和前面那句「能削 N 点」重复。
    const combo = aoeCombos(snapshot).find((c) => c.cut > cut && c.cut >= 3);
    if (combo) {
      return `手上没有嘲讽牌,拦不住打脸;但手上这几张群伤能叠起来清:${combo.text}`;
    }
    // **对面有墙的时候,不许说「直接抢脸」。**
    // 2026-11-03 第 20 回合的原文是「手上没有嘲讽牌,铺出来的拦不住打脸 —— 这回合
    // 别指望挡,直接抢脸」。当时对面 5 个随从里有 3 个嘲讽(共 21 血),抢脸物理上
    // 打不到 —— 她念完这句,自己又去调 hearthstone_advice 重算,才改口
    // 「先别抢脸,抢不到——三面墙挡着呢」。也就是说这条文案让她先说错、再自己纠正,
    // 用户听到的第一句就是错的。
    //
    // 「挡不住」和「打不进去」是两个方向,不能共用一句:
    // 前者说的是他的攻击会落到我脸上,后者说的是我的攻击进不去。
    const walls = snapshot.opponent.minions.filter((m) => m.taunt && m.health > 0);
    if (walls.length) {
      const wallHp = walls.reduce((n, m) => n + Math.max(0, m.health), 0);
      const thinnest = Math.min(...walls.map((m) => Math.max(1, m.health)));
      const myAtk = swingsOf(snapshot.me).reduce((n, x) => n + x, 0);
      // 说得出的只能是算得准的:他几面墙、共多少血、最薄的那面多少 —— 都是场上读数。
      // 能不能削掉一面要看攻击力够不够,不够就直说不够,别画饼。
      const reach = myAtk <= 0
        ? `你场上没有能动的攻击`
        : myAtk >= thinnest
          ? `你 ${myAtk} 点攻击够削掉最薄那面(${thinnest} 血),削一面他下回合就少一个攻击者`
          : `你 ${myAtk} 点攻击连最薄那面(${thinnest} 血)都削不掉,这回合只能先挨`;
      return `手上没有嘲讽牌,拦不住打脸;他 ${walls.length} 面嘲讽共 ${wallHp} 血挡在中间,脸这回合打不到 —— ${reach}`;
    }
    return '手上没有嘲讽牌,铺出来的拦不住打脸 —— 这回合别指望挡,直接抢脸';
  }

  const view = wallOutlook(snapshot, a.threat, true);
  if (view.count > 0 && view.rest >= view.hp) {
    return `守不住:他 ${view.count} 个攻击者共 ${view.total} 点,挡掉 ${view.blocks} 只还剩 ${view.rest} 点打脸,你 ${view.hp} 血 —— 这一手墙挡了也救不了,别把水晶花在上面`;
  }

  const top = taunts[0];
  // 一张都削不掉和「削了一部分」是两回事,话说得不一样
  const lead = cut > 0 ? '剩下的靠守' : '解不掉就守一下';
  const verdict = view.rest === 0
    ? '全挡住,一只都打不到脸'
    : `挡完还剩 ${view.rest} 点打脸,你 ${view.hp} 血扛得住`;
  return `${lead}:${top.name ?? top.cardId} 挂上嘲讽能吃掉一只攻击者,${verdict}`;
}

/**
 * 对面场上「不只是身材」的随从。
 *
 * 威胁评估算的是攻击力,所以 0 攻的随从一律显示「没有威胁」。但炉石里真正难缠的
 * 往往就是这种:0/1 复生 + 亡语给手牌 +1/+1、1/2 剧毒、0/3 嘲讽墙。
 *
 * 实测:第 3 回合对面两个 0/3 嘲讽,系统只说「对面打不到我」——
 * 那是真的,可他也没法打进去。第 5 回合那个 0/1 复生原型机同样被算成 0 威胁。
 *
 * 这里只收「会改变怎么打」的效果,纯身材不报 —— 报多了就成了念牌面。
 */
export interface NotableThreat {
  minion: MinionView;
  /** 为什么值得留意,按重要性排。 */
  reasons: string[];
}

export function notableThreats(snapshot: GameSnapshot): NotableThreat[] {
  const out: NotableThreat[] = [];
  for (const m of snapshot.opponent.minions) {
    const fx = cardEffects(m.cardId);
    // 运行时字段不全,卡面摘要要一起看:实测「不稳定的原型机」场上 reborn=false、
    // fx.deathrattle=0(因为它的亡语是给手牌 +1/+1,不是伤害),两个来源都没认出来,
    // 可摘要里明明写着「0/1 复生 亡语 +1/+1」。
    const note = cardNote(m.cardId);
    const tokens = note.split(/\s+/).filter(Boolean);
    const reasons: string[] = [];

    if (m.poisonous || /剧毒/.test(note)) reasons.push('剧毒,碰到就死');
    if (m.taunt) reasons.push('嘲讽墙');
    // 亡语:伤害型给出数字,其他效果把摘要内容带出来
    if (fx.deathrattle > 0) {
      reasons.push(`亡语还会打 ${fx.deathrattle}`);
    } else {
      const at = tokens.indexOf('亡语');
      if (at >= 0) {
        const detail = tokens[at + 1];
        const isKeyword = !detail || /^(嘲讽|圣盾|复生|战吼|吸血|剧毒|风怒|突袭|冲锋|潜行)$/.test(detail);
        reasons.push(isKeyword ? '有亡语' : `亡语(${detail})`);
      }
    }
    if (m.reborn || /复生/.test(note)) reasons.push('复生,打死了会站起来');
    if (m.lifesteal || /吸血/.test(note)) reasons.push('吸血');
    if (m.divineShield && reasons.length) reasons.push('圣盾');
    if (reasons.length) out.push({ minion: m, reasons });
  }
  return out;
}

/**
 * 「对面 0 攻、但打起来有代价」的随从,压成半句话接在建议后面。
 *
 * 只收亡语/复生/剧毒这三种 —— 它们不改变"对面打我多少血",但决定"我要不要现在就处理"。
 * 实测第 5 回合对面那个 0/1 原型机(复生 + 亡语给手牌 +1/+1),数值上是 0 威胁,
 * 拖到后面就是白送对面一手大牌。
 */
function sneakyNote(snapshot: GameSnapshot): string {
  const sneaky = notableThreats(snapshot)
    // 只挑低攻的。高攻随从的威胁 threatInfo 已经算在场攻里了,
    // 再对它说「早处理」是废话 —— 这里补的是「数值上看不见」那一类。
    .filter((n) => n.minion.atk <= 2)
    .map((n) => ({
      name: minionLabel(n.minion),
      // 原理由写得比较长(「复生,打死了会站起来」),塞进一句话里只留关键词
      why: n.reasons
        .filter((r) => /复生|亡语|剧毒/.test(r))
        .map((r) => r.replace(/,\s*打死了会站起来$/, '').replace(/剧毒,碰到就死/, '剧毒')),
    }))
    .filter((x) => x.why.length);
  if (!sneaky.length) return '';
  const one = sneaky[0];
  const more = sneaky.length > 1 ? ` 等 ${sneaky.length} 个` : '';
  return `;另外 ${one.name}${more} 带${one.why.join(' + ')},早处理比晚处理好`;
}

/**
 * 挑一组最省的解场动作(最多两步),并算清总共能削掉多少场攻。
 *
 * 优先级:单随从换掉且不死 > 合力换掉且损失小 > 群体伤害。
 * 只挑能真减少对方攻击力的,磨血不算。
 */
type RemovalPick = {
  text: string;
  cut: number;
  cutSafe: number;
  heal: number;
  selfHeroDamage: number;
  uncertain: boolean;
};

function pickRemoval(a: Advice): RemovalPick {
  const isSafe = (opt: { cutSafe: number; heal: number; selfHeroDamage: number }): boolean => {
    const hpAfter = a.threat.myEffectiveHp + opt.heal - opt.selfHeroDamage;
    const rem = Math.max(0, a.threat.enemyAttack - opt.cutSafe);
    return hpAfter > 0 && (rem <= 0 || (hpAfter - rem) > CLOSE_CALL_MARGIN);
  };

  const seen = new Set<number>();
  const clean = a.trades
    .filter((t) => t.kills && t.survives)
    .filter((t) => (seen.has(t.mine.id) ? false : (seen.add(t.mine.id), true)));

  let cleanOpt: RemovalPick | null = null;
  if (clean.length) {
    const first = clean[0];
    let text = `${minionLabel(first.mine)} 换掉 ${minionLabel(first.theirs)}`;
    let cut = first.theirs.atk;
    let heal = first.mine.lifesteal ? Math.min(first.mine.atk, first.theirs.health) : 0;
    const second = clean[1];
    if (second) {
      text += `、再用 ${minionLabel(second.mine)} 换掉 ${minionLabel(second.theirs)}`;
      cut += second.theirs.atk;
      if (second.mine.lifesteal) heal += Math.min(second.mine.atk, second.theirs.health);
    }
    cleanOpt = { text, cut, cutSafe: cut, heal, selfHeroDamage: 0, uncertain: false };
    if (isSafe(cleanOpt)) return cleanOpt;
  }

  const combined = a.combined.filter((c) => c.lost <= 1)[0];
  const combinedOpt: RemovalPick | null = combined
    ? {
      text: `${combined.steps.join(' + ')} 解掉 ${minionLabel(combined.target)}`,
      cut: combined.target.atk,
      cutSafe: combined.target.atk,
      heal: 0,
      selfHeroDamage: 0,
      uncertain: false,
    }
    : null;
  if (!cleanOpt && combinedOpt && isSafe(combinedOpt)) return combinedOpt;

  // 放出去直接烧死自己的 AOE 绝不作为求生方案
  const aoe = a.aoe.find((x) => x.selfHeroDamage < a.threat.myEffectiveHp);
  const aoeOpt: RemovalPick | null = aoe
    ? {
      text: aoe.spreads
        ? `用 ${aoe.name} 打一下(伤害随机分给随从,最多清掉 ${aoe.clears.length} 只,不保证)`
        : `用 ${aoe.name} 清场`,
      cut: aoe.cutMax,
      cutSafe: aoe.cutMin,
      heal: aoe.heal,
      selfHeroDamage: aoe.selfHeroDamage,
      uncertain: aoe.spreads,
    }
    : null;

  const single = a.singleRemovals[0];
  const singleOpt: RemovalPick | null = single
    ? {
      text: single.kind === 'heal'
        ? `用 ${single.name} 回血/叠甲`
        : `用 ${single.text}`,
      cut: single.cutSafe,
      cutSafe: single.cutSafe,
      heal: single.heal,
      selfHeroDamage: 0,
      uncertain: false,
    }
    : null;

  // 若前面白吃/合击救不了命，而 AOE 或确定单解能直接脱离斩杀线，优先选用救命解
  if (aoeOpt && !aoeOpt.uncertain && isSafe(aoeOpt)) return aoeOpt;
  if (singleOpt && isSafe(singleOpt)) return singleOpt;

  if (cleanOpt) return cleanOpt;
  if (combinedOpt) return combinedOpt;

  // 在 AOE 和单解之间择优：确定解（非随机且确定削攻/净回血更大）优于只给上界的随机 AOE
  if (aoeOpt && singleOpt) {
    if (aoeOpt.uncertain && singleOpt.cutSafe > 0) return singleOpt;
    const aoeScore = aoeOpt.cutSafe + aoeOpt.heal - aoeOpt.selfHeroDamage;
    const singleScore = singleOpt.cutSafe + singleOpt.heal;
    if (!aoeOpt.uncertain && aoeScore >= singleScore) return aoeOpt;
    return singleScore > aoeScore ? singleOpt : aoeOpt;
  }
  if (aoeOpt) return aoeOpt;
  if (singleOpt) return singleOpt;

  const drain = a.aoe.find((x) => x.heal > 0 && x.selfHeroDamage < a.threat.myEffectiveHp);
  if (drain) {
    return {
      text: `用 ${drain.name} 回血`,
      cut: 0,
      cutSafe: 0,
      heal: drain.heal,
      selfHeroDamage: drain.selfHeroDamage,
      uncertain: false,
    };
  }

  return { text: '', cut: 0, cutSafe: 0, heal: 0, selfHeroDamage: 0, uncertain: false };
}

/**
 * 给模型看的局面摘要。
 *
 * 只放**事实**,不放结论 —— 结论让它自己下,否则它只会复述我给的那句。
 */
export function buildModelPrompt(s: GameSnapshot, opts: AdviceOptions = {}): string {
  const keep = parseKeepCards(opts.keepCards);
  const board = (x: SideState) => (x.minions.length
    ? x.minions.map((m) => `${minionLabel(m)} ${m.atk}/${m.health}${m.taunt ? '嘲讽' : ''}${m.divineShield ? '圣盾' : ''}${m.windfury ? '风怒' : ''}${m.poisonous ? '剧毒' : ''}${m.lifesteal ? '吸血' : ''}${m.reborn ? '复生' : ''}${m.frozen ? '冻结' : ''}`).join('、')
    : '空场');
  let keptInHand = 0;
  const hand = (s.me.handCards ?? []).map((c) => {
    const info = describeCard(c.cardId);
    const kept = isKept(c.cardId, info?.name ?? null, keep);
    if (kept) keptInHand += 1;
    const note = handNote(c.cardId, c.prepared === true, c.darkGift);
    return `${info?.name ?? c.cardId}(${c.cost}费${note ? ` ${note}` : ''}${kept ? ',核心牌' : ''})`;
  }).join('、');

  const statusExtras = [
    s.me.comboActive ? '连击已激活' : '',
    (s.me.imbueCount ?? 0) > 0
      ? `灌注${s.me.imbueCount ?? 0}次${s.me.heroPower?.name ? `(${s.me.heroPower.name})` : ''}`
      : '',
  ].filter(Boolean).join(' · ');

  const lines = [
    `第 ${s.turn} 回合,${s.isMyTurn ? '轮到我' : '轮到对手'},我的水晶 ${s.me.mana}/${s.me.manaMax}${statusExtras ? ` · ${statusExtras}` : ''}`,
    `我:${s.me.heroClass || '职业未知'} ${s.me.health} 血${s.me.armor ? ` ${s.me.armor} 护甲` : ''};场面 ${board(s.me)};手牌 ${s.me.handCount} 张${hand ? `(${hand})` : ''};牌库 ${s.me.deckCount} 张`,
    `对手:${s.opponent.heroClass || '职业未知'} ${s.opponent.health} 血${s.opponent.armor ? ` ${s.opponent.armor} 护甲` : ''};场面 ${board(s.opponent)};手牌 ${s.opponent.handCount} 张(看不到);牌库 ${s.opponent.deckCount} 张`,
  ];
  if (s.me.spellPower) lines.push(`我场上法术伤害 +${s.me.spellPower}`);

  const myMinions = s.me.minions.length ? s.me.minions : [];
  const usableBuffs = (s.me.handCards ?? [])
    .map((c) => lookupBuffCard(c.cardId))
    .filter((b): b is NonNullable<ReturnType<typeof lookupBuffCard>> => !!b && b.atk > 0 && b.cost <= s.me.mana);
  if (usableBuffs.length && myMinions.length) {
    const best = [...myMinions].sort((a, b) => b.atk - a.atk)[0]!;
    const first = usableBuffs[0]!;
    lines.push(
      `手牌里有 buff:${usableBuffs.slice(0, 2).map((b) => `${b.name}(${b.cost}费 +${b.atk}${b.health > 0 ? `/+${b.health}` : '攻'})`).join('、')}`
      + ` —— 贴给${minionLabel(best)}能变成 ${best.atk + first.atk}/${best.health + first.health}。`,
    );
  }
  if (opts.tracker && opts.tracker.deckSource !== 'none') {
    const m = opts.tracker.me;
    const leftTop = m.remainingDeck.slice(0, 6).map((x) => `${x.name}×${x.left}(${Math.round(x.drawProb * 100)}%)`).join('、');
    lines.push(`记牌器(${m.deckCount}张余):${leftTop || '已空'}${m.hasDuplicates === false ? ';牌库无重复(宇宙可用)' : ''}`);
    if (opts.tracker.opponent.keyCardsUsed.length) {
      lines.push(`对手已交:${opts.tracker.opponent.keyCardsUsed.slice(0, 4).map((x) => `${x.name}×${x.count}`).join('、')}`);
    }
  }
  if (opts.matchupHint) lines.push(opts.matchupHint);
  if (keptInHand) {
    lines.push('注:标了「核心牌」的是玩家留着做配合的牌 —— 除非这回合能直接斩杀,否则不要建议提前打出去。');
  }
  return lines.join('\n');
}
