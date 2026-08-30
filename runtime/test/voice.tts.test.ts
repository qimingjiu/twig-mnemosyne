import { describe, it, expect } from 'vitest'
import { shouldTTS, semanticTruncate, normalizeVersionStrings, arabicToChinese, ttsSanitize } from '../src/voice/tts.js'
import { emotionScore } from '../src/voice/emotion.js'

describe('§21.6 shouldTTS（v0.3.1 PATCH-06：独立情绪分类器，阈值 30）', () => {
  it('危机路径 100% TTS，预算不限', () => {
    expect(shouldTTS('深呼吸，我在。', { crisis: true, alwaysTTS: false, recentTtsCount: 99 })).toBe(true)
  })

  it('纯信息查询不 TTS（情绪分 < 30）', () => {
    expect(emotionScore('明天天气怎样')).toBeLessThan(30)
    expect(shouldTTS('明天多云转晴。', { crisis: false, alwaysTTS: false, recentTtsCount: 0 })).toBe(false)
  })

  it('高情绪消息触发 TTS', () => {
    expect(emotionScore('今天好难过，抱抱我')).toBeGreaterThanOrEqual(30)
    expect(shouldTTS('抱抱。我在呢。', { crisis: false, alwaysTTS: false, recentTtsCount: 0 })).toBe(true)
  })

  it('防疲劳：连续 3 条 TTS 后第 4 条强制文字', () => {
    expect(shouldTTS('想你了。', { crisis: false, alwaysTTS: false, recentTtsCount: 3 })).toBe(false)
  })

  it('用户显式 alwaysTTS 优先（危机例外之外最优先于情绪阈值）', () => {
    expect(shouldTTS('好的。', { crisis: false, alwaysTTS: true, recentTtsCount: 0 })).toBe(true)
  })
})

describe('§21.5 硬截断兜底', () => {
  it('T11.3：>35 字走语义截断，不切断语义尾巴', () => {
    const long = '今天很累。不过看到你的消息，忽然觉得一切都值得了，谢谢你陪着我，真的。'
    const out = semanticTruncate(long, 35)
    expect([...out].length).toBeLessThanOrEqual(36) // 截到句末标点
    expect(out.endsWith('。') || out.endsWith('！') || out.endsWith('？')).toBe(true)
  })

  it('短文本原样返回', () => {
    expect(semanticTruncate('今天很累。但看到你了，就都值得。', 35)).toBe('今天很累。但看到你了，就都值得。')
  })

  it('TTS 数字规则：版本号与阿拉伯数字转汉字', () => {
    expect(normalizeVersionStrings('这是 v0.3.0 版')).toBe('这是 零点三点零版 版')
    expect(arabicToChinese('你有 3 条新消息')).toBe('你有 三 条新消息')
  })

  it('危机路径 bypass：不截断（以完整陪伴为优先）', () => {
    const long = '我在。' + '陪着你。'.repeat(20)
    expect(ttsSanitize(long, { crisis: true })).toBe(long)
  })
})
