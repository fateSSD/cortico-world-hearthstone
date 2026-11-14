/**
 * 回合水位:换局之后她还能不能继续开口。
 *
 * 用户的原话是「为啥打着打着,她不自动推荐打法了」。真凶就在这里:
 * `lastAnnouncedTurn` 是严格递增的水位,一局推到第 16 回合,下一局从第 1 回合开始,
 * `1 > 16` 是假命题 —— 整局一句不出,要等回合数爬过 16 才突然恢复。
 *
 * 这一组测试盯两件事:
 *   1. 换局必须清零水位(而且不能只靠 CREATE_GAME 检测)
 *   2. 没换局的时候不能乱清零 —— 否则同一回合会重复开口
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleTurnWatermark, shouldAnnounceTurn } from '../src/turn-event.ts';

const snap = (turn, isMyTurn = true, ended = false) => ({ turn, isMyTurn, ended });

/** 复刻 world.ts 的每批判定:先结算水位,再问该不该开口。 */
function batch(state, s) {
  state.watermark = settleTurnWatermark(state.watermark, s.turn);
  const announce = shouldAnnounceTurn(s, state.watermark);
  if (announce) state.watermark = s.turn;
  return announce;
}

test('第一回合就开口', () => {
  const state = { watermark: -1 };
  assert.equal(batch(state, snap(1)), true);
  assert.equal(state.watermark, 1);
});

test('同一回合不重复开口', () => {
  const state = { watermark: -1 };
  assert.equal(batch(state, snap(3)), true);
  assert.equal(batch(state, snap(3)), false, '打完一张牌回到行动阶段会再来一批,不能又报一次');
  assert.equal(state.watermark, 3);
});

test('对手回合不开口', () => {
  const state = { watermark: -1 };
  assert.equal(batch(state, snap(4, false)), false);
  assert.equal(state.watermark, -1, '没开口就不该推进水位');
});

test('已结束的对局不开口', () => {
  const state = { watermark: -1 };
  assert.equal(batch(state, snap(9, true, true)), false);
});

test('换局之后从第 1 回合开始,必须继续开口 —— 这就是那个 bug', () => {
  const state = { watermark: -1 };

  // 第一局:1 到 16 回合
  for (let t = 1; t <= 16; t += 1) assert.equal(batch(state, snap(t)), true, `第一局第 ${t} 回合`);
  assert.equal(state.watermark, 16);
  assert.equal(batch(state, snap(16, true, true)), false, '结束那一批不推');

  // 换局:回合号回到 1
  assert.equal(batch(state, snap(1)), true, '新局第一回合必须开口');
  assert.equal(state.watermark, 1);
  for (let t = 2; t <= 16; t += 1) assert.equal(batch(state, snap(t)), true, `新局第 ${t} 回合`);
});

test('不做水位清零就会整局哑火 —— 反证上面那条测试真能抓住回归', () => {
  // 这是修复前的行为,留在这里当对照:同样喂一遍新局,一条都不出
  const stuck = 16;
  const silent = [];
  for (let t = 1; t <= 16; t += 1) if (shouldAnnounceTurn(snap(t), stuck)) silent.push(t);
  assert.deepEqual(silent, [], '回合数没爬过上一局之前,一句都不会有');
});

test('settleTurnWatermark 只在回合号掉回去时清零', () => {
  assert.equal(settleTurnWatermark(16, 16), 16, '同一回合原样保留');
  assert.equal(settleTurnWatermark(16, 20), 16, '回合往前走更不能清');
  assert.equal(settleTurnWatermark(16, 1), -1, '掉回去 = 换局');
  assert.equal(settleTurnWatermark(-1, 1), -1);
});

test('重连场景:日志从一局的中段开始,回合号比上一局还大', () => {
  const state = { watermark: 16 };
  // 炉石断线重连,新日志第一屏就是第 26 回合
  assert.equal(batch(state, snap(26)), true, '26 > 16,照常开口');
  assert.equal(state.watermark, 26);
});

test('连续三局,每局都能从第 1 回合开始说话', () => {
  const state = { watermark: -1 };
  const announced = [];
  for (let game = 0; game < 3; game += 1) {
    for (let t = 1; t <= 12; t += 1) {
      if (batch(state, snap(t))) announced.push(`局${game + 1}-回${t}`);
    }
    batch(state, snap(12, true, true));
  }
  assert.equal(announced.length, 36, '三局各 12 回合,一条都不能少');
  assert.equal(announced[0], '局1-回1');
  assert.equal(announced[12], '局2-回1', '第二局的第一回合必须在');
  assert.equal(announced[24], '局3-回1');
});
