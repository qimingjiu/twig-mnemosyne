# 恢复手册（restore.md）— §13.6

> 备份未验证等于没有备份。本手册常备，**每季度做一次恢复演练**。

## 前置

新机：Ubuntu 24.04 LTS，已装 Docker + restic，`/opt/mnemosyne` 放置本仓库（compose + configs）。
`.env` 从密码管理器恢复（或从加密保管渠道取回）。

## 步骤

1. **起基础栈（先不起 mnemosyne/twig）**

   ```bash
   cd /opt/mnemosyne
   docker compose up -d postgres redis
   ```

2. **还原 Postgres**

   ```bash
   gunzip -c /backup/pg/<date>.sql.gz \
     | docker exec -i mnemosyne-postgres-1 psql -U mnemosyne -d mnemosyne
   ```

3. **还原 twig 数据卷**

   ```bash
   docker volume create mnemosyne_twig_data
   docker run --rm \
     -v mnemosyne_twig_data:/data \
     -v /backup/twig:/backup:ro \
     alpine sh -c "cd /data && tar xzf /backup/<date>.tar.gz"
   ```

4. **起全栈**

   ```bash
   docker compose up -d
   ```

5. **健康验收（全绿才算恢复成功）**

   ```bash
   curl -fsS http://127.0.0.1:8000/health | jq
   # 期望：db / redis / twig 全部 ok，twig.auth === true
   ```

6. **抽查一轮对话连续性**

   任选一个 client_key 发起 `/v1/chat/completions`，确认：
   - 近期对话被正确带出（session 记录在）；
   - `GET /v1/context` 的 promptText 与备份前叙事状态一致（threads/claims 齐全）；
   - 缓存层允许 MISS（Redis 未备份属预期）。

## 已知取舍

- Redis 有意不备份：缓存可再生，恢复后首轮 MISS 是正常现象。
- 备份中的用户数据残留随 30 天保留期滚动出清（隐私政策如实声明，§8.6）。
- restic 仓库本身加密（BACKUP_RESTIC_PASSWORD），密码丢失 = 备份不可用，密码入密码管理器。
