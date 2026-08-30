/**
 * 粗粒度 token 估算（§3.4：写入侧维护 token_count，拉取按批次计账）。
 * CJK 按每字 1 token 计（偏保守，宁可高估不挤爆预算），其余按 4 字符 1 token。
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

export function estimateMessageTokens(m: { role: string; content: string }): number {
  return estimateTokens(m.content) + 4 // role/包裹开销
}
