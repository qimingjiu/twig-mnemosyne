/**
 * 观测侧脱敏（§11.5 / VULN-10 配套）。
 * pino 的 redact 只能按字段路径删除；PII 藏在消息内容里，因此约定：
 * 任何携带用户内容的日志字段，构造时必须先过 redactText()。
 */
import { redactPii } from '../privacy/pii.js'

export function redactText(text: string): string {
  return redactPii(text)
}
