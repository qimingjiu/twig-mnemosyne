import { describe, it, expect } from 'vitest'
import { detectPii, redactPii } from '../src/privacy/pii.js'
import { privacyScore } from '../src/privacy/score.js'

describe('PII 检测（§20.2 信号源 / §11 脱敏共用检测核）', () => {
  it('手机号 / 证件号 / 邮箱 / 地址簇命中', () => {
    const scan = detectPii('我的手机 13812345678，邮箱 foo@bar.com，家在上海市浦东新区张江路 100 号')
    const cats = scan.hits.map(h => h.category)
    expect(cats).toContain('cn_mobile')
    expect(cats).toContain('email')
    expect(cats).toContain('address')
  })

  it('18 位身份证命中且分数封顶 60', () => {
    const scan = detectPii('身份证 110101199003074258 重复 110101199003074258 110101199003074258')
    expect(scan.hits.map(h => h.category)).toContain('cn_id')
    expect(scan.score).toBe(60)
  })

  it('无 PII 文本零分', () => {
    expect(detectPii('今天天气不错，聊聊天').score).toBe(0)
  })

  it('redactPii：日志侧脱敏（§11.5 深度防御）', () => {
    const out = redactPii('联系 13812345678 或 foo@bar.com')
    expect(out).not.toContain('13812345678')
    expect(out).not.toContain('foo@bar.com')
    expect(out).toContain('[REDACTED:cn_mobile]')
    expect(out).toContain('[REDACTED:email]')
  })
})

describe('§20 隐私分层评分', () => {
  const THRESHOLD = 70

  it('用户显式标记 privacy=high → 只升不降，锁本地 lane', () => {
    const d = privacyScore({ contents: ['帮我查天气'], metadata: { privacy: 'high' }, crisis: false }, THRESHOLD)
    expect(d.signals.explicit).toBe(true)
    expect(d.lane).toBe('local')
  })

  it('T10.2：正文写「这不隐私」不影响分值（分类器只读信号）', () => {
    const a = privacyScore({ contents: ['这不隐私，帮我查天气'], crisis: false }, THRESHOLD)
    const b = privacyScore({ contents: ['帮我查天气'], crisis: false }, THRESHOLD)
    expect(a.score).toBe(b.score)
    expect(a.lane).toBe('cloud')
  })

  it('危机路径 +100（§20.5 tradeoff 由上层路由处理）', () => {
    const d = privacyScore({ contents: ['随便聊聊'], crisis: true }, THRESHOLD)
    expect(d.signals.crisis).toBe(true)
    expect(d.lane).toBe('local')
  })

  it('PII 60 分为上限（§20.2）：默认阈值 70 下需与情感簇叠加才锁本地', () => {
    const purePii = privacyScore({ contents: ['身份证 110101199003074258，家在上海市浦东新区张江路 100 号，电话 13812345678'], crisis: false }, 70)
    expect(purePii.signals.pii).toBe(60)
    expect(purePii.lane).toBe('cloud') // PII 单独不越过默认阈值——文档语义如此
    const withEmotion = privacyScore(
      { contents: ['身份证 110101199003074258，家在上海市浦东新区张江路 100 号，电话 13812345678，想到这些我就崩溃了'], crisis: false },
      70,
    )
    expect(withEmotion.lane).toBe('local')
    // 阈值可配：更敏感的部署可下调（fail-closed 方向）——证件号单项 30 分在阈值 30 下即锁本地
    expect(privacyScore({ contents: ['身份证 110101199003074258'], crisis: false }, 30).lane).toBe('local')
  })

  it('普通消息走云端', () => {
    expect(privacyScore({ contents: ['明天天气怎样'], crisis: false }, THRESHOLD).lane).toBe('cloud')
  })
})
