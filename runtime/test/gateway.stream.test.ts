/**
 * §6 ModelGateway.chatStream 单测（债务 #5 真流式）：
 * SSE 帧解析、tool_calls 片段合并、跨 chunk 边界缓冲、usage 捕获、非 2xx 前置抛错。
 * fetch 全局 mock 为内存 ReadableStream，不连真实网关。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ModelGateway, LiteLlmError, isRetryableError } from '../src/gateways/litellm.js'

const gw = new ModelGateway('http://gw.test', 'sk-test')

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ModelGateway.chatStream', () => {
  it('内容 delta 逐帧外发；返回值与 chat() 同形（content/usage 捕获）', async () => {
    const frames = [
      frame({ id: 'chatcmpl-1', model: 'kimi-k3', choices: [{ delta: { role: 'assistant' } }] }),
      frame({ choices: [{ delta: { content: '你' } }] }),
      frame({ choices: [{ delta: { content: '好' } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }),
      'data: [DONE]\n\n',
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)))
    const seen: string[] = []
    const result = await gw.chatStream('kimi-k3', [], {}, t => seen.push(t))
    expect(seen).toEqual(['你', '好'])
    expect(result).toMatchObject({ id: 'chatcmpl-1', model: 'kimi-k3', content: '你好', promptTokens: 10, completionTokens: 2, cachedTokens: 4 })
    expect(result.toolCalls).toBeUndefined()
  })

  it('tool_calls 片段按 index 合并：name 一次到齐、arguments 分片拼接', async () => {
    const frames = [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'web_search', arguments: '' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"qu' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"x"}' } }] } }] }),
      'data: [DONE]\n\n',
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)))
    const seen: string[] = []
    const result = await gw.chatStream('m', [], {}, t => seen.push(t))
    expect(seen).toEqual([])
    expect(result.toolCalls).toEqual([{ id: 'call_a', name: 'web_search', args: '{"query":"x"}' }])
    expect(result.content).toBe('')
  })

  it('跨 chunk 边界：一帧被切成两段仍正确解析（decoder 流式缓冲）', async () => {
    const bytes = new TextEncoder().encode(frame({ choices: [{ delta: { content: 'AB' } }] }))
    const half = Math.floor(bytes.length / 2)
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, half))
        c.enqueue(bytes.slice(half))
        c.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))
    const seen: string[] = []
    const result = await gw.chatStream('m', [], {}, t => seen.push(t))
    expect(seen).toEqual(['AB'])
    expect(result.content).toBe('AB')
  })

  it('上游非 2xx 在任何 delta 外发前抛 LiteLlmError（保留链内 fallback 语义）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 502 })))
    const seen: string[] = []
    await expect(gw.chatStream('m', [], {}, t => seen.push(t))).rejects.toBeInstanceOf(LiteLlmError)
    expect(seen).toEqual([])
  })

  it('中途超时（AbortError）映射 LiteLlmError 504——可重试，fallback 与否由调用方 streamedAny 把门', async () => {
    // 设计纪律（验收过的）：「开始吐 delta 就不准换腿」的闸门在 runModelLoop 的
    // streamedAny 检查（catch 首行），不在网关层。网关只负责把裸 AbortError 重分类为
    // 504：零 delta 场景（推理模型首 token 前思考超时、纯工具轮）由此获得与 chat()
    // 首包超时一致的链内 fallback；已发 delta 的场景调用方仍按「已提交」抛出。
    vi.stubGlobal('fetch', vi.fn(async () => {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(frame({ choices: [{ delta: { content: '半句' } }] })))
          c.error(new DOMException('The operation was aborted.', 'AbortError'))
        },
      }), { status: 200 })
    }))
    await expect(gw.chatStream('m', [], {}, () => undefined)).rejects.toMatchObject({
      name: 'LiteLlmError',
      status: 504,
    })
    // 504 在 isRetryableError 的可重试集合内（链内 fallback 的通行证）
    expect(isRetryableError(new LiteLlmError(504, 'timeout'))).toBe(true)
  })
})
