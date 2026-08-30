import { z } from 'zod'
import { createHash } from 'node:crypto'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL required'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  // Narrative Engine（§8.2）：单一全局 MUNINN_AUTH_TOKEN；用户隔离由 Identity Layer 保证
  TWIG_URL: z.string().default('http://127.0.0.1:7300'),
  MUNINN_AUTH_TOKEN: z.string().default(''),

  // Model Gateway（§6）：LiteLLM = 管道，路由决策在 Runtime 侧（§6.3）
  LITELLM_URL: z.string().default('http://127.0.0.1:4000'),
  LITELLM_API_KEY: z.string().default(''),

  // AES-256-GCM 主钥（OAuth tokens / 危机审计 / 导入包暂存），base64 编码 32 字节
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY required'),
  // §4.6 确认票据 HMAC 密钥
  CONFIRM_SECRET: z.string().default('insecure-dev-confirm-secret'),
  // §5.3 broker 内部共享密钥
  BROKER_INTERNAL_TOKEN: z.string().default('insecure-dev-broker-token'),
  // 首个用户 bootstrap（仅无用户时生效一次）
  BOOTSTRAP_TOKEN: z.string().default(''),

  // §2.5.1 webhook 校验链
  ALLOW_INSECURE_WEBHOOK: z.string().optional().transform(v => v === '1' || v === 'true'),
  WEBHOOK_HOST_ALLOWLIST: z.string().default(''),

  // §20 隐私分层路由阈值
  PRIVACY_LOCAL_THRESHOLD: z.coerce.number().default(70),
  // §19.3.3 危机静默期
  CRISIS_SILENCE_HOURS: z.coerce.number().default(24),
  // §3.2 当前用户消息 API 层硬限长（token）
  MAX_MESSAGE_TOKENS: z.coerce.number().default(4096),

  // 迁移与配置目录（docker 内 /app/migrations、/app/config）
  MIGRATIONS_DIR: z.string().default('migrations'),
  CONFIG_DIR: z.string().default('config'),

  // 管理面独立凭证（§12.4：admin endpoints require separate authentication）
  ADMIN_TOKEN: z.string().default(''),

  // §3.8 默认 fallback 链
  DEFAULT_MODEL_CHAIN: z.string().default('gpt-4o,claude-sonnet,gemini-pro'),
})

export type Env = z.infer<typeof EnvSchema>

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment: ${issues}`)
  }
  const env = parsed.data
  // 启动即校验主钥长度，密钥错误越晚发现越危险
  const key = Buffer.from(env.ENCRYPTION_KEY, 'base64')
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}); generate with: openssl rand -base64 32`)
  }
  return env
}

export const env = loadEnv()

export const DEFAULT_CHAIN: string[] = env.DEFAULT_MODEL_CHAIN.split(',').map(s => s.trim()).filter(Boolean)

export function sha256Short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}
