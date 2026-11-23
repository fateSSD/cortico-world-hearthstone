import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDeckString } from '../src/deck-code.ts';
import { pickBestMatchingDeck, searchOpponentDeckCode } from '../src/deck-search.ts';

test('pickBestMatchingDeck 按对手已出原生牌精准匹配构筑', () => {
  // 315 = CS2_029 火球术，1004 = CS2_032 烈焰风暴，559 = CS2_024 寒冰箭
  const candidates = [
    { deck_id: 'd1', deck_list: '[[315,2],[559,2]]', win_rate: 58.2, total_games: 500, archetype_id: 10 },
    { deck_id: 'd2', deck_list: '[[1004,2],[559,2]]', win_rate: 53.0, total_games: 200, archetype_id: 11 },
  ];
  const picked = pickBestMatchingDeck(candidates, ['CS2_032']);
  assert.ok(picked);
  assert.equal(picked.entry.deck_id, 'd2');
  assert.equal(picked.matchedCount, 1);
});

test('searchOpponentDeckCode 编码出可解码的合法卡组代码并附带构筑名', async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('list_decks_by_win_rate_v2')) {
      return new Response(JSON.stringify({
        series: {
          data: {
            MAGE: [
              { deck_id: 'm1', deck_list: '[[315,2],[1004,1]]', win_rate: 56.4, total_games: 320, archetype_id: 777 },
            ],
          },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify([{ id: 777, name: 'Burn Mage' }]), { status: 200 });
  };

  const res = await searchOpponentDeckCode({
    format: 'standard',
    heroClass: '法师',
    playedCardIds: ['CS2_029'],
    fetcher: mockFetch,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(res.code, /^AAE/);
  assert.match(res.name, /Burn Mage/);
  assert.equal(res.matchedCount, 1);
  const decoded = decodeDeckString(res.code);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.deck.heroClass, '法师');
    assert.equal(decoded.deck.totalCards, 3);
  }
});
