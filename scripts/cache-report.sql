-- R0 缓存命中率报表：厂商侧（真金白银）与自建侧（exact/context）分开看。
-- 用法：对生产库执行（psql "$DATABASE_URL" -f scripts/cache-report.sql）。
-- 厂商侧命中 = prompt_tokens_details.cached_tokens，已落 usage_logs.cache_read_tokens。

-- 1. 厂商侧前缀缓存命中率（近 7 天，按 provider/model 拆）
SELECT model,
       SUM(input_tokens)                                          AS input_tokens,
       SUM(cache_read_tokens)                                     AS cached_tokens,
       ROUND(100.0 * SUM(cache_read_tokens) / NULLIF(SUM(input_tokens), 0), 1) AS provider_hit_pct
  FROM usage_logs
 WHERE timestamp > NOW() - INTERVAL '7 days' AND error = FALSE
 GROUP BY model_used
 ORDER BY input_tokens DESC;

-- 2. 自建缓存命中分布（近 7 天）：exact/context 应与 R1/R3 修复前的 0 对比
SELECT cache_hit_type, COUNT(*) AS requests
  FROM usage_logs
 WHERE timestamp > NOW() - INTERVAL '7 days' AND error = FALSE
 GROUP BY cache_hit_type;

-- 3. 自建缓存省下的输出 token（exact 命中才计；见 pipeline.ts finalize 的 savedTokens 口径）
SELECT COALESCE(SUM(output_tokens), 0) AS exact_saved_output_tokens
  FROM usage_logs
 WHERE timestamp > NOW() - INTERVAL '7 days' AND cache_hit_type = 'exact';
