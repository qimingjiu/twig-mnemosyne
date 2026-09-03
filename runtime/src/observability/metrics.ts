/**
 * §11 Observability（Sidecar 原则：绝不阻塞主请求路径）。
 * prom-client 直接暴露 /metrics 是务实 v0；OTel SDK → Collector 链路 deferred（README 路线图）。
 * 高基数 label（§11.5）控制在文档定义的集合内；采样与 buffer 限额由部署层调优。
 */
import client from 'prom-client'

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

export const requestsTotal = new client.Counter({
  name: 'mnemosyne_requests_total',
  help: 'Total chat completions requests',
  labelNames: ['client_type', 'session_type', 'provider', 'model'] as const,
  registers: [registry],
})

export const errorsTotal = new client.Counter({
  name: 'mnemosyne_errors_total',
  help: 'Total failed requests',
  labelNames: ['error_type', 'provider'] as const,
  registers: [registry],
})

export const cacheHitsTotal = new client.Counter({
  name: 'mnemosyne_cache_hits_total',
  help: 'Cache hits by tier',
  labelNames: ['cache_type'] as const,
  registers: [registry],
})

export const tokensTotal = new client.Counter({
  name: 'mnemosyne_tokens_total',
  help: 'Token usage by direction',
  labelNames: ['type', 'provider'] as const,
  registers: [registry],
})

export const latencySeconds = new client.Histogram({
  name: 'mnemosyne_latency_seconds',
  help: 'Latency by stage (model.call / crisis_prescan / twig_packet / assemble / gateway_first_byte / request_total)',
  labelNames: ['stage', 'provider'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 180],
  registers: [registry],
})

export const costUsd = new client.Counter({
  name: 'mnemosyne_cost_usd',
  help: 'Estimated spend',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
})

export async function renderMetrics(): Promise<string> {
  return registry.metrics()
}
