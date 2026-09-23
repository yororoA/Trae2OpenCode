# M4-6：导入后回读对账

`reconcileOpenCodeTransfer` 先校验预期与实际 transfer schema，再检查：

- 消息数、user/assistant 数、text/reasoning/tool 块数；
- 完整 messages 的 canonical SHA-256，包括顺序、状态、输入输出、时间和 metadata；
- 每条消息与 session info 的非投影字段。

仅排除 M0/M4 实机已确认由目标投影的 session `projectID`、`subpath`、
`time.updated` 和 session summary `model.variant`。模型 ID/provider、创建时间、
目录、parent ID、标题、metadata、所有消息字段仍需一致。

差异只报告固定 schema 字段名、消息下标、计数和 hash，不包含内容、绝对路径或
工具 payload 的动态 key。最多记录 1,000 个差异位置，另保留准确的总差异数。
无差异返回 `verified`；否则 `mismatch`。

`requireOpenCodeReconciliation` 已接入原生 adapter。即使命令成功且回读 schema
合法，只要丢失或修改消息就以 `T2O_OPENCODE_RECONCILIATION_FAILED` 拒绝。
失败后的已创建目标会话保留供 manifest/resume/rollback 处理，不猜测删除权限。

## 验证

2026-09-24：

- 新增 8 项对账单测及 1 项 adapter 回归，累计 249 项，全量
  `npm run check`（lint、test、typecheck、build、smoke）通过。
- 丢 assistant、消息/块乱序、正文、时间、reply、tool input/output/status、
  metadata、源模型 identity、parent、目录变化均被检测。
- 差异报告不输出合成私密内容，1,200 条差异的位置列表限制为 1,000 条。
- 可复现实机命令：
  `node --import tsx scripts/verify-target-adapter.ts`。
- macOS OpenCode 2.0.12 隔离实机五组全部 verified：completed tool、running
  tool、streaming tool、最终 error assistant、parent/child。每组 2 条消息、
  5 个内容块，CLI/API export 相同，重复导入均拒绝。
- 运行时报告写入忽略目录 `tmp/m4-6-adapter-report.json`，只包含 hash、计数与
  安全差异字段。隔离服务和数据目录在退出时清理。

范围是合成 parser-to-IR fixture 的生产 target adapter 验证。TRAE production
runtime bridge 与 CLI 批量编排尚未接通，Windows 实机验证待 M7。
测试技能 Step1–5 完成；Step6 flush 已执行，但全局技能自更新仍被 sandbox 拒绝。
