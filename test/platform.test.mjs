/**
 * 平台抽象层的验证。
 *
 * 这一组是 2026-11-12 补的：一位 mac 用户随 patch 带来了 `src/platform.ts`，
 * 我们照思路在自己的树上重做了一份（没有直接 apply 他的 diff —— 基线是 0.4.2，
 * 而 0.4.2 之后我们改了十几个地方，直接打会大面积冲突）。
 *
 * 所以这里的重点不是「他写的那份对不对」，而是**我们这份有没有把两件事同时做稳**：
 *
 * 1. **Windows 行为一字不变。** 这是最要紧的 —— 为了让 mac 能用而改坏 Windows，
 *    等于用一个人的问题换另一个人的问题。所以 win32 的每条路径都拿 0.4.2 的原值钉死。
 * 2. **mac 的路径按真机结论，不按推断。** 位用户真机跑过：`log.config` 在偏好目录、
 *    `client.config` 在安装目录（偏好目录那份炉石根本不读，他做了四轮 A/B 才确认）。
 *
 * 测试全部用注入参数（platform / home / env），不读真机环境 —— 否则在 Windows 上跑不出 mac 的分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clientConfigCandidates, defaultInstallDirs, logConfigPath, matchesPeerNames, peerProcessNames,
} from '../src/platform.ts';

test('Windows 安装目录：还是上游那 5 条，一条不多一条不少', () => {
  assert.deepEqual(defaultInstallDirs('win32', 'C:/Users/x'), [
    'C:\\Program Files (x86)\\Hearthstone',
    'C:\\Program Files\\Hearthstone',
    'D:\\Hearthstone',
    'D:\\Program Files (x86)\\Hearthstone',
    'E:\\Hearthstone',
  ]);
});

test('macOS 安装目录：应用目录优先', () => {
  const dirs = defaultInstallDirs('darwin', '/Users/x');
  assert.ok(dirs.includes('/Applications/Hearthstone'), '要能找到标准安装位置');
  assert.ok(dirs.includes('/Users/x/Applications/Hearthstone'), '用户目录下的安装也要试');
  // 不该混进 Windows 的盘符路径
  assert.ok(!dirs.some((d) => d.includes('Program Files')), 'mac 上不该出现 Program Files');
});

test('log.config：Windows 走 LOCALAPPDATA，mac 走偏好目录', () => {
  assert.equal(
    logConfigPath('win32', 'C:/Users/x', { LOCALAPPDATA: 'C:/Users/x/AppData/Local' }),
    'C:\\Users\\x\\AppData\\Local\\Blizzard\\Hearthstone\\log.config',
  );
  // 没有 LOCALAPPDATA 时落回 home 下的默认位置
  assert.equal(
    logConfigPath('win32', 'C:/Users/x', {}),
    'C:\\Users\\x\\AppData\\Local\\Blizzard\\Hearthstone\\log.config',
  );
  // mac：真机确认过的是偏好目录，不是安装目录
  assert.equal(
    logConfigPath('darwin', '/Users/x'),
    '/Users/x/Library/Preferences/Blizzard/Hearthstone/log.config',
  );
});

test('client.config：两个平台都只认安装目录', () => {
  // 这一条是那位用户在 mac 上做了四轮 A/B 才确认的：偏好目录那份炉石不读，
  // 放进去照样报「Failed to load config file」，放回安装目录才消失。
  assert.deepEqual(clientConfigCandidates('/Applications/Hearthstone', 'darwin'), [
    '/Applications/Hearthstone/client.config',
  ]);
  assert.deepEqual(clientConfigCandidates('E:\\Hearthstone', 'win32'), [
    'E:\\Hearthstone\\client.config',
  ]);
  // 没定位到安装目录时，mac 落回默认位置
  assert.deepEqual(clientConfigCandidates('', 'darwin'), ['/Applications/Hearthstone/client.config']);
});

test('播放器进程名：Windows 带 .exe，mac 不带', () => {
  assert.deepEqual(peerProcessNames('win32'), ['QQMusic.exe', 'cloudmusic.exe']);
  assert.deepEqual(peerProcessNames('darwin'), ['QQMusic', 'NeteaseMusic']);
});

test('进程匹配：Windows 只认带引号的整名，防止子串误命中', () => {
  const csv = '"QQMusic.exe","1234","Console","1","10,000 K"';
  assert.equal(matchesPeerNames(csv, ['QQMusic.exe'], 'win32'), true);
  // 「foo.exe」里含「oo.exe」这种子串不该算命中
  assert.equal(matchesPeerNames('"QQoo.exe","1"', ['oo.exe'], 'win32'), false);
});

test('进程匹配：mac 取路径末段比，容忍 .app 与 Helper 派生进程', () => {
  const ps = '/Applications/QQMusic.app/Contents/MacOS/QQMusic\n/usr/bin/somethingelse';
  assert.equal(matchesPeerNames(ps, ['QQMusic'], 'darwin'), true);
  // 直接给 .app 路径也算
  assert.equal(matchesPeerNames('/Applications/NeteaseMusic.app', ['NeteaseMusic'], 'darwin'), true);
  // Helper 派生进程
  assert.equal(matchesPeerNames('/Applications/QQMusic.app/Contents/Frameworks/QQMusic Helper', ['QQMusic'], 'darwin'), true);
  // 没装就是没装
  assert.equal(matchesPeerNames('/usr/bin/bash\n/bin/zsh', ['QQMusic'], 'darwin'), false);
});
