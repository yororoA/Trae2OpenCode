# M5-7 真实 TRAE 到 OpenCode 端到端验收

核验日期：2026-09-24。源为已登录的 TRAE CN 3.3.104 正常用户目录和生产
renderer，目标为完全隔离的 OpenCode 2.0.12。验收没有使用消息 fixture、
renderer 日志、数据库解密或用户现有 OpenCode 数据。

## 结果

通过 `npm run verify:live` 完成：

```text
TRAE production CDP
  -> getSession / paged getMessages
  -> parser and versioned IR
  -> private export and readback
  -> native OpenCode import
  -> full transfer reconciliation
  -> manifest resume
  -> independent duplicate migration
```

选中的非敏感可写会话准确分级为 `partial`，共有 4 条消息、2 个 user、
2 个 assistant、2 个 text 和 2 个 completed tool。项目路径无法由本地
workspace 证据唯一解析，因此目标使用隔离 fallback 目录；诊断保留
`T2O_IR_PROJECT_UNRESOLVED`，没有将其提升为 complete。

原生 import 实际执行 1 次。首次迁移 created=1、verified=1；同 manifest
resume 仍为 verified；独立重复迁移 created=0、skipped=1。verify 的 expected
与 actual 消息计数、messages hash 和 info hash 完全一致。目标 server、数据库、
导出 IR、manifest 和目录映射均在临时目录中，结束后清理。

机器可读报告保存在本地 `tmp/m5-live-runtime-report.json`，只包含版本、hash、
计数、诊断码和状态，不包含源会话 ID、标题、正文、工具 payload 或绝对路径。

## 实机发现与修复

1. 3.3.104 workbench 的实际 URL 是
   `/out/vs/code/electron-browser/workbench/workbench.html`，应用根目录需向上
   五层。旧 reader 使用早期路径和三层根目录，连接在 API 调用前 fail-closed。
2. runtime `getSession` 的一条悬空 ID 曾使整批 metadata 丢失。现在逐会话隔离；
   至少一个有效响应时保留有效项，整批失败仍拒绝。
3. 当前 renderer 使用 `agent_type: "solo_agent"`，最终正文仍是已验证的
   lowercase `finish.params.summary`。该显式类型复用 chat summary 映射；
   其他 plan thought 不猜作可见正文，继续产生降级诊断。
4. runtime 存在 name/params/result 均为空的工具占位。严格空占位不再误报工具
   调用；具有输入或结果但缺少名称的记录仍拒绝映射。
5. 带 workspaceStorageId 的资源错误此前成为 bundle 级错误并阻止所有 workspace。
   现在只归属该 workspace 的会话；无法归属的错误仍保持全局 fail-closed。

每项修复均有回归测试。完整质量门禁为 344 项测试、lint、双 TypeScript
类型检查、构建和 CLI smoke，全部通过。

## 覆盖边界

本次可写的真实会话没有 reasoning，不能宣称单个实机会话完成
source-to-target reasoning 验收。reasoning 的真实来源和字段结构已由 M0
已登录 renderer 证据确认；OpenCode reasoning 映射/回读由 M4 隔离实机和 M7
三系统合成来源矩阵验证。当前结论是生产 bridge 与编排整链已通过，reasoning
仍是拆分证据，不是单一会话整链证据。

扫描的 62 个候选中，16 个 runtime 读取失败、32 个触发凭据门禁、13 个非敏感
会话因源错误或目标无损映射门禁被阻止，仅 1 个满足实际写入条件。该结果验证了
工具不会为了提高迁移数量而绕过敏感信息、缺失字段或错误 payload。
