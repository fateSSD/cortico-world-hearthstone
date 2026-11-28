/**
 * 扩展内置联网搜卡组（直接拉取 Firestone 公开构筑统计静态 CDN 并用本地 deck-code 校验编码）。
 *
 * 为什么不依赖外部 browser_search：宿主未装/未启用搜索扩展时模型手里没有搜索工具。
 * 扩展自带公开数据源 + 本地编码校验，点「搜卡组」即可直接把合法 AAE... 导进对手记牌器。
 */
import https from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { decodeDeckString } from './deck-code.ts';
import type { LadderFormat } from './progress.ts';

export interface FirestoneDeckStat {
  decklist: string;
  playerClass?: string;
  archetypeName?: string;
  archetypeId?: number;
  totalGames?: number;
  totalWins?: number;
  winrate?: number;
}

export interface SearchOppDeckResult {
  ok: true;
  code: string;
  name: string;
  winRate: number;
  totalGames: number;
  matchedCount: number;
  playedTotal: number;
}

interface DecodedCandidate {
  entry: FirestoneDeckStat;
  code: string;
  bareIds: Set<string>;
}

const CLASS_META: Record<string, { firestoneKey: string; heroDbfId: number }> = {
  战士: { firestoneKey: 'warrior', heroDbfId: 7 },
  萨满: { firestoneKey: 'shaman', heroDbfId: 1066 },
  潜行者: { firestoneKey: 'rogue', heroDbfId: 930 },
  圣骑士: { firestoneKey: 'paladin', heroDbfId: 671 },
  猎人: { firestoneKey: 'hunter', heroDbfId: 31 },
  德鲁伊: { firestoneKey: 'druid', heroDbfId: 274 },
  术士: { firestoneKey: 'warlock', heroDbfId: 893 },
  法师: { firestoneKey: 'mage', heroDbfId: 637 },
  牧师: { firestoneKey: 'priest', heroDbfId: 813 },
  恶魔猎手: { firestoneKey: 'demonhunter', heroDbfId: 56550 },
  死亡骑士: { firestoneKey: 'deathknight', heroDbfId: 78065 },
};

const HERO_ZH_TO_FIRESTONE = new Map<string, string>(
  Object.entries(CLASS_META).map(([zh, meta]) => [zh, meta.firestoneKey]),
);

const FORMAT_META: Record<LadderFormat, { key: string; brackets: readonly string[]; zh: string }> = {
  standard: { key: 'standard', brackets: ['competitive', 'all'] as const, zh: '标准' },
  wild: { key: 'wild', brackets: ['competitive', 'all'] as const, zh: '狂野' },
  twist: { key: 'twist', brackets: ['all'] as const, zh: '幻变' },
};

const UPPER_SLUGS = new Set([
  'dk', 'dh', 'xl', 'otk', 'hl',
  'bbb', 'bbu', 'bfu', 'buu', 'fff', 'ffu', 'fuu', 'uuu', 'ubb', 'uub', 'fbu',
]);

const VARIANT_PREFIX = /^(?:CORE_|VAN_|VANILLA_|TUTORIAL_)/;
const bareId = (id: string): string => id.replace(VARIANT_PREFIX, '');

const CACHE_TTL_MS = 60 * 60 * 1000;
const deckCache = new Map<string, { at: number; byClass: Map<string, DecodedCandidate[]> }>();

const CLEAN_HEADERS = {
  accept: 'application/json, */*',
  'accept-encoding': 'gzip, deflate, br',
};

export function clearDeckSearchCache(): void {
  deckCache.clear();
}

function decompressBody(raw: Buffer, encodingHeader: string | string[] | undefined): string {
  const enc = (Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader ?? '').trim().toLowerCase();
  let buf = raw;
  if (enc === 'gzip' || enc === 'x-gzip') {
    buf = gunzipSync(raw);
  } else if (enc === 'br') {
    buf = brotliDecompressSync(raw);
  } else if (enc === 'deflate') {
    buf = inflateSync(raw);
  }
  return buf.toString('utf8');
}

function directHttpsGetJson(url: string, timeoutMs: number): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: false, headers: CLEAN_HEADERS, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          resolve({ status, data: null });
          return;
        }
        try {
          const body = decompressBody(Buffer.concat(chunks), res.headers['content-encoding']);
          resolve({ status, data: JSON.parse(body) });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('直连请求超时')); });
    req.on('error', reject);
  });
}

