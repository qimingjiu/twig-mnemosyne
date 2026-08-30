// 测试环境变量（config.ts 在 import 时即校验）
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test'
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
process.env.MIGRATIONS_DIR ||= 'migrations'
// 本地开发/测试从 runtime/ 目录跑，config 在仓库根；容器内 cwd=/app 用默认 'config'
process.env.CONFIG_DIR ||= '../config'
// 集成测试：TEST_DATABASE_URL 优先（runtime 全局 pool 与被测代码共用同一库）
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
