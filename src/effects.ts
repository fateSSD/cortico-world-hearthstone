/**
 * 结构化效果查询。
 *
 * 只有一个来源:卡表第 5 位那串标签(`b3 d2 s1 t`),生成见 `tools/build-card-table.mjs`。
 *
 * **为什么不在这里调大模型**:这些效果在卡牌数据里本来就是结构化的
 * (`mechanics: ["BATTLECRY"]` + 一句"造成3点伤害"),正则提一遍就够准;
 * 换成 LLM 每回合多发一次请求,换来的是延迟和不稳定 —— 算错一次比慢一秒糟得多。
 * LLM 更适合放在「读懂一段自由文本」的地方,不是这种有标准答案的数字。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 卡表一条记录。
 * 0 名称 / 1 费用 / 2 类型字母 / 3 摘要 / 4 结构化标签 / 5 职业中文 / 6 传说标记 `L`
 */
type CardEntry = [string, number, string, string, string?, string?, string?];

export interface CardEffects {
  /** 战吼造成多少伤害(0 = 没有)。 */
  battlecry: number;
  /**
   * **这张牌给多少点护甲**（0 = 没有）。
   *
   * 2026-11-14 补。原来这个字段根本不存在 —— 战士那几张护甲法术
   * （放出鳄鱼 `TIME_873` 甲10、清理污染 `YOG_502` 甲3）在结构化数据里是**全 0**，
   * 于是算斩杀时对手那 10 点甲等于不存在，她会说「能斩」而其实打不死。
   *
   * 触发这次的是一个真实报障：「打了一把战士，最后一回合她又迷惑了（我的法术效果）」。
   */
  armor: number;
  /**
   * 战吼有前提(「如果你装备着武器」「如果你控制着其他鱼人」之类)。
   *
   * 标签里写成 `b2?`,摘要里写成「战吼需装备武器」。**有条件就不能当确定伤害用** ——
   * 实测:雾帆劫掠者(2/2,战吼需装备武器)被记成无条件 2 点,建议说
   * 「手上这张战吼能打 2 点,打出去就补刀」,可他没武器,打出去一点伤害都没有。
   */
  battlecryConditional: boolean;
  /** 前提怎么写(中文短语,如 `装备武器`);没有前提为 null。 */
  battlecryCondition: string | null;
  /** 亡语造成多少伤害(0 = 没有)。我打死它,它还会咬我一口。 */
  deathrattle: number;
  /** 法术伤害 +N(0 = 没有)。我方所有直伤都要加这个数。 */
  spellPower: number;
  /** 攻击无视嘲讽。 */
  ignoreTaunt: boolean;
  /**
   * 吸血。
   *
   * 随从的吸血靠运行时 tag 就能读到,但**法术的吸血永远读不到** ——
   * 法术不进场地,没有实体标签。所以这里必须从卡面摘要兜底,否则
   * 「起源大厅 8 伤群体 + 吸血」在关键时刻会被当成普通清场牌:
   * 实测 9 血面对 8 点场攻,打出它清场 + 回 8 血是唯一活路,而建议只说了「能削 8 点」。
   */
  lifesteal: boolean;
  /**
   * 这张牌**可以锻造**(卡面带锻造词条)。
   *
   * 为什么需要这个字段:日志只告诉你「锻造完成了」(`xxx_t`),不告诉你「这是一张锻造牌」。
   * 想判断「手上这张还没锻造、打出去要不要先付代价」,只能靠卡面词条 —— 也就是这里。
   * 只认 mechanics 里的 FORGE,不按摘要文字猜:「战吼需你锻造过卡牌」那种不是锻造牌。
   */
  forge: boolean;
  /**
   * 这张牌**可以预备**(卡面关键词)。
   *
   * 预备 = 把牌拖进牌库,花掉全部剩余法力,换「消耗的法力 + 1」点减费,
   * 但当回合不能再打出。所以它对手牌建议的意义是:**这回合打不出去的剩水可以换成折扣**。
   *
   * 和锻造一样,日志里没有「这是不是预备牌」的信息(只有「已经预备过了」的那一位),
   * 判据只能来自卡面文本。
   */
  prepare: boolean;
  /**
   * 这张牌**可交易**。
   *
   * 花 1 费把它洗回牌库再抽一张 —— 和预备一样,是「用剩水换点东西」的手牌操作,
   * 但它换的是**牌**,不是费用。判据只在卡面(`mechanics: TRADEABLE`),日志里读不到。
   */
  tradeable: boolean;
}