async function fetchJsonSmart(
  url: string,
  customFetcher: typeof fetch | undefined,
  timeoutMs: number,
): Promise<{ ok: true; data: unknown } | { ok: false; status?: number; error: string }> {
  const doFetch = customFetcher ?? fetch;
  try {
    const res = await doFetch(url, {
      headers: { accept: 'application/json, */*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      return { ok: true, data: await res.json() };
    }
    // 宿主全局 fetch 常挂着系统代理，部分代理节点异常或限流时自动回退为 node:https 无代理直连
    if (!customFetcher && (res.status === 403 || res.status === 429 || res.status >= 500)) {
      const direct = await directHttpsGetJson(url, timeoutMs);
      if (direct.status >= 200 && direct.status < 300 && direct.data !== null) {
        return { ok: true, data: direct.data };
      }
      return { ok: false, status: direct.status || res.status, error: `HTTP ${direct.status || res.status}` };
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    if (!customFetcher) {
      try {
        const direct = await directHttpsGetJson(url, timeoutMs);
        if (direct.status >= 200 && direct.status < 300 && direct.data !== null) {
          return { ok: true, data: direct.data };
        }
        if (direct.status > 0) {
          return { ok: false, status: direct.status, error: `HTTP ${direct.status}` };
        }
      } catch { /* fall through */ }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function normalizeWinRate(entry: FirestoneDeckStat): number {
  const raw = Number(entry.winrate);
  if (Number.isFinite(raw)) {
    return raw <= 1 ? raw * 100 : raw;
  }
  const games = Number(entry.totalGames);
  const wins = Number(entry.totalWins);
  if (Number.isFinite(games) && games > 0 && Number.isFinite(wins) && wins >= 0) {
    return (wins / games) * 100;
  }
  return 50;
}

export function formatArchetypeName(slug: string | undefined, heroClass: string, winRate: number): string {
  const clean = (slug ?? '').trim();
  if (!clean) {
    return `${heroClass}主流(${winRate}%)`;
  }
  const words = clean.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) {
    return `${heroClass}主流(${winRate}%)`;
  }
  const title = words
    .map((w) => {
      const low = w.toLowerCase();
      if (UPPER_SLUGS.has(low)) return low.toUpperCase();
      return low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join(' ');
  return `${title} (${winRate}%)`;
}

function decodeCandidate(entry: FirestoneDeckStat): DecodedCandidate | null {
  if (!entry || typeof entry.decklist !== 'string' || !entry.decklist.trim()) return null;
  const dec = decodeDeckString(entry.decklist);
  if (!dec.ok || dec.deck.cards.length === 0) return null;
  const bareIds = new Set<string>();
  for (const c of dec.deck.cards) {
    const id = bareId(c.cardId);
    if (id) bareIds.add(id);
  }
  return { entry, code: dec.deck.code, bareIds };
}

function groupDecodedByClass(entries: readonly FirestoneDeckStat[]): Map<string, DecodedCandidate[]> {
  const byClass = new Map<string, DecodedCandidate[]>();
  for (const entry of entries) {
    const decoded = decodeCandidate(entry);
    if (!decoded) continue;
    const rawCls = entry.playerClass?.trim().toLowerCase() ?? '';
    let clsKey = rawCls;
    if (!clsKey) {
      const dec = decodeDeckString(decoded.code);
      clsKey = dec.ok ? (HERO_ZH_TO_FIRESTONE.get(dec.deck.heroClass) ?? '') : '';
    }
    if (!clsKey) continue;
    const list = byClass.get(clsKey);
    if (list) list.push(decoded);
    else byClass.set(clsKey, [decoded]);
  }
  return byClass;
}

function scoreCandidate(
  cand: DecodedCandidate,
  played: readonly string[],
): { cand: DecodedCandidate; matchedCount: number; score: number } {
  let matchedCount = 0;
  let missedCount = 0;
  for (const pid of played) {
    if (cand.bareIds.has(pid)) matchedCount += 1;
    else missedCount += 1;
  }
  const winRate = normalizeWinRate(cand.entry);
  const games = Math.max(0, Number(cand.entry.totalGames ?? 0));
  const score = matchedCount * 100 - missedCount * 45 + winRate + Math.log10(games + 1) * 6;
  return { cand, matchedCount, score };
}

function pickBestDecoded(
  candidates: readonly DecodedCandidate[],
  playedCardIds: readonly string[],
): { entry: FirestoneDeckStat; code: string; matchedCount: number } | null {
  const played = [...new Set(playedCardIds.map(bareId).filter(Boolean))];
  let best: { cand: DecodedCandidate; matchedCount: number; score: number } | null = null;
  for (const cand of candidates) {
    const cur = scoreCandidate(cand, played);
    if (!best || cur.score > best.score) {
      best = cur;
    }
  }
  return best ? { entry: best.cand.entry, code: best.cand.code, matchedCount: best.matchedCount } : null;
}

export function pickBestMatchingDeck(
  candidates: readonly FirestoneDeckStat[],
  playedCardIds: readonly string[],
): { entry: FirestoneDeckStat; code: string; matchedCount: number } | null {
  const decoded: DecodedCandidate[] = [];
  for (const entry of candidates) {
    const item = decodeCandidate(entry);
    if (item) decoded.push(item);
  }
  return pickBestDecoded(decoded, playedCardIds);
}

export async function searchOpponentDeckCode(opts: {
  format: LadderFormat;
  heroClass: string;
  playedCardIds: readonly string[];
  fetcher?: typeof fetch;
}): Promise<SearchOppDeckResult | { ok: false; error: string }> {
  const clsMeta = CLASS_META[opts.heroClass];
  if (!clsMeta) {
    return { ok: false, error: `暂不支持职业「${opts.heroClass || '未知'}」的自动搜卡组。` };
  }
  const fmtMeta = FORMAT_META[opts.format] ?? FORMAT_META.standard;
  const now = Date.now();
  const useCache = !opts.fetcher;

  let picked: { entry: FirestoneDeckStat; code: string; matchedCount: number } | null = null;
  let anyFetchOk = false;
  let lastError = '未获取到构筑榜';

  for (const bracket of fmtMeta.brackets) {
    const cacheKey = `${fmtMeta.key}:${bracket}`;
    let byClass = useCache ? deckCache.get(cacheKey) : undefined;
    if (!byClass || now - byClass.at > CACHE_TTL_MS) {
      const url = `https://static.zerotoheroes.com/api/constructed/stats/decks/${fmtMeta.key}/${bracket}/last-patch/overview-from-hourly.gz.json`;
      const fetched = await fetchJsonSmart(url, opts.fetcher, 12000);
      if (!fetched.ok) {
        lastError = fetched.error;
        continue;
      }
      const json = fetched.data as { deckStats?: unknown };
      if (!Array.isArray(json?.deckStats)) {
        lastError = '构筑榜返回格式异常，未找到卡组数据';
        continue;
      }
      byClass = {
        at: now,
        byClass: groupDecodedByClass(json.deckStats as FirestoneDeckStat[]),
      };
      if (useCache) {
        deckCache.set(cacheKey, byClass);
      }
    }

    anyFetchOk = true;
    const candidates = byClass.byClass.get(clsMeta.firestoneKey) ?? [];
    if (!candidates.length) continue;

    picked = pickBestDecoded(candidates, opts.playedCardIds);
    if (picked) break;
  }

  if (!picked) {
    if (!anyFetchOk) {
      return { ok: false, error: `联网拉取构筑榜失败（${lastError}）。` };
    }
    return { ok: false, error: `当前${fmtMeta.zh}构筑榜暂无${opts.heroClass}样本卡组。` };
  }

  const check = decodeDeckString(picked.code);
  if (!check.ok) {
    return { ok: false, error: `生成的卡组代码校验未通过：${check.error}` };
  }

  const winRate = Math.round(normalizeWinRate(picked.entry) * 10) / 10;
  const totalGames = Number(picked.entry.totalGames ?? 0);
  const name = formatArchetypeName(picked.entry.archetypeName, opts.heroClass, winRate);

  return {
    ok: true,
    code: picked.code,
    name,
    winRate,
    totalGames,
    matchedCount: picked.matchedCount,
    playedTotal: opts.playedCardIds.length,
  };
}
