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

export interface BaseTagEffects {
  /** 战吼造成多少伤害(0 = 没有)。 */
  battlecry: number;
  /** **这张牌给多少点护甲**（0 = 没有）。 */
  armor: number;
  /** 战吼有前提(「如果你装备着武器」「如果你控制着其他鱼人」之类)。 */
  battlecryConditional: boolean;
  /** 前提怎么写(中文短语,如 `装备武器`);没有前提为 null。 */
  battlecryCondition: string | null;
  /** 亡语造成多少伤害(0 = 没有)。我打死它,它还会咬我一口。 */
  deathrattle: number;
  /** 法术伤害 +N(0 = 没有)。我方所有直伤都要加这个数。 */
  spellPower: number;
  /** 攻击无视嘲讽。 */
  ignoreTaunt: boolean;
  /** 吸血。 */
  lifesteal: boolean;
  /** 这张牌**可以锻造**(卡面带锻造词条)。 */
  forge: boolean;
  /** 这张牌**可以预备**(卡面关键词)。 */
  prepare: boolean;
  /** 这张牌**可交易**。 */
  tradeable: boolean;
}

export interface CardEffects extends BaseTagEffects {
  /** 是否带连击词条。 */
  combo: boolean;
  /** 连击可造成的伤害（0 = 无）。 */
  comboDamage: number;
  /** 连击可加的攻击力（0 = 无）。 */
  comboBuffAtk: number;
  /** 是否可以灌注英雄技能。 */
  imbue: boolean;
  /** 是否与黑暗之赐相关。 */
  darkGift: boolean;
  /** 消灭效果。 */
  destroy: boolean;
  /** 变形效果。 */
  transform: boolean;
  /** 沉默效果。 */
  silence: boolean;
  /** 冻结效果。 */
  freeze: boolean;
  /** 恢复生命点数（0 = 无）。 */
  heal: number;
  /** 磁力关键词。 */
  magnetic: boolean;
  /** 群体伤害点数（0 = 无）。 */
  aoeDamage: number;
  /** 群体伤害是否为随机分配总量。 */
  aoeSpreads: boolean;
  /** 群体伤害是否只打随从。 */
  aoeMinionsOnly: boolean;
  /** 群体伤害是否也会打到己方随从（「所有角色 / 所有随从」）。 */
  aoeHitsOwnMinions: boolean;
  /** 群体伤害是否也会打到己方英雄（「所有角色」）。 */
  aoeHitsOwnHero: boolean;
  /** 打出时对己方英雄造成的确定自伤（0 = 无；覆盖群己与双方英雄）。 */
  selfHeroDamage: number;
}

const BASE_EMPTY: BaseTagEffects = {
  battlecry: 0, armor: 0, battlecryConditional: false, battlecryCondition: null,
  deathrattle: 0, spellPower: 0, ignoreTaunt: false, lifesteal: false, forge: false,
  prepare: false, tradeable: false,
};

