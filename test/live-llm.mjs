/**
 * 真实调用一次模型,确认 key 和接口通。
 * 只用于本机验收,不进测试套件(依赖网络和密钥)。
 */
import { readFileSync } from 'node:fs';
import { askModel, pickKey } from '../src/llm.ts';
import { PowerLogParser } from '../src/parser.ts';
import { advise, buildModelPrompt } from '../src/advice.ts';

const envFile = 'C:/Users/祁鹏宇/Coopanion/data/home/companion/.env';
const readEnv = (name) => {
  const m = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(\\S+)`, 'm').exec(readFileSync(envFile, 'utf8'));
  return m ? m[1] : '';
};
const key = pickKey(readEnv, ['CORTICO_HEARTHSTONE_DEEPSEEK_API_KEY', 'CORTICO_BROWSER_DEEPSEEK_API_KEY']);
console.log('拿到密钥:', key ? `是(${key.slice(0, 5)}… 共 ${key.length} 字符)` : '否');

const lines = readFileSync('C:/Program Files (x86)/Hearthstone/Logs/Hearthstone_2026_10_22_22_47_52/Power.log', 'utf8')
  .split('\n').map((l) => l.replace(/\r$/, ''));
const parser = new PowerLogParser(() => new Date().toISOString());
for (let i = 0; i < lines.length; i += 200) parser.feed(lines.slice(i, i + 200));
const snap = parser.snapshot();
const advice = advise(snap);

console.log('\n--- 喂给模型的局面 ---');
console.log(buildModelPrompt(snap));

console.log('\n--- 机械候选 ---');
console.log(advice.candidates.map((c) => `- ${c}`).join('\n'));

const t0 = Date.now();
const out = await askModel(
  { apiKey: key, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  {
    system: '你在替一个炉石传说玩家决定这一回合怎么打。只输出建议本身:一句话结论 + 最多两句理由,总共不超过 90 字。不要客套,不要复述输入。只能使用输入里出现过的牌。',
    user: `${buildModelPrompt(snap)}\n\n机械候选(仅供参考):\n${advice.candidates.map((c) => `- ${c}`).join('\n')}`,
    maxTokens: 200,
    timeoutMs: 15000,
  },
);
console.log('\n--- 模型返回 ---');
console.log(out ?? '(没有拿到)');
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
