/**
 * 「可交易」这个词条。
 *
 * 用户的判断是「她没算」。查下来是**算了，但只算了一条最窄的路**：
 *   · 只有「这回合什么都做不了」时才会提（`prepareNote` 的兜底分支）；
 *   · 工具回执里从来没有这一项 —— 她调 hearthstone_advice 看不到；
 *   · 剩下的水晶数用的是回合总水晶，和「按费打…剩 N 费」摆在一起会差一截。
 *
 * 这三条都在下面钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { advise, briefAdvice, readHand } from '../src/advice.ts';

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 30, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 0, handCards: [], coinCount: 0,
  deckCount: 20, secrets: 0, minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe) => ({
  startedAt: '', turn: 8, activePlayerId: 1, isMyTurn: true, step: '', ended: false, result: null,
  me, opponent: foe, boardAttack: { mine: 0, theirs: 0 },
});

const emptyFoe = () => side({ isLocal: false });

test('可交易标记读得出来', () => {
  const [card] = readHand(side({ mana: 3, handCards: [{ id: 1, cardId: 'EX1_002', cost: 4 }] }));
  assert.equal(card.name, '黑骑士');
  assert.equal(card.tradeable, true);
  assert.equal(card.playable, false, '4 费在 3 水晶回合打不出');
});

test('剩水的数字要和「剩 N 费」对得上，不能再说回合总水晶', () => {
  const s = snap(
    side({ mana: 3, manaMax: 3, handCount: 2, handCards: [
      { id: 1, cardId: 'EDR_251', cost: 1 },   // 龙鳞军备 1 费，会被推
      { id: 2, cardId: 'EX1_002', cost: 4 },   // 黑骑士 4 费可交易，打不出
    ] }),
    emptyFoe(),
  );
  const text = briefAdvice(s).text;
  assert.match(text, /剩 2 费/, '1 费花掉，还剩 2');
  assert.match(text, /还剩 2 点水晶/, '交易那句说的也该是 2，不是总水晶 3');
  assert.doesNotMatch(text, /还剩 3 点水晶/, '两个数不能差一截');
});

test('工具回执里要有可交易这一项', () => {
  const s = snap(
    side({ mana: 3, manaMax: 3, handCount: 2, handCards: [
      { id: 1, cardId: 'EDR_251', cost: 1 },
      { id: 2, cardId: 'EX1_002', cost: 4 },
    ] }),
    emptyFoe(),
  );
  const cands = advise(s).candidates.join('\n');
  assert.match(cands, /可交易/, '她调工具时要看得见这条路');
  assert.match(cands, /黑骑士/);
  assert.match(cands, /当回合就能打/, '换一张不是终点，换来那张还能打');
});

test('这回合打得出的可交易牌，不劝他交易掉', () => {
  // 4 水晶回合的黑骑士打得出来 —— 这时候交易等于把能用的牌洗掉
  const s = snap(
    side({ mana: 4, manaMax: 4, handCount: 1, handCards: [{ id: 1, cardId: 'EX1_002', cost: 4 }] }),
    emptyFoe(),
  );
  const text = briefAdvice(s).text;
  assert.doesNotMatch(text, /交易掉/, '打得出就别劝交易');
  assert.match(text, /黑骑士/, '该照常推它');
});

test('预备用剩水算，但只对「总水晶就打不出」的牌', () => {
  // 5 水晶、3 费预备牌：它打得出来，只是在按费打之后剩 2 费。
  // 这时候劝预备 = 同一句话里一边劝打一边劝锁。
  const s = snap(
    side({ mana: 5, manaMax: 5, handCount: 1, handCards: [{ id: 1, cardId: 'CS2_146', cost: 3 }] }),
    emptyFoe(),
  );
  const text = briefAdvice(s).text;
  const advisedPlay = /按费打:([^(\s]+)/.exec(text)?.[1];
  if (advisedPlay) {
    assert.doesNotMatch(text, new RegExp(`把${advisedPlay}预备掉`), '推它打，就不能同时劝它预备');
  }
});
