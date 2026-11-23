/**
 * 记牌器汇总引擎：把 PowerLogParser 的原始追踪 + 基准套牌（导入卡组代码 / 竞技场选牌）
 * 汇总为我方剩余牌库（含抽牌概率）、已打/已抽/墓地记录，以及对手已交/手牌滞留/奥秘线索。
 *
 * 诚实边界：
 *   · 有基准套牌（导入卡组或竞技场选牌）时，算得出每张牌库剩余张数和单抽概率；
 *   · 没有基准套牌时，绝不编造牌库里还没抽到的牌，只列确定见到过的牌。
 */
import { resolveArenaCard } from './arena.ts';
import type { DecodedDeck } from './deck-code.ts';
import { lookupDamageCard } from './damage.ts';
import { cardCostOf, cardName, cardNote, isLegendary } from './effects.ts';
import type { GameMeta, TrackerCardEvent, TrackerHandSlot, TrackerRawData, TrackerSecretInfo } from './parser.ts';
import { arenaModeFromMeta } from './progress.ts';
import { renderMatchupSummary, type ArchetypeMatch } from './archetypes.ts';

export interface RemainingDeckItem {
  cardId: string;
  name: string;
  cost: number;
  left: number;
  total: number;
  note: string;
  /** 单抽命中率（0..1）；未知卡组为 0。 */
  drawProb: number;
  /** 本局中衍生洗入牌库的牌（非原始构筑自带）。 */
  extraCreated?: boolean;
}

export interface TallyCardItem {
  cardId: string;
  name: string;
  cost: number;
  count: number;
  note: string;
  isCreated?: boolean;
  creatorName?: string;
}

export interface TrackerSnapshot {
  turn: number;
  meta: GameMeta;
  deckSource: 'imported' | 'arena' | 'none';
  deckName: string;
  deckMismatch: boolean;
  me: {
    heroClass: string;
    deckCount: number;
    remainingDeck: RemainingDeckItem[];
    drawnCards: TallyCardItem[];
    playedCards: TallyCardItem[];
    graveyardCards: TallyCardItem[];
    /** 有完整牌表时是否仍有重复牌（用于判断宇宙战吼前提）。无完整牌表时为 undefined。 */
    hasDuplicates?: boolean;
    /** 牌库里确定还剩下的直伤法术总伤与张数。 */
    remainingBurstDamage: number;
    remainingBurstCount: number;
    /** 牌库里还剩下的群伤/单解/过牌清单。 */
    remainingAoe: RemainingDeckItem[];
    remainingRemoval: RemainingDeckItem[];
    remainingDraw: RemainingDeckItem[];
  };
  opponent: {
    heroClass: string;
    deckCount: number;
    deckSource: 'imported' | 'none';
    deckName: string;
    deckMismatch: boolean;
    remainingDeck: RemainingDeckItem[];
    initialPlayed: TallyCardItem[];
    createdPlayed: TallyCardItem[];
    keyCardsUsed: TallyCardItem[];
    graveyardMinions: TallyCardItem[];
    secrets: TrackerSecretInfo[];
    revealedSecrets: TallyCardItem[];
    handCards: TrackerHandSlot[];
  };
}

const VARIANT_PREFIX = /^(?:CORE_|VAN_|VANILLA_|TUTORIAL_)/;
const bareId = (id: string): string => id.replace(VARIANT_PREFIX, '');

function tallyEvents(events: readonly TrackerCardEvent[]): TallyCardItem[] {
  const map = new Map<string, TallyCardItem>();
  for (const ev of events) {
    const key = `${ev.cardId}|${ev.isCreated ? 1 : 0}|${ev.creatorName ?? ''}`;
    const prev = map.get(key);
    const note = cardNote(ev.cardId);
    const cost = ev.cost || (cardCostOf(ev.cardId) ?? 0);
    const name = ev.name || cardName(ev.cardId) || ev.cardId;
    if (prev) {
      prev.count += 1;
    } else {
      map.set(key, {
        cardId: ev.cardId,
        name,
        cost,
        count: 1,
        note,
        ...(ev.isCreated ? { isCreated: true } : {}),
        ...(ev.creatorName ? { creatorName: ev.creatorName } : {}),
      });
    }
  }
  return [...map.values()].sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'zh'));
}

