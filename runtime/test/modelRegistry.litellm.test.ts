/**
 * 注册表 ↔ litellm 管道一致性守卫：
 * MODEL_REGISTRY 里每个模型必须在两份 litellm 配置里都有同名路由，
 * 防止「/v1/models 列得出来、litellm 却 404」的装配漂移。
 * CommandCode 文档模型名（openai/ 前缀后逐字透传）在这里锁死，防手滑改名。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY, clampTemperature } from '../src/context/modelRegistry.js'

describe('clampTemperature（推理型模型 UnsupportedParams 防御）', () => {
  it('gpt-5.6 系收敛到 ≤1，无上限模型放行', () => {
    expect(clampTemperature(2, 'gpt-5.6-luna')).toBe(1)
    expect(clampTemperature(2, 'gpt-5.6-sol')).toBe(1)
    expect(clampTemperature(0.7, 'gpt-5.6-luna')).toBe(0.7)
    expect(clampTemperature(2, 'grok-4.5')).toBe(2)
    expect(clampTemperature(2, '未登记模型')).toBe(2)
  })
  it('推理上限只标在已知 reasoning-active 的登记项上', () => {
    for (const [id, spec] of Object.entries(MODEL_REGISTRY)) {
      if (id.startsWith('gpt-5.6')) expect(spec.maxTemperature, id).toBe(1)
    }
  })
})

const here = dirname(fileURLToPath(import.meta.url))
const CONFIGS = [
  join(here, '../../deploy/litellm/config.yaml'),
  join(here, '../../deploy/compose/litellm.yaml'),
] as const

describe('MODEL_REGISTRY ↔ litellm model_list', () => {
  for (const cfg of CONFIGS) {
    it(`覆盖注册表全部模型：${cfg.split('/').slice(-2).join('/')}`, () => {
      const names = [...readFileSync(cfg, 'utf8').matchAll(/model_name:\s*(\S+)/g)].map(m => m[1])
      for (const id of Object.keys(MODEL_REGISTRY)) {
        expect(names, `${id} 在 ${cfg} 缺路由`).toContain(id)
      }
    })
  }

  it('CommandCode 上游模型名与文档逐字一致（大小写/分隔符敏感）', () => {
    const text = readFileSync(CONFIGS[0], 'utf8')
    expect(text).toContain('model: openai/google/gemini-3.7-flash')
    expect(text).toContain('model: openai/gpt-5.6-sol')
    expect(text).toContain('model: openai/xai/grok-4.5')
    expect(text).toContain('model: openai/xai/grok-4.6')
    expect(text).toContain('model: openai/moonshotai/Kimi-K2.7-Code-Highspeed')
    expect(text).toContain('model: openai/moonshotai/Kimi-K2.7-Code')
    expect(text).toContain('model: openai/moonshotai/Kimi-K2.6')
    expect(text).toContain('model: openai/moonshotai/Kimi-K2.5')
    expect(text).toContain('model: openai/zai-org/GLM-5.2-Fast')
    expect(text).toContain('model: openai/zai-org/GLM-5.3')
    expect(text).toContain('model: openai/z-ai/glm-5.3-flash')
  })
})
