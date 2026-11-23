/**
 * Power.log 解析器。
 *
 * 只吃 `GameState.DebugPrintPower()`。同一个动作在日志里出现两遍:GameState 是客户端收到就写,
 * PowerTaskList 是真正执行时写。两边都读会把每个动作记成两次,所以按前缀分开,只认前者。
 *
 * 三个「真实日志教我的事」(手造样本时全踩过):
 *
 * 1. **命令字普遍缩进。** CREATE_GAME 段里的 `GameEntity`/`Player` 缩 4 格、它们的 tag 缩 8 格;
 *    BLOCK 里再套一层。所以一律先 trim 再匹配,`tag=` 行另用一个更窄的规则认。
 * 2. **玩家级标签常写成玩家名而不是 id。** `TAG_CHANGE Entity=中津静流#51151 tag=RESOURCES value=5`,
 *    而 CREATE_GAME 里只有 `PLAYER_ID` 这个数字,两处没有直接对应字段。唯一的桥是
 *    `CURRENT_PLAYER=1`:数字形式那一次给出 playerId,紧跟的名字形式那一次给出名字。
 *    本地玩家靠 `MULLIGAN_STATE=INPUT` 认(对手永远不会出现在 INPUT 上),
 *    日志里它的占位符是 `UNKNOWN HUMAN PLAYER`。
 * 3. **职业看英雄实体的 `CLASS` tag**,不要从 cardId 猜 —— 皮肤 id 没有规律。
 *
 * 血量一律用 HEALTH − DAMAGE:HEALTH 是上限,DAMAGE 是已受伤害,单看任何一个都会算错。
 */

import { cardName, cardNote } from './effects.ts';

/** 一行日志:`D 15:44:29.2000003 GameState.DebugPrintPower() - <正文>`。 */
const LINE_RE = /^[A-Z] (\d{2}:\d{2}:\d{2}\.\d+)\s+GameState\.DebugPrintPower(?:List)?\(\) - ?(.*)$/;

const REF = String.raw`(\[[^\]]*\]|\S+)`;

/** 命令字匹配的都是 **trim 之后** 的文本。 */
const RE_GAME_ENTITY = /^GameEntity (?:Entity)?ID=(\d+)/;
const RE_PLAYER_ENTITY = /^Player EntityID=(\d+) PlayerID=(\d+)/;
const RE_FULL_CREATE = /^FULL_ENTITY - Creating (?:ID=(\d+)|Entity=(\[[^\]]*\]|\S+))(?: CardID=(\S*))?/;
const RE_FULL_UPDATE = /^FULL_ENTITY - Updating Entity=(\[[^\]]*\]|\S+)(?: CardID=(\S*))?/;
const RE_SHOW = /^(?:SHOW_ENTITY|CHANGE_ENTITY) - Updating Entity=(\[[^\]]*\]|\S+)(?: CardID=(\S*))?/;
const RE_HIDE = /^HIDE_ENTITY - Entity=(\[[^\]]*\]|\S+) tag=(\w+) value=(.*)$/;
const RE_TAG_CHANGE = /^TAG_CHANGE Entity=(\[[^\]]*\]|\S+) tag=(\w+) value=(.*)$/;
const RE_BLOCK_START = /^BLOCK_START (.*)$/;
/** 缩进后的纯标签行:trim 之后形如 `tag=HEALTH value=30`。 */
const RE_TAG_LINE = /^tag=([A-Za-z0-9_]+) value=(.*)$/;

/** 白名单数字 tag 映射（3527 = 灌注次数）。 */
const NUMERIC_TAG_ALIAS: Record<string, string> = {
  '3527': 'IMBUE_COUNT',
};

/** 已知灌注替换出的英雄技能 cardId 与按灌注层数（TAG_SCRIPT_DATA_NUM_1）动态生成的名称和效果说明。 */
const IMBUE_HERO_POWERS: Record<string, { name: string; note: (n: number) => string }> = {
  EDR_445p: { name: '巨龙的祝福', note: (n) => `洗两张${Math.max(1, n)}费翡翠传送门进牌库(召唤${Math.max(1, n)}费龙)` },
  EDR_448p: { name: '轻风的祝福', note: (n) => `随机使友方随从变形成法力值消耗增加(${Math.max(1, n)})的随从` },
  EDR_449p: { name: '月亮的祝福', note: (n) => `发现牧师牌置入手牌，法力值消耗减少(${Math.max(1, n)})` },
  EDR_847p: { name: '魔像的祝福', note: (n) => `召唤 ${Math.max(1, n)}/${Math.max(1, n)} 的植物魔像` },
  EDR_850p: { name: '巨狼的祝福', note: (n) => `手牌随机野兽+${Math.max(1, n)}攻且减(${Math.max(1, n)})费` },
  EDR_851p: { name: '小精灵的祝福', note: (n) => `召唤小精灵并对所有敌人随机造成 ${Math.max(1, n)} 点伤害` },
  END_000p: { name: '青铜龙的祝福', note: (n) => `青铜龙的祝福(当前灌注 ${Math.max(1, n)} 阶)` },
  END_003p: { name: '永恒龙的祝福', note: (n) => `永恒龙的祝福(当前灌注 ${Math.max(1, n)} 阶)` },
};

/** 对局本体实体的 id。它的 STATE/STEP 是「这局结束了」的另一个出口。 */
const GAME_ENTITY_ID = 1;
/** 明确不承载状态的噪音行,不计入「未识别」。 */
const NOISE = /^(?:BLOCK_END|ACTION_START|ACTION_END|SUB_SPELL_START|SUB_SPELL_END|META_DATA|Source=|Target=|EffectCardId=|info\[|tag=\d+ )/;

/**
 * 取最后一个 ` tag=名 value=值`。
 * 用 lastIndexOf 而不是从头跑正则 —— entityName 里可能带别的 `tag=` 字样,从头匹配会抢错。
 */
function splitTagValue(text: string): { name: string; value: string } | null {
  const at = text.lastIndexOf(' tag=');
  if (at < 0) return null;
  const m = /^tag=(\w+) value=([\s\S]*)$/.exec(text.slice(at + 1));
  return m ? { name: m[1], value: m[2] } : null;
}

/** 英文职业 tag 值 → 中文。 */
const CLASS_ZH: Record<string, string> = {
  DRUID: '德鲁伊', HUNTER: '猎人', MAGE: '法师', PALADIN: '圣骑士', PRIEST: '牧师',
  ROGUE: '潜行者', SHAMAN: '萨满', WARLOCK: '术士', WARRIOR: '战士',
  DEMONHUNTER: '恶魔猎手', DEATHKNIGHT: '死亡骑士', NEUTRAL: '中立',
};

/** 英雄卡牌 id 前缀兜底(CLASS tag 缺席时用)。HERO_08a 这类皮肤都归到 HERO_08。 */
const HERO_CLASS: Record<string, string> = {
  HERO_01: '战士', HERO_02: '萨满', HERO_03: '潜行者', HERO_04: '圣骑士', HERO_05: '猎人',
  HERO_06: '德鲁伊', HERO_07: '术士', HERO_08: '法师', HERO_09: '牧师', HERO_10: '恶魔猎手', HERO_11: '死亡骑士',
};

/**
 * 本地玩家在日志里的占位符。出现过两种写法:`UNKNOWN HUMAN PLAYER` 和 `UNKNOWN`。
 * 曾经只认前者,结果 `UNKNOWN` 抢先占掉了「本地玩家名」的位置,真名再也对不上,
 * 所有真名标签全被当成对手的 —— 表现是「我是圣骑士却判输」「水晶 0/0」。
 */
const isLocalPlaceholder = (name: string): boolean => name === 'UNKNOWN' || name.startsWith('UNKNOWN ');

/**
 * 从 `key=` 后面取出实体引用。
 *
 * 不能靠正则的 `\[[^\]]*\]`:真实的 entityName 里会再套一层方括号,
 * 例如 `entityName=UNKNOWN ENTITY [cardType=INVALID] id=54 zone=DECK ...`,
 * 简单匹配会断在内层 `]` 上,后面的 id/zone/cardId 全丢。这里按括号深度配对。
 */
function takeRef(text: string, key: string): { raw: string; end: number } | null {
  const at = text.indexOf(`${key}=`);
  if (at < 0) return null;
  const i = at + key.length + 1;
  if (text[i] === '[') {
    let depth = 0;
    for (let j = i; j < text.length; j += 1) {
      if (text[j] === '[') depth += 1;
      else if (text[j] === ']') {
        depth -= 1;
        if (depth === 0) return { raw: text.slice(i, j + 1), end: j + 1 };
      }
    }
    return { raw: text.slice(i), end: text.length };
  }
  const m = /^\S+/.exec(text.slice(i));
  return m ? { raw: m[0], end: i + m[0].length } : null;
}

export interface EntityRef {
  id?: number;
  name?: string;
  cardId?: string;
  playerId?: number;
  zone?: string;
  zonePos?: number;
}

/**
 * `[name=淡水鳄 id=82 zone=PLAY ...]`、`357`、`GameEntity` 都能解。
 * id 为 0 的引用(`Target=0`)表示「没有目标」,返回 null。
 */
export function parseEntityRef(raw: string): EntityRef | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('[') && s.endsWith(']')) {
    const body = s.slice(1, -1);
    const ref: EntityRef = {};
    const re = /([A-Za-z_]+)=([^\]]*?)(?=\s+[A-Za-z_]+=|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const key = m[1];
      const value = m[2].trim();
      if (key === 'id') ref.id = Number(value);
      else if (key === 'name' || key === 'entityName') ref.name = value;
      else if (key === 'cardId') ref.cardId = value;
      else if (key === 'player') ref.playerId = Number(value);
      else if (key === 'zone') ref.zone = value;
      else if (key === 'zonePos') ref.zonePos = Number(value);
    }
    if (ref.id === undefined) return Object.keys(ref).length ? ref : null;
    return ref.id > 0 ? ref : null;
  }
  if (/^\d+$/.test(s)) {
    const id = Number(s);
    return id > 0 ? { id } : null;
  }
  if (s === 'GameEntity') return { id: 1 };
  return { name: s };
}

interface EntityState {
  id: number;
  cardId: string;
  name: string;
  tags: Record<string, string>;
  /**
   * 这张牌第几回合进的手牌。
   *
   * 快枪(Quickdraw)只在「本回合到手」时生效,而日志里**没有**「快枪已生效」这种标签 ——
   * 只能靠进手时间来推。实测 2026-10-24 第 11 回合:手上那张日斑巨龙是当回合抽到的,
   * 快枪那 6 点伤害本来是能用的,建议里一个字都没提。
   */
  enteredTurn?: number;
  /** 第一次见到它时所在的区（用于记牌器区分原生牌库 vs 衍生）。 */
  initialZone?: string;
  /** 是否曾出现在 DECK 区。 */
  wasInDeck?: boolean;
  /** 进入 HAND 时在游戏界面上对本地玩家是否真正公开可见（如 REVEALED=1 或 PLAY 回手）。 */
  publicInHand?: boolean;
  /** 是否在牌库阶段被 HIDE_ENTITY / REVEALED=0 盖回背面（防止 Start-of-Game 展示后暗抽泄露）。 */
  hiddenInDeck?: boolean;
  /** 是否被实际打出过（PLAY block）。 */
  everPlayed?: boolean;
  playedTurn?: number;
  enteredSecretTurn?: number;
  graveyardTurn?: number;
}

export interface GameMeta {
  gameType: string;
  formatType: string;
  scenarioId: number;
}

export interface DarkGiftInfo {
  cardId: string;
  name: string;
  note: string;
}

export interface HeroPowerView {
  cardId: string;
  name: string;
  cost: number;
  exhausted: boolean;
  scriptNum1: number;
  note: string;
}

export interface TrackerCardEvent {
  entityId: number;
  cardId: string;
  name: string;
  cost: number;
  turn: number;
  isCreated: boolean;
  creatorName?: string;
}

export interface TrackerHandSlot {
  entityId: number;
  enteredTurn: number;
  heldTurns: number;
  isCoin: boolean;
  isCreated: boolean;
  creatorName?: string;
  revealedCardId?: string;
  revealedName?: string;
}

export interface TrackerSecretInfo {
  entityId: number;
  enteredTurn: number;
  cardId?: string;
  name?: string;
}

