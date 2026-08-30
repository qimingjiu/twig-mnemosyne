/**
 * Memory Relocation Pipeline（§23 记忆搬家）。
 *
 * 铁律 E-4 完整适用：只导 user turn，AI 的话整条丢弃——否则批量自指漂移。
 * 状态机：pending → running → cooling → reflecting → done；每 chunk 落 checkpoint，
 * 崩溃断点续传；全部完成后强制一轮 reflect；批次可经 batch:<id> tag 整体追溯/整体 contest。
 *
 * 用法：
 *   npm run relocate -- --source chatgpt --file conversations.json --user <eternal_id> [--burn]
 *   --burn：读取后立即删除源文件（§23.2 导入包即焚；默认保留）
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { migrate, pool } from '../src/db.js'
import { env } from '../src/config.js'
import { TwigAdapter } from '../src/memory/TwigAdapter.js'

const RATE_LIMIT_PER_MIN = 6
const TWIG_TEXT_LIMIT = 4000

interface Turn {
  title: string
  text: string
}

function extractChatgpt(raw: unknown): Turn[] {
  const conversations = (raw as { conversations?: unknown[] })?.conversations ?? (Array.isArray(raw) ? raw : [])
  const turns: Turn[] = []
  for (const conv of conversations as { title?: string; mapping?: Record<string, ChatgptNode> }[]) {
    const mapping = conv.mapping ?? {}
    // 从 root 沿 children 主链走（branches 取第一条），只取 user 文本 turn
    const rootNode = Object.values(mapping).find(n => n.parent === null)
    let cur = rootNode?.children?.[0] ? mapping[rootNode.children[0]] : undefined
    const fallbackTitle = conv.title ?? 'imported conversation'
    while (cur) {
      const msg = cur.message
      if (msg && msg.author?.role === 'user' && msg.content?.content_type === 'text') {
        const text = (msg.content.parts ?? []).filter((p): p is string => typeof p === 'string').join('\n').trim()
        if (text) turns.push({ title: fallbackTitle, text })
      }
      cur = cur.children?.[0] ? mapping[cur.children[0]] : undefined
    }
  }
  return turns
}

interface ChatgptNode {
  parent: string | null
  children?: string[]
  message?: {
    author?: { role?: string }
    content?: { content_type?: string; parts?: unknown[] }
  }
}

function extractClaude(raw: unknown): Turn[] {
  const chats = (raw as { chats?: { name?: string; chat_messages?: { sender?: string; text?: string }[] }[] }).chats ?? []
  const turns: Turn[] = []
  for (const chat of chats) {
    for (const m of chat.chat_messages ?? []) {
      if (m.sender === 'human' && typeof m.text === 'string' && m.text.trim()) {
        turns.push({ title: chat.name ?? 'imported conversation', text: m.text })
      }
    }
  }
  return turns
}

function extractPlaintext(raw: string): Turn[] {
  return raw
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(text => ({ title: 'plaintext import', text }))
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' }, // chatgpt | claude | plaintext
      file: { type: 'string' },
      user: { type: 'string' },
      burn: { type: 'boolean', default: false },
      'max-turns': { type: 'string', default: '10000' },
    },
  })
  if (!values.source || !values.file || !values.user) {
    console.error('usage: npm run relocate -- --source <chatgpt|claude|plaintext> --file <path> --user <eternal_id> [--burn]')
    process.exit(2)
  }
  if (!/^[a-f0-9]{64}$/.test(values.user)) {
    console.error('--user 必须是 64-hex eternal_id')
    process.exit(2)
  }
  if (!['chatgpt', 'claude', 'plaintext'].includes(values.source)) {
    console.error('--source 仅支持 chatgpt | claude | plaintext')
    process.exit(2)
  }

  await migrate()
  const twig = new TwigAdapter(env.TWIG_URL, env.MUNINN_AUTH_TOKEN)

  // §23.2：导入包处理完毕即焚。--burn 时读取进内存后立即物理删除源文件
  const rawText = readFileSync(values.file, 'utf8')
  if (values.burn) {
    rmSync(values.file, { force: true })
    console.log('[relocate] --burn：源文件已读取并物理删除')
  }
  const raw = values.source === 'plaintext' ? rawText : (JSON.parse(rawText) as unknown)

  const turns =
    values.source === 'chatgpt' ? extractChatgpt(raw)
    : values.source === 'claude' ? extractClaude(raw)
    : extractPlaintext(rawText)

  const maxTurns = Number(values['max-turns'] ?? 10000)
  const all = turns.slice(0, maxTurns)
  if (turns.length > maxTurns) {
    console.error(`[relocate] ${turns.length} turns 超过单批上限 ${maxTurns}，需二次确认后分批（§23.3）`)
    process.exit(5)
  }

  const batchId = randomUUID().slice(0, 8)
  const titlePrefix = `[import:${values.source}] `
  const tags = ['imported', values.source, `batch:${batchId}`]
  const checkpointPath = `${values.file}.relocation-checkpoint.json`
  const done: number[] = existsSync(checkpointPath) ? (JSON.parse(readFileSync(checkpointPath, 'utf8')) as { done: number[] }).done : []
  const doneSet = new Set(done)

  console.log(`[relocate] plan: source=${values.source} userTurns=${all.length} batch=${batchId} rate=${RATE_LIMIT_PER_MIN}/min`)
  let i = 0
  for (const turn of all) {
    if (doneSet.has(i)) {
      i++
      continue
    }
    // R5 未落地的过渡：按上游 4000 字符上限切分
    const text = turn.text.length > TWIG_TEXT_LIMIT ? turn.text.slice(0, TWIG_TEXT_LIMIT) : turn.text
    try {
      await twig.ingest(values.user, text, { title: titlePrefix + turn.title, tags })
    } catch (e) {
      console.error(`[relocate] chunk ${i} ingest 失败，checkpoint 已保留，可重跑续传：${e instanceof Error ? e.message : e}`)
      process.exit(6)
    }
    doneSet.add(i)
    writeFileSync(checkpointPath, JSON.stringify({ done: [...doneSet], batchId }))
    i++
    if (i % RATE_LIMIT_PER_MIN === 0) {
      // 限速 6/min：防碎片层爆炸、防线索池瞬时污染（§23.2）
      await sleep(60_000)
    }
  }

  // 大批量碎片需要反刍收口（§23.2）
  console.log('[relocate] 导入完成，强制执行一轮 reflect…')
  await twig.reflect(values.user)

  rmSync(checkpointPath, { force: true })
  console.log(`[relocate] done. batch:${batchId} 可用于整体追溯/整体 contest`)
  await pool.end()
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
