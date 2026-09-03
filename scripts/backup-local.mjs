#!/usr/bin/env node
/**
 * backup-local.mjs — Zeabur 部署的本地拉取备份（§13.6 的 Zeabur 路线，备份目的地=本机）。
 *
 * 覆盖物（与 VPS 版 backup.sh 同口径）：
 *   1. Postgres 逻辑备份（pg_dump custom 格式）——需 Zeabur postgres 开公网 + 本机装 pg 客户端；
 *   2. twig 叙事数据（叙事+情感层）：经 mnemosyne 公网域名 /v1/web/* 拉全量 JSON 快照
 *      （journal/soliloquy 全量导出 + claims/context/audit + state/notes/stamps 分页拉尽）。
 *   Redis 不备（缓存可再生，§13.6）。
 *
 * 配置（优先读 scripts/backup.local.env 的 KEY=VALUE，其次进程 env；该 env 文件不入 git）：
 *   BACKUP_ROOT            备份根目录（默认 <repo>/backups）
 *   PGBACKUP_URL           公网 postgres 连接串 postgresql://mnemosyne:<pass>@<host>:<port>/mnemosyne
 *   PGDUMP_BIN             pg_dump 路径（默认从 PATH 找；Windows 可指 C:\Program Files\PostgreSQL\16\bin\pg_dump.exe）
 *   MNEMOSYNE_BASE         mnemosyne 公网域名（如 https://twig-mnemosyne.zeabur.app）
 *   MNEMOSYNE_WEB_KEY      既有 web client_key（mn_…）；给了则跳过登录
 *   MNEMOSYNE_ETERNAL_ID   64 位 hex（登录用，与 MASTER_KEY 二选一组合）
 *   MNEMOSYNE_MASTER_KEY   master_key（登录换 client_key）
 *   RETAIN_DAYS            滚动保留天数（默认 14）
 *
 * 用法：node scripts/backup-local.mjs
 * 每日定时（Windows 管理员）：
 *   schtasks /Create /SC DAILY /ST 04:30 /TN MnemosyneBackup ^
 *     /TR "cmd /c cd /d <repo> && node scripts\backup-local.mjs >> backups\backup.log 2>&1"
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/* ---------- 配置装载 ---------- */
const envFile = join(here, 'backup.local.env')
const cfg = {}
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#')) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const get = (k, dflt) => cfg[k] ?? process.env[k] ?? dflt

const BACKUP_ROOT = resolve(get('BACKUP_ROOT', join(repoRoot, 'backups')))
const PGBACKUP_URL = get('PGBACKUP_URL')
const PGDUMP_BIN = get('PGDUMP_BIN', 'pg_dump')
const BASE = (get('MNEMOSYNE_BASE') ?? '').replace(/\/$/, '')
const WEB_KEY = get('MNEMOSYNE_WEB_KEY')
const ETERNAL_ID = get('MNEMOSYNE_ETERNAL_ID')
const MASTER_KEY = get('MNEMOSYNE_MASTER_KEY')
const RETAIN_DAYS = Number(get('RETAIN_DAYS', '14'))

const STAMP = new Date().toISOString().slice(0, 10)
const fail = (msg) => { console.error(`[backup] FAIL: ${msg}`); process.exit(1) }
const log = (msg) => console.log(`[backup] ${msg}`)