function isKeyCard(item: TallyCardItem): boolean {
  if (/伤害\s*\d+\s*群|消灭|变形|沉默/.test(item.note)) return true;
  if (isLegendary(item.cardId)) return true;
  const dmg = lookupDamageCard(item.cardId);
  if (dmg && dmg.damage >= 3) return true;
  const heal = /奶\s*(\d+)/.exec(item.note);
  if (heal && Number(heal[1]) >= 5) return true;
  const armor = /甲\s*(\d+)/.exec(item.note);
  if (armor && Number(armor[1]) >= 5) return true;
  return false;
}

export function buildTrackerSnapshot(
  raw: TrackerRawData,
  opts: { importedDeck?: DecodedDeck | null; oppImportedDeck?: DecodedDeck | null; arenaDeck?: readonly string[] } = {},
): TrackerSnapshot {
  const isArena = arenaModeFromMeta(raw.meta) !== null;
  let deckSource: TrackerSnapshot['deckSource'] = 'none';
  let deckName = '';
  let deckMismatch = false;

  const baseCounts = new Map<string, { cardId: string; name: string; cost: number; total: number; note: string }>();

  if (isArena && opts.arenaDeck && opts.arenaDeck.length > 0) {
    deckSource = 'arena';
    deckName = '当前竞技场套牌';
    for (const rawName of opts.arenaDeck) {
      const resolved = resolveArenaCard(rawName);
      const cid = resolved?.found ? resolved.id : rawName;
      const name = resolved?.found ? resolved.name : rawName;
      const cost = resolved?.found ? resolved.cost : (cardCostOf(cid) ?? 0);
      const note = resolved?.found ? resolved.note : cardNote(cid);
      const k = bareId(cid) || name;
      const prev = baseCounts.get(k);
      if (prev) prev.total += 1;
      else baseCounts.set(k, { cardId: cid, name, cost, total: 1, note });
    }
  } else if (opts.importedDeck && opts.importedDeck.cards.length > 0) {
    const imp = opts.importedDeck;
    if (imp.heroClass && raw.me.heroClass && imp.heroClass !== raw.me.heroClass) {
      deckMismatch = true;
    } else {
      deckSource = 'imported';
      deckName = imp.name;
      for (const c of imp.cards) {
        const k = bareId(c.cardId) || c.name;
        const prev = baseCounts.get(k);
        if (prev) prev.total += c.count;
        else baseCounts.set(k, { cardId: c.cardId, name: c.name, cost: c.cost, total: c.count, note: c.note });
      }
    }
  }

  const remainingDeck: RemainingDeckItem[] = [];
  let hasDuplicates: boolean | undefined;

  if (deckSource !== 'none') {
    const drawnCount = new Map<string, number>();
    for (const ev of raw.me.drawnFromDeck) {
      if (ev.isCreated) continue;
      const k = bareId(ev.cardId) || ev.name;
      drawnCount.set(k, (drawnCount.get(k) ?? 0) + 1);
    }

    const totalDeck = Math.max(0, raw.me.deckCount);
    for (const [k, base] of baseCounts) {
      const drawn = drawnCount.get(k) ?? 0;
      const left = Math.max(0, base.total - drawn);
      if (left <= 0) continue;
      remainingDeck.push({
        cardId: base.cardId,
        name: base.name,
        cost: base.cost,
        left,
        total: base.total,
        note: base.note,
        drawProb: totalDeck > 0 ? Math.min(1, left / totalDeck) : 0,
      });
    }

    // 额外洗入牌库的已知牌（含衍生洗入）
    const extraInDeck = new Map<string, { cardId: string; name: string; cost: number; count: number; note: string }>();
    for (const ev of raw.me.knownInDeck) {
      if (!ev.isCreated) continue;
      const k = bareId(ev.cardId) || ev.name;
      const prev = extraInDeck.get(k);
      const cost = ev.cost || (cardCostOf(ev.cardId) ?? 0);
      if (prev) prev.count += 1;
      else extraInDeck.set(k, { cardId: ev.cardId, name: ev.name, cost, count: 1, note: cardNote(ev.cardId) });
    }
    for (const ex of extraInDeck.values()) {
      remainingDeck.push({
        cardId: ex.cardId,
        name: ex.name,
        cost: ex.cost,
        left: ex.count,
        total: ex.count,
        note: ex.note,
        drawProb: totalDeck > 0 ? Math.min(1, ex.count / totalDeck) : 0,
        extraCreated: true,
      });
    }
    remainingDeck.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'zh'));

    // 判断牌库目前是否还有重复牌：仅当基础牌数至少接近完整构筑（>=15 张）才给确定布尔值，避免选一半竞技场卡组误判
    const baseTotal = [...baseCounts.values()].reduce((n, x) => n + x.total, 0);
    if (baseTotal >= 15) {
      hasDuplicates = remainingDeck.some((x) => x.left >= 2);
    }
  } else {
    // 无基准牌表：把目前确定洗入/已知留在牌库里的牌也列出来（比如可交易洗回/翡翠传送门）
    const knownTally = tallyEvents(raw.me.knownInDeck);
    const totalDeck = Math.max(0, raw.me.deckCount);
    for (const item of knownTally) {
      remainingDeck.push({
        cardId: item.cardId,
        name: item.name,
        cost: item.cost,
        left: item.count,
        total: item.count,
        note: item.note,
        drawProb: totalDeck > 0 ? Math.min(1, item.count / totalDeck) : 0,
        extraCreated: Boolean(item.isCreated),
      });
    }
  }

  let remainingBurstDamage = 0;
  let remainingBurstCount = 0;
  const remainingAoe: RemainingDeckItem[] = [];
  const remainingRemoval: RemainingDeckItem[] = [];
  const remainingDraw: RemainingDeckItem[] = [];

  if (deckSource !== 'none') {
    for (const item of remainingDeck) {
      const dmg = lookupDamageCard(item.cardId);
      if (dmg) {
        remainingBurstDamage += dmg.damage * item.left;
        remainingBurstCount += item.left;
      }
      if (/伤害\s*\d+\s*群/.test(item.note)) {
        remainingAoe.push(item);
      }
      if (/伤害\s*\d+|消灭|变形/.test(item.note)) {
        remainingRemoval.push(item);
      }
      if (/抽\s*\d+/.test(item.note) || (/抽/.test(item.note) && /牌/.test(item.note))) {
        remainingDraw.push(item);
      }
    }
  }

  const initialPlayed = tallyEvents(raw.opponent.playedCards.filter((c) => !c.isCreated));
  const createdPlayed = tallyEvents(raw.opponent.playedCards.filter((c) => c.isCreated));
  const allFoeRevealed = tallyEvents([
    ...raw.opponent.playedCards,
    ...raw.opponent.graveyardSpells,
    ...raw.opponent.revealedSecrets,
  ]);
  const keyCardsUsed = allFoeRevealed.filter(isKeyCard);

  let oppDeckSource: 'imported' | 'none' = 'none';
  let oppDeckName = '';
  let oppDeckMismatch = false;
  const oppRemainingDeck: RemainingDeckItem[] = [];
  if (!isArena && opts.oppImportedDeck && opts.oppImportedDeck.cards.length > 0) {
    const oppImp = opts.oppImportedDeck;
    if (oppImp.heroClass && raw.opponent.heroClass && oppImp.heroClass !== raw.opponent.heroClass) {
      oppDeckMismatch = true;
    } else {
      oppDeckSource = 'imported';
      oppDeckName = oppImp.name;
      const oppPlayedMap = new Map<string, number>();
      for (const ev of initialPlayed) {
        const k = bareId(ev.cardId) || ev.name;
        oppPlayedMap.set(k, (oppPlayedMap.get(k) ?? 0) + ev.count);
      }
      const oppTotalDeck = Math.max(0, raw.opponent.deckCount);
      for (const c of oppImp.cards) {
        const k = bareId(c.cardId) || c.name;
        const used = oppPlayedMap.get(k) ?? 0;
        const left = Math.max(0, c.count - used);
        if (left <= 0) continue;
        oppRemainingDeck.push({
          cardId: c.cardId,
          name: c.name,
          cost: c.cost,
          left,
          total: c.count,
          note: c.note,
          drawProb: oppTotalDeck > 0 ? Math.min(1, left / oppTotalDeck) : 0,
        });
      }
      oppRemainingDeck.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'zh'));
    }
  }

  return {
    turn: raw.turn,
    meta: raw.meta,
    deckSource,
    deckName,
    deckMismatch,
    me: {
      heroClass: raw.me.heroClass,
      deckCount: raw.me.deckCount,
      remainingDeck,
      drawnCards: tallyEvents(raw.me.drawnFromDeck),
      playedCards: tallyEvents(raw.me.playedCards),
      graveyardCards: tallyEvents(raw.me.graveyardCards),
      hasDuplicates,
      remainingBurstDamage,
      remainingBurstCount,
      remainingAoe,
      remainingRemoval,
      remainingDraw,
    },
    opponent: {
      heroClass: raw.opponent.heroClass,
      deckCount: raw.opponent.deckCount,
      deckSource: oppDeckSource,
      deckName: oppDeckName,
      deckMismatch: oppDeckMismatch,
      remainingDeck: oppRemainingDeck,
      initialPlayed,
      createdPlayed,
      keyCardsUsed,
      graveyardMinions: tallyEvents(raw.opponent.graveyardMinions),
      secrets: raw.opponent.secrets,
      revealedSecrets: tallyEvents(raw.opponent.revealedSecrets),
      handCards: raw.opponent.handCards,
    },
  };
}

