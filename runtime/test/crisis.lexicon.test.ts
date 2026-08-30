import { describe, it, expect } from 'vitest'
import { isCrisis, CRISIS_PROMPT, DEFAULT_CRISIS_RESOURCES } from '../src/crisis/lexicon.js'

describe('§3.9 危机预扫词表（v0.3.1 PATCH-02 多语言）', () => {
  it('命中中文危机信号', () => {
    expect(isCrisis('我真的撑不下去了，想死')).toBe(true)
    expect(isCrisis('最近总有自杀的念头')).toBe(true)
    expect(isCrisis('有时候想自残')).toBe(true)
    expect(isCrisis('不想活了')).toBe(true)
    expect(isCrisis('伤害自己')).toBe(true)
    expect(isCrisis('我活不下去')).toBe(true)
  })

  it('负向断言排除：不想活动 ≠ 不想活（上游词表前瞻语义）', () => {
    expect(isCrisis('今天不想活动，就想躺着')).toBe(false)
  })

  it('命中英文危机信号（大小写不敏感）', () => {
    expect(isCrisis('I want to die')).toBe(true)
    expect(isCrisis('thinking about suicide')).toBe(true)
    expect(isCrisis('I could kill myself')).toBe(true)
    expect(isCrisis('Sometimes I hurt myself')).toBe(true)
    expect(isCrisis('life is not worth living')).toBe(true)
  })

  it('普通消息不误报', () => {
    expect(isCrisis('帮我看看明天天气')).toBe(false)
    expect(isCrisis('这个bug快把我弄死了（夸张修辞）')).toBe(false)
  })

  it('已知误伤（宁枉勿纵）：词表锁定上游 @89a7881，「想死记硬背」按危机处理是可接受代价', () => {
    expect(isCrisis('我想死记硬背单词')).toBe(true)
    // R1（上游 /v1/crisis-check）落地后由引擎词表收敛，宿主不再自持副本
  })

  it('T9.3：输出侧复扫使用同一词表', () => {
    // generateOutreach 的复扫直接调用 isCrisis；此断言锚定词表一致性
    expect(isCrisis('听说有人轻生了，我们聊点开心的吧')).toBe(true)
  })

  it('宿主责任模块存在（§18.2 上游未实现部分）', () => {
    expect(CRISIS_PROMPT).toContain('永不推开')
    expect(CRISIS_PROMPT).toContain('最高优先级指令')
    expect(DEFAULT_CRISIS_RESOURCES).toContain('400-161-9995')
    expect(DEFAULT_CRISIS_RESOURCES).toContain('988')
  })
})
