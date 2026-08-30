#!/usr/bin/env bash
# backup.sh — §13.6 备份与容灾（VULN-16 修复）
# 部署在宿主机 cron：每日 04:30 →  crontab: 30 4 * * * /opt/mnemosyne/backup.sh
# 覆盖物：Postgres dump、twig 数据卷（叙事+情感层全量）；Redis 不备（缓存可再生）。
set -euo pipefail

BACKUP_ROOT=/backup
STAMP=$(date +%F)
mkdir -p "$BACKUP_ROOT/pg" "$BACKUP_ROOT/twig"

# 1. Postgres 逻辑备份
docker exec mnemosyne-postgres-1 pg_dump -U mnemosyne mnemosyne \
  | gzip > "$BACKUP_ROOT/pg/$STAMP.sql.gz"

# 2. twig 数据卷全量（叙事 + 情感层）
docker run --rm \
  -v mnemosyne_twig_data:/data:ro \
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