const EMPTY: CardEffects = {
  battlecry: 0, armor: 0, battlecryConditional: false, battlecryCondition: null,
  deathrattle: 0, spellPower: 0, ignoreTaunt: false, lifesteal: false, forge: false,
  prepare: false, tradeable: false,
};

let table: Record<string, CardEntry> | null = null;

function loadTable(): Record<string, CardEntry> {
  if (table) return table;
  try {
    const file = fileURLToPath(new URL('./data/cards.json', import.meta.url));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cards?: Record<string, CardEntry> };
    table = raw.cards ?? {};
  } catch {
    table = {};
  }
  return table;
}

/** 卡表里查不到的派生 id 前缀:核心/经典复刻。`CORE_EX1_066` 和 `EX1_066` 是同一张牌。 */
const VARIANT_PREFIX = /^(?:CORE_|VAN_|VANILLA_|TUTORIAL_)/;

/**
 * 锻造后的牌在日志里的 id:**原 id + `t`**。
 *
 * 实测(hs_2026_10_23_21_06_03,21:34:46):手牌里的 XB-488清理机器人 被锻造时,
 * 日志直接给 `CHANGE_ENTITY ... cardId=TTN_458` → `CardID=TTN_458t`,人还在 zone=HAND。
 * 也就是说「有没有锻造过」不用猜、也不用看 FORGED 标签 —— 看 id 末尾那个 t 就够了。
 *
 * 但 `t` 版本不是可收集牌,卡表里没有它:不回落的话,她念出来就是「你手上有一张 TTN_458t」,
 * 摘要、费用、身材全丢。
 */
export function forgedBaseOf(cardId: string): string | null {
  const t = loadTable();
  if (!cardId || !cardId.endsWith('t')) return null;
  const base = cardId.slice(0, -1);
  const entry = t[base];
  if (!entry) return null;
  // **只有本体卡面写着「可锻造」(第 5 位 tag 含 f),`_t` 才当锻造形态。**
  // 不这么卡的话,所有衍生物都会被回落成本体 —— `WW_816t` 是一只 1/1 的「快乐的雏龙」
  // (德鲁伊法术「飞向天空」召出来的),回落到 `WW_816` 就成了「飞向天空」,
  // 职业读成德鲁伊,于是她说「这是德鲁伊的牌,他玩的是死亡骑士」。
  // 实测 2026-10-24 第 24 回合,对面是死亡骑士,场上冒出一只雏龙,她当场报了这一句。
  const tags = String(entry[4] ?? '').split(/\s+/);
  if (!tags.includes('f')) return null;

  // ⚠ 2026-11-06:卡表开始收衍生 token 之后，`TTN_458t` 这种**自己在表里**了。
  // 原来第一步是「表里有就认自己」，于是锻造态被判成独立卡，`forged` 永远是 false ——
  // 她会念成「你手上有一张 TTN_458t」，没有「已锻造」三个字。
  // 现在的判据是**同名 + 自己没有 f**：
  //   · `TTN_458t` 名字也是「XB-488清理机器人」、词条没有 f → 是已锻造那版，回落到本体；
  //   · `TTN_855t`「提尔之涕」虽然同名，但**它自己就带 f**，它是未锻造态 → 认自己。
  const self = t[cardId];
  if (!self) return base;
  const selfTags = String(self[4] ?? '').split(/\s+/);
  return self[0] === entry[0] && !selfTags.includes('f') ? base : null;
}

