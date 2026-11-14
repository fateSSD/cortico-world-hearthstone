/**
 * 回合事件的拼装。
 *
 * 直接测纯函数,不走日志重放:重放受「哪一局、打到第几回合」影响,测起来脆;
 * 而这里要守的是**两句话必须来自同一份状态**,以及「算不准就不说」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeTurnEvent } from '../src/turn-event.ts';

const MINION = (o = {}) => ({
  id: 1, name: '', cardId: '', atk: 0, health: 1, maxHealth: 1,
  taunt: false, divineShield: false, frozen: false, stealth: false, windfury: false, canAttack: true, ...o,
});

const SIDE = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 20, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 0, handCards: [], deckCount: 20, secrets: 0,
  minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const SNAP = (me, foe, turn = 9) => ({
  startedAt: '', turn, activePlayerId: 1, isMyTurn: true, step: 'MAIN_ACTION', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 },
});

const POINT = (turn = 9) => ({ turn, myHp: 20, myArmor: 0, myHand: 5, myBoard: '1 个(攻 5/血 5)', foeHp: 12, foeArmor: 0, foeHand: 4, foeBoard: '1 个(攻 3/血 3)' });

test('正常回合:局面 + 建议一起给', () => {
  const snap = SNAP(
    SIDE({ health: 20, mana: 5, handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }], minions: [MINION({ id: 11, atk: 5, health: 5 })] }),
    SIDE({ isLocal: false, health: 8 }),
  );
  const out = composeTurnEvent(POINT(), snap, true);
  assert.equal(out.defer, false);
  assert.equal(out.hasAdvice, true);
  assert.match(out.text, /我 20 血/);
  assert.match(out.text, /建议(\[\w+\])?:/);
  assert.match(out.text, /能斩杀/);
});

test('关掉建议时只报局面', () => {
  const snap = SNAP(SIDE({ mana: 5 }), SIDE({ isLocal: false, health: 8 }));
  const out = composeTurnEvent(POINT(), snap, false);
  assert.equal(out.hasAdvice, false);
  assert.equal(/建议(\[\w+\])?:/.test(out.text), false);
});

test('水晶还没刷新(0)时,等下一批,不硬发', () => {
  const snap = SNAP(SIDE({ mana: 0, handCards: [{ id: 1, cardId: 'CS2_029', cost: 4 }] }), SIDE({ isLocal: false }));
  const out = composeTurnEvent(POINT(), snap, true);
  assert.equal(out.defer, true, '应当推迟');
  assert.equal(out.text, '');
});

test('已经等过一次还拿不到,就只报局面(不再无限等)', () => {
  const snap = SNAP(SIDE({ mana: 0 }), SIDE({ isLocal: false }));
  const out = composeTurnEvent({ ...POINT(), waited: true }, snap, true);
  assert.equal(out.defer, false);
  assert.equal(out.hasAdvice, false);
  assert.match(out.text, /第 9 回合/);
});

test('局面是别的回合的,一律不用 —— 不能把两回合的数混进一句话', () => {
  const snap = SNAP(SIDE({ mana: 5, health: 3 }), SIDE({ isLocal: false, health: 30 }), 15);
  const out = composeTurnEvent(POINT(9), snap, true);
  assert.equal(out.hasAdvice, false);
  // 用的是回合点自己的数字,不是第 15 回合的
  assert.match(out.text, /我 20\+?0? ?血|我 20 血/);
  assert.equal(out.text.includes('我 3 血'), false);
});

test('第 1 回合水晶本来就是 0,不算「没刷新」', () => {
  const snap = SNAP(SIDE({ mana: 0, manaMax: 0 }), SIDE({ isLocal: false }), 1);
  const out = composeTurnEvent(POINT(1), snap, true);
  assert.equal(out.defer, false, '第 1 回合不该卡住');
});