/** 生成给克罗艾读的记牌器汇总文本（事实为主、禁止编造未知牌库底）。 */
export function renderTrackerForModel(
  t: TrackerSnapshot,
  opts: { progressBrief?: string; matchup?: ArchetypeMatch | null } = {},
): string {
  const lines: string[] = [];
  if (opts.progressBrief) lines.push(`模式与战绩：${opts.progressBrief}`);

  if (t.deckSource !== 'none') {
    const srcLabel = t.deckSource === 'arena' ? '竞技场已选牌组' : `已导入卡组「${t.deckName}」`;
    lines.push(`【我方牌库剩余】（${srcLabel}，日志显示牌库剩 ${t.me.deckCount} 张）`);
    if (t.me.remainingDeck.length) {
      const items = t.me.remainingDeck.map(
        (c) => `${c.cost}费 ${c.name}×${c.left}(${Math.round(c.drawProb * 100)}%)${c.extraCreated ? '[洗入]' : ''}`,
      );
      lines.push(`  ${items.join('、')}`);
    } else {
      lines.push('  剩余明细为空（可能已抽完或已全打出）。');
    }
    const summaryBits: string[] = [];
    if (t.me.remainingBurstCount) summaryBits.push(`直伤法术 ${t.me.remainingBurstCount} 张(合计 ${t.me.remainingBurstDamage} 伤)`);
    if (t.me.remainingAoe.length) summaryBits.push(`群伤 ${t.me.remainingAoe.reduce((n, x) => n + x.left, 0)} 张`);
    if (t.me.hasDuplicates !== undefined) summaryBits.push(t.me.hasDuplicates ? '牌库仍有重复牌' : '牌库无重复牌(宇宙可用)');
    if (summaryBits.length) lines.push(`  核心资源：${summaryBits.join(' · ')}`);
  } else {
    const mismatchNote = t.deckMismatch ? '（当前导入的卡组代码职业与本局不符，已忽略）' : '（未导入卡组代码，看不到牌库里还没抽到的牌）';
    lines.push(`【我方已见牌】${mismatchNote} 牌库剩 ${t.me.deckCount} 张`);
    if (t.me.drawnCards.length) {
      lines.push(`  已抽/出：${t.me.drawnCards.map((c) => `${c.name}${c.count > 1 ? `×${c.count}` : ''}`).join('、')}`);
    }
    if (t.me.remainingDeck.length) {
      lines.push(`  已知仍在牌库：${t.me.remainingDeck.map((c) => `${c.name}×${c.left}`).join('、')}`);
    }
  }

  lines.push('', `【对手记牌】（手牌 ${t.opponent.handCards.length} 张 / 牌库 ${t.opponent.deckCount} 张）`);
  if (t.opponent.initialPlayed.length) {
    lines.push(`  已出原生牌：${t.opponent.initialPlayed.map((c) => `${c.cost}费 ${c.name}${c.count > 1 ? `×${c.count}` : ''}`).join('、')}`);
  } else {
    lines.push('  已出原生牌：暂无');
  }
  if (t.opponent.createdPlayed.length) {
    lines.push(`  已出衍生牌：${t.opponent.createdPlayed.map((c) => `${c.name}${c.count > 1 ? `×${c.count}` : ''}${c.creatorName ? `(来自${c.creatorName})` : ''}`).join('、')}`);
  }
  if (t.opponent.keyCardsUsed.length) {
    lines.push(`  已交关键解/威胁：${t.opponent.keyCardsUsed.map((c) => `${c.name}×${c.count}`).join('、')}`);
  }
  if (t.opponent.secrets.length) {
    lines.push(`  未触发奥秘：${t.opponent.secrets.length} 个（${t.opponent.secrets.map((s) => `T${s.enteredTurn}挂`).join('、')}）`);
  }
  if (t.opponent.revealedSecrets.length) {
    lines.push(`  已触发奥秘：${t.opponent.revealedSecrets.map((s) => `${s.name}×${s.count}`).join('、')}`);
  }
  if (t.opponent.handCards.length) {
    const slots = t.opponent.handCards.map((h, i) => {
      if (h.revealedName) return `#${i + 1}:${h.revealedName}[明牌]`;
      if (h.isCoin) return `#${i + 1}:硬币`;
      const src = h.isCreated ? (h.creatorName ? `衍生(${h.creatorName})` : '衍生') : '抽';
      return `#${i + 1}:T${h.enteredTurn}${src}(留${h.heldTurns}回合)`;
    });
    lines.push(`  对手手牌位置：${slots.join(' | ')}`);
  }

  if (opts.matchup) {
    const mText = renderMatchupSummary(opts.matchup, t.opponent.heroClass);
    if (mText) lines.push('', mText);
  }
  return lines.join('\n');
}

