import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installDirFromLog,
  patchLogLimit,
  readLogSizeLimit,
  ensureLogSizeUnlimited,
  powerLoggingState,
  patchPowerLogging,
  ensurePowerLogging,
} from '../src/log-config.ts';

/**
 * 炉石的日志上限是它自己的一个配置项（`client.config` 的 `Log.FileSizeLimit.Int`），
 * 默认 10000KB。`-1` 是它自己的「无限制」，记牌器工具都写这个键。
 *
 * 这组测试守的是：**改这一行，别的一个字节都不动。** 那是炉石的配置文件，
 * 里面还有画质、分辨率、账号缓存之类的东西，手抖改坏一项就是另一场事故。
 */

test('认得出安装目录 —— 新老两种日志路径都行', () => {
  assert.equal(
    installDirFromLog('C:\\Program Files (x86)\\Hearthstone\\Logs\\Hearthstone_2026_10_24_13_25_55\\Power.log'),
    'C:\\Program Files (x86)\\Hearthstone',
  );
  assert.equal(
    installDirFromLog('C:\\Program Files (x86)\\Hearthstone\\Logs\\Power.log'),
    'C:\\Program Files (x86)\\Hearthstone',
  );
  assert.equal(installDirFromLog('C:\\随便\\地方\\Power.log'), null, '路径里没有 Logs 就别瞎猜');
});

test('空文件 / 只有别的段 —— 追加一个 [Log] 段', () => {
  const empty = patchLogLimit('');
  assert.equal(empty.before, null);
  assert.match(empty.text, /\[Log\]/);
  assert.match(empty.text, /FileSizeLimit\.Int=-1/);
  assert.equal(empty.already, false);

  const other = patchLogLimit('[Config]\r\nLocale.American=enUS\r\n');
  assert.match(other.text, /Locale\.American=enUS/, '原有内容不能动');
  assert.match(other.text, /\[Log\]\r\nFileSizeLimit\.Int=-1/);
});

test('有 [Log] 段但没这一项 —— 插在段内，不要另起一段', () => {
  const text = '[Power]\nLogLevel=1\n\n[Log]\nWaitOnError=false\n\n[Config]\nLocale.American=zhCN\n';
  const out = patchLogLimit(text);
  assert.equal(out.before, null);
  assert.equal(
    out.text,
    '[Power]\nLogLevel=1\n\n[Log]\nWaitOnError=false\nFileSizeLimit.Int=-1\n\n[Config]\nLocale.American=zhCN\n',
    '插进 [Log] 段里，其余原样',
  );
});

test('已经有这一项 —— 只换值，键的写法保持原样', () => {
  const section = patchLogLimit('[Log]\nFileSizeLimit.Int=10000\nOther=1\n');
  assert.equal(section.before, 10000);
  assert.equal(section.text, '[Log]\nFileSizeLimit.Int=-1\nOther=1\n');

  // 扁平写法也得认，改完还是扁平写法
  const flat = patchLogLimit('Log.FileSizeLimit.Int = 10000\nLocale.American=zhCN\n');
  assert.equal(flat.before, 10000);
  // 键名和等号周边的空格都保留，只换值 —— 这是炉石的配置文件，改动越小越好
  assert.match(flat.text, /^Log\.FileSizeLimit\.Int\s*=-1\n/, `扁平写法没改成:${flat.text}`);
  assert.match(flat.text, /Locale\.American=zhCN/);
});

test('已经关了（-1）就别再动文件', () => {
  const text = '[Log]\nFileSizeLimit.Int=-1\n';
  const out = patchLogLimit(text);
  assert.equal(out.already, true);
  assert.equal(out.text, text);
});

test('CRLF 不会被改成 LF —— 那是 Windows 上的配置文件', () => {
  const out = patchLogLimit('[Log]\r\nWaitOnError=false\r\n');
  assert.ok(!/[^\r]\n/.test(out.text.replace(/\[Log\]\r\n/, '')), `混进了裸 LF:${JSON.stringify(out.text)}`);
});