export interface TrackerRawData {
  turn: number;
  localPlayerId: number;
  meta: GameMeta;
  me: {
    heroClass: string;
    deckCount: number;
    drawnFromDeck: TrackerCardEvent[];
    playedCards: TrackerCardEvent[];
    graveyardCards: TrackerCardEvent[];
    knownInDeck: TrackerCardEvent[];
    handCards: { entityId: number; cardId: string; name: string; cost: number; isCreated: boolean }[];
  };
  opponent: {
    heroClass: string;
    deckCount: number;
    playedCards: TrackerCardEvent[];
    graveyardMinions: TrackerCardEvent[];
    graveyardSpells: TrackerCardEvent[];
    secrets: TrackerSecretInfo[];
    revealedSecrets: TrackerCardEvent[];
    handCards: TrackerHandSlot[];
  };
}

export interface MinionView {
  id: number;
  name: string;
  cardId: string;
  atk: number;
  health: number;
  maxHealth: number;
  taunt: boolean;
  divineShield: boolean;
  frozen: boolean;
  stealth: boolean;
  windfury: boolean;
  /** 剧毒:造成伤害就足以致死,与攻击力大小无关。交换和过墙都要按「一刀毙命」算。 */
  poisonous: boolean;
  /** 吸血:造成的伤害回复自己英雄的血量。 */
  lifesteal: boolean;
  /** 复生:死后以 1 血复活。影响「换掉就完事」的判断,目前不计入数值。 */
  reborn: boolean;
  /** 突袭:当回合可以攻击随从,但不能打脸。 */
  rush: boolean;
  /** 冲锋:当回合什么都能打。 */
  charge: boolean;
  /**
   * 法术伤害加成(日志里的 `SPELLPOWER` 标签)。
   *
   * 场上有「法术伤害+1」的随从时,手里 4 点伤害的群伤实际打 5 点 —— 这一点的差别
   * 就是「清不掉」和「全清」的差别。实测 2026-10-24:场上电击学徒(CS3_007)，
   * 她仍在按牌面数字算,没看出这回合能全清对面。
   */
  spellPower: number;
  /**
   * **打不出来**的随从:卡面「无法攻击」(上古看守者)、以及休眠。
   *
   * 与 `canAttack` 的区别是**时间**:`canAttack` 为 false 也可能只是这回合刚下场
   * (EXHAUSTED 召唤失调),下回合就打得出来;`cantAttack` 是「再等也不打」。
   * 算下回合威胁、算场面攻击力时必须用它,不能用 `canAttack` ——
   * 拿 `canAttack` 去算会把一整排刚铺下来的随从算成 0,对面下回合反而被低估。
   */
  cantAttack: boolean;
  canAttack: boolean;
  /** 随从种族（如 MECHANICAL 机械、BEAST 野兽、DRAGON 龙等）。 */
  race?: string;
  /** 是否由其他牌衍生/召唤生成（非构筑原始进手/上场）。 */
  created?: boolean;
  /** 生成/衍生来源卡名（如有）。 */
  creatorName?: string;
}

export interface SideState {
  playerId: number;
  isLocal: boolean;
  heroClass: string;
  heroName: string;
  heroCardId: string;
  health: number;
  maxHealth: number;
  armor: number;
  heroAttack: number;
  /**
   * 英雄有没有风怒 —— **决定他这回合能砍两刀还是一刀。**
   *
   * 来源是武器（毁灭之锤那类「风怒」武器）。2026-10-30 实测：一局里英雄连着攻击两次
   * （seq 91、92 都是「女伯爵莉亚德琳 攻击 伯瓦尔」），可场攻和斩杀线都只按一次算，
   * 于是她说「只凑出 3 点，他还剩 6」—— 实际是 6 点，正好斩。**这就是漏算武器效果。**
   */
  heroWindfury: boolean;
  fatigue: number;
  mana: number;
  manaMax: number;
  overload: number;
  handCount: number;
  /** 场上随从提供的法术伤害加成合计(光环式,直接给所有直伤法术加伤)。 */
  spellPower: number;
  /** 手牌里每张牌(只有本地玩家有 cardId;对手的手牌在这里是空的)。 */
  handCards: {
    id: number;
    cardId: string;
    /** 日志里的实体名。卡表查不到的衍生物(`BE_327t`)靠它才有个能念的名字。 */
    name: string;
    cost: number;
    /**
     * 已经预备过(`tag=PREPARE value=1`)。
     *
     * 实测 2026-10-24 10:45:15 那条:对手手牌被揭示时带着 `tag=PREPARE value=1`。
     * 预备是玩家主动操作(把牌拖进牌库,花掉全部剩水换减费),所以这一位只有「做了/没做」,
     * 没有中间态。它对手牌建议的意义是:这张牌已经打过折、**这回合就能打**,而且不能再预备。
     */
    prepared: boolean;
    /**
     * 第几回合进的手牌(见 EntityState.enteredTurn)。
     * 快枪要「本回合到手」才生效 —— 但真正权威的判据是下面的 poweredUp。
     */
    enteredTurn?: number;
    /**
     * 快枪(Powered Up)此刻生不生效。
     *
     * 日志里有现成的 `tag=POWERED_UP`,别自己拿进手时间猜:
     * 实测 2026-10-24 那局,蹄铁发射机开局带 POWERED_UP=1,回合结束被清成 0;
     * 日斑巨龙抽到时是 1,打出时置 0。**这就是快枪的开关。**
     */
    poweredUp: boolean;
    /** 黑暗之赐附魔效果（通过 DARK_GIFT_ENTITY 或附魔实体追踪）。 */
    darkGift?: DarkGiftInfo;
    /** 是否属于本局衍生出来的牌。 */
    created?: boolean;
  }[];
  /**
   * 手牌里能加水晶的牌(幸运币、活动币)。
   *
   * 单独数出来是因为它**不是一张普通的 0 费牌**:打出去换 1 点水晶,
   * 意味着这一回合真正能花的钱比 `mana` 多。实测踩过:5 水晶手上一个硬币、
   * 一张 6 费的随从,建议说「差 1 费就能打」—— 其实打了硬币就能打出去。
   */
  coinCount: number;
  /**
   * 这些硬币**净赚**几点水晶 —— 不是「几枚」。
   *
   * 一枚硬币打出去换 1 点水晶,可它自己也有费用。费用是 0 时净赚 1;
   * 被「手牌费用 +1」那类光环照过之后(实测硬币 COST 会从 0 变 1),打硬币
   * 就是花 1 换 1,**净赚 0** —— 这时候还按「多一枚就多 1 点预算」算,
   * 会推出一整套根本打不出的组合。
   *
   * 2026-10-29 20:56:59 实测:同一条 `tag=COST` 变化里,加速光环 2→3、
   * 幸运币 0→1。她当时给的是「按费打:加速光环(3费·要打硬币)」——
   * 而那一枚硬币打出来什么也换不到,2 水晶还是 2 水晶。
   */
  coinMana: number;
  deckCount: number;
  secrets: number;
  /**
   * 头上挂着的**光环**(圣骑士本版本的「持续 N 回合」法术)。
   *
   * 光环在日志里不进 PLAY 区,而是 `tag=ZONE value=SECRET` —— 跟奥秘同一个区。
   * 所以 `secrets` 那个数里混着真奥秘和光环两种东西,只看数量分不出来。
   *
   * 为什么要单独挑出来:有的战吼写着「战吼需你控制着光环」(时间流具象),
   * 判这条前提只有这一个依据。2026-11-19 实测:8 费手上两张时间流具象(各 3 伤),
   * 对面 6 血,两条战吼正好斩杀 —— 而当时扩展把这条前提判成「判断不了」,
   * 连伤害都没算进斩杀线。
   *
   * 存名字和 cardId 两样:名字用来给人读(「时序光环」),cardId 用来兜底。
   *
   * 可选:手造的快照(测试)可能没有这一层,那时按「判不了」处理 —— 不拿 `undefined`
   * 当「肯定没有光环」,少说一句比说反一句便宜。
   */
  auras?: { cardId: string; name: string }[];
  minions: MinionView[];
  /**
   * 场上的武器。
   *
   * `cardId` 必须留着:装备那一刻实体名字常常还是空的(实测 2026-10-24 13:29:12
   * 牧师那把武器 dump 出来 `name` 是空的,只拿得到 `BE_227` 这种 id),
   * 不查卡表就会变成「武器 BE_227(0/3)」—— 她没法知道那是把什么刀。
   */
  weapon: {
    cardId: string;
    name: string;
    atk: number;
    durability: number;
    /** 武器带风怒 —— 英雄因此能砍两刀。毁灭之锤那类。 */
    windfury: boolean;
    /**
     * 这把武器砍不砍得到英雄的脸。
     *
     * 卡面写着「无法攻击英雄」的(无穷之手、愚者之灾)只能砍随从。日志里**没有**对应标签,
     * 只能按卡面摘要判 —— 跟「预备」词条同一套做法。
     * 算「下回合打我多少」时必须排除,不然一把打不到脸的武器会被当成实打实的打脸伤害:
     * 实测 2026-10-24 第 6 回合对面无穷之手 4/2,她报「场攻 6(随从 2 + 武器/英雄 4)」,
     * 那 4 点其实一点都打不到脸。
     */
    hitsHero: boolean;
  } | null;
  playState: string;
  /**
   * 换牌阶段的进度:INPUT / DEALING / WAITING / DONE,没进过换牌就是空串。
   *
   * 以前这个标签只在判「谁是我」时用过一次就扔了,于是扩展完全不知道
   * **开局还有一个可以换牌的时刻** —— 她只会在第 1 回合开口「对局开始」,
   * 而那时牌已经换完了。判据是本地玩家自己那一桶里的 `MULLIGAN_STATE`。
   */
  mulliganState: string;
  /** 连击是否已激活（本回合已打出过至少一张牌）。 */
  comboActive?: boolean;
  /** 本局已灌注次数（0 = 未灌注）。 */
  imbueCount?: number;
  /** 当前场上的英雄技能。 */
  heroPower?: HeroPowerView | null;
}

export interface GameSnapshot {
  startedAt: string;
  turn: number;
  activePlayerId: number;
  /**
   * 谁先手(playerId),没读到时为 0。
   *
   * **和 `activePlayerId` 是两件事。** 后者是「现在轮到谁」,换牌阶段它还没有意义;
   * 而「我先手还是对手先手」整局不变,只能从 `FIRST_PLAYER` 标签来。
   * 原来 `startText` 拿 `activePlayerId` 判先手,是个一直没被发现的错。
   */
  firstPlayerId: number;
  isMyTurn: boolean;
  step: string;
  ended: boolean;
  result: 'won' | 'lost' | 'tied' | 'unknown' | null;
  me: SideState;
  opponent: SideState;
  /** 场上随从攻击力合计,含英雄本身的攻击力(武器或变形)。 */
  boardAttack: { mine: number; theirs: number };
  /** 对局模式元数据（GameType / FormatType / ScenarioID）。 */
  meta?: GameMeta;
}

export type ActionKind = 'play' | 'attack' | 'death' | 'hero-power' | 'weapon';

export interface ActionRecord {
  seq: number;
  turn: number;
  who: 'me' | 'opponent' | 'unknown';
  kind: ActionKind;
  text: string;
  /**
   * 这一步涉及的牌的 cardId / 费用 / 身材。
   *
   * 只在 `play` / `weapon` 上有值。加这三个字段是为了回答一个问题:
   * **对手刚才打出的这张牌,有多「出乎意料」** —— 判据要用到职业(跨职业 = 发现/偷来的)
   * 和费用(比他这回合的水晶还贵 = 靠减费或硬币提前打出来的)。
   * 光有 `text`(「打出 德雷阿佳丝」)判不了这些,事后也没法从快照倒推。
   */
  cardId?: string;
  /**
   * 这一步涉及的实体 id。**只给「当时还叫不出名字」的动作用**（见 `backfillActionNames`）。
   *
   * 为什么需要它：对手出牌那一瞬间，日志里给不出 cardId，也还没有 entityName ——
   * 于是 `text` 只能是「打出 未知的牌」。但几十毫秒后随从落地，`FULL_ENTITY Updating`
   * 会带上真实名字。留着 id，等名字到了再回来补一遍，就不必永远念「未知的牌」。
   *
   * 实测 2026-11-14：一局 43 次对手出牌里有 17 次读不出（39%），她复盘时说不出对面出了什么。
   */
  entityId?: number;
  cost?: number;
  atk?: number;
  health?: number;
  /** 是否由其他牌衍生/发现/偷取而来。 */
  created?: boolean;
  /** 衍生来源卡名（如有）。 */
  creatorName?: string;
}

