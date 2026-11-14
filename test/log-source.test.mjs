import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 日志写满那一行不是对局日志，解析器看不见它 —— 但它之后的每一行都不会再有了。
 *
 * 实测 2026-10-24：Power.log 到 10MB 后炉石写下 `Truncating log, which has reached
 * the size limit of 10000KB` 就停了，那一局的后半段连同结局整段丢失。
 * 他输了，她一个字没说 —— 因为对她来说那局还停在 14:16。
 */
import { isLogFullLine } from '../src/log-source.ts';

test('认得出炉石自己写的「日志写满」', () => {
  assert.equal(isLogFullLine('Truncating log, which has reached the size limit of 10000KB'), true);
  assert.equal(isLogFullLine('D 14:16:00.0000000 Truncating log, which has reached the size limit of 10000KB'), true);
  // 正常对局行不能被误判
  assert.equal(isLogFullLine('D 14:10:59.5714847 GameState.DebugPrintPower() -     TAG_CHANGE Entity=1 tag=TURN value=11'), false);
  assert.equal(isLogFullLine(''), false);
});

/**
 * 定位日志的路径不用每轮都重扫。
 *
 * `resolvePowerLog` 要递归扫安装目录,实测 2.4ms —— 400ms 轮询下每轮都做,常年占着事件循环。
 * 而 `Logs` 只增不减(日志上限已关掉,每次重启炉石都多一个会话目录),会越扫越慢。
 * 路径只在炉石重启(换目录)或文件消失时才变,15 秒重扫一次足够。
 */
test('轮询不会每轮都重扫目录找日志', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { PowerLogTail } = await import('../src/log-source.ts');

  const dir = fs.mkdtempSync(join(os.tmpdir(), 'hs-rescan-'));
  try {
    const path = join(dir, 'Power.log');
    fs.writeFileSync(path, 'D 01:00:00.0000000 GameState.DebugPrintPower() - CREATE_GAME\n');
    let calls = 0;
    const tail = new PowerLogTail({
      getPath: () => { calls += 1; return { path, why: '测试' }; },
      onLines: () => {},
      pollMs: () => 40,
    });
    tail.start();
    await new Promise((r) => setTimeout(r, 600));   // 约 15 轮
    tail.stop();
    assert.ok(calls <= 2, `600ms 内定位被调了 ${calls} 次,应该只有 1–2 次`);
    assert.equal(tail.currentPath, path);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
