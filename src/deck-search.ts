/**
 * 扩展内置联网搜卡组（直接拉取 HSReplay 公开构筑榜并用本地 dbf-map + deck-code 校验编码）。
 *
 * 为什么不依赖外部 browser_search：宿主未装/未启用搜索扩展时模型手里没有搜索工具。
 * 扩展自带数据源 + 本地编码校验，点「搜卡组」即可直接把合法 AAE... 导进对手记牌器。
 */
import https from 'node:https';
import { dbfIdToCardId, decodeDeckString, encodeDeckString } from './deck-code.ts';
import type { LadderFormat } from './progress.ts';

export interface HsReplayDeckEntry {
  deck_id: string;
  deck_list: string;
  archetype_id?: number;
  total_games?: number;
  win_rate?: number;
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

const CLASS_META: Record<string, { hsKey: string; heroDbfId: number }> = {
  战士: { hsKey: 'WARRIOR', heroDbfId: 7 },
  萨满: { hsKey: 'SHAMAN', heroDbfId: 1066 },
  潜行者: { hsKey: 'ROGUE', heroDbfId: 930 },
  圣骑士: { hsKey: 'PALADIN', heroDbfId: 671 },
  猎人: { hsKey: 'HUNTER', heroDbfId: 31 },
  德鲁伊: { hsKey: 'DRUID', heroDbfId: 274 },
  术士: { hsKey: 'WARLOCK', heroDbfId: 893 },
  法师: { hsKey: 'MAGE', heroDbfId: 637 },
  牧师: { hsKey: 'PRIEST', heroDbfId: 813 },
  恶魔猎手: { hsKey: 'DEMONHUNTER', heroDbfId: 56550 },
  死亡骑士: { hsKey: 'DEATHKNIGHT', heroDbfId: 78065 },
};

const FORMAT_META: Record<LadderFormat, { gameType: string; deckFormat: number; zh: string }> = {
  standard: { gameType: 'RANKED_STANDARD', deckFormat: 2, zh: '标准' },
  wild: { gameType: 'RANKED_WILD', deckFormat: 1, zh: '狂野' },
  twist: { gameType: 'RANKED_TWIST', deckFormat: 3, zh: '幻变' },
};

const VARIANT_PREFIX = /^(?:CORE_|VAN_|VANILLA_|TUTORIAL_)/;
const bareId = (id: string): string => id.replace(VARIANT_PREFIX, '');

const CACHE_TTL_MS = 60 * 60 * 1000;
const deckCache = new Map<string, { at: number; data: Record<string, HsReplayDeckEntry[]> }>();
let archetypeCache: { at: number; names: Map<number, string> } | null = null;

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function directHttpsGetJson(url: string, timeoutMs: number): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: false, headers: BROWSER_HEADERS, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          resolve({ status, data: null });
          return;
        }
        try {
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
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      return { ok: true, data: await res.json() };
    }
    // 宿主全局 fetch 常挂着系统代理，部分代理 IP 会被目标站 403 拦截；此时自动回退为 node:https 无代理直连
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
      } catch { /* fall through */ }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseDeckListPairs(raw: string): { dbfId: number; count: number }[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: { dbfId: number; count: number }[] = [];
    for (const item of arr) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const dbfId = Number(item[0]);
      const count = Number(item[1]);
      if (Number.isFinite(dbfId) && dbfId > 0 && Number.isFinite(count) && count > 0) {
        out.push({ dbfId, count });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function pickBestMatchingDeck(
  candidates: readonly HsReplayDeckEntry[],
  playedCardIds: readonly string[],
): { entry: HsReplayDeckEntry; cards: { dbfId: number; count: number }[]; matchedCount: number } | null {
  const played = [...new Set(playedCardIds.map(bareId).filter(Boolean))];
  let best: {
    entry: HsReplayDeckEntry;
    cards: { dbfId: number; count: number }[];
    matchedCount: number;
    score: number;
  } | null = null;

  for (const entry of candidates) {
    const cards = parseDeckListPairs(entry.deck_list);
    if (!cards.length) continue;
    const deckBareIds = new Set<string>();
    for (const c of cards) {
      const cid = dbfIdToCardId(c.dbfId);
      if (cid) deckBareIds.add(bareId(cid));
    }
    let matchedCount = 0;
    let missedCount = 0;
    for (const pid of played) {
      if (deckBareIds.has(pid)) matchedCount += 1;
      else missedCount += 1;
    }
    const winRate = Number(entry.win_rate ?? 50);
    const games = Number(entry.total_games ?? 0);
    const score = matchedCount * 100 - missedCount * 45 + winRate + Math.log10(games + 1) * 6;
    if (!best || score > best.score) {
      best = { entry, cards, matchedCount, score };
    }
  }
  return best ? { entry: best.entry, cards: best.cards, matchedCount: best.matchedCount } : null;
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

  let seriesData = deckCache.get(fmtMeta.gameType);
  if (!seriesData || now - seriesData.at > CACHE_TTL_MS) {
    const url = `https://hsreplay.net/analytics/query/list_decks_by_win_rate_v2/?GameType=${fmtMeta.gameType}&RankRange=DIAMOND_THROUGH_LEGEND&TimeRange=CURRENT_PATCH`;
    const fetched = await fetchJsonSmart(url, opts.fetcher, 8000);
    if (!fetched.ok) {
      return { ok: false, error: `联网拉取构筑榜失败（${fetched.error}）。` };
    }
    const json = fetched.data as { series?: { data?: Record<string, HsReplayDeckEntry[]> } };
    const data = json.series?.data;
    if (!data) return { ok: false, error: '构筑榜返回格式异常，未找到卡组数据。' };
    seriesData = { at: now, data };
    deckCache.set(fmtMeta.gameType, seriesData);
  }

  const candidates = seriesData.data[clsMeta.hsKey] ?? [];
  if (!candidates.length) {
    return { ok: false, error: `当前${fmtMeta.zh}构筑榜暂无${opts.heroClass}样本卡组。` };
  }

  const picked = pickBestMatchingDeck(candidates, opts.playedCardIds);
  if (!picked) {
    return { ok: false, error: `未能从${fmtMeta.zh}${opts.heroClass}样本中匹配出有效套牌。` };
  }

  if (!archetypeCache || now - archetypeCache.at > CACHE_TTL_MS) {
    const rArch = await fetchJsonSmart('https://hsreplay.net/api/v1/archetypes/?format=json', opts.fetcher, 5000);
    if (rArch.ok && Array.isArray(rArch.data)) {
      const list = rArch.data as { id?: number; name?: string }[];
      const names = new Map<number, string>();
      for (const a of list) {
        if (typeof a.id === 'number' && a.name) names.set(a.id, a.name);
      }
      archetypeCache = { at: now, names };
    }
  }

  const code = encodeDeckString({
    format: fmtMeta.deckFormat,
    heroes: [clsMeta.heroDbfId],
    cards: picked.cards,
  });
  const check = decodeDeckString(code);
  if (!check.ok) {
    return { ok: false, error: `生成的卡组代码校验未通过：${check.error}` };
  }

  const archName = picked.entry.archetype_id ? archetypeCache?.names.get(picked.entry.archetype_id) : undefined;
  const winRate = Math.round(Number(picked.entry.win_rate ?? 0) * 10) / 10;
  const totalGames = Number(picked.entry.total_games ?? 0);
  const name = archName ? `${archName} (${winRate}%)` : `${opts.heroClass}主流(${winRate}%)`;

  return {
    ok: true,
    code,
    name,
    winRate,
    totalGames,
    matchedCount: picked.matchedCount,
    playedTotal: opts.playedCardIds.length,
  };
}