const EMPTY: CardEffects = {
  ...BASE_EMPTY,
  combo: false, comboDamage: 0, comboBuffAtk: 0,
  imbue: false, darkGift: false,
  destroy: false, transform: false, silence: false, freeze: false,
  heal: 0, magnetic: false,
  aoeDamage: 0, aoeSpreads: false, aoeMinionsOnly: false,
  aoeHitsOwnMinions: false, aoeHitsOwnHero: false, selfHeroDamage: 0,
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
export function parseTags(raw: string | undefined): BaseTagEffects {
  if (!raw) return { ...BASE_EMPTY };
  const out: BaseTagEffects = { ...BASE_EMPTY };
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
  const base = parseTags(entry?.[4]);
  const fx: CardEffects = { ...EMPTY, ...base };
  const note = entry?.[3] ?? '';
  // 吸血从摘要兜底:标签里没有这一项,而法术的吸血拿不到运行时 tag。
  if (/吸血/.test(note)) fx.lifesteal = true;
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

  // 扩展词条与控制/生存/AOE 字段
  if (/连击/.test(note)) {
    fx.combo = true;
    if (!/战吼/.test(note)) {
      const dmg = /伤害\s*(\d+)/.exec(note);
      if (dmg) fx.comboDamage = Number(dmg[1]) || 0;
    }
    const buffPair = /\+(\d+)\/\+\d+/.exec(note);
    const buffAtk = /\+(\d+)攻/.exec(note);
    if (buffPair) fx.comboBuffAtk = Number(buffPair[1]) || 0;
    else if (buffAtk) fx.comboBuffAtk = Number(buffAtk[1]) || 0;
  }
  if (/(?<!已)灌注/.test(note)) fx.imbue = true;
  if (/黑暗之赐/.test(note)) fx.darkGift = true;
  if (/消灭/.test(note)) fx.destroy = true;
  if (/变形/.test(note)) fx.transform = true;
  if (/沉默/.test(note)) fx.silence = true;
  if (/冻结/.test(note)) fx.freeze = true;
  if (/磁力/.test(note)) fx.magnetic = true;
  const heal = /奶\s*(\d+)/.exec(note);
  if (heal) fx.heal = Number(heal[1]) || 0;
  const aoe = /伤害\s*(\d+)\s*群(随机)?(随从)?(己)?/.exec(note);
  if (aoe) {
    fx.aoeDamage = Number(aoe[1]) || 0;
    fx.aoeSpreads = Boolean(aoe[2]) || /随机/.test(note);
    fx.aoeMinionsOnly = Boolean(aoe[3]) || /群(?:随机)?随从/.test(note);
    const hitsOwn = Boolean(aoe[4]) || /群(?:随机)?(?:随从)?己/.test(note)
      || (/(?:所有|每个)(?:其他)?(?:角色|随从)/.test(note) && !/敌方|敌人/.test(note));
    fx.aoeHitsOwnMinions = hitsOwn;
    fx.aoeHitsOwnHero = hitsOwn && !fx.aoeMinionsOnly;
    if (fx.aoeHitsOwnHero) fx.selfHeroDamage = fx.aoeDamage;
  } else {
    const bothHeroes = /伤害\s*(\d+)\s*双方英雄/.exec(note);
    if (bothHeroes) fx.selfHeroDamage = Number(bothHeroes[1]) || 0;
  }
  return fx;
}

/** 这张牌的中文名(查不到返回空串)。场上实体的 `name` 有时是空的,得靠它兜底。 */
export function cardName(cardId: string): string {
  if (!cardId) return '';
  return lookupEntry(cardId)?.[0] ?? '';
}

/**
 * 这张牌的**牌面费用**(查不到返回 null)。
 *
 * 用途只有一个:校验手牌实体读到的 `COST` 是不是真的。
 * 出牌那一瞬间实体常常还没 dump 完,`COST` 读出来是 0 —— 拿 0 去算斩杀,
 * 一张 4 费的战吼会被当成白送,背包就会多塞几张不该有的牌。
 *
 * **不拿它替代实体费用**:手牌被减费时卡表那个数是错的,只能当校验用。
 */
export function cardCostOf(cardId: string): number | null {
  if (!cardId) return null;
  const entry = lookupEntry(cardId);
  return entry ? entry[1] : null;
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

/** 这张牌的类型字母（S法术 / M随从 / W武器 / H英雄 / L地标 / 空串）。 */
export function cardTypeOf(cardId: string): string {
  if (!cardId) return '';
  return lookupEntry(cardId)?.[2] ?? '';
}

/** 是不是传说牌(卡表第 7 位的 `L`)。 */
export function isLegendary(cardId: string): boolean {
  if (!cardId) return false;
  return lookupEntry(cardId)?.[6] === 'L';
}

/** 这张牌的摘要文字(给需要正则兜底的地方用;查不到返回空串)。 */
/**
 * **持续效果（光环 / 被动触发）的补丁表**（2026-11-14）。
 *
 * ## 为什么要单独一张表
 *
 * 卡表的摘要靠**关键词提取**拼出来（伤害 / 抽牌 / 奶 / 加攻 / 甲 / 召唤…），
 * 这些全是**一次性效果**。持续效果整类都没进摘要 —— 实测奥丁（`TTN_811`）
 * 摘要只剩「8/8 战吼」，而它真正的效果「每当你获得护甲，获得等量攻击力」
 * 在数据里一个字都没有。
 *
 * ## 为什么这类必须单独标
 *
 * 一次性效果是**加数**（这张牌打出去 +3 伤），持续效果是**乘数**（之后每点甲都变成攻）。
 * 当成加数算，斩杀线会差出一整条命。
 *
 * ## 怎么往里加
 *
 * 键是卡 id（`CORE_` / `VAN_` 前缀会自动归一），值是给模型看的那句话，
 * 以「持续:」开头。**别写猜测** —— 只写卡面上确定有的效果。
 *
 * 彻底的办法是重新生成卡表（生成脚本 `effectNote()` 里加持续效果的提取规则），
 * 但那需要原始 HearthstoneJSON 数据；这张表是当下就能生效的补丁。
 */
const PASSIVE_PATCH: Record<string, string> = {
  // 首席执行官奥丁 8/8：每当你获得护甲，便获得等量攻击力。
  // 战士那套「叠甲流」的支点 —— 有它在场，3 点甲法术等于 3 点场攻。
  TTN_811: '持续:每当你获得护甲,获得等量攻击力',
};

/**
 * 自动生成的持续效果表（`src/data/passive-effects.json`）。
 *
 * 2026-11-14 从 HearthstoneJSON 批量提取：只要原文里有**「本局对战的剩余时间内」**
 * 就是整局持续效果（「本回合的剩余时间内」是临时的，不算）。一共 38 张在卡表里。
 *
 * 为什么单独成文件而不是塞进 cards.json：cards.json 是生成物，重建一次就覆盖了；
 * 这张表跟着源码走，重建卡表也不会丢。
 */
let passiveAuto: Record<string, string> | null = null;

function loadPassiveAuto(): Record<string, string> {
  if (passiveAuto) return passiveAuto;
  try {
    const file = fileURLToPath(new URL('./data/passive-effects.json', import.meta.url));
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { effects?: Record<string, string> };
    passiveAuto = raw.effects ?? {};
  } catch {
    passiveAuto = {};
  }
  return passiveAuto;
}

/**
 * 查这张牌的持续效果（没有就空串）。
 *
 * 手工表 `PASSIVE_PATCH` 优先 —— 自动提取的措辞是卡面原文，有时太长或不够直白。
 */
export function passiveOf(cardId: string): string {
  if (!cardId) return '';
  const bare = cardId.replace(VARIANT_PREFIX, '');
  const manual = PASSIVE_PATCH[cardId] ?? PASSIVE_PATCH[bare];
  if (manual) return manual;
  const auto = loadPassiveAuto();
  return auto[cardId] ?? auto[bare] ?? '';
}

export function cardNote(cardId: string): string {
  if (!cardId) return '';
  const base = lookupEntry(cardId)?.[3] ?? '';
  const extra = passiveOf(cardId);
  return extra ? `${base} ${extra}`.trim() : base;
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
  /*
   * 「控制着光环」—— 圣骑士这一版的光环法术(时序光环/誓缚光环/加速光环…)。
   *
   * 日志里光环跟奥秘同一个区(`ZONE=SECRET`),所以判据就是「SECRET 区里
   * 有没有名字带『光环』的实体」,由 parser 的 `auras` 给。
   * 2026-11-19 补:此前这条落到 unknown,于是「时间流具象」的战吼从来没被算过 ——
   * 8 费两张 = 6 点,对面 6 血,正好斩杀,而回执只写「这一条我判断不了」。
   *
   * 没传 `auras`(老调用方只给了 weapon/minionCount)时仍按调不了处理,
   * 不拿 0 当「肯定没有」—— 少说一句比说反一句便宜。
   */
  if (/控制着光环/.test(cond)) {
    return me.auras === undefined ? 'unknown' : me.auras > 0 ? 'ready' : 'blocked';
  }
  const imbueN = /已灌注\s*(\d+)\s*次/.exec(cond);
  if (imbueN) {
    const need = Number(imbueN[1]) || 1;
    return me.imbueCount === undefined ? 'unknown' : me.imbueCount >= need ? 'ready' : 'blocked';
  }
  if (/已灌注过/.test(cond)) {
    return me.imbueCount === undefined ? 'unknown' : me.imbueCount >= 1 ? 'ready' : 'blocked';
  }
  if (/手牌有黑暗之赐|手牌中有具有黑暗/.test(cond)) {
    return me.hasDarkGiftInHand === undefined ? 'unknown' : me.hasDarkGiftInHand ? 'ready' : 'blocked';
  }
  if (/牌库.*没有(?:相同|重复)|套牌.*没有(?:相同|重复)/.test(cond)) {
    return me.deckHasDuplicates === undefined ? 'unknown' : !me.deckHasDuplicates ? 'ready' : 'blocked';
  }
  // 「控X」需要种族信息,卡表没存;其余历史类判断不了
  return 'unknown';
}

export interface DarkGiftParsed {
  charge: boolean;
  doubleBattlecry: boolean;
  taunt: boolean;
  windfury: boolean;
  lifesteal: boolean;
  divineShield: boolean;
  reborn: boolean;
  elusive: boolean;
  atkBonus: number;
  hpBonus: number;
}

/** 解析手牌上的黑暗之赐效果。 */
export function darkGiftEffects(giftCardId: string, giftNote = ''): DarkGiftParsed {
  const cid = giftCardId.replace(/e\d*$/i, '');
  const note = giftNote || cardNote(cid);
  return {
    charge: cid === 'EDR_100t6' || /冲锋/.test(note),
    doubleBattlecry: cid === 'EDR_100t7' || /战吼会触发两次/.test(note),
    taunt: cid === 'EDR_100t3' || /嘲讽/.test(note),
    windfury: cid === 'EDR_100t13' || /风怒/.test(note),
    lifesteal: cid === 'EDR_100t' || /吸血/.test(note),
    divineShield: cid === 'EDR_100t13' || cid === 'EDR_100t10' || /圣盾/.test(note),
    reborn: cid === 'EDR_100t9' || /复生/.test(note),
    elusive: cid === 'EDR_100t1' || /扰魔/.test(note),
    atkBonus: cid === 'EDR_100t' ? 3 : cid === 'EDR_100t1' ? 2 : cid === 'EDR_100t8' ? 4 : cid === 'EDR_100t2' ? -2 : 0,
    hpBonus: cid === 'EDR_100t3' ? 4 : cid === 'EDR_100t1' ? 2 : cid === 'EDR_100t8' ? 5 : 0,
  };
}

/** 判断条件够用到的对局事实。 */
export interface BattlecryContext {
  /** 我装备着武器吗。 */
  weapon: boolean;
  /** 我场上随从数。 */
  minionCount: number;
  /**
   * 头上挂着几个光环(SECRET 区里名字带「光环」的实体数)。
   *
   * 可选:`undefined` = 这一层没拿到信息,不该被当成「一定没有光环」。
   */
  auras?: number;
  /** 本局已灌注次数（undefined = 没拿到这一层）。 */
  imbueCount?: number;
  /** 手牌中是否有带黑暗之赐的牌。 */
  hasDarkGiftInHand?: boolean;
  /** 牌库里是否还有重复牌（来自记牌器）。 */
  deckHasDuplicates?: boolean;
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

/* ---------- 共用群伤与全场变形判据（斩杀 / 清场 / 组合同一套口径） ---------- */

/** 「把所有随从生命值变为 N（通常是 1）」的全场变形牌摘要模式。 */
export const LEVELER_NOTE_RE = /所有随从.{0,8}生命值变为\s*1/;

export interface ResolvedAoeCard {
  kind: 'spell' | 'battlecry';
  damage: number;
  faceDamage: number;
  spreads: boolean;
  minionsOnly: boolean;
  hitsOwnMinions: boolean;
  hitsOwnHero: boolean;
  selfHeroDamage: number;
  lifesteal: boolean;
  doubleBattlecry: boolean;
}

/**
 * 统一解析手牌里一张可立即打出的群体伤害（法术或前提已就绪的战吼随从）。
 *
 * `detectSweep`、`aoeOptions`、`aoeCombos` 全部走这一处，避免各改一处时判据分叉。
 */
export function resolveHandAoeCard(
  card: { cardId: string; darkGift?: { cardId: string; note: string } },
  opts: { spellPower: number; battlecryCtx: BattlecryContext; boardSlotsFree: number },
): ResolvedAoeCard | null {
  if (!card.cardId) return null;
  const fx = cardEffects(card.cardId);
  if (fx.aoeDamage <= 0) return null;
  const type = cardTypeOf(card.cardId);

  let kind: 'spell' | 'battlecry' | null = null;
  let damage = 0;
  let doubleBattlecry = false;

  if (type === 'S') {
    kind = 'spell';
    damage = fx.aoeDamage + opts.spellPower;
  } else if (
    type === 'M'
    && opts.boardSlotsFree > 0
    && fx.battlecry > 0
    && battlecryState(fx, opts.battlecryCtx) === 'ready'
  ) {
    const dg = card.darkGift ? darkGiftEffects(card.darkGift.cardId, card.darkGift.note) : null;
    const mult = dg?.doubleBattlecry ? 2 : 1;
    kind = 'battlecry';
    damage = fx.battlecry * mult;
    doubleBattlecry = mult > 1;
  } else {
    return null;
  }

  if (damage <= 0) return null;
  return {
    kind,
    damage,
    faceDamage: fx.aoeMinionsOnly ? 0 : damage,
    spreads: fx.aoeSpreads,
    minionsOnly: fx.aoeMinionsOnly,
    hitsOwnMinions: fx.aoeHitsOwnMinions,
    hitsOwnHero: fx.aoeHitsOwnHero,
    selfHeroDamage: fx.aoeHitsOwnHero ? damage : 0,
    lifesteal: fx.lifesteal,
    doubleBattlecry,
  };
}
