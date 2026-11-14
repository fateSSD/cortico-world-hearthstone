/**
 * 对端扩展对应的程序在不在跑。
 *
 * 为什么需要这一层：两个扩展装在同一个宿主里，各推各的事件，**互相不认识** ——
 * 宿主只给了「往同一个对话推事件」这一条路，没有 world 之间互查状态的接口。
 * 而「听歌的时候别解说」这种需求是真的，进程列表就是唯一不需要跨扩展通信、
 * 也不用改宿主就能拿到的信号。
 *
 * 代价要说清楚：**看到进程 ≠ 正在听**。播放器挂着没放也算在跑，这时炉石同样会安静。
 * 所以它只能躲在用户自己打开的开关后面，不能默认开。
 *
 * 各平台怎么列进程、进程叫什么，全在 `platform.ts`（Windows 是 `tasklist` + `.exe`，
 * macOS 是 `/bin/ps -Ao comm=` + 不带后缀的进程名）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { matchesPeerNames, peerProcessNames, peerProbeCommand } from './platform.ts';

const run = promisify(execFile);

/** 缓存时长：列一次进程要一两百毫秒，不能每次要判断都跑一遍。 */
const TTL_MS = 15_000;

let lastAt = 0;
let lastHit = false;

/**
 * 名单里任一进程在跑就返回 true。不传名单就用当前平台的默认名单。
 *
 * 查询失败时返回 false（当作没在跑）—— 这个方向是刻意的：宁可多说几句，
 * 也不要因为一次查询失败就让她整场闭麦，那种「突然不说话」最难排查。
 */
export async function isPeerRunning(names: readonly string[] = peerProcessNames()): Promise<boolean> {
  const now = Date.now();
  if (now - lastAt < TTL_MS) return lastHit;

  let hit = false;
  try {
    const { command, args } = peerProbeCommand();
    const { stdout } = await run(command, args, {
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 4 << 20,
    });
    hit = matchesPeerNames(stdout, names);
  } catch {
    hit = false;
  }

  lastAt = now;
  lastHit = hit;
  return hit;
}

/** 测试用：把缓存清掉。 */
export function resetPeerCache(): void {
  lastAt = 0;
  lastHit = false;
}
