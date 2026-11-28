import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDeckString, encodeDeckString } from '../src/deck-code.ts';
import {
  clearDeckSearchCache,
  formatArchetypeName,
  pickBestMatchingDeck,
  searchOpponentDeckCode,
} from '../src/deck-search.ts';

// 315 = CS2_029 火球术，1004 = CS2_032 烈焰风暴，559 = CS2_024 寒冰箭，hero 637 = 法师
const MAGE_CODE_1 = encodeDeckString({
  format: 2,
  heroes: [637],
  cards: [{ dbfId: 315, count: 2 }, { dbfId: 559, count: 2 }],
});
const MAGE_CODE_2 = encodeDeckString({
  format: 2,
  heroes: [637],
  cards: [{ dbfId: 1004, count: 2 }, { dbfId: 559, count: 2 }],
});

test('pickBestMatchingDeck 按对手已出原生牌精准匹配构筑', () => {
  const candidates = [
    { decklist: MAGE_CODE_1, playerClass: 'mage', archetypeName: 'burn-mage', winrate: 0.582, totalGames: 500 },
    { decklist: MAGE_CODE_2, playerClass: 'mage', archetypeName: 'control-mage', winrate: 0.530, totalGames: 200 },
  ];
  const picked = pickBestMatchingDeck(candidates, ['CS2_032']);
  assert.ok(picked);
  assert.equal(picked.entry.archetypeName, 'control-mage');
  assert.equal(picked.code, MAGE_CODE_2);
  assert.equal(picked.matchedCount, 1);
});

test('searchOpponentDeckCode 正确解析 Firestone 数据并返回可解码的合法卡组代码', async () => {
  clearDeckSearchCache();
  const mockFetch = async () => new Response(JSON.stringify({
    lastUpdated: '2026-11-28T02:59:53.000Z',
    deckStats: [
      { decklist: MAGE_CODE_1, playerClass: 'mage', archetypeName: 'burn-mage', winrate: 0.564, totalGames: 320, totalWins: 180 },
      { decklist: MAGE_CODE_2, playerClass: 'mage', archetypeName: 'dk-control-mage', winrate: 0.51, totalGames: 150 },
    ],
  }), { status: 200 });

  const res = await searchOpponentDeckCode({
    format: 'standard',
    heroClass: '法师',
    playedCardIds: ['CS2_029'],
    fetcher: mockFetch,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(res.code, /^AAE/);
  assert.equal(res.name, 'Burn Mage (56.4%)');
  assert.equal(res.winRate, 56.4);
  assert.equal(res.totalGames, 320);
  assert.equal(res.matchedCount, 1);
  assert.equal(res.playedTotal, 1);
  const decoded = decodeDeckString(res.code);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.deck.heroClass, '法师');
    assert.equal(decoded.deck.totalCards, 4);
  }
});

test('searchOpponentDeckCode 在 competitive 失败或空样本时自动降级到 all', async () => {
  const seenUrls = [];
  const mockFetch = async (url) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.includes('/competitive/')) {
      return new Response('server error', { status: 500 });
    }
    return new Response(JSON.stringify({
      deckStats: [
        { decklist: MAGE_CODE_2, playerClass: 'mage', archetypeName: 'xl-big-spell-mage', winrate: 0.542, totalGames: 210 },
      ],
    }), { status: 200 });
  };

  const res = await searchOpponentDeckCode({
    format: 'standard',
    heroClass: '法师',
    playedCardIds: ['CS2_032'],
    fetcher: mockFetch,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(seenUrls.length, 2);
  assert.match(seenUrls[0], /\/competitive\//);
  assert.match(seenUrls[1], /\/all\//);
  assert.equal(res.name, 'XL Big Spell Mage (54.2%)');
});

test('边界反例：损坏 decklist 跳过、空出牌取主流、未知职业与全档位失败报错', async () => {
  const mockMixed = async () => new Response(JSON.stringify({
    deckStats: [
      { decklist: 'NOT_A_VALID_CODE', playerClass: 'mage', archetypeName: 'broken', winrate: 0.9, totalGames: 9999 },
      { decklist: MAGE_CODE_1, playerClass: 'mage', archetypeName: 'bbu-harold-mage', winrate: 0.55, totalGames: 120 },
    ],
  }), { status: 200 });

  const emptyPlayed = await searchOpponentDeckCode({
    format: 'wild',
    heroClass: '法师',
    playedCardIds: [],
    fetcher: mockMixed,
  });
  assert.equal(emptyPlayed.ok, true);
  if (emptyPlayed.ok) {
    assert.equal(emptyPlayed.name, 'BBU Harold Mage (55%)');
    assert.equal(emptyPlayed.matchedCount, 0);
  }

  const badClass = await searchOpponentDeckCode({
    format: 'standard',
    heroClass: '武僧',
    playedCardIds: [],
    fetcher: mockMixed,
  });
  assert.equal(badClass.ok, false);
  if (!badClass.ok) {
    assert.match(badClass.error, /暂不支持职业/);
  }

  const allFail = await searchOpponentDeckCode({
    format: 'standard',
    heroClass: '法师',
    playedCardIds: [],
    fetcher: async () => new Response('forbidden', { status: 403 }),
  });
  assert.equal(allFail.ok, false);
  if (!allFail.ok) {
    assert.equal(allFail.error, '联网拉取构筑榜失败（HTTP 403）。');
  }

  assert.equal(formatArchetypeName('', '潜行者', 52.3), '潜行者主流(52.3%)');
});