/** 每回合开局时的一个点,复盘靠它还原局势走向。 */
export interface TurnPoint {
  turn: number;
  myHp: number;
  myArmor: number;
  myHand: number;
  myBoard: string;
  foeHp: number;
  foeArmor: number;
  foeHand: number;
  foeBoard: string;
  /**
   * 这一刻的完整局面。
   *
   * 带着它是为了让**同一个事件里的两句话来自同一份状态**:回合那行文字用的
   * 血量和场面、后面附的自动建议,必须对得上。踩过的错:文字取 TURN 变化那一刻、
   * 建议现取当前解析器状态,两句话对不上 —— 文字说「对手 9 血、场面 1 个」,
   * 建议说「对面场攻 9」。
   */
  state?: GameSnapshot;
  /** 已经为等资源补发过一次,别再等。 */
  waited?: boolean;
}

export interface ParseDelta {
  gameStarted: boolean;
  gameEnded: boolean;
  turnChanged: boolean;
  newActions: ActionRecord[];
}

export interface Diagnostics {
  lines: number;
  powerLines: number;
  unmatchedLines: number;
  unmatchedSamples: string[];
  tagChanges: number;
  nameTags: number;
  unmappedNames: number;
  unmappedSamples: string[];
  /** 从日志里认出来的本地玩家名和 PLAYER_ID,没认出来时为 null。 */
  localPlayerId: number | null;
  /** localId 是怎么定下来的:靠手牌可见性,还是配置写死,还是没定成默认 1。 */
  localDetectedBy: 'hand' | 'config' | 'default';
}

const num = (raw: string | undefined, fallback = 0): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const tag = (e: EntityState | undefined, name: string): string | undefined => e?.tags[name];

const tagNum = (e: EntityState | undefined, name: string, fallback = 0): number => num(tag(e, name), fallback);

const tagOn = (e: EntityState | undefined, name: string): boolean => tag(e, name) === '1';

/**
 * 这张牌是不是「加水晶」的硬币。
 *
 * 卡表里查不到它 —— 硬币不是可收集牌(幸运币 `GAME_005`、活动币 `MUDAN_COIN1`
 * 这类都是衍生物),所以只能按 id 认。认错的代价不大:它只影响「能不能多花 1 费」。
 */
export const isCoinCard = (cardId: string): boolean => /COIN|GAME_005/i.test(cardId);

/**
 * 一张牌在文本里怎么称呼:优先本地化名字,其次是**卡表里的中文名**,
 * 再次是卡牌 id,最后才是实体 id。
 *
 * 2026-10-28 修:原来中间那一层是缺的 —— 实体 `name` 读空时直接落到 `cardId`,
 * 于是归档里全是「打出 #57」「打出 #61」。那些牌卡表里**明明有名字**,
 * 只是出牌那一瞬间实体的 NAME 标签还没 dump 完。她复盘时读到的就是一堆井号数字。
 *
 * 卡表也查不到(衍生物、新卡)就直说没认出来,不露内部 id ——
 * `CATA_190t14`、`#57` 这类东西她读了也接不上,只会让她以为自己漏看了什么。
 * 真要排查,`core.log` 里原始行都在,不必靠存档。
 */
function labelOf(e: EntityState | undefined, id?: number): string {
  if (!e) return '未知目标';
  if (e.name) return e.name;
  const fromTable = cardName(e.cardId ?? '');
  if (fromTable) return fromTable;
  // 连 cardId 都没读到(对手出牌那一瞬间常见)也照样不露编号:归档里原本是「打出 #57」
  return '未知的牌';
}

function classOfTagOrCard(classTag: string | undefined, heroCardId: string): string {
  if (classTag) return CLASS_ZH[classTag.toUpperCase()] ?? classTag;
  if (!heroCardId) return '';
  return HERO_CLASS[heroCardId.slice(0, 7).toUpperCase()] ?? '';
}

export class PowerLogParser {
  private entities = new Map<number, EntityState>();
  /** 玩家实体 id → PLAYER_ID。 */
  private playerOfEntity = new Map<number, number>();
  /** PLAYER_ID → 玩家实体 id。 */
  private entityOfPlayer = new Map<number, number>();
  /**
   * 名字形式的玩家级标签,按「我 / 对手」分两个桶存。
   *
   * 不能直接按当时算出来的 playerId 存:换牌阶段还没有任何证据能确定本地是 1 还是 2,
   * 那时写下的 RESOURCES/PLAYSTATE 会落到默认的 1 上;等手牌揭示出真实身份,后续又写到 2 上,
   * 同一局的标签就劈成两半(表现是「赢了判输」「水晶 0/0」)。
   */
  /**
   * 两个玩家的标签,**按 playerId 存**(下标 playerId-1)。
   *
   * 以前存成「本地桶 / 对手桶」两个字段,归属一写死就再也翻不过来 —— 而「本地是谁」
   * 是手牌可见性判出来的(可能晚、也可能判错)。一旦写成对手桶,整局的
   * 血量/手牌/水晶/胜负全部左右互换,而且没人报错。
   *
   * 按 playerId 存之后:名字→playerId 绑对一次,后面怎么读都跟着 localPlayerId() 走。
   */
  private readonly tagsByPlayer: [Record<string, string>, Record<string, string>] = [{}, {}];

  /** 本地玩家那一桶。返回引用,写入照旧。 */
  private get localTags(): Record<string, string> {
    return this.tagsByPlayer[this.localPlayerId() - 1] ?? {};
  }

  /** 对手那一桶。 */
  private get opponentTags(): Record<string, string> {
    return this.tagsByPlayer[this.localPlayerId() === 1 ? 1 : 0] ?? {};
  }
  /** 玩家名 → PLAYER_ID。靠 CURRENT_PLAYER 那一对建立。 */
  private nameToPlayerId = new Map<string, number>();
  /** 名字反查实体 id 用。 */
  private names = new Map<string, number>();
  private current: number | null = null;
  private startedAt = '';
  private sawCreateGame = false;
  private turn = 0;
  private activePlayer = 0;
  private step = '';
  private seq = 0;
  private actions: ActionRecord[] = [];
  private historyLimit = 60;
  private ended = false;
  /**
   * 胜负直接记「我赢没赢」,不经过 PLAYER_ID。
   *
   * 名字形式的标签已经按「我 / 对手」分了桶,胜负跟着桶走就天然对齐:
   * 对手桶里出现 LOST,就是我赢。绕 playerId 一圈反而会出错 ——
   * 结算那一刻本地玩家还没认出来,算出来的 id 是默认值,和快照时的 id 对不上。
   */
  private winnerIsLocal: boolean | null = null;
  private outcomeKind: 'winner' | 'tie' | 'unknown' | null = null;
  private localId = 1;
  private explicitLocalId = false;
  /**
   * 靠手牌可见性认出来的本地玩家。
   *
   * 试过的错判据:`MULLIGAN_STATE=INPUT` —— 对手也会出现在 INPUT 上,拿它判会把两边说反。
   * 硬判据是:**自己手牌带 cardId,对手手牌的那一栏永远是空的**(客户端只知道自己的牌)。
   * 一旦认出来就锁定,不再改。
   */
  private detectedLocalId: number | null = null;
  /**
   * 本地玩家的名字。判据是 `MULLIGAN_STATE=INPUT` —— 换牌时能选牌的只有自己,
   * 对手不会出现 INPUT。日志里它在换牌阶段先写作占位符 `UNKNOWN HUMAN PLAYER`,随即换成真名。
   */
  private localName: string | null = null;
  /**
   * 玩家名 → playerId。
   *
   * **这是判胜负的关键桥梁。** PlayState/CurrentPlayer 这类标签在日志里是**名字形式**
   * (`TAG_CHANGE Entity=名字#1234 tag=PLAYSTATE value=LOST`),名字本身不带 playerId。
   * 而「我是哪个 playerId」是由手牌可见性定的(detectedLocalId)。两者对不上,胜负就会判反。
   *
   * 绑定机会只有一次:**开局第一个行动方**,日志会同时给出数字形式
   * (`Entity=<玩家实体id> tag=CURRENT_PLAYER value=1`)和名字形式。那一刻把名字钉到 playerId 上,
   * 剩下的那个名字就是另一个。
   *
   * 踩过的错(2026-10-23):原来靠「换牌阶段 MULLIGAN_STATE=INPUT 的第一个名字就是本地」——
   * 实际上**两个玩家都会出现 INPUT**(换牌是全服同步的),谁先谁后纯看日志顺序。
   * 实测抓到的是对手的名字,于是对手的 WON 被记进 localTags,她一路报「赢了」而他明明 0 血。
   */
  private readonly nameToPlayer = new Map<string, number>();
  /** 开局数字形式给出的第一个行动方 playerId。 */
  private firstPlayerId: number | null = null;
  /** 与它配对的那个名字。 */
  private firstName: string | null = null;
  /** 名字先到、playerId 后到时的暂存位。 */
  private pendingName: string | null = null;
  /** 最近一次「数字形式」的 CURRENT_PLAYER=1,用来把名字绑到 playerId。 */
  private numberedCurrentPlayer = 0;
  /** 这批里是否出现了 CREATE_GAME。 */
  private createdThisBatch = false;
  /**
   * 待推送的「轮到我」回合点。
   *
   * 不能由调用方在批次边界判断是否轮到我 —— 一批可能跨好几个回合,批末状态早就不是当时的了
   * (实测:整批喂进去时 turn 事件一条都推不出来,因为批末对局已经结束)。
   * 由解析器在 STEP 进入行动阶段那一刻记下来,调用方只管取走。
   */
  private pendingTurns: TurnPoint[] = [];
  private lastQueuedTurn = -1;
  /** 每回合开局时记一个点。放在解析器内部,初始重放(整局在一批里)才不会漏。 */
  private turnPoints: TurnPoint[] = [];
  /** 已经记过阵亡的实体,避免同一次死亡记两遍。 */
  private deadSeen = new Set<number>();
  /** 一局内已报过的告警 id,换局时清空。 */
  public firedAlerts = new Set<string>();
  private gameMeta: GameMeta = { gameType: '', formatType: '', scenarioId: 0 };
  private diag: Diagnostics = {
    lines: 0, powerLines: 0, unmatchedLines: 0, unmatchedSamples: [],
    tagChanges: 0, nameTags: 0, unmappedNames: 0, unmappedSamples: [], localPlayerId: null, localDetectedBy: 'default',
  };

  private readonly now: () => string;

  constructor(now: () => string) {
    this.now = now;
  }

  setHistoryLimit(n: number): void {
    this.historyLimit = Math.max(10, Math.min(300, Math.floor(n) || 60));
    this.trimHistory();
  }

  /**
   * 配置里指定的本地玩家。
   *
   * 自动判定（名字↔playerId 绑定 + 手牌可见性）已经够用，但总会有判反的时候 ——
   * 那时他需要一个能手动扳正的开关。传 1/2 强制，传 null 交回给自动判定。
   *
   * **跨局保持**：`reset()` 不清这两个字段，否则每开一局配置就失效一次。
   */
  setLocalPlayerId(id: 1 | 2 | null): void {
    if (id === 1 || id === 2) {
      this.localId = id;
      this.explicitLocalId = true;
      return;
    }
    // 交回自动：把强制值抹掉，让 detectLocalByHand 重新说了算
    this.explicitLocalId = false;
    this.localId = 1;
  }

  reset(): void {
    this.entities.clear();
    this.playerOfEntity.clear();
    this.entityOfPlayer.clear();
    this.tagsByPlayer[0] = {};
    this.tagsByPlayer[1] = {};
    this.nameToPlayerId.clear();
    this.names.clear();
    this.deadSeen.clear();
    this.turnPoints = [];
    this.pendingTurns = [];
    this.lastQueuedTurn = -1;
    this.current = null;
    this.startedAt = '';
    this.sawCreateGame = false;
    this.turn = 0;
    this.activePlayer = 0;
    this.step = '';
    this.seq = 0;
    this.actions = [];
    this.ended = false;
    this.winnerIsLocal = null;
    this.outcomeKind = null;
    this.playStates.clear();
    this.detectedLocalId = null;
    this.numberedCurrentPlayer = 0;
    this.nameToPlayer.clear();
    this.firstPlayerId = null;
    this.firstName = null;
    this.pendingName = null;
    this.localName = null;
    this.firedAlerts.clear();
    this.gameMeta = { gameType: '', formatType: '', scenarioId: 0 };
  }

