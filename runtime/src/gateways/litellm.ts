/**
 * §6 Model Gateway：LiteLLM = 管道（provider 适配、单 group 内 retry/cooldown/负载均衡），
 * Mnemosyne（TS）= 路由大脑：每个请求以显式 model 参数调用（§6.3）。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  cache_control?: { type: 'ephemeral' }
}

export interface ChatResult {
  id: string
  model: string
  content: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  latencyMs: number
}

export class LiteLlmError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`litellm ${status}: ${message.slice(0, 300)}`)
    this.name = 'LiteLlmError'
  }
}

export function isRetryableError(e: unknown): boolean {
  if (e instanceof LiteLlmError) return e.status === 429 || e.status >= 500
  if (e instanceof TypeError) return true // fetch 网络层失败
  return false
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export class ModelGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async chat(model: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now()
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        }),
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      })
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new LiteLlmError(504, `gateway timeout: ${model}`)
      throw e
    }
    if (!res.ok) throw new LiteLlmError(res.status, await res.text())

    const data = (await res.json()) as {
      id?: string
      model?: string
      choices?: { message?: { content?: string } }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    const choice = data.choices?.[0]
    const usage = data.usage
    return {
      id: data.id ?? `chatcmpl-${Date.now()}`,
      model: data.model ?? model,
      content: choice?.message?.content ?? '',
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      latencyMs: Date.now() - started,
    }
  }
}
