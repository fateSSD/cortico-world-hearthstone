/**
 * describe.json 与代码的一致性。
 *
 * 宿主 `resources/app/build/cortico/src/extensions/describe.ts` 的注释原话：
 * **索引仓的 Action 和 WebUI 的扩展市场只读 describe.json，不执行扩展代码**；
 * 运行时模型拿的是扩展导出的那张表。两处一旦分家：
 *   · 运行时不报错，模型照着新描述走；
 *   · 只有市场页面在骗人 —— 用户按页面上的说明提问，得到相反的答案。
 *
 * 2026-11-16 在 journey 上真踩过一次（改了工具说明、忘了重生成），顺手自查这一包，
 * 发现 6 条工具说明是旧的，而且 **`hearthstone.selfplay` 代码里有、JSON 里根本没有**
 * —— 市场页面上那个事件等于不存在，用户读不到「先问她一句再动手」这条规矩。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { HEARTHSTONE_DESCRIBE } from '../src/world.ts';

const onDisk = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));

test('工具声明：describe.json 的名单和说明必须和代码一字不差', () => {
  assert.deepEqual(
    onDisk.tools.map((t) => t.name).sort(),
    HEARTHSTONE_DESCRIBE.tools.map((t) => t.name).sort(),
    '工具名单两边不一致 —— 改一边忘了另一边',
  );
  for (const t of HEARTHSTONE_DESCRIBE.tools) {
    const mirror = onDisk.tools.find((x) => x.name === t.name);
    assert.equal(mirror.description, t.description, `${t.name} 的 description 漂了`);
    assert.deepEqual(mirror.summary, t.summary, `${t.name} 的 summary 漂了`);
    assert.deepEqual(mirror.parameters, t.parameters, `${t.name} 的 parameters 漂了`);
  }
});

test('事件声明：describe.json 的事件表和运行时一致', () => {
  assert.deepEqual(
    onDisk.events.map((e) => e.type).sort(),
    HEARTHSTONE_DESCRIBE.events.map((e) => e.type).sort(),
    '事件名单两边不一致',
  );
  for (const e of HEARTHSTONE_DESCRIBE.events) {
    const mirror = onDisk.events.find((x) => x.type === e.type);
    assert.equal(mirror.trigger, e.trigger, `${e.type} 的 trigger 两边不一致`);
    assert.deepEqual(mirror.tags ?? [], e.tags ?? [], `${e.type} 的 tags 两边不一致`);
    assert.deepEqual(mirror.description, e.description, `${e.type} 的说明漂了`);
    assert.ok(e.description.zh.trim() && e.description.en.trim(), `${e.type} 少了说明`);
  }
});
