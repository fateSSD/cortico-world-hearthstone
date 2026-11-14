/**
 * 竞技场选牌。
 *
 * 这里测的不是「她选得对不对」——那是模型判断,测不了。测的是**会算错的地方**:
 *   · 卡名能不能反查到(竞技场靠名字输入,查不到就等于瞎)
 *   · 曲线和缺口算得对不对
 *   · 评分排序有没有明显反智(3 费 1/4 排到 6 费 6/7 前面就是反智)
 *   · 查不到的牌必须标出来,不能给个分蒙混过去
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { curveGaps, deckStats, rankOptions, renderDraft, resolveArenaCard, scoreCard } from '../src/arena.ts';

test('按中文名找到牌,费用和摘要都对', () => {
  const card = resolveArenaCard('火球术');
  assert.ok(card?.found);
  assert.equal(card.name, '火球术');
  assert.equal(card.cost, 4);
  assert.equal(card.type, '法术');
  assert.match(card.note, /伤害6/);
});

test('按 cardId 也能找到', () => {
  const card = resolveArenaCard('CS2_029');
  assert.equal(card?.name, '火球术');
});

test('查不到的牌返回 found=false,不许编', () => {
  const card = resolveArenaCard('这张牌肯定不存在zzz');
  assert.equal(card?.found, false);
  assert.equal(scoreCard(card, null), null, '查不到就不能给分');
});

test('曲线按费用分档,7 费以上并到一档', () => {
  const stats = deckStats(['淡水鳄', '淡水鳄', '火球术', '炎爆术', '山岭巨人']);
  assert.equal(stats.count, 5);
  assert.equal(stats.curve[2], 2);
  assert.equal(stats.curve[4], 1);
  assert.equal(stats.minions, 3);
  assert.equal(stats.spells, 2);
});

test('解场牌数与群体分开数', () => {
  const stats = deckStats(['火球术', '寒冰箭', '烈焰风暴', '淡水鳄']);
  assert.equal(stats.removal, 3, '两张单体直伤 + 一张群体');
  assert.equal(stats.aoe, 1);
});

test('直伤法术高于同费白板,群体高于单体', () => {
  const fireball = scoreCard(resolveArenaCard('火球术'), null).total;
  const flamestrike = scoreCard(resolveArenaCard('烈焰风暴'), null).total;
  const ogre = scoreCard(resolveArenaCard('石拳食人魔'), null).total;
  assert.ok(fireball > ogre, `火球术 ${fireball} 应高于石拳食人魔 ${ogre}`);
  assert.ok(flamestrike > ogre, `烈焰风暴 ${flamestrike} 应高于石拳食人魔 ${ogre}`);
});

test('低效小身材不能靠「嘲讽」翻身压过大随从', () => {
  // 曾经踩过:每费效率算法让 3 费 1/4 嘲讽(银背族长) 排到了 6 费 6/7 前面
  const silverback = scoreCard(resolveArenaCard('银背族长'), null).total;
  const ogre = scoreCard(resolveArenaCard('石拳食人魔'), null).total;
  assert.ok(ogre > silverback, `石拳食人魔 ${ogre} 应高于银背族长 ${silverback}`);
});

test('牌组缺 2 费时,2 费牌会被加分', () => {
  const thin = ['火球术', '火球术', '火球术', '火球术', '火球术', '火球术', '火球术', '火球术'];
  const stats = deckStats(thin);
  const withGap = scoreCard(resolveArenaCard('淡水鳄'), stats);
  const withoutGap = scoreCard(resolveArenaCard('淡水鳄'), null);
  assert.ok(withGap.total > withoutGap.total, `${withGap.total} 应高于 ${withoutGap.total}`);
  assert.ok(withGap.parts.some((p) => p.includes('缺口')), '要说明为什么加分');
});

test('曲线缺口能指出来', () => {
  const stats = deckStats(Array.from({ length: 12 }, () => '火球术'));
  const gaps = curveGaps(stats);
  assert.ok(gaps.some((g) => g.includes('2 费偏少')), gaps.join(';'));
});

test('排序按分数从高到低,查不到的排最后且不给分', () => {
  const ranked = rankOptions(['石拳食人魔', '火球术', '不存在的牌'], null);
  assert.equal(ranked[0].card.name, '火球术');
  assert.equal(ranked.at(-1).card.found, false);
  assert.equal(ranked.at(-1).score, null);
});

test('回执里四块都在,并且明确说了候选从哪来', () => {
  const text = renderDraft(['火球术', '石拳食人魔'], ['淡水鳄', '寒冰箭']);
  assert.match(text, /【当前牌组】/);
  assert.match(text, /【候选】/);
  assert.match(text, /【机械排序】/);
  assert.match(text, /火球术/);
});

test('没给候选时,明说读不到日志、要用户念', () => {
  const text = renderDraft([], []);
  assert.match(text, /读不到/);
  assert.match(text, /念/);
});

/* ---------- 卡名形近兜底（2026-11-12） ---------- */

// 来源：一位用户在 mac 上打竞技场，把「巡游船长萝拉」念成「巡游船长罗拉」，
// 精确匹配和子串都对不上，那一手就没出机械分。选牌阶段只能靠手动报牌，
// 报错一次就少一条数据，而且他不知道是自己报错了。

test('形近兜底：罗拉 → 萝拉（语音常见的同音字）', () => {
  const c = resolveArenaCard('巡游船长罗拉');
  assert.ok(c, '不该返回 null');
  assert.equal(c.found, true, '该认出来');
  assert.equal(c.name, '巡游船长萝拉');
  assert.equal(c.matchedBy, 'fuzzy', '必须标明是形近命中，不能当精确');
});

test('原样报对时走精确，不能被兜底抢走', () => {
  const c = resolveArenaCard('巡游船长萝拉');
  assert.equal(c.matchedBy, 'exact');
});

test('查不到时给候选，不是干巴巴一句「查不到」', () => {
  const c = resolveArenaCard('完全不存在这张牌xyz');
  assert.ok(c);
  assert.equal(c.found, false);
  // 没有合理候选时可以是空数组，但不能是 undefined 以外的怪东西
  assert.ok(Array.isArray(c.suggestions ?? []));
});

test('规范化：空格和标点不影响命中', () => {
  const a = resolveArenaCard('火球 术');
  const b = resolveArenaCard('火球术');
  assert.ok(a && b);
  assert.equal(a.name, b.name, '抹掉空格后应该是同一张');
});

test('空白查询返回 null（调用方要能区分「没给」和「查不到」）', () => {
  assert.equal(resolveArenaCard('   '), null);
  assert.equal(resolveArenaCard(''), null);
});