function lookupEntry(cardId: string): CardEntry | undefined {
  const t = loadTable();
  const bare = cardId.replace(VARIANT_PREFIX, '');
  const hit = t[cardId] ?? t[bare] ?? t[`CORE_${bare}`] ?? t[`VAN_${bare}`];
  if (hit) return hit;
  // 锻造后的 `xxx_t`:回落到原卡 —— 名字/费用照原卡给,「已锻造」由调用方标出
  const forgedBase = forgedBaseOf(cardId);
  return forgedBase ? t[forgedBase] : undefined;
}

/** 解析那串标签。`b3 d2 s1 t` → {battlecry:3, deathrattle:2, spellPower:1, ignoreTaunt:true} */
export function parseTags(raw: string | undefined): CardEffects {
  if (!raw) return { ...EMPTY };
  const out: CardEffects = { ...EMPTY };
  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    // 末尾的 `?` 表示这条有前提(`b2?`)
    const conditional = token.endsWith('?');
    const body = conditional ? token.slice(0, -1) : token;
    const n = Number(body.slice(1));
    switch (body[0]) {
      case 'b':
        out.battlecry = n || 0;
        out.battlecryConditional = conditional;
        break;
      case '甲': out.armor = n || 0; break;
      case 'd': out.deathrattle = n || 0; break;
      case 's': out.spellPower = n || 0; break;
      case 't': out.ignoreTaunt = true; break;
      case 'f': out.forge = true; break;
      case 'p': out.prepare = true; break;
      case 'x': out.tradeable = true; break;
      default: break;
    }
  }
  return out;
}

/** 查一张牌的效果。查不到返回全零 —— 调用方要当成「没有已知效果」,而不是猜。 */
export function cardEffects(cardId: string): CardEffects {
  if (!cardId) return { ...EMPTY };
  const entry = lookupEntry(cardId);
  const fx = parseTags(entry?.[4]);
  const note = entry?.[3] ?? '';
  // 吸血从摘要兜底:标签里没有这一项,而法术的吸血拿不到运行时 tag。
  if (/吸血/.test(note)) fx.lifesteal = true;
  /*
   * 护甲也走摘要兜底（2026-11-14）。
   *
   * 生成脚本里那条 `/获得\s*(\d+)\s*点护甲/` 是后加的，而现有卡表是加之前生成的 ——
   * 实测 14,316 张牌里标签带「甲」的 **0 张**。但摘要里有（「甲10 召唤」），
   * 所以从摘要里捞：`parseTags` 那条中文分支等下次重新生成卡表才会用上。
   */
  if (!fx.armor) {
    const armor = /甲\s*(\d+)/.exec(note);
    if (armor) fx.armor = Number(armor[1]) || 0;
  }
  // 前提写在摘要里(「战吼需装备武器」),标签里那个 `?` 只说明"有前提"、不含内容
  const cond = /战吼需([^\s]+)/.exec(note);
  if (cond) {
    fx.battlecryConditional = true;
    fx.battlecryCondition = cond[1];
  }
  return fx;
}

/** 这张牌的中文名(查不到返回空串)。场上实体的 `name` 有时是空的,得靠它兜底。 */
export function cardName(cardId: string): string {
  if (!cardId) return '';
  return lookupEntry(cardId)?.[0] ?? '';
}

/**
 * 这张牌的职业(中文,如「法师」「中立」)。查不到返回空串。
 *
 * 用途只有一个:**判断对手打出的牌是不是跨职业**。跨职业牌只可能是发现/偷来的,
 * 这是「出乎意料」里最硬的一条判据 —— 它不依赖任何推测。
 */
export function cardClassZh(cardId: string): string {
  if (!cardId) return '';
  return lookupEntry(cardId)?.[5] ?? '';
}

/**
 * 这张牌的**牌面身材**(随从才有,查不到返回 null)。
 *
 * 为什么要这个:出牌那一刻实体常常还没被 dump 完,`ATK`/`HEALTH` 读出来是 0
 * (实测 255 次对手出牌里只有 2 次拿得到身材)。判「是不是一只巨兽」不能等实体,
 * 只能退回牌面值 —— 摘要开头就是 `8/8`,生成时就拼在那儿,比另外存一份字段省。
 */
