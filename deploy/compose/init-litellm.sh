#!/bin/bash
# init-litellm.sh — 供给 litellm 服务 DATABASE_URL 指向的角色与库（仅首次初始化卷时执行）。
# 缺了它 litellm 的 Prisma（spend tracking / virtual keys）每次启动都连不上。
# 注意：对已初始化过的旧数据卷不会补跑——存量部署需手工执行同样两条 SQL。
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE ROLE litellm LOGIN PASSWORD '$POSTGRES_PASSWORD';
	CREATE DATABASE litellm OWNER litellm;
EOSQL
