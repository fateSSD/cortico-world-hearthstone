/**
 * 天梯等级与竞技场输赢进度追踪（持久化在 dataDir/hearthstone-progress.json）。
 *
 * 设计原则（诚实认知论）：
 *   1. Power.log 只有 GameType / FormatType / 胜负，没有暴雪服务器段的段位与星数。
 *   2. 竞技场只要开着扩展打，从 0-0 起按局累计是准确的（支持中途手动校准起始胜负）。
 *   3. 天梯段位由玩家填入起始段位后按标准规则推算，并始终标记为「参考推算」且可随时校准；
 *      未设置起始段位时，只报真实记录到的「模式 + 胜负场次 / 连胜」。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GameMeta } from './parser.ts';

export type LadderFormat = 'standard' | 'wild' | 'twist';
export type LeagueName = '青铜' | '白银' | '黄金' | '白金' | '钻石' | '传说';
export type ArenaMode = 'arena' | 'underground';

export interface LadderTrack {
  rankText: string | null;
  league?: LeagueName;
  tier?: number;
  stars?: number;
  legendRank?: number;
  starBonus: number;
  wins: number;
  losses: number;
  streak: number;
  updatedAt: string;
  estimated: boolean;
}

export interface ArenaRun {
  mode: ArenaMode;
  wins: number;
  losses: number;
  maxWins: number;
  maxLosses: number;
  heroClass: string;
  active: boolean;
  calibrated: boolean;
  startedAt: string;
  updatedAt: string;
}

export interface ArenaArchiveItem {
  mode: ArenaMode;
  wins: number;
  losses: number;
  heroClass: string;
  startedAt: string;
  endedAt: string;
}

export interface ProgressState {
  ladder: Record<LadderFormat, LadderTrack>;
  arena: ArenaRun | null;
  arenaHistory: ArenaArchiveItem[];
  recordedGameKeys: string[];
}

const LEAGUES: readonly LeagueName[] = ['青铜', '白银', '黄金', '白金', '钻石', '传说'];
const STARS_PER_TIER = 3;
const MAX_RECORDED_KEYS = 120;
const MAX_ARENA_HISTORY = 10;

function writeAtomicSync(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

function emptyTrack(): LadderTrack {
  return {
    rankText: null,
    starBonus: 1,
    wins: 0,
    losses: 0,
    streak: 0,
    updatedAt: '',
    estimated: false,
  };
}

export function defaultProgress(): ProgressState {
  return {
    ladder: {
      standard: emptyTrack(),
      wild: emptyTrack(),
      twist: emptyTrack(),
    },
    arena: null,
    arenaHistory: [],
    recordedGameKeys: [],
  };
}

export function ladderFormatFromMeta(meta?: Partial<GameMeta>): LadderFormat {
  const f = (meta?.formatType ?? '').toUpperCase();
  if (f === 'FT_WILD') return 'wild';
  if (f === 'FT_TWIST') return 'twist';
  return 'standard';
}

export function arenaModeFromMeta(meta?: Partial<GameMeta>): ArenaMode | null {
  const g = (meta?.gameType ?? '').toUpperCase();
  if (g === 'GT_UNDERGROUND_ARENA') return 'underground';
  if (g === 'GT_ARENA') return 'arena';
  return null;
}

export function isRankedMeta(meta?: Partial<GameMeta>): boolean {
  return (meta?.gameType ?? '').toUpperCase() === 'GT_RANKED';
}

export function formatModeLabel(meta?: Partial<GameMeta>): string {
  const g = (meta?.gameType ?? '').toUpperCase();
  const f = (meta?.formatType ?? '').toUpperCase();
  const fmt = f === 'FT_WILD' ? '狂野' : f === 'FT_TWIST' ? '幻变' : f === 'FT_STANDARD' ? '标准' : '';
  if (g === 'GT_RANKED') return `${fmt || '标准'}天梯`;
  if (g === 'GT_UNDERGROUND_ARENA') return '地下竞技场';
  if (g === 'GT_ARENA') return '竞技场';
  if (g === 'GT_CASUAL') return `${fmt ? `${fmt}` : ''}休闲模式`;
  if (g === 'GT_VS_FRIEND') return '好友切磋';
  if (g === 'GT_TAVERNBRAWL') return '酒馆乱斗';
  if (g === 'GT_VS_AI') return '练习模式';
  return fmt ? `${fmt}对局` : '';
}

export function formatArenaLimits(mode: ArenaMode): { maxWins: number; maxLosses: number } {
  return mode === 'underground' ? { maxWins: 12, maxLosses: 3 } : { maxWins: 5, maxLosses: 2 };
}

export interface ParsedRank {
  rankText: string;
  league: LeagueName;
  tier?: number;
  stars?: number;
  legendRank?: number;
}

const LEAGUE_ALIAS: Record<string, LeagueName> = {
  青铜: '青铜', 铜: '青铜', bronze: '青铜', b: '青铜',
  白银: '白银', 银: '白银', silver: '白银', s: '白银',
  黄金: '黄金', 金: '黄金', gold: '黄金', g: '黄金',
  白金: '白金', 铂金: '白金', platinum: '白金', plat: '白金', p: '白金',
  钻石: '钻石', 钻: '钻石', diamond: '钻石', dia: '钻石', d: '钻石',
  传说: '传说', 传: '传说', legend: '传说', l: '传说',
};

export function formatRankText(r: { league?: LeagueName; tier?: number; stars?: number; legendRank?: number }): string | null {
  if (!r.league) return null;
  if (r.league === '传说') {
    return r.legendRank && r.legendRank > 0 ? `传说 #${r.legendRank}` : '传说';
  }
  const tier = Math.max(1, Math.min(10, r.tier ?? 10));
  const stars = Math.max(0, Math.min(STARS_PER_TIER, r.stars ?? 0));
  const short = r.league === '钻石' ? '钻' : r.league;
  return `${short}${tier} ${stars}星`;
}

/**
 * 解析玩家手动输入的段位文本：
 *   「钻5 2星」「钻石3 1星」「黄金10」「传说 #1200」「传说」「D5 2*」
 */