/* ---------- 1. Postgres（pg_dump custom 格式，pg_restore 可恢复）---------- */
async function backupPostgres() {
  if (!PGBACKUP_URL) {
    log('postgres：未配 PGBACKUP_URL，跳过（仅备 twig 时可接受；完整备份请开 Zeabur postgres 公网并补配）')
    return
  }
  mkdirSync(join(BACKUP_ROOT, 'pg'), { recursive: true })
  const out = join(BACKUP_ROOT, 'pg', `${STAMP}.dump`)
  const res = spawnSync(PGDUMP_BIN, [
    '--no-owner', '--no-privileges', '--format=custom',
    '--file', out,
    PGBACKUP_URL,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  if (res.error?.code === 'ENOENT') {
    fail(`找不到 pg_dump（${PGDUMP_BIN}）。安装 PostgreSQL 客户端：winget install PostgreSQL.PostgreSQL.16，或在 backup.local.env 设 PGDUMP_BIN 指向 pg_dump.exe 全路径`)
  }
  if (res.status !== 0) fail(`pg_dump 退出码 ${res.status}：${res.stderr}`)
  log(`postgres → ${out}（${(statSync(out).size / 1024).toFixed(0)} KB）`)
}

/* ---------- 2. twig 叙事数据（经 BFF，凭证不出本机之外）---------- */
let clientKey = WEB_KEY ?? null

async function api(path, init = {}, retried = false) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'X-Client-Key': clientKey, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (res.status === 401 && !WEB_KEY) {
    // key 失效（如 web 端重新登录轮换了 client_key）→ 重登一次再重试；
    // 此前只把 clientKey 置空返回 null，调用方把字面 null 写进文件还打 ✓，备份静默变空
    if (retried) throw new Error(`${path} → 401（重登后仍被拒；master_key 可能已变更）`)
    clientKey = null
    await ensureKey()
    return api(path, init, true)
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function ensureKey() {
  if (clientKey) return
  if (!BASE) fail('未配 MNEMOSYNE_BASE，twig 快照拉取不了')
  if (!WEB_KEY && !(ETERNAL_ID && MASTER_KEY)) fail('需配 MNEMOSYNE_WEB_KEY，或 MNEMOSYNE_ETERNAL_ID + MNEMOSYNE_MASTER_KEY')
  if (WEB_KEY) { clientKey = WEB_KEY; return }
  const res = await fetch(`${BASE}/v1/web/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // BFF schema 只收小写 64-hex；env 里手抄的大写会 400 掉整个 twig 备份
    body: JSON.stringify({ user_eternal_id: String(ETERNAL_ID).trim().toLowerCase(), master_key: MASTER_KEY }),
  })
  if (!res.ok) fail(`web/login ${res.status}: ${(await res.text()).slice(0, 200)}`)
  clientKey = (await res.json()).client_key
  log('已用 master_key 换取新 web client_key')
}

async function pullAll(pathBase, pageParam) {
  // 分页拉尽（state/notes 为 page/limit 语义）；非分页端点一次返回
  if (!pageParam) return api(pathBase)
  const out = []
  let first = null
  for (let page = 1; page <= 500; page++) {
    const sep = pathBase.includes('?') ? '&' : '?'
    const data = await api(`${pathBase}${sep}${pageParam}=${page}&limit=500`)
    if (first === null) first = data
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.notes) ? data.notes : Array.isArray(data?.fragments) ? data.fragments : null
    if (items == null) return data // 形状不带分页，直接返回
    out.push(...items)
    if (items.length < 500) break
  }
  // state 端点顶层是 state 对象 + fragments 分页（此前不认识该形状，只备份到第 1 页 500 条）
  if (first && Array.isArray(first.fragments)) return { ...first, fragments: out, totalFragments: out.length }
  return out
}

async function backupTwig() {
  await ensureKey()
  const dir = join(BACKUP_ROOT, 'twig', STAMP)
  mkdirSync(dir, { recursive: true })
  const targets = [
    ['context.json', '/v1/web/memory/context', null],
    ['claims.json', '/v1/web/memory/claims', null],
    ['audit-last.json', '/v1/web/memory/audit/last', null],
    ['journal.json', '/v1/web/memory/journal/export', null],
    ['soliloquy.json', '/v1/web/memory/soliloquy/export', null],
    ['state.json', '/v1/web/memory/state', 'page'],
    ['notes.json', '/v1/web/memory/notes', 'page'],
    ['stamps.json', '/v1/web/memory/stamps/recent?limit=200', null],
  ]
  for (const [file, path, pageParam] of targets) {
    try {
      const data = await pullAll(path, pageParam)
      writeFileSync(join(dir, file), JSON.stringify(data, null, 1))
      log(`twig ${file} ✓`)
    } catch (e) {
      fail(`twig ${file}：${e.message}`)
    }
  }
  log(`twig → ${dir}/`)
}

/* ---------- 3. 滚动清理 ---------- */
function prune(sub) {
  const dir = join(BACKUP_ROOT, sub)
  if (!existsSync(dir)) return
  const cutoff = Date.now() - RETAIN_DAYS * 86_400_000
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).mtimeMs < cutoff) {
      rmSync(p, { recursive: true })
      log(`prune ${sub}/${name}（>${RETAIN_DAYS} 天）`)
    }
  }
}

/* ---------- 主流程 ---------- */
const t0 = Date.now()
backupPostgres()
  .then(backupTwig)
  .then(() => { prune('pg'); prune('twig') })
  .then(() => log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`))
  .catch((e) => fail(e instanceof Error ? e.message : String(e)))