export function cardBody(cardId: string): { atk: number; health: number } | null {
  if (!cardId) return null;
  const note = lookupEntry(cardId)?.[3] ?? '';
  const m = /^(\d+)\/(\d+)/.exec(note);
  if (!m) return null;
  return { atk: Number(m[1]), health: Number(m[2]) };
}

/** 是不是传说牌(卡表第 7 位的 `L`)。 */
export function isLegendary(cardId: string): boolean {
  if (!cardId) return false;
  return lookupEntry(cardId)?.[6] === 'L';
}

/** 这张牌的摘要文字(给需要正则兜底的地方用;查不到返回空串)。 */
export function cardNote(cardId: string): string {
  if (!cardId) return '';
  return lookupEntry(cardId)?.[3] ?? '';
}

/* ---------- 条件战吼 ---------- */

/** 条件战吼的判断结果。 */
export type BattlecryState =
  | 'ready'      // 条件确定满足
  | 'blocked'    // 条件确定不满足
  | 'unknown';   // 判断不了(比如要看牌库里有没有同名牌)

/**
 * 这手牌的战吼现在能不能生效。
 *
 * **只判断能判断的。** 能判断的是「场上/手上就看得到」的那种:有没有武器、
 * 有没有其他随从。要靠牌库构成、对局历史(本局累计伤害、上回合用过什么)
 * 才能判断的,一律 unknown —— 猜错会让她把「打不出」说成「能打」,
 * 那比不说更糟。
 */
export function battlecryState(fx: CardEffects, me: BattlecryContext): BattlecryState {
  if (!fx.battlecryConditional) return 'ready';
  const cond = fx.battlecryCondition ?? '';

  if (/装备武器/.test(cond)) return me.weapon ? 'ready' : 'blocked';
  if (/没有控制其他随从/.test(cond)) return me.minionCount === 0 ? 'ready' : 'blocked';
  // 「控X」需要种族信息,卡表没存;牌库/历史类判断不了
  return 'unknown';
}

/** 判断条件够用到的对局事实。 */
export interface BattlecryContext {
  /** 我装备着武器吗。 */
  weapon: boolean;
  /** 我场上随从数。 */
  minionCount: number;
}

/** 一手牌里带前提的战吼,连着前提一起报出来(判断结果在 `state`)。 */
export interface ConditionalBattlecry {
  cardId: string;
  /** 满足前提能打多少。 */
  damage: number;
  /** 前提是什么(中文短语)。 */
  condition: string;
  state: BattlecryState;
}

export function conditionalBattlecries(
  cardIds: readonly string[],
  me: BattlecryContext,
): ConditionalBattlecry[] {
  const out: ConditionalBattlecry[] = [];
  for (const id of cardIds) {
    const fx = cardEffects(id);
    if (!fx.battlecry || !fx.battlecryConditional) continue;
    out.push({
      cardId: id,
      damage: fx.battlecry,
      condition: fx.battlecryCondition ?? '有前提',
      state: battlecryState(fx, me),
    });
  }
  return out;
}

/**
 * 确定打得出的战吼伤害。
 *
 * 和「按牌面最大伤害算」的区别:**条件不满足或判断不了的一律不算**。
 * 实测雾帆劫掠者(战吼需装备武器)被当成无条件 2 点,建议说「打出去就补刀」,
 * 可他没武器,打出去一点伤害都没有 —— 那是让他白扔一张牌。
 */
export function sureBattlecry(
  cardIds: readonly string[],
  me: BattlecryContext,
): { damage: number; cardId: string } {
  let best = { damage: 0, cardId: '' };
  for (const id of cardIds) {
    const fx = cardEffects(id);
    if (fx.battlecry <= best.damage) continue;
    if (battlecryState(fx, me) !== 'ready') continue;
    best = { damage: fx.battlecry, cardId: id };
  }
  return best;
}
