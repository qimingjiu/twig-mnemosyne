import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // 集成测试（test/integration/）由 describe.skipIf(!TEST_DATABASE_URL) 自门控：
    // 未配置真实 Postgres 时自动跳过；`npm run test:integration` 单独跑
    exclude: ['node_modules/**', 'dist/**'],
  },
})
