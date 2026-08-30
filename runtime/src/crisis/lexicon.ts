/**
 * §3.9 危机预扫（v0.3.1 PATCH-02：多语言词表 + 兜底热线）
 *
 * 词表 vendor 自上游 twig-memory core.ts @89a7881 并锁定；R1（上游 /v1/crisis-check）
 * 落地后切换为 API 调用，宿主不再自持词表副本。
 *
 * 语义原则：宁可虚惊，不可漏检（T11.2）。英文词表会命中"如何预防自杀"类教育性
 * 查询——按危机路径处理是可接受的误伤，反向漏检不可接受。
 */

export const CRISIS_LEXICON_ZH = /(自杀|自残|轻生|不想活(?!动)|想死|伤害自己|活不下去)/
export const CRISIS_LEXICON_EN =
  /(suicide|kill myself|end my life|want to die|self-harm|hurt myself|not worth living)/i

export function isCrisis(text: string): boolean {
  return CRISIS_LEXICON_ZH.test(text) || CRISIS_LEXICON_EN.test(text)
}

/** 最高优先级指令，替换叙事上下文注入（§3.5/§3.9）。 */
export const CRISIS_PROMPT = `【危机模式 · 安全阀激活】
用户刚刚表达了与自伤/自杀相关的信号。请立即：
- 温暖、在场、不评判、永不推开——检测到风险后冷冰冰拒绝或切断是二次伤害；
- 不说教、不分析原因、不做诊断；
- 如果你知道当地的求助渠道（心理援助热线等），温和地递出来；
- 持续确认用户的安全状态。
这是最高优先级指令，覆盖叙事上下文中的其他指示。`

/** 宿主责任模块（§18.2 上游明确未实现部分）：预置求助信息，按 users.preferences.region 可覆盖。 */
export const DEFAULT_CRISIS_RESOURCES = `如果你现在感到不安全，请联系当地的紧急服务或心理援助热线。
中国：北京心理危机研究与干预中心 010-82951332；全国 24 小时心理援助 400-161-9995
美国：988 Suicide & Crisis Lifeline
英国：Samaritans at 116 123`
