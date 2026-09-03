#!/usr/bin/env bash
# backup.sh — §13.6 备份与容灾（VULN-16 修复）
# 部署在宿主机 cron：每日 04:30 →  crontab: 30 4 * * * /opt/mnemosyne/backup.sh
# 覆盖物：Postgres dump、twig 数据卷（叙事+情感层全量）；Redis 不备（缓存可再生）。
# 容器/卷一律经 compose 解析：此前硬编码 mnemosyne-postgres-1 / mnemosyne_twig_data，
# 而 compose 项目名取目录名（twig-mnemosyne-*），照抄本脚本必挂。
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fi

BACKUP_ROOT="${BACKUP_ROOT:-/backup}"
STAMP=$(date +%F)
mkdir -p "$BACKUP_ROOT/pg" "$BACKUP_ROOT/twig"

# 1. Postgres 逻辑备份（compose exec 按服务名定位，与项目名/容器名无关）
docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U mnemosyne mnemosyne | gzip > "$BACKUP_ROOT/pg/$STAMP.sql.gz"

# 2. twig 数据卷全量（叙事 + 情感层）。卷名按标签过滤解析，TWIG_VOLUME 可显式覆盖
TWIG_VOLUME="${TWIG_VOLUME:-$(docker volume ls --format '{{.Name}}' | grep -m1 'twig_data$')}"
if [ -z "$TWIG_VOLUME" ]; then
  echo "[backup] 找不到 twig_data 卷；设 TWIG_VOLUME=<卷名> 后重试" >&2
  exit 1
fi
docker run --rm \
  -v "$TWIG_VOLUME":/data:ro \
  -v "$BACKUP_ROOT/twig":/backup \
  alpine tar czf "/backup/$STAMP.tar.gz" -C /data .

# 3. restic 加密上传（B2），保留策略 + prune
restic -r b2:mnemosyne-backup backup "$BACKUP_ROOT" \
  --password-file /root/.restic-pass
restic -r b2:mnemosyne-backup forget \
  --keep-daily 14 --keep-weekly 8 --prune \
  --password-file /root/.restic-pass

# 4. 本地滚动清理（保留 14 天）
find "$BACKUP_ROOT/pg" "$BACKUP_ROOT/twig" -type f -mtime +14 -delete

echo "[backup] $STAMP done"