  get inGame(): boolean {
    return this.sawCreateGame;
  }

  diagnostics(): Diagnostics {
    return {
      ...this.diag,
      unmatchedSamples: [...this.diag.unmatchedSamples],
      unmappedSamples: [...this.diag.unmappedSamples],
      localPlayerId: this.explicitLocalId || this.detectedLocalId !== null ? this.localPlayerId() : null,
      localDetectedBy: this.explicitLocalId ? 'config' : this.detectedLocalId !== null ? 'hand' : 'default',
    };
  }

  recent(limit = 20): ActionRecord[] {
    return this.actions.slice(-Math.max(1, limit));
  }

  /** 吃一批行,返回这批里发生的变化。 */
  feed(lines: readonly string[]): ParseDelta {
    const delta: ParseDelta = { gameStarted: false, gameEnded: false, turnChanged: false, newActions: [] };
    const before = this.actions.length;
    const turnBefore = this.turn;
    const endedBefore = this.ended;
    this.createdThisBatch = false;

    for (const line of lines) {
      this.diag.lines += 1;
      // 名字绑定与模式元数据走旁路扫描:必须在 LINE_RE 过滤之前。
      this.scanGameMeta(line);
      this.scanNameBinding(line);
      const m = LINE_RE.exec(line);
      if (!m) continue;
      this.diag.powerLines += 1;
      this.handle(m[2]);
    }

    if (before !== this.actions.length) delta.newActions = this.actions.slice(before);
    delta.turnChanged = this.turn !== turnBefore;
    delta.gameEnded = this.ended && !endedBefore;
    delta.gameStarted = this.createdThisBatch;
    return delta;
  }

  private handle(payload: string): void {
    const text = payload.trim();
    if (!text) return;

    if (text === 'CREATE_GAME') {
      this.reset();
      this.sawCreateGame = true;
      this.createdThisBatch = true;
      this.startedAt = this.now();
      return;
    }
    if (!this.sawCreateGame) return;

    // 缩进后的纯标签行,归属上面那个实体
    const tagLine = RE_TAG_LINE.exec(text);
    if (tagLine) {
      if (this.current !== null) this.applyTag(this.current, tagLine[1], tagLine[2]);
      return;
    }
    if (NOISE.test(text)) return;

    let m: RegExpExecArray | null;

    if ((m = RE_GAME_ENTITY.exec(text))) {
      this.current = Number(m[1]);
      this.ensure(this.current);
      return;
    }
    if ((m = RE_PLAYER_ENTITY.exec(text))) {
      const entityId = Number(m[1]);
      const playerId = Number(m[2]);
      this.current = entityId;
      this.ensure(entityId);
      this.playerOfEntity.set(entityId, playerId);
      this.entityOfPlayer.set(playerId, entityId);
      this.applyTag(entityId, 'PLAYER_ID', String(playerId));
      return;
    }
    // FULL_ENTITY - Creating ID=123 CardID=XXX
    if ((m = /^FULL_ENTITY - Creating ID=(\d+)(?: CardID=(\S*))?/.exec(text))) {
      const id = Number(m[1]);
      const entity = this.ensure(id);
      if (m[2]) entity.cardId = m[2];
      this.current = id;
      return;
    }
    // FULL_ENTITY / SHOW_ENTITY / CHANGE_ENTITY - Updating Entity=[...] CardID=XXX
    if (/^(?:FULL_ENTITY|SHOW_ENTITY|CHANGE_ENTITY) - Updating Entity=/.test(text)) {
      const taken = takeRef(text, 'Entity');
      const ref = taken ? parseEntityRef(taken.raw) : null;
      const id = this.resolveRef(ref);
      if (id === null) { this.noteUnmatched(text); return; }
      const entity = this.ensure(id);
      if (ref?.name) entity.name = ref.name;
      // 引用之后才是 CardID=;从引用结束处往后找,免得把 entityName 里的内容当成卡号
      const cardId = / CardID=(\S*)/.exec(taken ? text.slice(taken.end) : text);
      if (cardId && cardId[1]) {
        entity.cardId = cardId[1];
        const curZone = tag(entity, 'ZONE');
        if (curZone === 'HAND' || curZone === 'SETASIDE') {
          entity.publicInHand = true;
          entity.hiddenInDeck = false;
        }
      }
      this.current = id;
      return;
    }
    // HIDE_ENTITY - Entity=[...] tag=ZONE value=SETASIDE/DECK/HAND
    if (text.startsWith('HIDE_ENTITY - ')) {
      const taken = takeRef(text, 'Entity');
      const tail = splitTagValue(text);
      const id = taken ? this.resolveRef(parseEntityRef(taken.raw)) : null;
      if (id !== null && tail) {
        const entity = this.ensure(id);
        entity.publicInHand = false;
        if (tail.name === 'ZONE' && tail.value.trim() === 'DECK') entity.hiddenInDeck = true;
        this.applyTag(id, tail.name, tail.value);
      }
      return;
    }
    // TAG_CHANGE Entity=[...] tag=XXX value=YYY
    if (text.startsWith('TAG_CHANGE ')) {
      this.diag.tagChanges += 1;
      const taken = takeRef(text, 'Entity');
      const tail = splitTagValue(text);
      if (!taken || !tail) { this.noteUnmatched(text); return; }
      const ref = parseEntityRef(taken.raw);

      // 玩家名形式:没有 id,只有名字
      if (ref && ref.id === undefined && ref.name) {
        this.onPlayerNameTag(ref.name, tail.name, tail.value);
        return;
      }
      const id = this.resolveRef(ref);
      if (id === null) { this.noteUnmatched(text); return; }
      const entity = this.ensure(id);
      if (ref?.cardId && !entity.cardId) entity.cardId = ref.cardId;
      if (ref?.name && !entity.name) entity.name = ref.name;
      this.applyTag(id, tail.name, tail.value);
      return;
    }
    if (text.startsWith('BLOCK_START ')) {
      this.onBlockStart(text);
      return;
    }

    this.noteUnmatched(text);
  }

  private noteUnmatched(text: string): void {
    this.diag.unmatchedLines += 1;
    if (this.diag.unmatchedSamples.length < 12) this.diag.unmatchedSamples.push(text.slice(0, 150));
  }

  /* ---------- 对局模式元数据与玩家名形式的标签 ---------- */

  /** 旁路读取 `GameState.DebugPrintGame()` 里的模式与赛制。 */
  private scanGameMeta(raw: string): void {
    const marker = 'GameState.DebugPrintGame() - ';
    const idx = raw.indexOf(marker);
    if (idx < 0) return;
    const body = raw.slice(idx + marker.length).trim();
    if (body.startsWith('GameType=')) this.gameMeta.gameType = body.slice('GameType='.length).trim();
    else if (body.startsWith('FormatType=')) this.gameMeta.formatType = body.slice('FormatType='.length).trim();
    else if (body.startsWith('ScenarioID=')) this.gameMeta.scenarioId = num(body.slice('ScenarioID='.length).trim(), 0);
  }

