-- init.sql — Postgres 容器初始化（仅扩展与角色级设置）
-- 业务 schema 由 runtime 启动时的迁移器按 runtime/migrations/*.sql 顺序应用（schema_migrations 表记账）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
