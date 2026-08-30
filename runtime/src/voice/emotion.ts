/**
 * 独立情绪分类器（v0.3.1 PATCH-06：与 §20.2 隐私评分解耦）。
 * 专用词表 0–100 分；阈值 30（§21.6 shouldTTS）。
 * 词表为 vendor 管理配置，当前内置启发式；隐私评分的情感簇信号另行缩放引用。
 */

const EMOTION_WORDS = [
  // 中文
  '难过', '伤心', '孤独', '寂寞', '害怕', '恐惧', '焦虑', '崩溃', '委屈', '心疼',
  '想你', '爱你', '抱抱', '陪陪我', '在乎你', '喜欢你我', '心碎', '绝望', '无助', '疲惫',
  '心情不好', 'emo', '失眠', '流泪', '哭', '拥抱', '安慰', '担心', '想你啦', '开心',
  // 英文
  'sad', 'lonely', 'depressed', 'anxious', 'scared', 'miss you', 'love you', 'hug',
  'heartbroken', 'hopeless', 'exhausted', 'crying', 'comfort me',
]

export function emotionScore(text: string): number {
  const lower = text.toLowerCase()
  let hits = 0
  for (const w of EMOTION_WORDS) {
    if (lower.includes(w)) hits++
  }
  if (hits === 0) return 0
  // 首个命中 30 分（恰好等于 §21.6 阈值线），每加一个 +15，封顶 100
  return Math.min(100, 30 + (hits - 1) * 15)
}
