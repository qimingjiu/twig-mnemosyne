-- 004_widen_eternal_session_id.sql — 施工修正：
-- 文档 §2.2.3 定义 eternal_session_id VARCHAR(64)，但同文档的 ID 形态为
-- `sess_` + 32B CSPRNG hex（69 字符），列宽装不下（集成测试首次真跑即触发
-- value too long）。放宽到 VARCHAR(128)；`^sess_[a-f0-9]{64}$` 形态校验不变。
ALTER TABLE sessions ALTER COLUMN eternal_session_id TYPE VARCHAR(128);
