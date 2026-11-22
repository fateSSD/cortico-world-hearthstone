/**
 * 对手主流卡组情报库（持久化在 dataDir/hearthstone-ladder-meta.json）。
 *
 * 原理：扩展自己不内置过时的版本攻略。遇到天梯对局时，若本地没有该职业近期的主流卡组档案
 * （或超过 7 天过期），会提示桌宠 LLM 用联网搜索查当下版本，再用 `hearthstone_matchup` 存进来；
 * 随后每回合根据对手已打出的非衍生牌自动匹配卡组、点名尚未交出的关键解场与威胁。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LadderFormat } from './progress.ts';

export interface ArchetypeEntry {
  /** 卡组名，例如「圣契骑」「星灵法」「机械战」。 */
  name: string;
  /** 用于识别这套牌的特征单卡名（3–10 张）。 */
  coreCards: string[];
  /** 对手还没交出来时要提防的关键解场/返场/爆发牌。 */
  threats: string[];
  /** 1–2 句实操对阵要点。 */
  strategy: string;
}

export interface ClassMetaBucket {
  format: LadderFormat;
  heroClass: string;
  savedAt: string;
  archetypes: ArchetypeEntry[];
}

export interface ArchetypeMatch {
  matched: ArchetypeEntry | null;
  /** 命中了哪些特征牌。 */
  hitCards: string[];
  /** 置信度：high >= 2 张特征牌；low = 1 张；none = 未匹配。 */
  confidence: 'high' | 'low' | 'none';
  /** 对手尚未交出的威胁牌（从 matched.threats 里排掉已打过的）。 */
  pendingThreats: string[];
  /** 该职业近期情报是否缺失或过期（>7天），需要桌宠联网补搜。 */
  needsSearch: boolean;
  stale: boolean;
  candidates: string[];
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function writeAtomicSync(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

function normCardName(s: string): string {
  return s.replace(/[\s，,。.;；、:：()（）·]/g, '').toLowerCase();
}

function cardMatches(target: string, playedList: readonly string[]): boolean {
  const nt = normCardName(target);
  if (!nt) return false;
  for (const p of playedList) {
    const np = normCardName(p);
    if (!np) continue;
    if (np === nt || (nt.length >= 2 && (np.includes(nt) || nt.includes(np)))) return true;
  }
  return false;
}

function bucketKey(format: LadderFormat, heroClass: string): string {
  return `${format}:${heroClass.trim()}`;
}

export class ArchetypeStore {
  private readonly filePath: string;
  private buckets: Record<string, ClassMetaBucket> = {};

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'hearthstone-ladder-meta.json');
    this.buckets = this.load();
  }

  private load(): Record<string, ClassMetaBucket> {
    try {
      if (!existsSync(this.filePath)) return {};
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as { buckets?: Record<string, ClassMetaBucket> };
      return raw?.buckets && typeof raw.buckets === 'object' ? raw.buckets : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      writeAtomicSync(this.filePath, JSON.stringify({ buckets: this.buckets }, null, 2));
    } catch {
      // 旁路情报库落盘失败不阻断陪打
    }
  }

  read(format: LadderFormat, heroClass: string): ClassMetaBucket | null {
    return this.buckets[bucketKey(format, heroClass)] ?? null;
  }

  listAll(): ClassMetaBucket[] {
    return Object.values(this.buckets);
  }

  saveBucket(
    format: LadderFormat,
    heroClass: string,
    archetypes: readonly ArchetypeEntry[],
    now: string = new Date().toISOString(),
  ): ClassMetaBucket {
    const cleanCls = heroClass.trim();
    const cleaned: ArchetypeEntry[] = archetypes
      .filter((a) => a && typeof a.name === 'string' && a.name.trim())
      .map((a) => ({
        name: a.name.trim(),
        coreCards: Array.isArray(a.coreCards) ? a.coreCards.map((x) => String(x).trim()).filter(Boolean) : [],
        threats: Array.isArray(a.threats) ? a.threats.map((x) => String(x).trim()).filter(Boolean) : [],
        strategy: String(a.strategy ?? '').trim(),
      }));
    const bucket: ClassMetaBucket = { format, heroClass: cleanCls, savedAt: now, archetypes: cleaned };
    this.buckets[bucketKey(format, cleanCls)] = bucket;
    this.save();
    return bucket;
  }

  clearBucket(format: LadderFormat, heroClass: string): boolean {
    const k = bucketKey(format, heroClass);
    if (!this.buckets[k]) return false;
    delete this.buckets[k];
    this.save();
    return true;
  }

  clearAll(): void {
    this.buckets = {};
    this.save();
  }

  /** 根据对手打过的非衍生牌匹配主流卡组。 */
  match(
    format: LadderFormat,
    heroClass: string,
    opponentInitialPlayedNames: readonly string[],
    nowMs: number = Date.now(),
  ): ArchetypeMatch {
    if (!heroClass) {
      return { matched: null, hitCards: [], confidence: 'none', pendingThreats: [], needsSearch: false, stale: false, candidates: [] };
    }
    const bucket = this.read(format, heroClass);
    if (!bucket || !bucket.archetypes.length) {
      return { matched: null, hitCards: [], confidence: 'none', pendingThreats: [], needsSearch: true, stale: false, candidates: [] };
    }

    const savedMs = Date.parse(bucket.savedAt);
    const stale = !Number.isFinite(savedMs) || nowMs - savedMs > MAX_AGE_MS;
    const candidates = bucket.archetypes.map((a) => a.name);

    const scored = bucket.archetypes
      .map((arch) => {
        const hits = arch.coreCards.filter((c) => cardMatches(c, opponentInitialPlayedNames));
        return { arch, hits };
      })
      .filter((x) => x.hits.length > 0)
      .sort((a, b) => b.hits.length - a.hits.length || (b.hits.length / Math.max(1, b.arch.coreCards.length)) - (a.hits.length / Math.max(1, a.arch.coreCards.length)));

    const best = scored[0];
    if (!best) {
      return { matched: null, hitCards: [], confidence: 'none', pendingThreats: [], needsSearch: stale, stale, candidates };
    }

    const confidence: ArchetypeMatch['confidence'] = best.hits.length >= 2 ? 'high' : 'low';
    const pendingThreats = best.arch.threats.filter((t) => !cardMatches(t, opponentInitialPlayedNames));
    return {
      matched: best.arch,
      hitCards: best.hits,
      confidence,
      pendingThreats,
      needsSearch: stale,
      stale,
      candidates,
    };
  }

  path(): string {
    return this.filePath;
  }
}

export function renderMatchupSummary(match: ArchetypeMatch, heroClass: string): string {
  if (!heroClass) return '';
  if (match.matched) {
    const tag = match.confidence === 'high' ? '大概率是' : '疑似';
    const threats = match.pendingThreats.length ? `，还没交的关键威胁：${match.pendingThreats.slice(0, 4).join('、')}` : '';
    const strat = match.matched.strategy ? `（${match.matched.strategy}）` : '';
    return `对手推测：${tag}【${match.matched.name}】（命中 ${match.hitCards.join('、')}）${threats}${strat}`;
  }
  if (match.needsSearch) {
    return `对手是${heroClass}，本地暂无当前版本主流卡组缓存${match.stale ? '（旧缓存已超7天）' : ''} —— 可先联网搜一轮当下天梯主流${heroClass}构筑并用 hearthstone_matchup 记下来。`;
  }
  if (match.candidates.length) {
    return `对手是${heroClass}，已知主流有 ${match.candidates.join(' / ')}，目前出牌还不足以定型。`;
  }
  return '';
}
