# M5-5：可恢复回滚

核验日期：2026-09-24。目标契约固定为 OpenCode 2.0.12。

## 用法

```bash
trae2opencode rollback --manifest ./run/migration-manifest.json \
  --server http://127.0.0.1:4096 --json

# 先停用所有其他目标写入者，并核对预览中的 runId 与会话范围。
trae2opencode rollback --manifest ./run/migration-manifest.json \
  --server http://127.0.0.1:4096 --confirm <runId> --exclusive-target --json

trae2opencode verify --manifest ./run/migration-manifest.json \
  --server http://127.0.0.1:4096 --json
```

不提供 `--confirm` 时只预览，manifest 正文与目标内容均不改变。
`--confirm` 必须精确匹配本 manifest 的 run ID；缺少 `--exclusive-target`
声明时拒绝执行。`--dry-run` 只用于 migrate，rollback 本身默认预览。

## 删除范围

- 只删除 manifest 中本轮尝试导入且归属标记一致的新会话。
- skipped、从未尝试导入及 replacement 会话全部排除。替换前的内容没有备份，
  回滚不会恢复旧内容，也不会删除替换后的会话。
- 对原始完整回读计算的 `deletionHash` 必须完全匹配，包括目标自动投影的字段。
  新增消息、工具结果、标题、时间等任意变化均会保护整个回滚范围。
- 失败的部分写入必须有当时持久化的精确 hash。若在首次回读前中断，只有本轮
  归属一致且完整对账通过的会话可重新建立删除证据；未知部分写入拒删。
- 旧 manifest 已记录 created、却没有精确 hash 的会话拒删，不用当前值补证。
- 全图预检：任何外来、已变化或未选中的子会话都会阻止删除。实际删除前再次
  检查叶子和 hash，复用固定版本的原生 CLI 删除适配器。
- 端点或契约变化、回读失败同样会阻止删除，不把不可读当作不存在。

预检出现 protected 时 `hasFailures=true`，CLI 退出码为 5，且不执行任何删除。
运行中的 manifest 使用现有跨进程排他锁；它不是目标数据库的全局锁。
OpenCode 原生 DELETE 会级联，且没有条件删除，因此整个执行期间必须暂停其他
写入者。目标端点 fingerprint 不等于数据库身份。

## 中断与恢复

确认后的第一次 checkpoint 将 `rollbackState` 设为 `in-progress`。此后该
manifest 不再允许 migrate resume，也不能作为 replacement 授权来源。

删除按父子拓扑逆序执行。每个会话先持久化 `deleting` 与精确 hash，再调用原生
删除；确认目标不存在后持久化 `rolled-back`。删除响应丢失时以回读结果为准；
若连回读也失败，再次执行同一 rollback 命令可从 `deleting` 恢复。

全流程完成后标记 `completed`。重复执行不会二次删除。verify 对 rolled-back
检查不存在；若后来复用同 ID 创建了会话，verify 与 rollback 都报告失败且保护
新内容。未完成的 rollback 不会被 verify 报告为成功。

## 验证

- 单元范围：rollback、manifest 状态约束、migrate/verify、replacement 与 CLI。
- 缺陷分析：未发现已确认缺陷。
- 新增 15 项用例，另扩充 manifest 非法状态断言；定向测试首轮全部通过。
- `npm run check`：325 项测试、lint、typecheck、build、CLI smoke 全通过。
- `scripts/verify-rollback.ts` 使用隔离 OpenCode 和合成 parser-to-IR fixture；
  实机通过：预览 2 个会话、保护 1 个外来子会话、原生删除子会话后丢失响应与
  回读，续跑共删除 2 次并确认全部不存在；重复删除 0 次，迁移 resume 被阻止。
  结果记录于本地 `tmp/m5-5-real-report.json`。此脚本不能替代已登录 TRAE
  runtime 来源的端到端验收。
- 测试技能的 `utree flush` 已尝试；全局技能自更新被 workspace sandbox 拒绝，
  不影响仓库测试和实机验证。
