/**
 * §6 Model Gateway：LiteLLM = 管道（provider 适配、单 group 内 retry/cooldown/负载均衡），
 * Mnemosyne（TS）= 路由大脑：每个请求以显式 model 参数调用（§6.3）。
 */
import { env } from '../config.js'
import { latencySeconds } from '../observability/metrics.js'

export interface ToolCallSpec {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  cache_control?: { type: 'ephemeral' }
  tool_calls?: ToolCallSpec[]
  tool_call_id?: string
  name?: string
}

export interface ChatResult {
  id: string
  model: string
  content: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  latencyMs: number
  /** 模型请求的工具调用（§5 工具执行回路） */
  toolCalls?: { id: string; name: string; args: string }[]
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
  /** §5：注入的工具 schema（OpenAI function calling 格式）；非 function 条目 = 厂商原生工具，按型号开关透传 */
  tools?: {
    type: string
    function?: { name: string; description?: string; parameters?: unknown }
    [key: string]: unknown
  }[]
  /** 客户端显式指定的 tool_choice（有客户端工具时透传；缺省 auto） */
  toolChoice?: unknown
}

/** 单腿调用超时：链式 fallback 最坏排队吃满整条链，默认收紧到 90s（原 120s 硬编码），env 可调。 */
const CALL_TIMEOUT_MS = env.MODEL_TIMEOUT_MS

function callSignal(opts: ChatOptions): AbortSignal {
  return opts.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS)
}

export class ModelGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private requestBody(model: string, messages: ChatMessage[], opts: ChatOptions, stream: boolean): Record<string, unknown> {
    return {
      model,
      messages,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.tools && opts.tools.length > 0
        ? { tools: opts.tools, tool_choice: opts.toolChoice !== undefined ? opts.toolChoice : 'auto' }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }
  }

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
        body: JSON.stringify(this.requestBody(model, messages, opts, false)),
        signal: callSignal(opts),
      })
      latencySeconds.observe({ stage: 'gateway_first_byte', provider: 'litellm' }, (Date.now() - started) / 1000)
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new LiteLlmError(504, `gateway timeout: ${model}`)
      throw e
    }
    if (!res.ok) throw new LiteLlmError(res.status, await res.text())

    const data = (await res.json()) as {
      id?: string
      model?: string
      choices?: {
        message?: {
          content?: string
          tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
        }
      }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    const choice = data.choices?.[0]
    const usage = data.usage
    const rawCalls = choice?.message?.tool_calls ?? []
    const toolCalls = rawCalls.length > 0
      ? rawCalls.map((c, i) => ({
          id: c.id ?? `call_${i}`,
          name: c.function?.name ?? '',
          args: c.function?.arguments ?? '{}',
        }))
      : undefined
    return {
      id: data.id ?? `chatcmpl-${Date.now()}`,
      model: data.model ?? model,
      content: choice?.message?.content ?? '',
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      latencyMs: Date.now() - started,
      toolCalls,
    }
  }

  /**
   * 真流式（2026-09-03 债务 #5 收口）：上游 token 级透传。内容 delta 经 onDelta 即时外发，
   * tool_calls 片段按 index 合并；返回值与 chat() 同形（管线无感切换）。
   * 错误语义与链内 fallback 的分工：
   * - 上游非 2xx 在任何 delta 外发之前抛出；
   * - 中途超时（AbortSignal 触发 body 读中断）重分类为 LiteLlmError(504)，可重试；
   * - 「换不换腿」由调用方（runModelLoop 的 streamedAny 首闸）裁定：已向客户端发过 delta
   *   即「已提交」，任何错误都禁止换模型重试（换腿会在半句话里出现人格接缝）；
   *   零 delta 的失败（含超时）照常沿链降级。
   */
  async chatStream(
    model: string,
    messages: ChatMessage[],
    opts: ChatOptions,
    onDelta: (text: string, upstreamModel: string) => void,
  ): Promise<ChatResult> {
    const started = Date.now()
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.requestBody(model, messages, opts, true)),
        signal: callSignal(opts),
      })
      latencySeconds.observe({ stage: 'gateway_headers', provider: 'litellm' }, (Date.now() - started) / 1000)
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new LiteLlmError(504, `gateway timeout: ${model}`)
      throw e
    }
    if (!res.ok) throw new LiteLlmError(res.status, await res.text())
    if (!res.body) throw new LiteLlmError(502, 'empty stream body')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let done = false
    let id = ''
    let upstreamModel = ''
    let content = ''
    const fragments = new Map<number, { id?: string; name?: string; args: string }>()
    let usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }
    let firstTokenAt: number | null = null

    const handleEvent = (rawEvent: string): void => {
      for (const line of rawEvent.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') {
          if (data === '[DONE]') done = true
          continue
        }
        let chunk: {
          id?: string
          model?: string
          choices?: {
            delta?: {
              content?: string
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
            }
          }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
        }
        try {
          chunk = JSON.parse(data) as typeof chunk
        } catch {
          continue // 心跳/注释/非 JSON 帧
        }
        if (chunk.id && !id) id = chunk.id
        if (chunk.model && !upstreamModel) upstreamModel = chunk.model
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
            cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          }
        }
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) {
          if (firstTokenAt === null) {
            firstTokenAt = Date.now()
            latencySeconds.observe({ stage: 'gateway_first_byte', provider: 'litellm' }, (firstTokenAt - started) / 1000)
          }
          content += delta.content
          onDelta(delta.content, upstreamModel || model)
        }
        for (const [i, tc] of (delta?.tool_calls ?? []).entries()) {
          const idx = tc.index ?? i
          const frag = fragments.get(idx) ?? { args: '' }
          if (tc.id) frag.id = tc.id
          if (tc.function?.name) frag.name = (frag.name ?? '') + tc.function.name
          if (tc.function?.arguments) frag.args += tc.function.arguments
          fragments.set(idx, frag)
        }
      }
    }

    // 读循环整体包 abort 映射：AbortSignal.timeout 中途触发时 reader.read() 抛裸 AbortError，
    // 不映射的话 isRetryableError=false → 直接 502，无 delta 外发时本可换链上下一候选（与 chat() 一致）
    try {
      for (;;) {
        const { done: eof, value } = await reader.read()
        if (eof) break
        buf += decoder.decode(value, { stream: true })
        buf = buf.replace(/\r\n/g, '\n') // 容忍 CRLF 分帧的 SSE 服务端
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          handleEvent(event)
          if (done) break
        }
        if (done) break
      }
      // EOF：冲刷 decoder 的悬挂多字节序列，并处理未被空行终结的最后一帧——
      // 丢弃尾部会把收尾 delta 与 usage 帧一起吞掉（usage 记 0）
      buf += decoder.decode()
      buf = buf.replace(/\r\n/g, '\n')
      if (buf.trim().length > 0 && !done) handleEvent(buf)
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new LiteLlmError(504, `gateway timeout mid-stream: ${model}`)
      throw e
    }

    const toolCalls = fragments.size > 0
      ? [...fragments.entries()].map(([i, f]) => ({ id: f.id ?? `call_${i}`, name: f.name ?? '', args: f.args || '{}' }))
      : undefined
    return {
      id: id || `chatcmpl-${Date.now()}`,
      model: upstreamModel || model,
      content,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cachedTokens: usage.cached_tokens,
      latencyMs: Date.now() - started,
      toolCalls,
    }
  }
}
