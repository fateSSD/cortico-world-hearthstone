/**
 * 扩展页那块「陪打」面板的数据面。
 *
 * 为什么单独做一块面板:设置页只是**接入**用的,他一天真正要点几十次的是两件事——
 * 「现在什么情况」和「这回合怎么打」。所以把这两件提成一个面板:上面一行状态,
 * 中间一个按钮,下面一行建议。
 *
 * 非自动模式(mode=quiet)下,这个按钮就是唯一的问法 —— 他不用再去聊天框打字。
 */
import type { GameSnapshot } from './parser.ts';
import { briefAdvice, type AdviceOptions } from './advice.ts';

/** 面板要的那一份建议。字段少而全:kind 决定配色,face 给她换成同一张脸。 */
/** 日志读到哪里了。和 world.ts 的 Phase 同一套值 —— 面板据此决定画什么。 */
export type PanelPhase = 'no-log' | 'watching' | 'in-game' | 'ended';

export interface PanelAdvice {
  kind: 'lethal' | 'danger' | 'trade' | 'develop' | 'hold' | 'idle';
  text: string;
  face: string | null;
}

export interface PanelSide {
  cls: string;
  hp: number;
  armor: number;
}

export interface PanelMe extends PanelSide {
  mana: number;
  manaMax: number;
  hand: number;
  deck: number;
}

export interface PanelFoe extends PanelSide {
  /** 对面场上攻击力合计 —— 「他下回合能砸多少」里最直观的那一个数。 */
  boardAttack: number;
  minions: number;
}

export interface PanelProgressView {
  brief: string;
  ladderFormat: 'standard' | 'wild' | 'twist';
  ladderText: string;
  arenaMode: 'arena' | 'underground';
  arenaText: string;
}

export interface SavedDeckSummary {
  id: string;
  name: string;
  heroClass: string;
  active: boolean;
}

export interface PanelTrackerView {
  inGame: boolean;
  hasImportedDeck?: boolean;
  deckSource: 'imported' | 'arena' | 'none';
  deckName: string;
  deckMismatch: boolean;
  myClass?: string;
  oppClass?: string;
  oppDeckCount?: number;
  oppHandCount?: number;
  savedDecks?: SavedDeckSummary[];
  activeDeckId?: string | null;
  hasOppImportedDeck?: boolean;
  oppDeckSource?: 'imported' | 'none';
  oppDeckName?: string;
  oppDeckMismatch?: boolean;
  oppSavedDecks?: SavedDeckSummary[];
  oppActiveDeckId?: string | null;
  oppRemaining?: {
    cardId: string;
    name: string;
    cost: number;
    left: number;
    total: number;
    prob: number;
  }[];
  myRemainingCount: number;
  myRemaining: {
    cardId: string;
    name: string;
    cost: number;
    left: number;
    total: number;
    prob: number;
    extraCreated?: boolean;
  }[];
  myPlayed: { name: string; cost: number; count: number }[];
  oppPlayed: { name: string; cost: number; count: number; created: boolean }[];
  oppHand: {
    slot: number;
    enteredTurn: number;
    age: number;
    created: boolean;
    isCoin: boolean;
    revealedName?: string;
    creatorName?: string;
  }[];
  oppSecrets: number;
  hasDuplicates?: boolean;
  remainingBurstDamage: number;
  remainingBurstCount: number;
  matchupBrief?: string;
}

export interface PanelStatus {
  phase: PanelPhase;
  /** 一句话说清现在能不能看见对局。面板上没有别的地方放这句话。 */
  note: string;
  turn: number | null;
  myTurn: boolean;
  ended: boolean;
  me: PanelMe | null;
  foe: PanelFoe | null;
  auto: {
    mode: 'normal' | 'quiet';
    speakTurns: boolean;
    speakAlerts: boolean;
  };
  voice: 'mine' | 'his';
  hisReady: boolean;
  thoughts?: { at: string; text: string; where?: string }[];
  /** 当前模式短标签（标准/狂野/地下竞技场等）。 */
  modeLabel?: string;
  /** 天梯段位与竞技场战绩进度。 */
  progress?: PanelProgressView;
  /** 记牌器快照。 */
  tracker?: PanelTrackerView;
}