  /**
   * 旁路扫描:把 BattleTag 名字钉到 playerId 上。
   *
   * **为什么不能在 handle() 里做**:`LINE_RE` 只认 `GameState.DebugPrintPower()`,而
   * `PowerTaskList.DebugPrintPower()` 是被**故意过滤**掉的(它是 GameState 的镜像,再解一遍会重复计数)。
   * 但关键的那一行恰恰只出现在 PowerTaskList 里 ——
   *
   * ```
   * 23:32:02  GameState     TAG_CHANGE Entity=3            tag=FIRST_PLAYER value=1   ← 数字:playerId 2 先手
   * 23:32:04  PowerTaskList TAG_CHANGE Entity=无恋风影#5957 tag=FIRST_PLAYER value=1   ← 名字:被过滤,丢了
   * 23:32:42  GameState     TAG_CHANGE Entity=中津静流#51151 tag=CURRENT_PLAYER value=1
   * ```
   *
   * 名字丢了,第一个被看到的名字就成了「先手那个」—— 于是对手的 CONCEDED / WON 被算到他头上。
   * 用户看到的就是「反了」。
   *
   * 这里只做配对,不参与动作记录,所以不会引入重复计数。只认带 `#` 的真 BattleTag。
   */
  private scanNameBinding(raw: string): void {
    if (this.nameToPlayer.size >= 2 || !raw.includes('#') || !raw.includes('tag=')) return;
    const m = /TAG_CHANGE Entity=(\S*#\d+)\s+tag=(?:CURRENT_PLAYER|FIRST_PLAYER) value=1\s*$/.exec(raw.trim());
    if (!m) return;
    const name = m[1];
    if (this.nameToPlayer.has(name)) return;

    if (this.firstPlayerId !== null && this.firstName === null) {
      this.firstName = name;
      this.nameToPlayer.set(name, this.firstPlayerId);
      return;
    }
    if (this.firstPlayerId === null) {
      // 数字形式还没到:先记下,等它来了再补绑
      if (this.pendingName === null) this.pendingName = name;
      return;
    }
    if (this.nameToPlayer.size === 1) {
      const taken = [...this.nameToPlayer.values()][0];
      this.nameToPlayer.set(name, taken === 1 ? 2 : 1);
    }
  }

  /**
   * `TAG_CHANGE Entity=<玩家名> ...`。
   * 名字没有直接的 playerId 字段,只能靠 CURRENT_PLAYER=1 那一刻把名字绑到 playerId 上。
   */
  private onPlayerNameTag(name: string, rawTagName: string, value: string): void {
    this.diag.nameTags += 1;
    const tagName = NUMERIC_TAG_ALIAS[rawTagName] ?? rawTagName;
    const key = name.trim();

    // 换牌时能选牌的只有自己,对手不会出现 INPUT;占位符不能当真名记下来
    //
    // ⚠ 这条只作兜底。实测两个玩家都会打 MULLIGAN_STATE=INPUT,「第一个名字」不一定是自己。
    // 真正可信的是下面的 nameToPlayer 绑定。
    if (tagName === 'MULLIGAN_STATE' && value === 'INPUT' && this.localName === null && !isLocalPlaceholder(key)) {
      this.localName = key;
    }

    // 「现在轮到谁」是数字形式和名字形式唯一会同时出现的东西 —— 拿它把名字钉到 playerId 上。
    // 开局那一次最干净:数字形式刚刚给出 firstPlayerId,跟着来的第一个 CURRENT_PLAYER=1 就是那个名字。
    if (tagName === 'CURRENT_PLAYER' && value === '1' && !this.nameToPlayer.has(key)) {
      if (this.firstName === null && this.firstPlayerId !== null) {
        this.firstName = key;
        this.nameToPlayer.set(key, this.firstPlayerId);
      } else if (this.nameToPlayer.size === 1) {
        const taken = [...this.nameToPlayer.values()][0];
        this.nameToPlayer.set(key, taken === 1 ? 2 : 1);
      }
    }

    // 已经知道这个名字对应哪个 playerId:直接按 playerId 存,不看「谁是本地」。
    // **胜负能不能判对,全靠这一条。** 存的时候还不知道本地是谁也没关系 ——
    // 桶是按 playerId 的,读取时才按那时的 localPlayerId() 分我/对手。
    const mapped = this.nameToPlayer.get(key);
    if (mapped !== undefined) {
      const bucket = this.tagsByPlayer[mapped - 1];
      if (bucket) bucket[tagName] = value;
      if (tagName === 'PLAYSTATE') this.checkEndState();
      if (tagName === 'CURRENT_PLAYER' && value === '1' && mapped === this.localPlayerId()) this.queueMyTurn();
      return;
    }

    // 还没绑上名字(开局头几秒):退回到占位符 / 换牌名字这套老判据。
    // 这个阶段的标签多是 MULLIGAN_STATE、CURRENT_PLAYER 之类,不影响胜负。
    if (isLocalPlaceholder(key) || (this.localName !== null && key === this.localName)) {
      this.localTags[tagName] = value;
      if (tagName === 'PLAYSTATE') this.checkEndState();
      if (tagName === 'CURRENT_PLAYER' && value === '1') this.queueMyTurn();
      return;
    }
    if (this.localName !== null) {
      this.opponentTags[tagName] = value;
      if (tagName === 'PLAYSTATE') this.checkEndState();
      return;
    }

    this.diag.unmappedNames += 1;
    if (this.diag.unmappedSamples.length < 12) this.diag.unmappedSamples.push(`${key} · ${tagName}`);
  }

  /**
   * 现在是不是轮到我。
   *
   * 直接读两个桶里的 CURRENT_PLAYER,不绕 PLAYER_ID:数字形式的 CURRENT_PLAYER 只在开局出现一次,
   * 之后全是名字形式 —— 盯着 activePlayer 会让它永远停在开局那个值上(实测 turn 事件一条都推不出来)。
   */
  private isMyTurnNow(): boolean {
    if (this.localTags['CURRENT_PLAYER'] === '1') return true;
    if (this.opponentTags['CURRENT_PLAYER'] === '1') return false;
    return this.activePlayer === this.localPlayerId();
  }

  /** 玩家级标签:桶按 playerId 存,所以这里直接按下标取,不用管谁是本地。 */
  private playerTagValue(playerId: number, tagName: string): string | undefined {
    const bucket = this.tagsByPlayer[playerId - 1];
    if (bucket && bucket[tagName] !== undefined) return bucket[tagName];
    const entityId = this.entityOfPlayer.get(playerId);
    return tag(this.entities.get(entityId), tagName);
  }

  /* ---------- 通用实体 ---------- */

  private ensure(id: number): EntityState {
    let e = this.entities.get(id);
    if (!e) {
      e = { id, cardId: '', name: '', tags: {} };
      this.entities.set(id, e);
    }
    return e;
  }

  private resolveRef(ref: EntityRef | null): number | null {
    if (!ref) return null;
    if (ref.id !== undefined && Number.isFinite(ref.id)) {
      const e = this.ensure(ref.id);
      if (ref.name && !e.name) e.name = ref.name;
      if (ref.cardId && !e.cardId) e.cardId = ref.cardId;
      if (ref.name) this.names.set(ref.name, ref.id);
      return ref.id;
    }
    if (ref.name) {
      const id = this.names.get(ref.name);
      if (id !== undefined) return id;
    }
    return null;
  }

  private applyTag(id: number, rawTagName: string, rawValue: string): void {
    const rawName = NUMERIC_TAG_ALIAS[rawTagName] ?? rawTagName;
    // 数字形式的 tag(如 tag=1596)除白名单外不承载我们知道含义的字段
    if (!/^[A-Z_][A-Z0-9_]*$/.test(rawName)) return;
    const entity = this.ensure(id);
    const value = rawValue.trim();
    const before = entity.tags[rawName];
    entity.tags[rawName] = value;
    if (before === value) return;

    // 这局结束了。除了双方的 PLAYSTATE,GameEntity 自己也会报 STATE=COMPLETE / STEP=FINAL_GAMEOVER。
    //
    // 为什么必须单独认它:断线重连回来的日志里,常常**一条 PLAYSTATE 都没有**(名字桶整个是空的,
    // 数字形式也没发),只剩最后这几条 GameEntity 的标签。而 checkEndState 原本只在 PLAYSTATE
    // 出现时被调用 —— 于是那局永远结束不了,她会一直拿最后那一帧当「现在」,
    // 对手 0 血了还在问「这回合怎么打」。
    if (id === GAME_ENTITY_ID && (rawName === 'STATE' || rawName === 'STEP')) this.checkEndState();

    if (rawName === 'REVEALED') {
      if (value === '1') {
        entity.publicInHand = true;
        entity.hiddenInDeck = false;
      } else if (value === '0') {
        entity.publicInHand = false;
        if (tag(entity, 'ZONE') === 'DECK') entity.hiddenInDeck = true;
      }
      return;
    }

    if (rawName === 'ZONE') {
      if (entity.initialZone === undefined) entity.initialZone = value;
      if (value === 'DECK') {
        entity.wasInDeck = true;
        if (before !== undefined && before !== 'DECK') {
          entity.publicInHand = false;
          entity.hiddenInDeck = true;
        }
      }
      // 进手牌就记回合号。这张牌是抽到的、还是被效果放进来的,日志里分不出来,
      // 但「本回合到手」这件事两者都成立 —— 够判快枪了。
      if (value === 'HAND') {
        entity.enteredTurn = this.turn;
        if (before === 'PLAY') {
          // 场上随从/牌回手（如暗影步、冰冻陷阱）对双方明牌可见
          entity.publicInHand = true;
          entity.hiddenInDeck = false;
        } else if (before === 'DECK') {
          if (tag(entity, 'REVEALED') === '1') {
            entity.publicInHand = true;
            entity.hiddenInDeck = false;
          } else {
            entity.publicInHand = false;
          }
        }
      }
      if (value === 'SECRET' && entity.enteredSecretTurn === undefined) entity.enteredSecretTurn = this.turn;
      if (value === 'GRAVEYARD') {
        if (entity.graveyardTurn === undefined) entity.graveyardTurn = this.turn;
        if (tag(entity, 'CARDTYPE') === 'MINION' && !this.deadSeen.has(id)) {
          this.deadSeen.add(id);
          this.record('death', id, null, `${labelOf(entity)} 阵亡`);
        }
      }
      return;
    }
    if (rawName === 'STEP') {
      this.step = value;
      // 真正进入行动阶段,才算是「轮到他了」;同一回合内多次回到 MAIN_ACTION 只记一次
      if (value === 'MAIN_ACTION' || value === 'MAIN_READY') this.queueMyTurn();
      return;
    }
    if (rawName === 'TURN') {
      const next = num(value, this.turn);
      if (next > this.turn) {
        this.turn = next;
        this.captureTurnPoint();
      }
      return;
    }
    if (rawName === 'FIRST_PLAYER') {
      // `Entity=3 tag=FIRST_PLAYER value=1` —— **value 是布尔**,实体 3 属于哪个 playerId,
      // 哪个就是先手。原来没直接解这个标签,先手只能靠「第一次 CURRENT_PLAYER」间接推,
      // 而换牌阶段 CURRENT_PLAYER 未必先到 —— 于是「我先手/对手先手」经常说反。
      const on = num(value, 0) === 1;
      const owner = this.playerIdOf(id);
      if (on && owner !== null) this.firstPlayerId = owner;
      return;
    }
    if (rawName === 'CURRENT_PLAYER') {
      // 这里原来写的是 `const pid = num(value, 0); if (pid > 0) this.activePlayer = pid;`
      // —— value 恒为 0/1,于是 `activePlayer` 只会是 1 或 0,**永远不可能是 2**。
      // 后果:本地是 playerId 2 时,`activePlayer === localPlayerId()` 永远不成立,
      // 而 `startText` 直接拿 `activePlayerId` 判先后手 —— 后手开局会被说成「我先手」。
      // 实测 2026-10-28:起手 4 张 + 一枚硬币(铁板钉钉的后手),扩展说「我先手」。
      const on = num(value, 0) === 1;
      const owner = this.playerIdOf(id);
      if (on && owner !== null) {
        this.activePlayer = owner;
        this.numberedCurrentPlayer = owner;
        // 第一次出现「谁先动」:这一刻数字和名字会同时给出,是绑定名字↔playerId 的唯一机会
        if (this.firstPlayerId === null && this.firstName === null) {
          this.firstPlayerId = owner;
          // 名字先到过(旁路扫到但那时还不知道 playerId):现在补绑
          if (this.pendingName !== null) {
            this.firstName = this.pendingName;
            this.nameToPlayer.set(this.pendingName, owner);
            this.pendingName = null;
          }
        }
      }
      return;
    }
    if (rawName === 'PLAYSTATE') { this.checkEndState(); return; }
  }

  /**
   * 谁的手牌里带 cardId,谁就是本地玩家 —— 但必须**按数量比**,不能在事件流里「遇到就锁」。
   *
   * 踩过的错:一开始写成「见到 HAND + cardId 就锁定」。对手打牌时那张牌会以 HAND 状态被
   * SHOW_ENTITY 揭示,一样带 cardId,于是把对手当成了自己。现在的判据是数量:
   * 自己的起手手牌整批可见,对手一张都不露。
   */
  private detectLocalByHand(): void {
    const counts = new Map<number, number>();
    for (const e of this.entities.values()) {
      if (tag(e, 'ZONE') !== 'HAND' || !e.cardId) continue;
      const controller = num(tag(e, 'CONTROLLER'), 0);
      if (controller !== 1 && controller !== 2) continue;
      counts.set(controller, (counts.get(controller) ?? 0) + 1);
    }
    const a = counts.get(1) ?? 0;
    const b = counts.get(2) ?? 0;
    // 必须是「一边明确有一手、另一边明确一张都没露」才敢锁。
    // 1:0 太容易是瞬态(某张牌刚进 HAND,另一边的还没写进来),锁下去就一错到底 ——
    // 而这一次的结果决定整局的「我/对手」归属,包括胜负。
    if (Math.max(a, b) < 2 || Math.min(a, b) > 0) return;
    this.detectedLocalId = a > b ? 1 : 2;
  }

  /**
   * 每个 playerId 的 PLAYSTATE,**按 playerId 记,不在这里判谁赢**。
   *
   * 以前是「拿到 PLAYSTATE 当场判":那一刻的 localPlayerId() 决定这条状态算我的还是对手的。
   * 但那一刻 `detectedLocalId` 可能还没定(它要等手牌够了才算),于是默认按 playerId=1 读 ——
   * 如果本地其实是 2,就会把对手的 WON 当成自己的。
   *
   * 现在只记录事实,`resultFor()` 才结合那时的 localPlayerId() 翻译成输赢。
   * 判定被推到「有人真的来问结果」的时刻,时序问题就消失了。
   */
  private readonly playStates = new Map<number, string>();

  private checkEndState(): void {
    // 名字形式的桶已经按 playerId 存好:两个玩家都扫一遍
    for (const pid of [1, 2]) {
      const state = this.tagsByPlayer[pid - 1]?.['PLAYSTATE'];
      if (state && state !== 'PLAYING' && state !== 'UNKNOWN') this.playStates.set(pid, state);
    }
    // 数字形式(玩家实体上的标签)兜底
    for (const [entityId, playerId] of this.playerOfEntity) {
      const state = tag(this.entities.get(entityId), 'PLAYSTATE');
      if (state && state !== 'PLAYING' && state !== 'UNKNOWN') this.playStates.set(playerId, state);
    }
    if (this.playStates.size) {
      this.ended = true;
      return;
    }

    // GameEntity 自己的收尾:STATE=COMPLETE 是终点,STEP=FINAL_GAMEOVER 是它前面那一格。
    // 两个都认 —— 断线重连的日志有时只留下其中一条。
    const game = this.entities.get(GAME_ENTITY_ID);
    if (!this.ended && (tag(game, 'STATE') === 'COMPLETE' || tag(game, 'STEP') === 'FINAL_GAMEOVER')) {
      this.ended = true;
      if (this.outcomeKind === null) this.outcomeKind = 'unknown';
    }
  }

  private otherPlayer(playerId: number): number {
    for (const p of this.playerOfEntity.values()) if (p !== playerId) return p;
    return playerId === 1 ? 2 : 1;
  }

  /** 把「两边各自的 PLAYSTATE」翻译成「我赢了 / 我输了」。到这一刻才看谁是本地。 */
  private resultFor(): GameSnapshot['result'] {
    if (!this.ended) return null;
    const localId = this.localPlayerId();
    const mine = this.playStates.get(localId);
    const foe = this.playStates.get(localId === 1 ? 2 : 1);
    if (mine === 'TIED' || foe === 'TIED') return 'tied';
    // 我赢:我 WON,或者对面 LOST/CONCEDED
    if (mine === 'WON' || foe === 'LOST' || foe === 'CONCEDED') return 'won';
    // 我输:我 LOST/CONCEDED,或者对面 WON
    if (mine === 'LOST' || mine === 'CONCEDED' || foe === 'WON') return 'lost';
    return 'unknown';
  }

  /* ---------- 动作 ---------- */

  private labelFor(ref: EntityRef | null): string {
    if (!ref) return '未知目标';
    const entity = ref.id !== undefined ? this.entities.get(ref.id) : undefined;
    if (entity?.name) return entity.name;
    if (ref.name) return ref.name;
    if (entity?.cardId) return entity.cardId;
    if (ref.cardId) return ref.cardId;
    return '未知目标';
  }

  private onBlockStart(rest: string): void {
    const typeMatch = /BlockType=(\w+)/.exec(rest);
    if (!typeMatch) return;
    const blockType = typeMatch[1];
    if (blockType !== 'PLAY' && blockType !== 'ATTACK') return;

    // 引用可能嵌套方括号(entityName 里带 [cardType=...]),按深度取
    const entityRaw = takeRef(rest, 'Entity');
    const targetRaw = takeRef(rest, 'Target');
    const ref = entityRaw ? parseEntityRef(entityRaw.raw) : null;
    const target = targetRaw ? parseEntityRef(targetRaw.raw) : null;
    const entityId = this.resolveRef(ref);
    if (entityId === null) return;
    const entity = this.entities.get(entityId);

    if (blockType === 'ATTACK') {
      const targetLabel = target ? this.labelFor(target) : '';
      this.record('attack', entityId, null, targetLabel ? `${labelOf(entity)} 攻击 ${targetLabel}` : `${labelOf(entity)} 发起攻击`);
      return;
    }

    const cardType = tag(entity, 'CARDTYPE');
    if (cardType === 'HERO_POWER' || (!entity?.cardId && tag(entity, 'ZONE') === 'PLAY')) {
      this.record('hero-power', entityId, null, `${labelOf(entity)} 使用英雄技能`);
      return;
    }
    if (entity) {
      entity.everPlayed = true;
      if (entity.playedTurn === undefined) entity.playedTurn = this.turn;
    }
    const targetLabel = target ? this.labelFor(target) : '';
    this.record(
      cardType === 'WEAPON' ? 'weapon' : 'play',
      entityId,
      null,
      `打出 ${labelOf(entity)}${targetLabel ? ` → ${targetLabel}` : ''}`,
      {
        cardId: entity?.cardId,
        cost: entity ? tagNum(entity, 'COST', 0) : undefined,
        atk: cardType === 'MINION' || cardType === 'WEAPON' ? tagNum(entity, 'ATK', 0) : undefined,
        health: cardType === 'MINION' ? tagNum(entity, 'HEALTH', 0) : undefined,
      },
    );
  }

  private playerIdOf(entityId: number): number | null {
    const direct = this.playerOfEntity.get(entityId);
    if (direct !== undefined) return direct;
    const controller = tag(this.entities.get(entityId), 'CONTROLLER');
    if (controller !== undefined) return num(controller, 0) || null;
    return null;
  }

  localPlayerId(): number {
    if (this.explicitLocalId) return this.localId;
    if (this.detectedLocalId !== null) return this.detectedLocalId;
    return this.localId;
  }

  /** 配置指定的本地玩家;传 0 表示交回自动判断。 */
  setLocalPlayerId(id: number): void {
    if (id === 1 || id === 2) {
      this.localId = id;
      this.explicitLocalId = true;
    } else {
      this.explicitLocalId = false;
      this.localId = 1;
    }
  }

  private entityCreatorName(e: EntityState): string | undefined {
    const cid = num(tag(e, 'DISPLAYED_CREATOR') ?? tag(e, 'CREATOR'), 0);
    if (cid <= 0) return undefined;
    const c = this.entities.get(cid);
    if (!c) return undefined;
    return c.name || cardName(c.cardId ?? '') || undefined;
  }

  private record(
    kind: ActionKind,
    entityId: number,
    who: number | null,
    text: string,
    extra?: Pick<ActionRecord, 'cardId' | 'cost' | 'atk' | 'health' | 'created' | 'creatorName'>,
  ): void {
    const playerId = who ?? this.playerIdOf(entityId);
    const localId = this.localPlayerId();
    const ent = this.entities.get(entityId);
    const created = extra?.created ?? (ent ? (this.isEntityCreated(ent) || isCoinCard(ent.cardId)) : false);
    const creatorName = extra?.creatorName ?? (ent ? this.entityCreatorName(ent) : undefined);
    this.seq += 1;
    this.actions.push({
      seq: this.seq,
      turn: this.turn,
      who: playerId === null ? 'unknown' : playerId === localId ? 'me' : 'opponent',
      kind,
      text,
      // 名字这一瞬间可能还没有（对手出牌常见）。留给 backfill 补，别就此定稿。
      entityId,
      ...extra,
      ...(created ? { created: true } : {}),
      ...(creatorName ? { creatorName } : {}),
    });
    this.trimHistory();
  }

  /**
   * 把「未知的牌」用实体后来的名字补上。
   *
   * 对手出牌那一刻，日志里既没有 cardId 也没有 entityName —— 只有实体 id。
   * 随从落地之后 `FULL_ENTITY - Updating` 才把名字补进实体表。
   * 每个快照前跑一遍，回填过的不会再匹配（`text` 里已经没有「未知的牌」）——
   * 幂等，几十条动作遍历一遍是微秒级。
   */
  private backfillActionNames(): void {
    for (const a of this.actions) {
      if (a.entityId === undefined) continue;
      const e = this.entities.get(a.entityId);
      if (!e) continue;
      if (!a.created && (this.isEntityCreated(e) || isCoinCard(e.cardId))) a.created = true;
      if (!a.creatorName) {
        const cn = this.entityCreatorName(e);
        if (cn) a.creatorName = cn;
      }
      if (!a.text.includes('未知的牌')) continue;
      const name = e.name || cardName(e.cardId ?? '');
      if (!name) continue;
      a.text = a.text.replace('未知的牌', name);
      if (e.cardId && !a.cardId) a.cardId = e.cardId;
    }
  }

  private trimHistory(): void {
    if (this.actions.length > this.historyLimit) this.actions = this.actions.slice(-this.historyLimit);
  }

  /**
   * 回合开始时记一个点。
   *
   * 必须由解析器自己记 —— 不能在调用方按批次记:启动时的初始重放会把整局塞进同一批,
   * 批次边界上只剩「已结束」这一个状态,时间线就空了(实测过,21 回合的点一个都没有)。
   */
  private captureTurnPoint(): void {
    const s = this.snapshot();
    if (!s || s.ended) return;
    this.turnPoints.push({
      turn: s.turn,
      myHp: s.me.health, myArmor: s.me.armor, myHand: s.me.handCount, myBoard: boardSummary(s.me),
      foeHp: s.opponent.health, foeArmor: s.opponent.armor, foeHand: s.opponent.handCount, foeBoard: boardSummary(s.opponent),
      state: s,
    });
  }

  /**
   * 轮到本地玩家进入行动阶段时,把这一刻的局面记进待推队列。
   * 用回合号去重:同一回合打完一张牌会回到 MAIN_ACTION,不该再推一次。
   */
  private queueMyTurn(): void {
    if (this.turn <= 0) return;
    if (!this.isMyTurnNow()) return;
    const s = this.snapshot();
    if (!s || s.ended) return;

    const point: TurnPoint = {
      turn: s.turn,
      myHp: s.me.health, myArmor: s.me.armor, myHand: s.me.handCount, myBoard: boardSummary(s.me),
      foeHp: s.opponent.health, foeArmor: s.opponent.armor, foeHand: s.opponent.handCount, foeBoard: boardSummary(s.opponent),
      state: s,
    };

    // 同一回合会被触发两次:CURRENT_PLAYER 切过来一次、STEP 进 MAIN_ACTION 再一次。
    // 第一次太早 —— 那一刻水晶还是 0、场上的随从也可能还没落位。所以先记下来,
    // **允许后一次覆盖**,并且只在「资源已经刷新」时才覆盖,免得把好数据换回坏数据。
    //
    // 曾经把 `lastQueuedTurn` 的去重挡在最前面,结果每回合只留住了最早那一帧:
    // 水晶 0、场面空场,建议算出来是「没牌可打」。
    const existing = this.pendingTurns.findIndex((p) => p.turn === s.turn);
    if (existing >= 0) {
      if (s.me.mana > 0 || s.turn === 1) this.pendingTurns[existing] = point;
      return;
    }

    // 已经推出去过的回合不再推第二条
    if (this.lastQueuedTurn === s.turn) return;
    this.lastQueuedTurn = s.turn;
    this.pendingTurns.push(point);
  }

  /** 取走这一批里攒下的「轮到我」,由调用方决定要不要开口。 */
  drainMyTurns(): TurnPoint[] {
    if (!this.pendingTurns.length) return [];
    const out = this.pendingTurns;
    this.pendingTurns = [];
    return out;
  }

  /** 这一局的回合时间线,复盘用。 */
  turnTimeline(): TurnPoint[] {
    return [...this.turnPoints];
  }

  /* ---------- 快照 ---------- */

  snapshot(): GameSnapshot | null {
    if (!this.sawCreateGame) return null;
    // 先把「打出 未知的牌」用实体后来的名字补一遍：对手出牌那一刻还没有名字，
    // 落地几十毫秒后才有。每回合都会重算快照，所以这里补最省事，也是幂等的。
    this.backfillActionNames();
    if (!this.explicitLocalId && this.detectedLocalId === null) this.detectLocalByHand();

    const localId = this.localPlayerId();
    const sides = new Map<number, SideState>();
    for (const [entityId, playerId] of this.playerOfEntity) {
      sides.set(playerId, this.buildSide(entityId, playerId, playerId === localId));
    }
    const me = sides.get(localId) ?? this.emptySide(localId, true);
    const otherId = localId === 1 ? 2 : 1;
    const opponent = sides.get(otherId) ?? this.emptySide(otherId, false);

    return {
      startedAt: this.startedAt,
      turn: this.turn,
      activePlayerId: this.activePlayer,
      firstPlayerId: this.firstPlayerId ?? 0,
      isMyTurn: this.isMyTurnNow(),
      step: this.step,
      ended: this.ended,
      result: this.reconcileResult(this.resultFor(), me, opponent),
      me,
      opponent,
      boardAttack: { mine: sumAttack(me), theirs: sumAttack(opponent) },
      meta: { ...this.gameMeta },
    };
  }

  /**
   * 用血量给胜负上一道保险。
   *
   * 炉石里英雄血量归零**立刻**判负,所以「说我赢、但我血量 ≤ 0、对手还活着」在物理上不可能。
   * 出现这种组合只有一个原因:「我 / 对手」的标签归错了桶(名字没绑上 playerId 时就会)。
   *
   * 这不是猜,是两条独立路径互相校验:血量来自英雄实体,胜负来自 PLAYSTATE ——
   * 一个走实体、一个走名字。它们打架的时候,血量更可信。
   *
   * 2026-10-23 实测:她报「赢了:第 30 回合,我 0 血 / 对手 30 血」,用户当场说「输的判定点得看看」。
   *
   * ## 2026-10-24 补:`unknown` 也归血量管
   *
   * 这一条是回归实测抓出来的,不是推演:真实 `Power.log` 里 **GameEntity 的
   * `STATE=COMPLETE` 会早于双方 PLAYSTATE 到**(实测 10_23_20_46_05,COMPLETE 在
   * 12788 行,WON/LOST 在 12791–12797 行)。`ended` 在 COMPLETE 那一刻就翻成 true,
   * 此刻 `playStates` 还是空的 → `resultFor()` 给 `unknown` → 世界层立刻把
   * `hearthstone.game.end` 推出去,于是她说「结果未知」、桌宠给 `<neutral>`:
   * 明明是一局斩杀获胜,却既没庆祝也没说对。
   *
   * 只差三行日志,没必要去等(等就要引入延时补偿,风险更大)。血量那一刻已经是对的:
   * 对手 0 血 = 我赢,我 0 血 = 我输。把 `unknown` 也纳入校验,判定当场就准。
   */
  private reconcileResult(
    result: GameSnapshot['result'],
    me: SideState,
    opponent: SideState,
  ): GameSnapshot['result'] {
    if (result !== 'won' && result !== 'lost' && result !== 'unknown') return result;
    const meDead = me.health <= 0;
    const foeDead = opponent.health <= 0;
    // 双方同时 0 血:可能是同归于尽,也可能是日志尾部把血量清了 —— 分不清就不编,维持原判。
    if (meDead && foeDead) return result;
    if (foeDead) return 'won';
    if (meDead) return 'lost';
    return result;
  }

  private emptySide(playerId: number, isLocal: boolean): SideState {
    return {
      playerId, isLocal, heroClass: '', heroName: '', heroCardId: '',
      health: 0, maxHealth: 0, armor: 0, heroAttack: 0, heroWindfury: false, fatigue: 0,
      mana: 0, manaMax: 0, overload: 0, handCount: 0, handCards: [], coinCount: 0, coinMana: 0, deckCount: 0, secrets: 0, auras: [],
      spellPower: 0,
      minions: [], weapon: null, playState: '', mulliganState: '',
      comboActive: false, imbueCount: 0, heroPower: null,
    };
  }

  /** 判断某实体是否属于本局衍生牌（排除系统初始发的后手硬币特殊判断在调用处处理）。 */
  private isEntityCreated(e: EntityState): boolean {
    const creator = num(tag(e, 'CREATOR') ?? tag(e, 'DISPLAYED_CREATOR'), 0);
    if (creator > 0) return true;
    if (e.initialZone && e.initialZone !== 'DECK' && e.initialZone !== 'HAND') return true;
    return false;
  }

  /** 解析附着在手牌上的黑暗之赐效果。 */
  private resolveDarkGift(
    e: EntityState,
    attachedEnchants: Map<number, EntityState[]>,
  ): DarkGiftInfo | undefined {
    const pickFromGiftEntity = (ge: EntityState | undefined): DarkGiftInfo | undefined => {
      if (!ge?.cardId) return undefined;
      const cid = ge.cardId.replace(/e\d*$/i, '');
      const name = ge.name || cardName(cid) || cardName(ge.cardId) || '黑暗之赐';
      const note = cardNote(cid) || cardNote(ge.cardId) || '';
      return { cardId: cid, name, note };
    };

    const dgEid = num(tag(e, 'DARK_GIFT_ENTITY'), 0);
    if (dgEid > 0) {
      const hit = pickFromGiftEntity(this.entities.get(dgEid));
      if (hit) return hit;
    }

    const enchants = attachedEnchants.get(e.id) ?? [];
    for (const enc of enchants) {
      const isNightmare = tagOn(enc, 'IS_NIGHTMARE_BONUS') || /^EDR_100t/i.test(enc.cardId);
      if (!isNightmare) continue;
      const cid = num(tag(enc, 'CREATOR'), 0);
      if (cid > 0) {
        const hit = pickFromGiftEntity(this.entities.get(cid));
        if (hit) return hit;
      }
      const hit = pickFromGiftEntity(enc);
      if (hit) return hit;
    }

    const lastBy = num(tag(e, 'LAST_AFFECTED_BY'), 0);
    if (lastBy > 0) {
      const ge = this.entities.get(lastBy);
      if (ge && /^EDR_100t/i.test(ge.cardId)) {
        const hit = pickFromGiftEntity(ge);
        if (hit) return hit;
      }
    }

    if (tagOn(e, 'HAS_DARK_GIFT')) {
      return { cardId: '', name: '黑暗之赐', note: '已获黑暗之赐' };
    }
    return undefined;
  }

  private buildSide(playerEntityId: number, playerId: number, isLocal: boolean): SideState {
    const playerEntity = this.entities.get(playerEntityId);
    const heroEntityId = num(this.playerTagValue(playerId, 'HERO_ENTITY') ?? tag(playerEntity, 'HERO_ENTITY'), 0);
    const hero = heroEntityId ? this.entities.get(heroEntityId) : undefined;

    // 预收集附魔索引，用于精确解析手牌上的黑暗之赐
    const attachedEnchants = new Map<number, EntityState[]>();
    if (isLocal) {
      for (const ent of this.entities.values()) {
        if (tag(ent, 'CARDTYPE') !== 'ENCHANTMENT') continue;
        if (tag(ent, 'ZONE') === 'REMOVEDFROMGAME') continue;
        const targetId = num(tag(ent, 'ATTACHED'), 0);
        if (targetId <= 0) continue;
        const list = attachedEnchants.get(targetId) ?? [];
        list.push(ent);
        attachedEnchants.set(targetId, list);
      }
    }

    const minions: MinionView[] = [];
    const handCards: SideState['handCards'] = [];
    let handCount = 0;
    let coinCount = 0;
    let coinMana = 0;
    let spellPower = 0;
    let deckCount = 0;
    let secrets = 0;
    const auras: { cardId: string; name: string }[] = [];
    let weapon: SideState['weapon'] = null;
    let heroPower: HeroPowerView | null = null;
    let heroPowerEntityId = 0;

    for (const e of this.entities.values()) {
      if (e.id === playerEntityId || e.id === heroEntityId) continue;
      if (num(tag(e, 'CONTROLLER'), 0) !== playerId) continue;
      const zone = tag(e, 'ZONE');
      // 场上随从的法术伤害加成,对所有直伤生效
      if (zone === 'PLAY') spellPower += tagNum(e, 'SPELLPOWER', 0);

      if (zone === 'HAND') {
        handCount += 1;
        if (e.cardId) {
          const darkGift = isLocal ? this.resolveDarkGift(e, attachedEnchants) : undefined;
          handCards.push({
            id: e.id,
            cardId: e.cardId,
            // 先日志里的实体名，再回退卡表。
            //
            // **回退这一步 2026-11-14 补的**：原来只写 `e.name ?? ''`，
            // 而实测有一手牌 `cardId=CORE_DS1_185`（奥术射击，卡表里明明白白）读出来名字是空 ——
            // 起手摸到的牌在日志里常常只有 cardId、没有 entityName 标签。
            // 名字空了她就没法说「打奥术射击」，只能跳过这张，等于白丢一手牌。
            // 反过来也不能只用卡表：衍生物（`BE_327t`、`VAC_323t2`）卡表里查不到，
            // 只有日志的实体名能念出来。所以是「先实体名、再卡表」。
            name: e.name || cardName(e.cardId) || '',
            cost: tagNum(e, 'COST', 0),
            prepared: tagOn(e, 'PREPARE'),
            enteredTurn: e.enteredTurn,
            poweredUp: tagOn(e, 'POWERED_UP'),
            ...(darkGift ? { darkGift } : {}),
            ...(this.isEntityCreated(e) ? { created: true } : {}),
          });
          if (isCoinCard(e.cardId)) {
            coinCount += 1;
            // 硬币净赚 = 换到的 1 点 − 它自己的费用。被「手牌费用 +1」照过的
            // 硬币(COST 0→1)净赚 0,再往上加价就是负收益,取 0 不打它。
            coinMana += Math.max(0, 1 - tagNum(e, 'COST', 0));
          }
        }
        continue;
      }
      if (zone === 'DECK') { deckCount += 1; continue; }
      if (zone === 'SECRET') {
        secrets += 1;
        // 光环和奥秘同一个区:名字里带「光环」的挑出来单独记。
        // 名字取不到时退回卡表(起手摸到的实体常常只有 cardId)。
        const name = e.name || cardName(e.cardId ?? '') || '';
        if (/光环/.test(name)) auras.push({ cardId: e.cardId ?? '', name });
        continue;
      }
      if (zone !== 'PLAY') continue;
      const cardType = tag(e, 'CARDTYPE');
      if (cardType === 'MINION') {
        const maxHealth = tagNum(e, 'HEALTH', 0);
        const damage = tagNum(e, 'DAMAGE', 0);
        const race = tag(e, 'CARDRACE') || undefined;
        const created = this.isEntityCreated(e);
        const creatorName = this.entityCreatorName(e);
        minions.push({
          id: e.id,
          name: e.name,
          cardId: e.cardId,
          atk: tagNum(e, 'ATK', 0),
          health: Math.max(0, maxHealth - damage),
          maxHealth,
          taunt: tagOn(e, 'TAUNT'),
          divineShield: tagOn(e, 'DIVINE_SHIELD'),
          frozen: tagOn(e, 'FROZEN'),
          stealth: tagOn(e, 'STEALTH'),
          windfury: tagOn(e, 'WINDFURY'),
          poisonous: tagOn(e, 'POISONOUS'),
          lifesteal: tagOn(e, 'LIFESTEAL'),
          reborn: tagOn(e, 'REBORN'),
          rush: tagOn(e, 'RUSH'),
          charge: tagOn(e, 'CHARGE'),
          // DORMANT:休眠(醒来前打不出来);CANT_ATTACK:卡面「无法攻击」,如 1 费 4/5 的上古看守者
          cantAttack: tagOn(e, 'CANT_ATTACK') || tagOn(e, 'DORMANT'),
          spellPower: tagNum(e, 'SPELLPOWER', 0),
          canAttack: !tagOn(e, 'EXHAUSTED') && !tagOn(e, 'CANT_ATTACK') && !tagOn(e, 'DORMANT') && tagNum(e, 'ATK', 0) > 0,
          ...(race ? { race } : {}),
          ...(created ? { created: true } : {}),
          ...(creatorName ? { creatorName } : {}),
        });
      } else if (cardType === 'WEAPON') {
        weapon = {
          cardId: e.cardId ?? '',
          // 名字优先用日志里的;没有就查卡表 —— 装备那一刻实体的 name 常是空的
          name: e.name || cardName(e.cardId ?? '') || '未知武器',
          atk: tagNum(e, 'ATK', 0),
          durability: Math.max(0, tagNum(e, 'HEALTH', 0) - tagNum(e, 'DAMAGE', 0)),
          windfury: tagOn(e, 'WINDFURY'),
          hitsHero: !/无法攻击英雄/.test(cardNote(e.cardId ?? '') ?? ''),
        };
      } else if (cardType === 'HERO_POWER' && e.id >= heroPowerEntityId) {
        heroPowerEntityId = e.id;
        const hpCardId = e.cardId ?? '';
        const scriptNum1 = tagNum(e, 'TAG_SCRIPT_DATA_NUM_1', 0);
        const imbueSpec = IMBUE_HERO_POWERS[hpCardId];
        heroPower = {
          cardId: hpCardId,
          name: e.name || imbueSpec?.name || cardName(hpCardId) || '',
          cost: tagNum(e, 'COST', 2),
          exhausted: tagOn(e, 'EXHAUSTED'),
          scriptNum1,
          note: imbueSpec ? imbueSpec.note(scriptNum1) : cardNote(hpCardId),
        };
      }
    }

    minions.sort((a, b) => a.id - b.id);

    const maxHealth = tagNum(hero, 'HEALTH', 0);
    const heroDamage = tagNum(hero, 'DAMAGE', 0);
    const heroCardId = hero?.cardId ?? '';
    const resources = num(this.playerTagValue(playerId, 'RESOURCES'), 0);
    const used = num(this.playerTagValue(playerId, 'RESOURCES_USED'), 0);
    const temp = num(this.playerTagValue(playerId, 'TEMP_RESOURCES'), 0);
    const locked = num(this.playerTagValue(playerId, 'OVERLOAD_LOCKED'), 0);
    const comboActive = this.playerTagValue(playerId, 'COMBO_ACTIVE') === '1';
    const rawImbue = num(this.playerTagValue(playerId, 'IMBUE_COUNT'), 0);
    const hpImbue = heroPower && Object.hasOwn(IMBUE_HERO_POWERS, heroPower.cardId) ? heroPower.scriptNum1 : 0;
    const imbueCount = Math.max(rawImbue, hpImbue);

    return {
      playerId,
      isLocal,
      heroClass: classOfTagOrCard(tag(hero, 'CLASS'), heroCardId),
      heroName: hero?.name ?? '',
      heroCardId,
      health: Math.max(0, maxHealth - heroDamage),
      maxHealth,
      armor: tagNum(hero, 'ARMOR', 0),
      heroAttack: tagNum(hero, 'ATK', 0),
      // 风怒可能挂在英雄身上，也可能挂在武器上 —— 两个都读，谁有算谁。
      // 注意 weapon 是上面刚构造出来的对象（不是日志实体），所以读它的字段而不是 tagOn 它。
      heroWindfury: tagOn(hero, 'WINDFURY') || weapon?.windfury === true,
      fatigue: num(this.playerTagValue(playerId, 'FATIGUE'), 0),
      mana: Math.max(0, resources - used + temp - locked),
      manaMax: resources,
      overload: num(this.playerTagValue(playerId, 'OVERLOAD_OWED'), 0),
      handCount,
      handCards,
      coinCount,
      coinMana,
      spellPower,
      deckCount,
      secrets,
      auras,
      minions,
      weapon,
      playState: this.playerTagValue(playerId, 'PLAYSTATE') ?? '',
      mulliganState: this.playerTagValue(playerId, 'MULLIGAN_STATE') ?? '',
      comboActive,
      imbueCount,
      heroPower,
    };
  }

  /** 提取当前对局的原始记牌器数据（供 `tracker.ts` 汇总剩余牌库与对手情报）。 */
  trackerData(): TrackerRawData | null {
    if (!this.sawCreateGame) return null;
    if (!this.explicitLocalId && this.detectedLocalId === null) this.detectLocalByHand();
    const localId = this.localPlayerId();
    const foeId = localId === 1 ? 2 : 1;

    const snap = this.snapshot();
    const myClass = snap?.me.heroClass ?? '';
    const foeClass = snap?.opponent.heroClass ?? '';
    const myDeckCount = snap?.me.deckCount ?? 0;
    const foeDeckCount = snap?.opponent.deckCount ?? 0;

    const toCardEvent = (e: EntityState, turnOverride?: number): TrackerCardEvent => {
      const creatorName = this.entityCreatorName(e);
      return {
        entityId: e.id,
        cardId: e.cardId,
        name: e.name || cardName(e.cardId) || e.cardId || '未知的牌',
        cost: tagNum(e, 'COST', 0),
        turn: turnOverride ?? e.playedTurn ?? e.enteredTurn ?? this.turn,
        isCreated: this.isEntityCreated(e) || isCoinCard(e.cardId),
        ...(creatorName ? { creatorName } : {}),
      };
    };

    const drawnFromDeck: TrackerCardEvent[] = [];
    const myPlayed: TrackerCardEvent[] = [];
    const myGraveyard: TrackerCardEvent[] = [];
    const myKnownInDeck: TrackerCardEvent[] = [];
    const myHandCards: TrackerRawData['me']['handCards'] = [];

    const foePlayed: TrackerCardEvent[] = [];
    const foeGraveyardMinions: TrackerCardEvent[] = [];
    const foeGraveyardSpells: TrackerCardEvent[] = [];
    const foeSecrets: TrackerSecretInfo[] = [];
    const foeRevealedSecrets: TrackerCardEvent[] = [];
    const foeHandRaw: { pos: number; slot: TrackerHandSlot }[] = [];

    for (const e of this.entities.values()) {
      const controller = num(tag(e, 'CONTROLLER'), 0);
      if (controller !== localId && controller !== foeId) continue;
      const ct = tag(e, 'CARDTYPE');
      if (ct === 'GAME' || ct === 'PLAYER' || ct === 'HERO' || ct === 'HERO_POWER' || ct === 'ENCHANTMENT') continue;

      const zone = tag(e, 'ZONE') ?? '';
      const isCreated = this.isEntityCreated(e);

      if (controller === localId) {
        if (e.cardId) {
          if (!isCreated && !isCoinCard(e.cardId) && (e.wasInDeck || e.initialZone === 'DECK') && zone !== 'DECK') {
            drawnFromDeck.push(toCardEvent(e, e.enteredTurn ?? e.playedTurn ?? 0));
          }
          if (zone === 'DECK') {
            myKnownInDeck.push(toCardEvent(e));
          }
          if (e.everPlayed) {
            myPlayed.push(toCardEvent(e, e.playedTurn));
          }
          if (zone === 'GRAVEYARD') {
            myGraveyard.push(toCardEvent(e, e.graveyardTurn));
          }
          if (zone === 'HAND') {
            myHandCards.push({
              entityId: e.id,
              cardId: e.cardId,
              name: e.name || cardName(e.cardId) || e.cardId,
              cost: tagNum(e, 'COST', 0),
              isCreated: isCreated || isCoinCard(e.cardId),
            });
          }
        }
        continue;
      }

      // 对手
      if (zone === 'HAND') {
        const enteredTurn = e.enteredTurn ?? 0;
        const pos = tagNum(e, 'ZONE_POSITION', e.id);
        const creatorName = this.entityCreatorName(e);
        const likelyCoin = isCoinCard(e.cardId)
          || (!isCreated && !e.wasInDeck && e.initialZone === 'HAND' && enteredTurn === 0
            && this.firstPlayerId !== null && this.firstPlayerId > 0 && foeId !== this.firstPlayerId);
        const publicVisible = e.publicInHand === true && Boolean(e.cardId);
        foeHandRaw.push({
          pos,
          slot: {
            entityId: e.id,
            enteredTurn,
            heldTurns: Math.max(0, this.turn - enteredTurn),
            isCoin: likelyCoin,
            isCreated: isCreated && !likelyCoin,
            ...(creatorName ? { creatorName } : {}),
            ...(publicVisible ? { revealedCardId: e.cardId, revealedName: e.name || cardName(e.cardId) || '未知明牌' } : {}),
          },
        });
      }

      if (zone === 'SECRET') {
        const sName = e.name || cardName(e.cardId ?? '') || '';
        if (!/光环/.test(sName)) {
          foeSecrets.push({
            entityId: e.id,
            enteredTurn: e.enteredSecretTurn ?? 0,
            ...(e.cardId ? { cardId: e.cardId } : {}),
            ...(sName ? { name: sName } : {}),
          });
        }
      } else if (e.enteredSecretTurn !== undefined && e.cardId) {
        const sName = e.name || cardName(e.cardId) || '';
        if (!/光环/.test(sName)) foeRevealedSecrets.push(toCardEvent(e, e.graveyardTurn ?? e.enteredSecretTurn));
      }

      if (e.cardId && e.everPlayed) {
        foePlayed.push(toCardEvent(e, e.playedTurn));
      }
      if (e.cardId && zone === 'GRAVEYARD') {
        if (ct === 'MINION') foeGraveyardMinions.push(toCardEvent(e, e.graveyardTurn));
        else if (ct === 'SPELL') foeGraveyardSpells.push(toCardEvent(e, e.graveyardTurn));
      }
    }

    foeHandRaw.sort((a, b) => a.pos - b.pos || a.slot.entityId - b.slot.entityId);
    myPlayed.sort((a, b) => a.turn - b.turn || a.entityId - b.entityId);
    foePlayed.sort((a, b) => a.turn - b.turn || a.entityId - b.entityId);

    return {
      turn: this.turn,
      localPlayerId: localId,
      meta: { ...this.gameMeta },
      me: {
        heroClass: myClass,
        deckCount: myDeckCount,
        drawnFromDeck,
        playedCards: myPlayed,
        graveyardCards: myGraveyard,
        knownInDeck: myKnownInDeck,
        handCards: myHandCards,
      },
      opponent: {
        heroClass: foeClass,
        deckCount: foeDeckCount,
        playedCards: foePlayed,
        graveyardMinions: foeGraveyardMinions,
        graveyardSpells: foeGraveyardSpells,
        secrets: foeSecrets,
        revealedSecrets: foeRevealedSecrets,
        handCards: foeHandRaw.map((x) => x.slot),
      },
    };
  }
}

/** 场面的简短描述。 */
function boardSummary(side: SideState): string {
  if (!side.minions.length) return '空场';
  const atk = side.minions.reduce((sum, m) => sum + m.atk, 0);
  const hp = side.minions.reduce((sum, m) => sum + m.health, 0);
  return `${side.minions.length} 个(攻 ${atk}/血 ${hp})`;
}

/**
 * 场面攻击力合计。
 *
 * 英雄的攻击力和武器的攻击力**是同一个数**(装备武器后英雄的 ATK 就等于武器攻击),
 * 相加会让带武器的职业凭空多出一倍场攻 —— 实测:英雄 ATK=3、武器 ATK=3 时被算成 6。
 */
function sumAttack(side: SideState): number {
  let total = 0;
  // 打不到脸的武器(「无法攻击英雄」)不进合计:英雄那点攻击力本来就是它给的,
  // 它砍不到脸,英雄也砍不到
  if (side.weapon?.hitsHero !== false) {
    const swing = Math.max(side.heroAttack, side.weapon?.atk ?? 0);
    // **风怒要算两次。** 漏了这一下,场攻就少一半武器价值 ——
    // 2026-10-30 实测:风怒武器让英雄连砍两刀,系统只记一刀,她说「只凑出 3 点,他还剩 6」,
    // 实际正好 6 点够斩。
    total += side.heroWindfury ? swing * 2 : swing;
  }
  // 打不出来的随从(无法攻击/休眠)不计:它挂着 4 点攻击力,但一分伤害也打不出来。
  // 风怒随从同理要算两次(泰坦猛击者 6/6 风怒,只记 6 就少了一半)。
  for (const m of side.minions) {
    if (m.cantAttack) continue;
    total += m.windfury ? m.atk * 2 : m.atk;
  }
  return total;
}

/**
 * 数值怎么念给人看。
 *
 * 炉石把「无限」写成 `2147483647`（INT32_MAX）—— 实测「无穷之手」`END_012` 就是把
 * 随从和英雄的 ATK 直接设成这个数。原样念出去是「攻击力 2147483647」，
 * 2026-11-06 她就是这么说的（「写成二十多亿了，数字都溢出来了」），还以为是日志坏了。
 *
 * 这个数**算的时候不能改**：无限攻确实该按无限算。只在**念给人听**的时候换成 ∞。
 */
const HUGE = 2_000_000_000;
export const numText = (n: number): string => (n >= HUGE ? '∞' : String(n));

/** 把一份快照写成给模型读的中文段落。事实为主,不带建议口吻。 */
export function renderSnapshot(s: GameSnapshot): string {
  const side = (x: SideState, title: string): string => {
    const hp = x.armor ? `${numText(x.health)} 血 + ${numText(x.armor)} 护甲` : `${numText(x.health)} 血`;
    // 武器要带上效果原文。它挂在英雄身上、不占场面,攻击力常常是 0 ——
    // 只写「武器 X(0/3)」等于没说:实测那把黑暗帝国之刃每回合扣疲劳,
    // 场上一个随从都没有,场面数字全对,却解释不了血为什么一直掉。
    // 卡表里武器的摘要以身材开头(`0/0 效果…`),这里已经在括号里报过 0/3 了,
    // 不剥掉会念成「(0/3 0/0 在你的回合结束时…)」—— 数字看着像两把刀。
    const wNote = x.weapon ? cardNote(x.weapon.cardId).replace(/^\d+\/\d+\s*/, '') : '';
    const weapon = x.weapon
      ? `,武器 ${x.weapon.name}(${numText(x.weapon.atk)}/${numText(x.weapon.durability)}${x.heroWindfury ? ' **风怒·能砍两刀**' : ''}${wNote ? ` ${wNote}` : ''})`
      : '';
    const board = x.minions.length
      ? x.minions.map((m) => {
        const flags = [m.taunt ? '嘲讽' : '', m.divineShield ? '圣盾' : '', m.frozen ? '冻结' : '', m.stealth ? '潜行' : '', m.windfury ? '风怒' : ''].filter(Boolean).join('');
        return `${m.name || cardName(m.cardId ?? '') || '未知随从'}(${numText(m.atk)}/${numText(m.health)}${flags ? ` ${flags}` : ''})`;
      }).join('、')
      : '空场';
    const who = x.heroClass ? `${x.heroClass}${x.heroName ? `·${x.heroName}` : ''}` : '职业未知';
    return `${title}:${who},${hp},${x.mana}/${x.manaMax} 水晶,手牌 ${x.handCount} 张,牌库 ${x.deckCount} 张${x.secrets ? `,奥秘 ${x.secrets} 个` : ''}${x.fatigue ? `,疲劳 ${x.fatigue}` : ''}${weapon}\n  场面:${board}`;
  };
  const lines = [
    side(s.me, '我'),
    side(s.opponent, '对手'),
    `第 ${s.turn} 回合,${s.isMyTurn ? '轮到我行动' : '轮到对手'}${s.step ? `(${s.step})` : ''};场攻合计 我 ${numText(s.boardAttack.mine)} / 对手 ${numText(s.boardAttack.theirs)}`,
  ];
  if (s.ended) {
    const label = s.result === 'won' ? '赢' : s.result === 'lost' ? '输' : s.result === 'tied' ? '平局' : '结束';
    lines.push(`这局已结束:${label}`);
  }
  return lines.join('\n');
}
