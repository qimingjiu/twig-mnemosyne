-- 001_identity.sql — §2.2（VULN-02 修复）+ v0.3.1 PATCH-01（clients.metadata）
--               + §19.3.3（users.crisis_silence_until）

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    eternal_id      VARCHAR(64) UNIQUE NOT NULL,
    display_name    VARCHAR(255),
    email           VARCHAR(255) UNIQUE,
    -- VULN-02 修复：主凭证与盐
    master_key_hash TEXT NOT NULL,          -- argon2id；签发/轮换 client_key 的唯一凭证
    id_salt         BYTEA NOT NULL,         -- 每用户随机 32B；eternal_id = sha256(id_salt ‖ email ‖ created_at)
    -- v0.3.1：危机静默期（§19.3.3 Final Policy Check 源；monotonic 延长，user-scoped）
    crisis_silence_until TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    preferences     JSONB DEFAULT '{}',
    CONSTRAINT eternal_id_format CHECK (eternal_id ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_users_eternal_id ON users(eternal_id);

CREATE TABLE IF NOT EXISTS clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_type     VARCHAR(32) NOT NULL CHECK (client_type IN
                    ('operit', 'rikkahub', 'telegram', 'web', 'mobile', 'api')),
    key_hash        VARCHAR(128) UNIQUE NOT NULL,   -- sha256(client_key)；明文只在签发时返回一次
    display_name    VARCHAR(255),
    webhook_url     TEXT,                            -- 校验规则见 §2.5.1
    scopes          TEXT[] NOT NULL DEFAULT '{chat}',-- 'chat' 默认；'provision' 可签发新 client
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}',  -- v0.3.1 PATCH-01：voice_capable 等客户端能力声明
    UNIQUE(user_id, client_type)
);

CREATE INDEX IF NOT EXISTS idx_clients_key_hash ON clients(key_hash);
CREATE INDEX IF NOT EXISTS idx_clients_user_id ON clients(user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_type    VARCHAR(32) NOT NULL DEFAULT 'personal'
                    CHECK (session_type IN ('personal', 'coding', 'research', 'roleplay')),
    eternal_session_id VARCHAR(64) UNIQUE NOT NULL,  -- cross-client persistent ID
    title           VARCHAR(255),
    is_active       BOOLEAN DEFAULT TRUE,
    context_window  INTEGER DEFAULT 128000,  -- max tokens for this session
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    metadata        JSONB DEFAULT '{}'  -- custom tags, project links
);

CREATE INDEX IF NOT EXISTS idx_sessions_eternal_id ON sessions(eternal_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
