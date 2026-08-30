# 测试

## 纯逻辑单测

`runtime/test/*.test.ts`（vitest，无需任何外部服务）：

```bash
cd runtime
npm run typecheck && npm test
```

## 集成测试

`runtime/test/integration/`（identity 回环 / T9.5 并发抢槽 / T9.7 幂等投递 / T9.6+T9.11
outbox 恢复 / T9.8 幂等键唯一性 / INV-H03+H04 硬过滤）需要真实 Postgres。
用例通过 `describe.skipIf(!TEST_DATABASE_URL)` 自门控：未配置时在 `npm test` 里自动跳过，
配置后随常规测试一起执行，也可单独跑：

```bash
TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:5432/mnemosyne_test npm run test:integration
```

compose 栈起来后可直接指向容器库跑：`docker compose exec mnemosyne npm run test:integration`
（或在宿主机对 127.0.0.1:5432 跑）。

## 红队用例覆盖映射（设计文档 §12.2 → test/）

| 用例 | 测试锚点 |
|---|---|
| T1.5 暴力尝试 | `identity.service.test.ts`（AttemptLimiter 10 次/15min） |
| T8.1 跨租户缓存 | `cache.keys.test.ts`（userId 入键） |
| T8.3 叙事演化 MISS | `cache.keys.test.ts`（nv 入摘要） |
| T8.4 危机零缓存 | `cache.keys.test.ts`（policy crisis_path） |
| T8.5 webhook SSRF | `webhook.guard.test.ts`（私网/元数据全拦截） |
| T8.9 确认票伪造 | `confirmation.test.ts`（篡改/跨会话/跨工具/过期） |
| T8.10 twig 裸奔 | `src/index.ts` 启动断言（需集成测试环境验证） |
| T9.1/T9.5 daily_cap | `migrations/003` 原子抢槽 + `outreach.policy.test.ts` |
| T9.2 危机静默 | `outreach.policy.test.ts`（INV-H04） |
| T9.3 输出侧复扫 | `crisis.lexicon.test.ts` + `outreach/generate.ts` |
| T9.6–T9.12 | `runtime/test/integration/`（需 PG/Redis） |
| T10.1/T10.2 | `privacy.test.ts`（fail-closed / 分类器只读信号） |
| T11.2/T11.3 | `voice.tts.test.ts` |