export function parseRankInput(raw: string): ParsedRank | null {
  const s = raw.trim();
  if (!s) return null;

  const leg = /^(?:传说|传|legend|l)\s*(?:[#第]?\s*(\d+))?$/i.exec(s);
  if (leg) {
    const legendRank = leg[1] ? Number(leg[1]) : undefined;
    return {
      rankText: formatRankText({ league: '传说', legendRank })!,
      league: '传说',
      ...(legendRank ? { legendRank } : {}),
    };
  }

  const m = /^(青铜|白银|黄金|白金|铂金|钻石|铜|银|金|钻|bronze|silver|gold|platinum|plat|diamond|dia|[bsgpd])\s*(\d{1,2})(?:\s+(\d+)\s*[星*]?|\s*[·・,，]\s*(\d+)\s*[星*]?)?$/i.exec(s);
  if (!m) return null;
  const league = LEAGUE_ALIAS[m[1].toLowerCase()];
  if (!league || league === '传说') return null;
  const tier = Math.max(1, Math.min(10, Number(m[2])));
  const starsRaw = m[3] ?? m[4];
  const stars = starsRaw ? Math.max(0, Math.min(STARS_PER_TIER, Number(starsRaw))) : 0;
  return {
    rankText: formatRankText({ league, tier, stars })!,
    league,
    tier,
    stars,
  };
}

/** 把段位映射到线性星数（0..149，青铜10 0星 = 0，钻石1 3星起 = 150 → 传说）。 */
function toTotalStars(league: LeagueName, tier: number, stars: number): number {
  const li = LEAGUES.indexOf(league);
  if (li < 0 || league === '传说') return 150;
  const tierOffset = 10 - Math.max(1, Math.min(10, tier));
  return li * 30 + tierOffset * STARS_PER_TIER + Math.max(0, Math.min(STARS_PER_TIER, stars));
}

function fromTotalStars(total: number): { league: LeagueName; tier?: number; stars?: number } {
  if (total >= 150) return { league: '传说' };
  const clamped = Math.max(0, total);
  const leagueIdx = Math.floor(clamped / 30);
  const rem = clamped % 30;
  const tier = 10 - Math.floor(rem / STARS_PER_TIER);
  const stars = rem % STARS_PER_TIER;
  return { league: LEAGUES[leagueIdx] ?? '青铜', tier, stars };
}

/** 是否处在 10 / 5 保护底线，或者青铜 10-6 阶段（不会掉星）。 */
function floorStars(total: number): number {
  if (total >= 150) return 150;
  // 每 15 颗星是一个保护底线（青铜10=0, 青铜5=15, 白银10=30, 白银5=45 ... 钻石5=135）
  return Math.floor(total / 15) * 15;
}

function applyLadderMatch(track: LadderTrack, result: 'won' | 'lost' | 'tied', now: string): void {
  if (result === 'tied') return;
  if (result === 'won') {
    track.wins += 1;
    track.streak = track.streak > 0 ? track.streak + 1 : 1;
  } else {
    track.losses += 1;
    track.streak = track.streak < 0 ? track.streak - 1 : -1;
  }
  track.updatedAt = now;

  if (!track.league) return;
  track.estimated = true;

  if (track.league === '传说') {
    track.rankText = formatRankText(track);
    return;
  }

  const current = toTotalStars(track.league, track.tier ?? 10, track.stars ?? 0);
  if (result === 'won') {
    // 钻石 5 (135 星) 起无连胜额外加星；且若 starBonus > 1 则按 starBonus 结算（每跨一个 5 段底线消耗 1 点加成）
    let gain = Math.max(1, track.starBonus);
    if (track.starBonus <= 1 && current < 135 && track.streak >= 3) {
      gain = 2;
    }
    const next = Math.min(150, current + gain);
    const nextFloor = floorStars(next);
    if (nextFloor > floorStars(current) && track.starBonus > 1) {
      track.starBonus = Math.max(1, track.starBonus - 1);
    }
    const conv = fromTotalStars(next);
    track.league = conv.league;
    track.tier = conv.tier;
    track.stars = conv.stars;
    if (conv.league === '传说') track.legendRank = undefined;
    track.rankText = formatRankText(track);
    return;
  }

  // 输局：青铜 10-6（0..14）不掉星；其余不低于当前 5/10 级保护底线
  if (current < 15) {
    track.rankText = formatRankText(track);
    return;
  }
  const next = Math.max(floorStars(current), current - 1);
  const conv = fromTotalStars(next);
  track.league = conv.league;
  track.tier = conv.tier;
  track.stars = conv.stars;
  track.rankText = formatRankText(track);
}

export class ProgressStore {
  private readonly filePath: string;
  private state: ProgressState;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'hearthstone-progress.json');
    this.state = this.load();
  }

  private load(): ProgressState {
    const base = defaultProgress();
    try {
      if (!existsSync(this.filePath)) return base;
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<ProgressState>;
      if (raw.ladder) {
        for (const fmt of ['standard', 'wild', 'twist'] as const) {
          if (raw.ladder[fmt]) base.ladder[fmt] = { ...emptyTrack(), ...raw.ladder[fmt] };
        }
      }
      if (raw.arena && typeof raw.arena === 'object') {
        base.arena = raw.arena;
      }
      if (Array.isArray(raw.arenaHistory)) base.arenaHistory = raw.arenaHistory.slice(-MAX_ARENA_HISTORY);
      if (Array.isArray(raw.recordedGameKeys)) base.recordedGameKeys = raw.recordedGameKeys.slice(-MAX_RECORDED_KEYS);
    } catch {
      // 坏文件不崩，回落默认
    }
    return base;
  }

  private save(): void {
    try {
      writeAtomicSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch {
      // 进度落盘失败不影响主陪打链路
    }
  }

  snapshot(): ProgressState {
    return JSON.parse(JSON.stringify(this.state)) as ProgressState;
  }

  /** 手动设置某赛制天梯段位与星数加成。 */
  setRank(
    format: LadderFormat,
    rankInput: string,
    starBonus?: number,
    now: string = new Date().toISOString(),
  ): { ok: boolean; track: LadderTrack; error?: string } {
    const track = this.state.ladder[format];
    const trimmed = rankInput.trim();
    if (!trimmed) {
      track.rankText = null;
      track.league = undefined;
      track.tier = undefined;
      track.stars = undefined;
      track.legendRank = undefined;
      track.estimated = false;
      track.updatedAt = now;
      if (typeof starBonus === 'number' && Number.isFinite(starBonus)) {
        track.starBonus = Math.max(1, Math.min(11, Math.floor(starBonus)));
      }
      this.save();
      return { ok: true, track: { ...track } };
    }

    const parsed = parseRankInput(trimmed);
    if (!parsed) {
      return {
        ok: false,
        track: { ...track },
        error: '没认出这个段位写法。试试「钻5 2星」「黄金10」「传说 #1200」。',
      };
    }

    track.rankText = parsed.rankText;
    track.league = parsed.league;
    track.tier = parsed.tier;
    track.stars = parsed.stars;
    track.legendRank = parsed.legendRank;
    track.estimated = false;
    track.updatedAt = now;
    if (typeof starBonus === 'number' && Number.isFinite(starBonus)) {
      track.starBonus = Math.max(1, Math.min(11, Math.floor(starBonus)));
    }
    this.save();
    return { ok: true, track: { ...track } };
  }

  /** 手动校准当前竞技场胜负。 */
  calibrateArena(
    wins: number,
    losses: number,
    mode: ArenaMode = this.state.arena?.mode ?? 'underground',
    heroClass: string = this.state.arena?.heroClass ?? '',
    now: string = new Date().toISOString(),
  ): ArenaRun {
    const limits = formatArenaLimits(mode);
    const w = Math.max(0, Math.min(limits.maxWins, Math.floor(wins)));
    const l = Math.max(0, Math.min(limits.maxLosses, Math.floor(losses)));
    const active = w < limits.maxWins && l < limits.maxLosses;
    this.state.arena = {
      mode,
      wins: w,
      losses: l,
      ...limits,
      heroClass,
      active,
      calibrated: true,
      startedAt: this.state.arena?.startedAt || now,
      updatedAt: now,
    };
    this.save();
    return { ...this.state.arena };
  }

  /** 开始新的一轮竞技场（0-0）。 */
  resetArenaRun(mode: ArenaMode = this.state.arena?.mode ?? 'underground', heroClass = '', now: string = new Date().toISOString()): ArenaRun {
    if (this.state.arena && (this.state.arena.wins > 0 || this.state.arena.losses > 0) && this.state.arena.active) {
      this.state.arenaHistory.push({
        mode: this.state.arena.mode,
        wins: this.state.arena.wins,
        losses: this.state.arena.losses,
        heroClass: this.state.arena.heroClass,
        startedAt: this.state.arena.startedAt,
        endedAt: now,
      });
      if (this.state.arenaHistory.length > MAX_ARENA_HISTORY) {
        this.state.arenaHistory = this.state.arenaHistory.slice(-MAX_ARENA_HISTORY);
      }
    }
    const limits = formatArenaLimits(mode);
    this.state.arena = {
      mode,
      wins: 0,
      losses: 0,
      ...limits,
      heroClass,
      active: true,
      calibrated: false,
      startedAt: now,
      updatedAt: now,
    };
    this.save();
    return { ...this.state.arena };
  }

  /** 对局结束时记录模式胜负（按 gameKey 幂等去重）。 */
  recordGameResult(
    gameKey: string,
    meta: Partial<GameMeta> | undefined,
    result: 'won' | 'lost' | 'tied' | 'unknown' | null,
    myHeroClass = '',
    now: string = new Date().toISOString(),
  ): { recorded: boolean; summary?: string } {
    if (!result || result === 'unknown') return { recorded: false };
    if (this.state.recordedGameKeys.includes(gameKey)) return { recorded: false };

    let summary: string | undefined;
    if (isRankedMeta(meta)) {
      const fmt = ladderFormatFromMeta(meta);
      const track = this.state.ladder[fmt];
      applyLadderMatch(track, result, now);
      summary = `${formatModeLabel(meta)} ${track.rankText ? `${track.rankText}${track.estimated ? '(推算)' : ''}` : `${track.wins}胜${track.losses}负`}`;
    } else {
      const aMode = arenaModeFromMeta(meta);
      if (aMode && result !== 'tied') {
        const limits = formatArenaLimits(aMode);
        if (!this.state.arena || !this.state.arena.active || this.state.arena.mode !== aMode) {
          this.state.arena = {
            mode: aMode,
            wins: 0,
            losses: 0,
            ...limits,
            heroClass: myHeroClass,
            active: true,
            calibrated: false,
            startedAt: now,
            updatedAt: now,
          };
        }
        const run = this.state.arena;
        if (!run.heroClass && myHeroClass) run.heroClass = myHeroClass;
        if (result === 'won') run.wins = Math.min(run.maxWins, run.wins + 1);
        else run.losses = Math.min(run.maxLosses, run.losses + 1);
        run.updatedAt = now;
        if (run.wins >= run.maxWins || run.losses >= run.maxLosses) {
          run.active = false;
          this.state.arenaHistory.push({
            mode: run.mode,
            wins: run.wins,
            losses: run.losses,
            heroClass: run.heroClass,
            startedAt: run.startedAt,
            endedAt: now,
          });
          if (this.state.arenaHistory.length > MAX_ARENA_HISTORY) {
            this.state.arenaHistory = this.state.arenaHistory.slice(-MAX_ARENA_HISTORY);
          }
        }
        summary = `${formatModeLabel(meta)} ${run.wins}胜${run.losses}负${run.active ? '' : '（本轮已结束）'}`;
      }
    }

    this.state.recordedGameKeys.push(gameKey);
    if (this.state.recordedGameKeys.length > MAX_RECORDED_KEYS) {
      this.state.recordedGameKeys = this.state.recordedGameKeys.slice(-MAX_RECORDED_KEYS);
    }
    this.save();
    return { recorded: true, summary };
  }

  /** 生成给提示词与 UI 用的紧凑一行摘要。 */
  briefForMeta(meta?: Partial<GameMeta>): string {
    const label = formatModeLabel(meta);
    if (isRankedMeta(meta)) {
      const track = this.state.ladder[ladderFormatFromMeta(meta)];
      const rank = track.rankText ? `${track.rankText}${track.estimated ? '·推算' : ''}` : '未设段位';
      const rec = track.wins + track.losses > 0 ? `（${track.wins}胜${track.losses}负${track.streak >= 2 ? `·${track.streak}连胜` : ''}）` : '';
      return `${label} · ${rank}${rec}`;
    }
    const aMode = arenaModeFromMeta(meta);
    if (aMode) {
      const run = this.state.arena;
      if (run && run.mode === aMode) {
        return `${label} · ${run.wins}胜${run.losses}负${run.active ? '' : '(已结)'}`;
      }
      return `${label} · 0胜0负`;
    }
    return label || '对局中';
  }

  clearAll(): void {
    this.state = defaultProgress();
    this.save();
  }

  path(): string {
    return this.filePath;
  }
}
