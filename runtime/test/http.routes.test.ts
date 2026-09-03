/**
 * HTTP 装配层单测：/v1/models（OpenAI 兼容模型列表）、chat 假流式重放（缓存命中路径）与
 * 真流式接线（live delta、错误双通道）。chat 管线 mock 掉，只测路由语义与 SSE 形状；依赖全用假件。
 */
import { describe, it, expect, vi } from 'vitest'
import Fastify, { type FastifyReply } from 'fastify'

vi.mock('../src/chat/pipeline.js', () => ({
  handleChatCompletion: vi.fn(async () => ({
    status: 200,
    payload: {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1788000000,
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: '你好呀，月亮。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, cache_read_tokens: 0, cache_write_tokens: 0 },
    },
  })),
}))

import { registerRoutes, createStreamSink, type RouteDeps } from '../src/http/routes.js'
import { handleChatCompletion } from '../src/chat/pipeline.js'
import { AttemptLimiter } from '../src/identity/service.js'

const CLIENT = { id: 'c-1', user_id: 'u-1', client_type: 'rikkahub' }

describe('extractClientKey 第三方客户端变体', () => {
  it('标准双通道 / x-api-key / 裸 Authorization / Bearer 非 mn_ 前缀 / 缺失', async () => {
    const { extractClientKey } = await import('../src/http/shared.js')
    expect(extractClientKey({ 'x-client-key': 'mn_a' })).toBe('mn_a')
    expect(extractClientKey({ authorization: 'Bearer mn_b' })).toBe('mn_b')
    expect(extractClientKey({ authorization: 'Bearer user_xyz' })).toBe('user_xyz')
    expect(extractClientKey({ authorization: 'mn_raw' })).toBe('mn_raw')
    expect(extractClientKey({ 'x-api-key': 'mn_c' })).toBe('mn_c')
    expect(extractClientKey({ 'api-key': 'mn_d' })).toBe('mn_d')
    expect(extractClientKey({ authorization: 'Bearer ' })).toBeNull()
    expect(extractClientKey({})).toBeNull()
  })
})

function buildApp(): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false })
  registerRoutes(app, {
    db: { query: async () => ({ rows: [] }) },
    redis: { ping: async () => 'PONG', incr: async () => 1, expire: async () => 1 },
    twig: {}, gateway: {}, builder: {}, ingestion: {}, box: {}, mcp: {},
    limiter: new AttemptLimiter(),
    identityAuth: async (k: string) => (k === 'mn_ok' ? CLIENT : null),
    userOf: async () => ({ id: 'u-1' }),
  } as unknown as RouteDeps)
  return app
}

describe('POST /v1/chat/completions：origin=client 工具透传', () => {
  it('请求体 tools/tool_choice 原样进管线；消息对象 passthrough 保住 tool_calls 字段', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-client-key': 'mn_ok' },
      payload: {
        messages: [
          { role: 'user', content: '帮我在本机搜一下' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'my_local_tool', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '结果' },
        ],
        tools: [{ type: 'function', function: { name: 'my_local_tool', description: '本地工具' } }],
        tool_choice: 'auto',
      },
    })
    expect(res.statusCode).toBe(200)
    const calls = vi.mocked(handleChatCompletion).mock.calls
    const last = calls[calls.length - 1]?.[1]
    expect(last?.tools).toEqual([{ type: 'function', function: { name: 'my_local_tool', description: '本地工具' } }])
    expect(last?.toolChoice).toBe('auto')
    // zod passthrough：tool_calls / tool_call_id 必须活过校验层（续轮重放依赖它们）
    expect(last?.messages?.[1]?.tool_calls).toBeDefined()
    expect(last?.messages?.[2]?.tool_call_id).toBe('call_1')
    await app.close()
  })
})

