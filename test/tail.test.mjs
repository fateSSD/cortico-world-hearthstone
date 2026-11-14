/**
 * 增量读取的验证。
 *
 * 这里最容易出事的地方不是「能不能读到」,而是三个边界:
 *   1. 一次写入被切成两半(半行)—— 不能把半行当整行交出去
 *   2. 多字节中文被切在缓冲边界上 —— 不能切出乱码
 *   3. 文件被截断/换了一局 —— 不能拿旧偏移继续读
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PowerLogTail } from '../src/log-source.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PREFIX = 'D 21:00:00.0000000 GameState.DebugPrintPower() - ';

function makeTail(path, sink) {
  return new PowerLogTail({
    getPath: () => ({ path, why: '测试' }),
    onLines: (lines) => sink.push(...lines),
    pollMs: () => 100,
  });
}

test('先写整行再追加,逐行交出去,不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-tail-'));
  const file = join(dir, 'Power.log');
  try {
    writeFileSync(file, `${PREFIX}CREATE_GAME\n${PREFIX}    GameEntity ID=1\n`);
    const got = [];
    const tail = makeTail(file, got);
    tail.start();
    await sleep(250);
    assert.deepEqual(got.map((l) => l.split(' - ')[1]), ['CREATE_GAME', '    GameEntity ID=1']);

    appendFileSync(file, `${PREFIX}TAG_CHANGE Entity=4 tag=DAMAGE value=3\n`);
    await sleep(250);
    assert.equal(got.length, 3);
    assert.match(got[2], /DAMAGE value=3/);

    tail.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('半行不交出去,补齐之后才作为一行出现', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-tail-'));
  const file = join(dir, 'Power.log');
  try {
    writeFileSync(file, '');
    const got = [];
    const tail = makeTail(file, got);
    tail.start();
    await sleep(200);

    const full = `${PREFIX}TAG_CHANGE Entity=4 tag=ZONE value=HAND\n`;
    appendFileSync(file, full.slice(0, 30));
    await sleep(250);
    assert.equal(got.length, 0, '半行不该被当成一条完整记录');

    appendFileSync(file, full.slice(30));
    await sleep(250);
    assert.equal(got.length, 1);
    assert.match(got[0], /ZONE value=HAND/);

    tail.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多字节中文被切在边界上也不出乱码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-tail-'));
  const file = join(dir, 'Power.log');
  try {
    writeFileSync(file, '');
    const got = [];
    const tail = makeTail(file, got);
    tail.start();
    await sleep(200);

    const line = `${PREFIX}TAG_CHANGE Entity=[name=淡水鳄 id=30 zone=PLAY] tag=TAUNT value=1\n`;
    const bytes = Buffer.from(line, 'utf8');
    // 故意切在一个汉字的中间
    const cut = bytes.indexOf(Buffer.from('鳄', 'utf8')) + 1;
    appendFileSync(file, bytes.subarray(0, cut));
    await sleep(220);
    appendFileSync(file, bytes.subarray(cut));
    await sleep(250);

    assert.equal(got.length, 1);
    assert.match(got[0], /淡水鳄/, '中文不该被切成替换字符');

    tail.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件被截断后从最后一局开头重读,不拿旧偏移硬读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-tail-'));
  const file = join(dir, 'Power.log');
  try {
    // 先有一局,读进去
    writeFileSync(file, `${PREFIX}CREATE_GAME\n${PREFIX}旧的一局\n`);
    const got = [];
    const tail = makeTail(file, got);
    tail.start();
    await sleep(250);
    const before = got.length;
    assert.ok(before >= 1);

    // 炉石重开:文件被换成一局新的
    writeFileSync(file, `${PREFIX}CREATE_GAME\n${PREFIX}新的一局\n`);
    await sleep(300);

    const added = got.slice(before).join('\n');
    assert.match(added, /CREATE_GAME|新的一局/, '截断后要能读到新内容');
    assert.match(got.join('\n'), /新的一局/);

    tail.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件不存在时不崩,等它出现', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-tail-'));
  const file = join(dir, 'Power.log');
  try {
    const got = [];
    const tail = new PowerLogTail({
      getPath: () => ({ path: file, why: '测试' }),
      onLines: (lines) => got.push(...lines),
      pollMs: () => 100,
    });
    tail.start();
    await sleep(200);
    assert.equal(got.length, 0, '文件还没有,不该有内容');

    writeFileSync(file, `${PREFIX}CREATE_GAME\n`);
    await sleep(300);
    assert.equal(got.length, 1, '文件出现后要接上');

    tail.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
