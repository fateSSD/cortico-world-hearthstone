/**
 * 模型调用。
 *
 * 这是唯一一处「离开本机去问别人」的代码,所以边界要测清楚:
 *   · 没 key 就不发请求(不能空手去打)
 *   · 非 200、断网、超时、返回结构变形 —— 一律 null,不抛
 *   · 拿到正文才返回,空串当没拿到
 *
 * 调用方(advice)必须能接受 null 并退化 —— 模型是加分项,不是命脉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { askModel, pickKey } from '../src/llm.ts';

const CFG = { apiKey: 'sk-test', baseUrl: 'https://api.example.com', model: 'deepseek-chat' };

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

test('密钥按优先级取第一个非空的', () => {
  const map = { A: '', B: '  ', C: 'sk-c' };
  assert.equal(pickKey((n) => map[n] ?? '', ['A', 'B', 'C']), 'sk-c');
  assert.equal(pickKey(() => '', ['A']), '', '全空要返回空串');
});

test('没有 key 时根本不发请求', () => {
  let called = false;
  return withFetch(() => { called = true; throw new Error('不该被调用'); }, async () => {
    const out = await askModel({ ...CFG, apiKey: '' }, { system: 's', user: 'u' });
    assert.equal(out, null);
    assert.equal(called, false);
  });
});

test('正常返回正文', () => {
  return withFetch(
    async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ' 打脸,下回合斩杀 ' } }] }) }),
    async () => {
      const out = await askModel(CFG, { system: 's', user: 'u' });
      assert.equal(out, '打脸,下回合斩杀', '要去掉首尾空白');
    },
  );
});

test('HTTP 非 200 时返回 null,不抛', () => {
  return withFetch(
    async () => ({ ok: false, status: 401, json: async () => ({}) }),
    async () => {
      assert.equal(await askModel(CFG, { system: 's', user: 'u' }), null);
    },
  );
});

test('网络异常时返回 null', () => {
  return withFetch(
    async () => { throw new Error('ECONNRESET'); },
    async () => {
      assert.equal(await askModel(CFG, { system: 's', user: 'u' }), null);
    },
  );
});

test('返回结构不对或正文为空,都算没拿到', () => {
  return withFetch(
    async () => ({ ok: true, json: async () => ({ choices: [] }) }),
    async () => {
      assert.equal(await askModel(CFG, { system: 's', user: 'u' }), null);
    },
  );
});

test('请求体走 OpenAI 兼容格式,地址自动拼 /chat/completions', () => {
  let seen = null;
  return withFetch(
    async (url, init) => {
      seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    },
    async () => {
      await askModel({ ...CFG, baseUrl: 'https://api.example.com/' }, { system: 'sys', user: 'usr' });
      assert.equal(seen.url, 'https://api.example.com/chat/completions', '尾部斜杠不该重复');
      assert.equal(seen.auth, 'Bearer sk-test');
      assert.equal(seen.body.model, 'deepseek-chat');
      assert.deepEqual(seen.body.messages.map((m) => m.role), ['system', 'user']);
    },
  );
});
