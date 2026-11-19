/**
 * 赢了要跳。
 *
 * 用户的原话是「赢了，麻烦让她跳一下，开心一下」。表情早就有了，缺的是**动作** ——
 * 桌宠的词表里除了表情还有 motion(`jump` / `hop` / `flap` / `dance` …)，
 * 写成 `<happy, jump>` 这样的行内标记，她照抄进 `pet_say` 就会真的跳。
 *
 * 这一组测试盯三件事：
 *   1. 三种结局的标记没写反（输了还跳，比不跳更难看）
 *   2. 标记是**语法合法**的 —— 用桌宠自己的 parseScript 解一遍，一个词都不许掉
 *   3. 同一局只庆祝一次 —— 否则重启一次她就为同一场胜利欢呼一次
 *
 * 第 2 条是最容易静默失效的：词 id 写错、立绘包换了没有某个动作，
 * 桌宠那边都是**静默丢弃**，不报错。她照抄过去，人站着不动，谁也不知道为什么。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { endMarker } from '../src/alerts.ts';
import { gameKey } from '../src/world.ts';

const COOP_ROOT = process.env.COOPANION_ROOT ?? 'C:/Users/祁鹏宇/Coopanion';
const PET_PKG = `${COOP_ROOT}/resources/app/node_modules/cortico-world-desktop-pet`;

/** 桌宠自己的脚本解析器与当前立绘包的词表；拿不到就跳过那几条(换台机器不该红)。 */
async function petToolkit() {
  try {
    // Node 22 拒绝直接 strip node_modules 里的 TS；转换同一份真实源码后经 data URL 执行。
    const source = readFileSync(`${PET_PKG}/src/script.ts`, 'utf8');
    const javascript = stripTypeScriptTypes(source, { mode: 'transform' });
    const script = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
    const figure = JSON.parse(readFileSync(`${PET_PKG}/web/whale/figure.json`, 'utf8'));
    return { parseScript: script.parseScript, vocab: figure.vocab };
  } catch {
    return null;
  }
}

test('赢了给的是「开心 + 跳」', () => {
  assert.equal(endMarker('won'), '<happy, jump>');
});

test('输了不跳 —— 只给一张难过的脸', () => {
  assert.equal(endMarker('lost'), '<sad>');
  assert.ok(!endMarker('lost').includes('jump'), '输了还跳，比不跳更难看');
});

test('平局不跳', () => {
  assert.equal(endMarker('tied'), '<neutral>');
});

test('标记是 pet_say 能认的语法，一个词都不许掉', async (t) => {
  const kit = await petToolkit();
  if (!kit) return t.skip('找不到 Coopanion 的桌宠包（设 COOPANION_ROOT 再跑）');

  for (const result of ['won', 'lost', 'tied']) {
    const marker = endMarker(result);
    const parsed = kit.parseScript(`${marker}这局赢了`, kit.vocab);
    assert.deepEqual(parsed.dropped, [], `${result} 的标记里有桌宠不认识的词：${parsed.dropped.join('、')}`);
    assert.equal(parsed.beats.length, 1);
    assert.equal(parsed.beats[0].text, '这局赢了', '标记本身不是台词，不该混进正文');
  }
});

test('赢了的标记真的会调起 jump 这个动作', async (t) => {
  const kit = await petToolkit();
  if (!kit) return t.skip('找不到 Coopanion 的桌宠包（设 COOPANION_ROOT 再跑）');

  const kinds = new Map(kit.vocab.map((v) => [v.id, v.kind]));
  const parsed = kit.parseScript(`${endMarker('won')}赢了赢了!`, kit.vocab);

  // `<…>` 是行内标记：挂在 anchor 上，打字打到那个位置时触发，不另起气泡。
  // 所以动作在 beats[0].anchors[0] 里，不在 beats[0].actions 里 —— 后者是 `【…】` 那种整块标记。
  assert.equal(parsed.beats[0].anchors.length, 1);
  assert.deepEqual(parsed.beats[0].anchors[0].actions, ['happy', 'jump']);
  assert.equal(parsed.beats[0].anchors[0].at, 0, '写在最前面就该一开始就跳');
  assert.equal(kinds.get('happy'), 'expression');
  assert.equal(kinds.get('jump'), 'motion', 'jump 必须是动作，不能是表情');
});

test('同一局指纹稳定，不同的两局不会撞', () => {
  const base = {
    result: 'won', turn: 12,
    me: { health: 18, armor: 0, heroClass: 'PALADIN' },
    opponent: { health: -3, armor: 0, heroClass: 'MAGE' },
  };
  const same = { ...base, me: { ...base.me }, opponent: { ...base.opponent } };
  assert.equal(gameKey(base), gameKey(same), '同一局重放必须对得上，否则每次重启都会再庆祝一次');

  const otherTurn = { ...base, turn: 13 };
  const otherHp = { ...base, me: { ...base.me, health: 17 } };
  assert.notEqual(gameKey(base), gameKey(otherTurn));
  assert.notEqual(gameKey(base), gameKey(otherHp));
});
