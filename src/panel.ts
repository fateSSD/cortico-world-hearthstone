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
import { briefAdvice } from './advice.ts';

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
  /**
   * 现在按谁的习惯解说。
   *
   * 单独一个字段而不是塞进 `auto`：那三个是「她开不开口」，
   * 这个是「她站在谁的立场上」—— 关掉自动开口（quiet）之后这一项照样有用。
   */
  voice: 'mine' | 'his';
  /**
   * 「他那边」有没有东西可读。
   *
   * 注意它说的是**他那一份在不在**，不是「当前立场有没有内容」——
   * 一开始我写成后者，结果在当前处于 `mine` 时它恒为 true，
   * 前端拿它给「你的」按钮做提示，正好把「那边是空的」说成了「有」。
   * 没打过局就没有档案，这时她按「他习惯怎么打」只能老实说不知道，
   * 面板要把这件事露出来 —— 否则切过去一句话没变，看着像按钮坏了。
   */
  hisReady: boolean;
  /**
   * 她最近想到的几条（新的在前）。
   *
   * 面板上只显示 3 条：这是「她这两天在琢磨什么」，不是日志。
   * 想看全部就打开日记目录 —— 那儿一份不少。
   */
  thoughts?: { at: string; text: string; where?: string }[];
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
export function panelAdvice(snapshot: GameSnapshot | null, keepCards: string): PanelAdvice | null {
  if (!snapshot || snapshot.ended) return null;
  const a = briefAdvice(snapshot, { keepCards });
  return { kind: a.kind, text: a.text, face: a.face ?? null };
}

export function panelStatus(
  snapshot: GameSnapshot | null,
  watch: { phase: PanelPhase; path: string | null; note: string },
  cfg: PanelCfg,
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
