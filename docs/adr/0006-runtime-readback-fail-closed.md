# ADR-0006：运行时回读与 fail-closed 映射边界

- 状态：Accepted
- 日期：2026-09-23
- 适用基线：TRAE CN 3.3.104、OpenCode 2.0.12

## 背景

TRAE CN 3.3.104 的消息实体位于不透明的 `ai-agent` 数据库中。客户端 schema
暴露了 `chat_message`、`plan_item` 等候选字段，但没有经授权的数据库行级
fixture。真实 V2 renderer 回读现已确认 `TraeApi.chat.getMessages` 返回消息正文、
reasoning、工具 payload、关系、状态和时间字段；脱敏 fixture 只保留 schema、
计数、长度和 SHA-256。

OpenCode 2.0.12 的原生 import 可以无损回读已完成消息，但缺少
`assistant.time.completed` 的消息会在 CLI 和 API export 中整条消失。

## 决策

### 1. 生产读取边界

TRAE CN 3.3.104 的生产迁移路径只接受已验证的 V2
`TraeApi.chat.getMessages({ env: "local" })` adapter 或等价官方 bridge。renderer
日志仅用于辅助验证，不是迁移输入。实现不得依赖日志格式、提取数据库密钥或自行
解密 `ai-agent` 数据库。

直接数据库读取只有在产品提供受支持的只读方式、用户明确授权且对应版本已有脱敏
fixture 后，才能作为独立 storage profile 启用。

### 2. 证据与内容恢复等级分离

`partial` 证据状态只表示部分关系已验证，不等于会话已达到 IR 的 `partial`
恢复等级。字段进入 IR 内容块前，必须验证该字段的实际值、语义和关联：

| 证据 | 当前处理 |
| --- | --- |
| 当前版本真实回读验证的结构化 payload | 可按字段映射进入 IR |
| 只验证身份、顺序或关联 | 只导出 metadata/source ref 和 diagnostic |
| 只观察到 schema 或路径 | 不读取内容，不推断字段值 |
| 未知版本或未验证 profile | 只允许 metadata/diagnostic 导出，拒绝目标 import |

`trae-cn-runtime-v2` 是当前唯一经过内容级验证的 runtime profile。旧
`memento`、未知产品版本以及直接数据库 profile 仍未验证并 fail closed。profile
验证只授权已覆盖字段；例如当前非空错误 payload 和附件关联仍需额外 fixture。

### 3. 不补造状态或时间

源端没有明确值时，不补造 assistant 完成时间，不把 running/streaming 工具改写为
completed，也不根据消息位置猜测结束状态。缺少真实 `time.completed` 的 assistant
可以保留在离线 IR/诊断中，但对 OpenCode 2.0.12 默认拒绝 import。

目标端重算的 `projectID`、`subpath`、`time.updated` 和 summary model variant
不反写为源值。manifest 同时记录源值、目标投影值和差异。

### 4. 写入门槛

只有同时满足以下条件，会话才可进入目标 import：

1. 源版本匹配已验证的 storage/runtime profile。
2. 待写字段均有内容级证据和稳定关联。
3. assistant 完成状态及时间来自源数据。
4. 目标版本能力探测通过。
5. 导入后可执行 export/readback 对账。

任一条件不满足时 fail closed：保留离线导出和诊断，不创建目标会话。

## 结果

- M0-3 已完成，3.3.104 runtime profile 可作为后续 parser 的字段契约和回归证据。
- M0-5 已更新映射和降级规则；M0 的“真实完整消息链”退出条件已满足。
- 项目可进入 reader、IR 和目标 adapter 实现；生产迁移能力要到逐会话完整性校验
  和 OpenCode 回读对账完成后才启用。

## 被否决方案

- **把 renderer log 当迁移源**：格式不稳定，且日志不保证包含完整或脱敏内容。
- **从二进制或进程中提取数据库密钥**：越过支持边界，存在安全和兼容风险。
- **用目标端默认值补齐完成时间**：会伪造历史语义，并掩盖已证实的消息丢失。
- **按字段名直接启用 parser**：schema 存在不等于角色值、payload 和 join 已验证。
