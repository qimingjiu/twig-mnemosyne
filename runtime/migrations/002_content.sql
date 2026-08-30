-- 002_content.sql — §14.1 conversation_messages / §9.3 usage_logs
--               + §5.3 oauth_tokens（Token Broker）+ §18.2 crisis_audit（独立加密审计轨迹）

CREATE TABLE IF NOT EXISTS conversation_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role            VARCHAR(16) NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content         TEXT NOT NULL,
    -- §3.4：写入侧维护 token_count（写入时估算并存储），拉取按批次计账
    token_count     INTEGER,
    tool_calls      JSONB,
    tool_results    JSONB,
    model_used      VARCHAR(64),
    tokens_input    INTEGER,
    tokens_output   INTEGER,
    latency_ms      INTEGER,
    was_tts         BOOLEAN DEFAULT FALSE,   -- §21.6 频次上限依赖
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_session_time
  ON conversation_messages(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id          VARCHAR(64) UNIQUE NOT NULL,
    timestamp           TIMESTAMPTZ DEFAULT NOW(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id          UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    client_type         VARCHAR(32),
    provider            VARCHAR(64),
    model               VARCHAR(64),
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    cache_read_tokens   INTEGER DEFAULT 0,
    cache_write_tokens  INTEGER DEFAULT 0,
    latency_ms          INTEGER,
    cache_hit_type      VARCHAR(32),
    cache_saved_tokens  INTEGER DEFAULT 0,
    cost_usd            DECIMAL(10, 6),
    estimated_savings   DECIMAL(10, 6),
    route_reason        TEXT,
    fallback_count      INTEGER DEFAULT 0,
    error               BOOLEAN DEFAULT FALSE,
    error_type          VARCHAR(64),
    error_message       TEXT,
    -- v0.3.0 新增字段（§9.2）
    tts_chars           INTEGER,                       -- §21.6 预算告警源
    privacy_tier        VARCHAR(8),                    -- 'cloud' | 'local'（FEATURE-02）
    outreach_type       VARCHAR(16)                    -- 'remention' | 'vein-nudge' | 'ritual'
);

CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_logs(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_logs(provider, timestamp DESC);

-- Token Broker 凭证库（§5.3）：AES-256-GCM 密文；gateway 按短票取件，永不接触明文库
CREATE TABLE IF NOT EXISTS oauth_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        VARCHAR(64) NOT NULL,
    scopes          TEXT[] NOT NULL DEFAULT '{}',
    access_token_enc  TEXT NOT NULL,
    refresh_token_enc TEXT,
    expires_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, provider)
);

-- 危机审计轨迹（§18.2）：独立、加密、append-only；不进 usage_logs、不进任何缓存
CREATE TABLE IF NOT EXISTS crisis_audit (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    payload_enc TEXT NOT NULL,          -- AES-256-GCM(JSON {message, model, ts, ...})
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Token Broker 取件审计（§5.3）：「哪个工具动用了哪个身份」，Dashboard 展示源
CREATE TABLE IF NOT EXISTS broker_audit (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    provider    VARCHAR(64) NOT NULL,
    scopes      TEXT[] NOT NULL DEFAULT '{}',
    outcome     VARCHAR(16) NOT NULL DEFAULT 'issued',  -- issued | scope_denied | not_found
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
