# M0-5 字段映射与降级矩阵

> 基线：TRAE CN 3.3.104 -> OpenCode 2.0.12
>
> 状态：映射决策已冻结；源正文证据不足，完整迁移路径未启用。

## 判定规则

- **map**：源值、语义和关联均已通过当前版本 fixture 验证，可以进入 IR。
- **diagnostic**：只保留 hash、来源和缺失原因，不生成目标消息字段。
- **reject-import**：可以离线保留，但写入当前 OpenCode 会造成伪造或已知丢失。
- **unsupported**：当前版本没有受支持读取路径，不尝试猜测。

证据状态 `partial` 与会话恢复等级 `partial` 是不同概念。前者不能自动授权内容
映射。当前 profile 为 `unverified`，因此下表中的内容字段均未达到 `map`。

## TRAE 到 IR

| 语义 | 当前来源与证据 | 预期 IR | 当前处理 |
| --- | --- | --- | --- |
| source session ID | workspace 状态与 runtime session 关系 | `SessionIR.sourceId`、`sourceRefs` | metadata export |
| project/workspace | `workspace.json`、workspace 状态 | `projectPath`、`sourceRefs` | metadata export；保留原值 |
| model/Agent 关联 | workspace 状态 | session/message source metadata | diagnostic；未验证消息级语义 |
| user message identity | runtime assistant `reply_to_message_id` | user event source ref | diagnostic；关系已验证，正文未验证 |
| user text | 候选 `chat_message.content` / 输入历史 | user event text | unsupported；不能证明输入历史等于完整消息链 |
| assistant identity | runtime metadata `message_id` | assistant event source ref | diagnostic |
| message order | runtime `message_index` | event order/source ref | diagnostic；只对已观测样本成立 |
| turn/reply relation | runtime `turn_id`、`reply_to_message_id` | event relation/source ref | diagnostic |
| assistant text | 候选 `chat_message.content` | `{ type: "text", text }` | unsupported；无结构化正文 fixture |
| reasoning text | 候选 `plan_item.thought` | `{ type: "reasoning", text }` | unsupported；正文和分类均未验证 |
| plan item attachment | runtime history readback | diagnostic/source ref | diagnostic；不能据此生成 reasoning |
| tool call identity/status | runtime `tool_call_id`，`Running -> Exited` | tool diagnostic | diagnostic；终态成功/失败仅作证据 |
| tool name/input/output | 候选 `plan_item` 字段 | `{ type: "tool", ... }` | unsupported；payload 和 join 未验证 |
| assistant completion time | 尚无验证来源 | assistant `completedAt` | reject-import；禁止补造 |
| message timestamps | 尚无内容级 fixture | event timestamps | diagnostic；禁止按索引推算 |
| attachments/long text | `paste-files/`、`long-text/` 候选路径 | `resources` / content refs | deferred；归属和内容关联未验证 |

若后续通过受支持接口取得脱敏结构化 payload，只有对应 fixture 覆盖的字段才能从
`diagnostic` 或 `unsupported` 提升为 `map`。数据库 schema 字段名本身不构成提升
依据。

## IR 到 OpenCode

| IR 内容 | OpenCode 2.0.12 | 映射条件 | 降级/拒绝 |
| --- | --- | --- | --- |
| user event | `messages[].type = "user"`、`id`、`time.created`、`text` | ID、正文、时间均来自已验证源 | 任一关键值缺失则不创建消息 |
| assistant event | `type = "assistant"`、agent、model、`time`、`content` | 消息级字段及完成状态可证实 | 缺 `time.completed` 时 reject-import |
| text block | `content[].type = "text"`、`text` | 原始文本已持久化并保持块顺序 | 不从日志片段或 tool 输出拼接 |
| reasoning block | `content[].type = "reasoning"`、`text`、可选 `time` | 源端明确标记为可持久化 reasoning | 不把普通 plan item 猜成 reasoning |
| completed tool | `state.status = "completed"`、`input`、`content[]` | call ID、名称、输入、输出、终态完整 | 仅有退出码时 diagnostic |
| failed tool | `state.status = "error"`、`input`、`error` | 错误 payload 与调用关联完整 | 不根据非零退出码编造错误正文 |
| active tool | `running` / `streaming` | 源状态真实，且所属 assistant 有真实完成时间 | 不修改状态；assistant 未完成则拒绝导入 |
| parent session | `info.parentID` | 父会话已成功导入并完成 ID 映射 | 父会话不存在时拒绝子会话 |
| project metadata | target `projectID`、`subpath` | 由 import 目录投影 | manifest 记录源值和目标差异 |
| updated time/model variant | target 重算字段 | 仅用于 readback 对账 | 不覆盖源 metadata |

## 当前能力结论

| 能力 | 状态 |
| --- | --- |
| 脱敏扫描 storage/profile/路径 | M0 fixture 采集器可用 |
| 产品级 session/workspace metadata 与诊断导出 | 规划允许，尚未实现 |
| 验证 runtime 消息关系与工具状态 | 可用，仅作证据 |
| 导出真实 user/assistant 正文到 IR | 关闭 |
| 导出 reasoning/tool payload 到 IR | 关闭 |
| 将真实 TRAE 会话导入 OpenCode | 关闭 |
| 合成 OpenCode import/export 契约验证 | 已验证，但有未完成消息丢失边界 |

## 验收结论

M0-5 的字段映射、降级和不支持项已明确。由于尚无一个真实 TRAE 会话达到完整
消息链恢复条件，M0 总退出条件不通过。按
[ADR-0006](./adr/0006-runtime-readback-fail-closed.md)，后续只可推进不会暗示
完整迁移能力的 metadata/diagnostic 导出基础设施；目标写入保持关闭。
