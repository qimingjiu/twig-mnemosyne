# 上游契约对齐与施工偏差

宿主（本仓库）按 `Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md` +
`v0.3.1_patch.md` 施工，上游契约锚定 [qimingjiu/twig-memory](https://github.com/qimingjiu/twig-memory)（muninn）@ `89a7881`。
本文记录实测对齐结果、对补丁的两处施工修正，以及上游配合事项（§0.4 R1–R5）的状态。

## 对 v0.3.1 补丁的两处施工修正

补丁 §19.3.1 的 `outreach` 表定义与 `reserveOutreachSlot` 代码存在两处会直接打挂 Huginn 的硬伤，已在 `runtime/migrations/003_outreach.sql` 落地为修正版：

1. **`UNIQUE(user_id, dedupe_key)` 与抢槽占位冲突**：抢槽时以 `dedupe_key=''` 插入 reserved 行——同一用户抢第二个槽即 23505，且 filtered 行永远保持空键，**第一次空扫描后该用户将永久无法再预留槽位**。修正：改为部分唯一索引 `WHERE dedupe_key <> ''`；T9.8「相同 dedupe_key 二次 INSERT 必失败」语义不变。
2. **`outreach_type NOT NULL` 与抢槽 INSERT 缺列冲突**：抢槽发生在候选扫描之前，此时类型未知，INSERT 即 23502。修正：改为可空，类型在候选确定后回填（终态交付行恒有类型）。

另有一处语义差异记录在案：补丁 §19.3.5 示例向 `/v1/intervene` 传 `outcome:'pre_intervention'`，但 outcome 枚举不含该值（它属于 evidenceLevel）——实现改为初始上报只带 `evidenceLevel:'post_intervention'`。

## 契约对齐实测记录（muninn 实测 @ 本地工作区）

- `POST /v1/intervene` 已支持 `outcome` / `evidenceLevel`；`outcome='user_engaged'` + claimId 消费 remention 邀请（`status='redeemed'`，小写枚举）。
- **再提邀请挂在 contested 论断上**（独立新证据 ≥3 + 否决冷却 14 天后由 reflect 生成），非 active 论断；邀请 30 天后上游不再注入 promptText，宿主侧 `invitationActive` 同步失效。
- 宿主侧新增 **remention 7 天投递冷却**（`scanCandidate`）：dedupe_key 的 5 分钟桶只防同刻重放，防不了下一轮 cron 对同一 pending 邀请的重复兑现（§19.6 防纠缠）。
- `GET /health` 返回 `{ok, llm, embed, auth}`；ingest 收 `{userId, text, title?, tags?[]}` 且强制 4000 字符上限；上游自带 per-user 限速（429）。
- `threads` 仍无 `last_user_evidence_at` / `last_huginn_outreach_at` 字段 → vein-nudge 独立证据检测维持「7 天硬冷却 + evidenceLevel 降级」近似（R 请求仍有效）。
- R1（`/v1/crisis-check`）上游尚未实现 → 危机词表继续 vendor 自 core.ts @89a7881。

## 上游配合事项（§0.4 R1–R5 状态）

- ✅ **已落地（muninn 本地工作区）**：intervene 的 `outcome`/`evidenceLevel` 字段；`user_engaged → REDEEMED` 消费；`post_intervention` 碎片在 reflect 中权重降级（core.ts `evidenceLevel === 'post_intervention'` 过滤）。
- ⏳ R1 `/v1/crisis-check`：未落地，宿主词表继续 vendor（锁定 @89a7881）。
- ⏳ R5 ingest 长度上限：上游仍强制 4000 字符，宿主保留切片过渡。
- ⏳ 证据时间戳（thread.last_user_evidence_at 等）：未提供，vein-nudge 独立证据公式维持近似。
- ⏳ 宿主侧 deferred：用户对触达的回应更新为 `outcome='user_engaged'`（消费邀请）——需要先有回应来源（webhook 通道的用户回复关联），上游消费逻辑已就绪。