test('读配置：没写这一项就是 null，不是 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-cfg-'));
  try {
    const p = join(dir, 'client.config');
    assert.equal(readLogSizeLimit(p), null, '文件不存在 → null');

    writeFileSync(p, '[Log]\nWaitOnError=false\n');
    assert.equal(readLogSizeLimit(p), null, '有段没项 → null');

    writeFileSync(p, '[Log]\nFileSizeLimit.Int=20000\n');
    assert.equal(readLogSizeLimit(p), 20000);

    writeFileSync(p, '[Log]\nFileSizeLimit.Int=-1\n');
    assert.equal(readLogSizeLimit(p), -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('改真文件：留备份、只增不改别的内容、再跑一次不再动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-cfg-'));
  try {
    const cfg = join(dir, 'client.config');
    writeFileSync(cfg, '[Config]\nLocale.American=zhCN\n', 'latin1');

    const first = ensureLogSizeUnlimited(dir);
    assert.equal(first.changed, true);
    assert.equal(first.unlimited, true);
    assert.equal(first.before, null);
    assert.ok(first.backup && existsSync(first.backup), '改之前要留一份备份');
    assert.equal(readFileSync(first.backup, 'latin1'), '[Config]\nLocale.American=zhCN\n', '备份是原件');

    const text = readFileSync(cfg, 'latin1');
    assert.match(text, /\[Config\]\nLocale\.American=zhCN/);
    assert.match(text, /FileSizeLimit\.Int=-1/);
    assert.equal(readLogSizeLimit(cfg), -1);

    const second = ensureLogSizeUnlimited(dir);
    assert.equal(second.changed, false, '已经是 -1 就别再写一遍');
    assert.equal(second.unlimited, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('原本没有 client.config —— 建一个，不留 half 文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-cfg-'));
  try {
    const r = ensureLogSizeUnlimited(dir);
    assert.equal(r.changed, true);
    assert.equal(r.before, null);
    assert.equal(r.backup, undefined, '原本没有文件，没什么可备份的');
    assert.equal(readLogSizeLimit(join(dir, 'client.config')), -1);
    assert.equal(existsSync(join(dir, 'client.config.tmp')), false, '临时文件要收干净');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 第二件事：让炉石真的往 Power.log 写对局。
 *
 * 开关不在安装目录，在 `%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`。
 * 没有它，Power.log 照样存在、照样能读能监听，但里面只有错误行 —— **不报错**，
 * 用户看到的是「她一句话不说」。这组测试守的就是这个静默失败。
 */

test('[Power] 段判据：LogLevel=1 与 FilePrinting=true 缺一不可', () => {
  assert.equal(powerLoggingState(''), 'incomplete', '空文件等于没开');
  assert.equal(powerLoggingState('[Power]\r\nLogLevel=1\r\nFilePrinting=true\r\n'), 'ok');
  assert.equal(powerLoggingState('[Power]\r\nLogLevel=0\r\nFilePrinting=true\r\n'), 'incomplete', 'LogLevel=0 只有错误行');
  assert.equal(powerLoggingState('[Power]\r\nLogLevel=1\r\n'), 'incomplete', '不写文件等于没开');
  assert.equal(powerLoggingState('[Power]\r\nLogLevel=1\r\nFilePrinting=false\r\n'), 'incomplete');
  assert.equal(
    powerLoggingState('[Log]\r\nLogLevel=1\r\nFilePrinting=true\r\n'), 'incomplete',
    '别的段里的同名键不算数',
  );
});

test('[Power] 段补全：只补这一段，别的字节不动', () => {
  // 1) 空文件 → 补一整段
  const empty = patchPowerLogging('');
  assert.equal(empty.changed, true);
  assert.match(empty.text, /\[Power\]/);
  assert.match(empty.text, /LogLevel=1/);
  assert.match(empty.text, /FilePrinting=true/);

  // 2) 有别的段、没有 [Power] → 追加，原有内容原样
  const other = '[Config]\r\nLocale.American=enUS\r\n';
  const patched = patchPowerLogging(other);
  assert.equal(patched.changed, true);
  assert.ok(patched.text.startsWith(other), '原有内容必须一个字节都不变');
  assert.match(patched.text, /\[Power\]/);

  // 3) 有 [Power] 段、缺 FilePrinting → 补在段内，不能补到下一段里去
  const half = '[Power]\r\nLogLevel=1\r\n[Log]\r\nFileSizeLimit.Int=-1\r\n';
  const fixed = patchPowerLogging(half);
  assert.equal(fixed.changed, true);
  const lines = fixed.text.split(/\r?\n/);
  const powerAt = lines.findIndex((l) => l.trim() === '[Power]');
  const logAt = lines.findIndex((l) => l.trim() === '[Log]');
  const printAt = lines.findIndex((l) => l.trim().startsWith('FilePrinting'));
  assert.ok(printAt > powerAt && printAt < logAt, 'FilePrinting 插错段了');

  // 4) 值不对 → 改值，不能插成两个同名的键
  const corrected = patchPowerLogging('[Power]\r\nLogLevel=0\r\nFilePrinting=false\r\n');
  assert.equal(corrected.changed, true);
  assert.equal((corrected.text.match(/LogLevel=/g) ?? []).length, 1, '不要插成两个 LogLevel');
  assert.match(corrected.text, /LogLevel=1/);
  assert.match(corrected.text, /FilePrinting=true/);

  // 5) 已经齐了 → 一个字都不写
  const good = '[Power]\r\nLogLevel=1\r\nFilePrinting=true\r\n';
  assert.deepEqual(patchPowerLogging(good), { text: good, changed: false });

  // 6) CRLF 要保住，不能顺手改成 LF
  assert.ok(patchPowerLogging('[Config]\r\nA=1\r\n').text.includes('\r\n'), 'CRLF 文件不能变成 LF');
});

test('ensurePowerLogging：建文件、留备份、第二次不再动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-powercfg-'));
  try {
    // 全新机器：文件不存在
    const p = join(dir, 'log.config');
    const first = ensurePowerLogging(p);
    assert.equal(first.existed, false);
    assert.equal(first.before, 'absent');
    assert.equal(first.changed, true);
    assert.equal(first.backup, undefined, '原本没有文件，没什么可备份的');
    assert.ok(existsSync(p));
    assert.equal(powerLoggingState(readFileSync(p, 'latin1')), 'ok');
    assert.equal(existsSync(`${p}.tmp`), false, '临时文件要收干净');

    // 第二次：已经齐了，不再改、也别留 bak
    const second = ensurePowerLogging(p);
    assert.equal(second.changed, false);
    assert.equal(second.before, 'ok');
    assert.ok(!existsSync(`${p}.bak`), '没改就不该留备份');

    // 已有别的配置但不全：要留备份，且用户原有的内容不能丢
    const p2 = join(dir, 'log2.config');
    writeFileSync(p2, '[Config]\r\nKeep=me\r\n', 'latin1');
    const third = ensurePowerLogging(p2);
    assert.equal(third.changed, true);
    assert.equal(third.before, 'incomplete');
    assert.ok(existsSync(`${p2}.bak`), '改之前要留备份');
    assert.ok(readFileSync(p2, 'latin1').includes('Keep=me'), '别把用户的其它配置改没了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
