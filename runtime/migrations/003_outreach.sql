-- 003_outreach.sql — v0.3.1 补丁 §19.3.1（Transactional Outbox + 原子抢槽）
--
-- ⚠ 对补丁原文的一处施工修正（dedupe_key 硬伤）：
--   补丁定义 UNIQUE(user_id, dedupe_key)，而 reserveOutreachSlot 在抢槽时以
--   dedupe_key='' 插入 reserved 行。后果：
--   (a) 同一用户抢第二个槽即触发 23505，daily_cap 实际坍缩为 1；
--   (b) filtered 行永远保持 dedupe_key=''，第一次空扫描后该用户将永久无法再预留槽位。
--   修复：唯一性改为**部分唯一索引**——仅对真实 dedupe_key（<> ''）生效，
--   T9.8「相同 dedupe_key 第二次 INSERT 必失败」语义保持不变。

CREATE TABLE IF NOT EXISTS outreach (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- ⚠ 对补丁原文的第二处施工修正：补丁的 reserveOutreachSlot INSERT 未提供本列，
    --   而 NOT NULL 无默认 → 抢槽第一步即 23502。改为可空（filtered 行在候选扫描前即可产生），
    --   类型在候选确定后回填；终态行（delivered/failed 交付路径）恒有类型。
    outreach_type   VARCHAR(16) CHECK (outreach_type IN ('remention','vein-nudge','ritual')),
    claim_id        VARCHAR(64),
    thread_id       VARCHAR(64),
    content         TEXT NOT NULL,
    dedupe_key      VARCHAR(64) NOT NULL DEFAULT '',
    status          VARCHAR(16) NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved','generated','delivery_pending','delivered',
                                      'intervention_pending','completed','failed','filtered')),
    intervention_status VARCHAR(16) DEFAULT 'pending'
                    CHECK (intervention_status IN ('pending','reported','failed')),
    intervention_attempts INTEGER DEFAULT 0,
    delivery_attempts     INTEGER DEFAULT 0,
    last_intervention_error TEXT,
    last_delivery_error   TEXT,
    policy_version  VARCHAR(32) NOT NULL DEFAULT 'v1',
    filter_reason   VARCHAR(64),
    reservation_date DATE NOT NULL DEFAULT CURRENT_DATE,
    slot_number     INTEGER NOT NULL DEFAULT 1,
    dedupe_key_set_at TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    intervened_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 真实幂等键唯一（替代补丁原文的全列 UNIQUE，见文件头说明）
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_dedupe
  ON outreach(user_id, dedupe_key) WHERE dedupe_key <> '';

-- 原子抢槽依据：每用户每日每槽一行
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_slot
  ON outreach(user_id, reservation_date, slot_number);

-- Outbox Worker 轮询（§19.3.5）
CREATE INDEX IF NOT EXISTS idx_outreach_pending_intervene
  ON outreach(user_id, status, intervention_status)
  WHERE status = 'delivered' AND intervention_status = 'pending';

-- 主管线重试扫描：卡在 delivery_pending 的行
CREATE INDEX IF NOT EXISTS idx_outreach_delivery_pending
  ON outreach(reservation_date, status)
  WHERE status IN ('reserved','generated','delivery_pending');

-- 审计：filtered 记录持久化（AUDIT-11）
CREATE INDEX IF NOT EXISTS idx_outreach_user_day ON outreach(user_id, created_at DESC);
