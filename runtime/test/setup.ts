// 测试环境变量（config.ts 在 import 时即校验）
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test'
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
process.env.MIGRATIONS_DIR ||= 'migrations'
process.env.CONFIG_DIR ||= 'config'