export interface PanelCfg {
  mode: 'normal' | 'quiet';
  speakTurns: boolean;
  speakAlerts: boolean;
  keepCards: string;
  voice: 'mine' | 'his';
  /** 他的那份档案在不在。由调用方读盘决定 —— 这个模块不碰文件系统。 */
  hisReady?: boolean;
}

/**
 * 面板建议。和回合事件用同一个 `briefAdvice` ——
 * 两处各写一套的话,「点按钮看到的」和「她自己说的」会打架。
 */
export function panelAdvice(
  snapshot: GameSnapshot | null,
  keepCards: string,
  extra?: Pick<AdviceOptions, 'tracker' | 'matchupHint'>,
): PanelAdvice | null {
  if (!snapshot || snapshot.ended) return null;
  const a = briefAdvice(snapshot, { keepCards, ...extra });
  return { kind: a.kind, text: a.text, face: a.face ?? null };
}

export function panelStatus(
  snapshot: GameSnapshot | null,
  watch: { phase: PanelPhase; path: string | null; note: string },
  cfg: PanelCfg,
  extra?: { modeLabel?: string; progress?: PanelProgressView; tracker?: PanelTrackerView },
): PanelStatus {
  const auto = { mode: cfg.mode, speakTurns: cfg.speakTurns, speakAlerts: cfg.speakAlerts };
  const base: PanelStatus = {
    phase: watch.path ? watch.phase : 'no-log',
    note: watch.note,
    turn: null,
    myTurn: false,
    ended: false,
    me: null,
    foe: null,
    auto,
    voice: cfg.voice,
    hisReady: Boolean(cfg.hisReady),
    ...(extra?.modeLabel ? { modeLabel: extra.modeLabel } : {}),
    ...(extra?.progress ? { progress: extra.progress } : {}),
    ...(extra?.tracker ? { tracker: extra.tracker } : {}),
  };
  if (!snapshot) return base;

  return {
    ...base,
    turn: snapshot.turn,
    myTurn: snapshot.isMyTurn,
    ended: snapshot.ended,
    me: {
      cls: snapshot.me.heroClass,
      hp: snapshot.me.health,
      armor: snapshot.me.armor,
      mana: snapshot.me.mana,
      manaMax: snapshot.me.manaMax,
      hand: snapshot.me.handCards.length || snapshot.me.handCount,
      deck: snapshot.me.deckCount,
    },
    foe: {
      cls: snapshot.opponent.heroClass,
      hp: snapshot.opponent.health,
      armor: snapshot.opponent.armor,
      boardAttack: snapshot.boardAttack.theirs,
      minions: snapshot.opponent.minions.length,
    },
  };
}

/**
 * 点按钮时推给她的事件正文。
 *
 * 只给事实和机械建议,不替她组织语言 —— 那是她的活。
 * 但必须说清「这是他主动问的」:否则她会以为自己在自动播报,语气收不住。
 */
export function panelAskText(snapshot: GameSnapshot, advice: PanelAdvice): string {
  const me = snapshot.me;
  const foe = snapshot.opponent;
  const mine = me.armor ? `${me.health} 血 + ${me.armor} 护甲` : `${me.health} 血`;
  const theirs = foe.armor ? `${foe.health} 血 + ${foe.armor} 护甲` : `${foe.health} 血`;
  return [
    `第 ${snapshot.turn} 回合${snapshot.isMyTurn ? ',轮到我' : ',现在是对手回合'};我 ${mine}、手牌 ${me.handCount} 张、${me.mana}/${me.manaMax} 水晶;对手 ${theirs}、场面 ${foe.minions.length} 个(场攻 ${snapshot.boardAttack.theirs})。`,
    '他在扩展页上点了「让她看这回合」——这不是自动播报,是他主动问的。用一两句话说清这回合打什么。',
    `机械建议:${advice.text}`,
  ].join('\n');
}