describe('GET /v1/models', () => {
  it('无 key → 401', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/v1/models' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('无效 key → 401', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer mn_bad' } })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('Bearer key → OpenAI list，条目来自 §6.4 注册表', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer mn_ok' } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { object: string; data: Array<{ id: string; object: string; owned_by: string; lane: string }> }
    expect(body.object).toBe('list')
    const ids = body.data.map(m => m.id)
    expect(ids).toContain('gpt-4o')
    expect(ids).toContain('glm-5.2')
    expect(ids).toContain('kimi-k3')
    expect(ids).toContain('gpt-5.6-sol')
    expect(ids).toContain('grok-4.5')
    expect(ids).toContain('kimi-k2.5')
    const gpt = body.data.find(m => m.id === 'gpt-4o')!
    expect(gpt.object).toBe('model')
    expect(gpt.owned_by).toBe('openai')
    expect(gpt.lane).toBe('cloud')
    await app.close()
  })

  it('X-Client-Key 双通道同样可用', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { 'x-client-key': 'mn_ok' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('GET /health', () => {
  it('上报 mcp 网关状态；mcp 不可达不翻转 ok（数据面语义）', async () => {
    const app = Fastify({ logger: false })
    registerRoutes(app, {
      db: { query: async () => ({ rows: [] }) },
      redis: { ping: async () => 'PONG' },
      twig: { health: async () => ({ ok: true, auth: true }) },
      gateway: {}, builder: {}, ingestion: {}, box: {},
      mcp: { ping: async () => 11 },
      limiter: new AttemptLimiter(),
      identityAuth: async () => CLIENT,
      userOf: async () => ({ id: 'u-1' }),
    } as unknown as RouteDeps)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; db: string; mcp: string }
    expect(body.ok).toBe(true)
    expect(body.db).toBe('ok')
    expect(body.mcp).toBe('ok:11')
    await app.close()
  })

  it('mcp 不可达 → mcp:unreachable 但 ok 仍由 db/redis/twig 决定', async () => {
    const app = Fastify({ logger: false })
    registerRoutes(app, {
      db: { query: async () => ({ rows: [] }) },
      redis: { ping: async () => 'PONG' },
      twig: { health: async () => ({ ok: true, auth: true }) },
      gateway: {}, builder: {}, ingestion: {}, box: {},
      mcp: {},
      limiter: new AttemptLimiter(),
      identityAuth: async () => CLIENT,
      userOf: async () => ({ id: 'u-1' }),
    } as unknown as RouteDeps)
    const res = await app.inject({ method: 'GET', url: '/health' })
    const body = res.json() as { ok: boolean; mcp: string }
    expect(body.ok).toBe(true)
    expect(body.mcp).toBe('unreachable')
    await app.close()
  })
})

describe('POST /v1/chat/completions 流式', () => {
  const payload = { messages: [{ role: 'user', content: '在吗' }], stream: true }

  it('stream=true → 200 SSE：role 帧起点、content 切片、stop 帧、usage 帧、[DONE] 收尾', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer mn_ok', 'content-type': 'application/json' },
      payload,
    })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'])).toContain('text/event-stream')
    expect(res.body).toContain('"object":"chat.completion.chunk"')
    expect(res.body).toContain('"content":"你好呀，月亮。"')
    expect(res.body).toContain('"finish_reason":"stop"')
    expect(res.body).toContain('"prompt_tokens":3')
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true)
    await app.close()
  })

  it('stream 缺省 → 原 JSON 通道不变', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer mn_ok', 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: '在吗' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().object).toBe('chat.completion')
    await app.close()
  })

  it('无 key → 401（进 SSE 前拒绝，错误仍走 JSON 通道）', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload,
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe('createStreamSink（真流式 sink，债务 #5）', () => {
  const fakeReply = () => {
    const written: string[] = []
    const state = { hijacked: false, ended: false }
    const reply = {
      hijack: () => { state.hijacked = true },
      raw: {
        writeHead: () => undefined,
        write: (c: string) => { written.push(c) },
        end: (c?: string) => { if (c) written.push(c); state.ended = true },
      },
    }
    return { reply: reply as unknown as FastifyReply, written, state }
  }

  it('push 惰性开流：首帧前 opened=false；开流发 role 帧再 delta 帧', () => {
    const { reply, written, state } = fakeReply()
    const sink = createStreamSink(reply)
    expect(sink.opened).toBe(false)
    sink.push('你', 'kimi-k3')
    expect(sink.opened).toBe(true)
    sink.push('好', 'kimi-k3')
    expect(written[0]).toContain('"delta":{"role":"assistant"')
    expect(written[1]).toContain('"content":"你"')
    expect(written[2]).toContain('"content":"好"')
    expect(state.hijacked).toBe(true)
  })

  it('finish 已开流 → stop 帧 + usage/attachments/audio 扩展帧 + [DONE]，不整段重放', () => {
    const { reply, written, state } = fakeReply()
    const sink = createStreamSink(reply)
    sink.push('你好', 'kimi-k3')
    sink.finish({
      id: 'chatcmpl-x', model: 'kimi-k3', usage: { prompt_tokens: 3 },
      attachments: [{ kind: 'music', title: 't', artist: 'a', page_url: 'p', play_url: 'q' }],
      audio: { data: 'k', mime: 'audio/mpeg', expires_in: 60 },
    })
    const body = written.join('')
    expect(body).toContain('"finish_reason":"stop"')
    expect(body).toContain('"usage":{"prompt_tokens":3}')
    expect(body).toContain('"attachments"')
    expect(body).toContain('"audio"')
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(state.ended).toBe(true)
  })

  it('fail 已开流 → error 帧 + [DONE]；未开流 no-op（调用方走 JSON）', () => {
    const opened = fakeReply()
    const sink1 = createStreamSink(opened.reply)
    sink1.push('x', 'm')
    sink1.fail({ error: { message: 'upstream', type: 'gateway_error' } })
    const body = opened.written.join('')
    expect(body).toContain('"error"')
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(opened.state.ended).toBe(true)

    const closed = fakeReply()
    const sink2 = createStreamSink(closed.reply)
    sink2.fail({ error: { message: 'upstream', type: 'gateway_error' } })
    expect(sink2.opened).toBe(false)
    expect(closed.state.ended).toBe(false)
  })
})

describe('POST /v1/chat/completions 真流式接线（债务 #5）', () => {
  it('管线 onDelta 帧 live 透传；payload 不再整段重放', async () => {
    vi.mocked(handleChatCompletion).mockImplementationOnce(async (_deps, _req, onDelta) => {
      onDelta?.('早', 'kimi-k3')
      onDelta?.('安', 'kimi-k3')
      return {
        status: 200,
        payload: {
          id: 'chatcmpl-live', object: 'chat.completion', created: 1788000000, model: 'kimi-k3',
          choices: [{ index: 0, message: { role: 'assistant', content: '早安' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      }
    })
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer mn_ok', 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: '在吗' }], stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'])).toContain('text/event-stream')
    expect(res.body).toContain('"content":"早"')
    expect(res.body).toContain('"content":"安"')
    // 不重放：payload.choices 的完整文本不应以切片帧出现
    expect(res.body).not.toContain('"content":"早安"')
    expect(res.body).toContain('"finish_reason":"stop"')
    expect(res.body).toContain('"usage":{"prompt_tokens":3')
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true)
    await app.close()
  })

  it('首帧后管线抛错 → SSE error 帧 + [DONE]（不再走 JSON 状态码）', async () => {
    vi.mocked(handleChatCompletion).mockImplementationOnce(async (_deps, _req, onDelta) => {
      onDelta?.('部分', 'm')
      throw new Error('upstream exploded')
    })
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer mn_ok', 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: '在吗' }], stream: true },
    })
    expect(res.statusCode).toBe(200) // 已 hijack，只能 SSE
    expect(res.body).toContain('"content":"部分"')
    expect(res.body).toContain('"error"')
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true)
    await app.close()
  })

  it('首帧前管线抛错 → 保持 JSON 状态码（sink 未开流）', async () => {
    vi.mocked(handleChatCompletion).mockImplementationOnce(async () => {
      throw new Error('pre-flight failure')
    })
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer mn_ok', 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: '在吗' }], stream: true },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ error: { type: 'internal_error' } })
    await app.close()
  })
})
