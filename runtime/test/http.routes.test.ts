/**
 * HTTP 装配层单测：/v1/models（OpenAI 兼容模型列表）与 chat 假流式（chunk 重放）。
 * chat 管线 mock 掉，只测路由语义与 SSE 形状；依赖全用假件（不连 Postgres/Redis）。
 */
import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

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

import { registerRoutes, type RouteDeps } from '../src/http/routes.js'
import { AttemptLimiter } from '../src/identity/service.js'

const CLIENT = { id: 'c-1', user_id: 'u-1', client_type: 'rikkahub' }

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
