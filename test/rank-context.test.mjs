import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefAdvice } from '../src/advice.ts';

const minion = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 0, health: 1, maxHealth: 1, taunt: false,
  divineShield: false, frozen: false, stealth: false, windfury: false,
  canAttack: true, cantAttack: false, ...o,
});
const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '圣骑士', heroName: '', heroCardId: '',
  health: 30, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 0, handCards: [], coinCount: 0,
  coinMana: 0, deckCount: 20, secrets: 0, minions: [], weapon: null, playState: 'PLAYING', ...o,
});
const snap = (me, foe) => ({
  startedAt: '', turn: 12, activePlayerId: 1, isMyTurn: true, step: '',
  ended: false, result: null, me, opponent: foe, boardAttack: { mine: 0, theirs: 0 },
});

// 2026-10-29 第 12 回合的原样：对面 18 血、我 30 血、对面场攻 4（一只 4/4）。
// 旧逻辑里「救生员(4费 2/7 嘲讽)」无条件排第一，她推架墙；他实际打的是大力扣杀(6费)。
test('优势局不该先推嘲讽墙', () => {
  const s = snap(
    side({
      health: 30, mana: 6, manaMax: 6,
      handCards: [
        { id: 1, cardId: 'VAC_919', cost: 4 },
        { id: 2, cardId: 'VAC_915', cost: 6 },
      ],
      handCount: 2,
    }),
    side({ playerId: 2, isLocal: false, heroClass: '术士', health: 18, minions: [minion({ id: 9, atk: 4, health: 4, maxHealth: 4 })] }),
  );
  const text = briefAdvice(s, {}).text;
  assert.doesNotMatch(text, /按费打:救生员/, `优势局推了嘲讽:${text}`);
});

// 2026-10-29 第 14 回合：两张 6 费随从并列，3/0 风怒排在了 6/6 吸血前面。
test('同费同档时，身材好的排前面', () => {
  const s = snap(
    side({
      health: 30, mana: 7, manaMax: 7,
      handCards: [
        { id: 1, cardId: 'JAM_011', cost: 6 },
        { id: 2, cardId: 'WW_434', cost: 6 },
      ],
      handCount: 2,
    }),
    side({ playerId: 2, isLocal: false, heroClass: '术士', health: 4, minions: [minion({ id: 9, atk: 6, health: 8, maxHealth: 8, taunt: true })] }),
  );
  const text = briefAdvice(s, {}).text;
  assert.match(text, /按费打:日斑巨龙/, `3/0 压过了 6/6:${text}`);
});
