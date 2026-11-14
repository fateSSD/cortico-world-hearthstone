/**
 * 模型调用(DeepSeek,OpenAI 兼容的 /chat/completions)。
 *
 * 为什么扩展要自己发请求:框架只把模型客户端交给 **Persona**(她本人),
 * World 拿到的 `WorldContext` 里没有 `llm`,只有 `secret()` / `storeSecret()`。
 * 所以这里自己发 HTTP,密钥走部署目录的 `.env`。
 *
 * 用在什么地方、不用在什么地方,是有讲究的:
 *   ✅ 用:被问「这回合怎么打」时做**多回合规划** —— 规则算不出「现在忍一手,下回合斩杀」,
 *         而这一步本来就要等工具回执,1–2 秒用户感受不到。
 *   ❌ 不用:每回合自动推送的那句建议。那里必须零延迟,交给规则算;
 *         她收到事件后本来就会用自己的判断润色,再调一次模型是重复劳动。
 *
 * 失败一律返回 null,调用方降级成纯规则结果 —— 模型是加分项,不是命脉。
 */
export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/** 从若干候选密钥名里取第一个非空的。 */
export function pickKey(read: (name: string) => string, names: readonly string[]): string {
  for (const name of names) {
    const value = read(name).trim();
    if (value) return value;
  }
  return '';
}

/** 调一次模型。任何失败都返回 null,不抛。 */
export async function askModel(cfg: LlmConfig, req: LlmRequest): Promise<string | null> {
  if (!cfg.apiKey) return null;
  const timeoutMs = req.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 220,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? text : null;
  } catch {
    // 超时、断网、JSON 变形 —— 一律当没有
    return null;
  } finally {
    clearTimeout(timer);
  }
}