/**
 * 给常驻环境变量 `{{hs.tracker}}` 用的精简摘要（P2-⑨ 省上下文，不逐张展开完整牌库明细）。
 *
 * 完整逐张剩余牌库与抽牌概率留给按需调用的 `hearthstone_tracker`。
 */
export function renderTrackerForPrompt(
  t: TrackerSnapshot,
  opts: { progressBrief?: string; matchup?: ArchetypeMatch | null } = {},
): string {
  const lines: string[] = [];
  if (opts.progressBrief) lines.push(`模式与战绩：${opts.progressBrief}`);

  if (t.deckSource !== 'none') {
    const srcLabel = t.deckSource === 'arena' ? '竞技场已选牌组' : `已导入卡组「${t.deckName}」`;
    const bits: string[] = [`余 ${t.me.deckCount} 张`];
    if (t.me.remainingBurstCount) bits.push(`直伤 ${t.me.remainingBurstCount} 张(${t.me.remainingBurstDamage}伤)`);
    if (t.me.remainingAoe.length) {
      bits.push(`清场 ${t.me.remainingAoe.slice(0, 2).map((x) => `${x.name}×${x.left}(${Math.round(x.drawProb * 100)}%)`).join('、')}`);
    }
    if (t.me.hasDuplicates !== undefined) bits.push(t.me.hasDuplicates ? '非宇宙' : '宇宙就绪');
    lines.push(`我方记牌（${srcLabel}）：${bits.join(' · ')}（逐张明细查 hearthstone_tracker）。`);
  } else {
    const tip = t.deckMismatch ? '已导入卡组职业与本局不符(已忽略)' : '未导入卡组(未知牌库底)';
    const known = t.me.remainingDeck.length
      ? `;已知洗入：${t.me.remainingDeck.slice(0, 3).map((c) => `${c.name}×${c.left}`).join('、')}`
      : '';
    lines.push(`我方记牌（${tip}）：牌库余 ${t.me.deckCount} 张${known}。`);
  }

  const oppBits: string[] = [`手牌 ${t.opponent.handCards.length} 张 / 牌库 ${t.opponent.deckCount} 张`];
  if (t.opponent.secrets.length) oppBits.push(`奥秘 ${t.opponent.secrets.length} 个`);
  const revealed = t.opponent.handCards.filter((h) => h.revealedName).map((h) => `${h.revealedName}[明牌]`);
  if (revealed.length) oppBits.push(`明牌：${revealed.join('、')}`);
  if (t.opponent.keyCardsUsed.length) {
    oppBits.push(`已交关键：${t.opponent.keyCardsUsed.slice(0, 4).map((c) => `${c.name}×${c.count}`).join('、')}`);
  }
  lines.push(`对手记牌：${oppBits.join(' · ')}`);

  if (opts.matchup) {
    const mText = renderMatchupSummary(opts.matchup, t.opponent.heroClass);
    if (mText) lines.push(mText);
  }
  return lines.join('\n');
}
