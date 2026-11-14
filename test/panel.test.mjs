/**
 * 扩展页那块「陪打」面板的数据面。
 *
 * 这块面板存在的理由很具体:设置页是接入用的,他一天真正要点几十次的是
 * 「现在什么情况」和「这回合怎么打」。非自动模式(mode=quiet)下,那个按钮就是唯一的问法 ——
 * 所以它不能只是好看:状态要准,建议要和回合事件里说的一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelAdvice, panelAskText, panelStatus } from '../src/panel.ts';

const side = (o = {}) => ({
  playerId: 1, isLocal: true, heroClass: '', heroName: '', heroCardId: '',
  health: 30, maxHealth: 30, armor: 0, heroAttack: 0, fatigue: 0,
  mana: 5, manaMax: 5, overload: 0, handCount: 3, handCards: [], deckCount: 18, secrets: 0,
  spellPower: 0, minions: [], weapon: null, playState: 'PLAYING', ...o,
});

const snap = (me, foe, extra = {}) => ({
  startedAt: '', turn: 9, activePlayerId: 1, isMyTurn: true, step: 'MAIN_ACTION',
  ended: false, result: null, me, opponent: foe, boardAttack: { mine: 0, theirs: 0 }, ...extra,
});

const cfg = { mode: 'quiet', speakTurns: true, speakAlerts: true, keepCards: '' };

test('没找到日志时面板说清「看不见对局」,而不是显示 0 血', () => {
  const st = panelStatus(null, { phase: 'no-log', path: null, note: '没找到 Power.log。' }, cfg);
  assert.equal(st.phase, 'no-log');
  assert.equal(st.me, null);
  assert.equal(st.foe, null);
  assert.equal(st.turn, null);
  assert.match(st.note, /Power\.log/);
  // 开关状态照样要读出来,不然面板上的复选框全是空的
  assert.equal(st.auto.mode, 'quiet');
});

test('对局中:面板给的是能直接看的数,不是日志原文', () => {
  const st = panelStatus(
    snap(
      side({ heroClass: '术士', health: 22, armor: 3, mana: 6, manaMax: 9, handCount: 5 }),
      side({ isLocal: false, heroClass: '牧师', health: 15, armor: 0, minions: [1, 2].map((id) => ({
        id, name: '', cardId: '', atk: 3, health: 3, maxHealth: 3, taunt: false, divineShield: false,
        frozen: false, stealth: false, windfury: false, poisonous: false, lifesteal: false,
        reborn: false, rush: false, charge: false, canAttack: true,
      })) }),
      { boardAttack: { mine: 4, theirs: 7 } },
    ),
    { phase: 'in-game', path: 'x/Power.log', note: '第 9 回合。' },
    cfg,
  );
  assert.equal(st.turn, 9);
  assert.equal(st.myTurn, true);
  assert.equal(st.me.hp, 22);
  assert.equal(st.me.armor, 3);
  assert.equal(st.me.manaMax, 9);
  assert.equal(st.me.hand, 5);
  assert.equal(st.foe.cls, '牧师');
  assert.equal(st.foe.boardAttack, 7);
  assert.equal(st.foe.minions, 2);
});

test('对局结束后不给建议 —— 没有「这回合打什么」这回事', () => {
  const ended = snap(side(), side(), { ended: true, result: 'lost' });
  assert.equal(panelAdvice(ended, ''), null);
  assert.equal(panelAdvice(null, ''), null);
});

test('面板建议和回合事件同一句 —— 两处各写一套就会互相打脸', () => {
  const s = snap(
    side({ health: 6, mana: 4, manaMax: 4, handCards: [] }),
    side({ isLocal: false, heroClass: '战士', manaMax: 5, minions: [{
      id: 21, name: '', cardId: '', atk: 9, health: 9, maxHealth: 9, taunt: false, divineShield: false,
      frozen: false, stealth: false, windfury: false, poisonous: false, lifesteal: false,
      reborn: false, rush: false, charge: false, canAttack: true,
    }] }),
  );
  const a = panelAdvice(s, '');
  assert.ok(a);
  assert.equal(a.kind, 'danger');
  assert.match(a.text, /危险/);
  // face 要给出来:面板旁边的桌宠要摆同一张脸
  assert.equal(a.face, 'scared');
});

test('点按钮推给她的事件:说清是他主动问的,并带上机械建议', () => {
  const s = snap(
    side({ health: 20, mana: 7, manaMax: 9, handCount: 4 }),
    side({ isLocal: false, heroClass: '术士', health: 12 }),
  );
  const advice = panelAdvice(s, '');
  assert.ok(advice);
  const text = panelAskText(s, advice);
  assert.match(text, /第 9 回合/);
  assert.match(text, /点.*让她看这回合/, `没说清是他主动问的:${text}`);
  assert.match(text, /机械建议/, text);
  // 建议正文要原样带上,不然她还得再查一次工具
  assert.ok(text.includes(advice.text));
});
