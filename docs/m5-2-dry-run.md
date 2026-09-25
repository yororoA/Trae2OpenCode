# M5-2：共享迁移计划与 dry-run

`migrate --dry-run` 使用 `buildMigrationPlan` 调用 M4 稳定身份、父依赖排序、
目录解析和 `mapOpenCodeSession`。计划保留实际 transfer，后续执行直接消费，
不另建映射分支。

支持 `--recovery complete,partial`、`--namespace`、可重复
`--path-map <from=to>` 和 `--fallback-directory`。缺失目录不创建，父会话不在
可导入计划内时阻塞子会话。显式选择 metadata-only 也不能绕过 M4 的消息门禁。
单会话映射失败保留错误码，其余独立会话继续生成计划。每个 transfer 上限
384 MiB，累计上限 1 GiB。映射在首次异步目录检查前完成输入快照，避免为整个
Bundle 再创建一份深拷贝。

无需 OpenCode 即可进行离线映射检查；提供 `--server` 时额外运行只读能力探测。
未探测目标的计划不代表目标可写。输出包含 ID、计数、hash、目录策略和固定
错误码，不输出正文、标题或目录。此阶段真实写入仍由 M5-3 接通。

## 验证

- 范围：共享计划、参数转换、摘要与 CLI 接线。
- 缺陷分析：未发现确认缺陷；恢复排除、父依赖和大小限制符合 fail-closed 契约。
- 生成用例：10 项；涵盖精确映射一致性、父先子、排除/阻塞、失败隔离、
  跨平台路径、调用方变更隔离、脱敏、参数校验及 CLI。
- Step5 首轮：各目标文件使用 `perl ... 120 node --import tsx --test ...`，
  全部通过，无失败或测试修复。全量 `npm run check` 275 项测试、lint、
  typecheck、build、smoke 全通过。
- 本机执行：62 个 metadata-only 会话全部 excluded，ready=0，blocked=0；
  JSON 无 `/Users/` 路径。未进行目标写入。
- Step6 已执行 `utree flush`；工具尝试更新全局 skill 目录，被工作区沙箱拒绝。
  该遥测工具故障不影响以上测试结果。
