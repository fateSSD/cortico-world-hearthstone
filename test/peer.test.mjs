/**
 * 「听歌时让路」靠的就是这个探测。它错了只有两种后果，两种都难看：
 * 认不出来 → 开关形同虚设；乱认一气 → 她整场不说话，而且没人知道为什么。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPeerRunning, resetPeerCache } from '../src/peer.ts';

test('对端进程探测：认得出在跑的，也认得出不在的', async (t) => {
  if (process.platform !== 'win32') return t.skip('只测 Windows（tasklist）');

  resetPeerCache();
  assert.equal(
    await isPeerRunning(['definitely-not-a-real-process-xyz.exe']), false,
    '不存在的进程必须判 false —— 否则她会莫名其妙整场闭麦',
  );

  resetPeerCache();
  assert.equal(
    await isPeerRunning(['node.exe']), true,
    '测试自己就跑在 node 里，认不出来就是坏了',
  );
});
