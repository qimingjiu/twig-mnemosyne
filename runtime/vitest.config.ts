import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // 集成测试（需 Postgres/Redis/twig/LiteLLM）不进默认跑批
    exclude: ['test/integration/**', 'node_modules/**'],
  },
})
