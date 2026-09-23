# M0-5 字段映射与降级矩阵

> 基线：TRAE CN 3.3.104 -> OpenCode 2.0.12
>
> 状态：映射决策已按真实 V2 回读更新；实现尚未进入生产迁移阶段。

## 判定规则

- **map**：源值、语义和关联均已通过当前版本 fixture 验证，可以进入 IR。
- **diagnostic**：只保留 hash、来源和缺失原因，不生成目标消息字段。
- **reject-import**：可以离线保留，但写入当前 OpenCode 会造成伪造或已知丢失。
- **unsupported**：当前版本没有受支持读取路径，不尝试猜测。

证据状态与会话恢复等级是不同概念。当前 `trae-cn-runtime-v2` profile 已验证，
但具体会话仍须按实际字段覆盖率计算 `complete` / `partial`；单个字段缺失时不得
用 profile 级结论补造。

## TRAE 到 IR

| 语义 | 当前来源与证据 | 预期 IR | 当前处理 |
| --- | --- | --- | --- |
| source session ID | runtime `chat_session_id` | `SessionIR.sourceId`、`sourceRefs` | map |
| project/workspace | `workspace.json`、workspace 状态 | `projectPath`、`sourceRefs` | map；保留原值 |
| model/Agent 关联 | workspace 状态 | session/message source metadata | diagnostic；未验证消息级语义 |
| user message identity | runtime `message_id` 与 assistant `reply_to_message_id` | user event source ref | map |
| user text | runtime `query` / `content` | user event text | map；parser 必须确定字段优先级并保留 hash |
| assistant identity | runtime `message_id` | assistant event source ref | map |
| message order | runtime `message_index` | event order/source ref | map |
| turn/reply relation | runtime `turn_id`、`reply_to_message_id` | event relation/source ref | map |
| assistant text | runtime assistant `content` envelope | `{ type: "text", text }` | map；保持 envelope 内块顺序 |
| reasoning text | `plan_item.reasoning_content` | `{ type: "reasoning", text }` | map；空值不生成 block |
| `plan_item.thought` | runtime plan item | diagnostic/source ref | diagnostic；与 reasoning 的展示语义需单独固定 |
| tool call identity/status | `plan_item.tool_call_info.id/result.status` | tool call/status | map |
| tool name/input/output | `tool_call_info.name/params/result.data` | `{ type: "tool", ... }` | map；当前完整样本覆盖 success |
| tool error | `result.error_message/error_variant` | error tool result | diagnostic；待非空错误 payload fixture |
| assistant completion time | runtime `chat_end_time` | assistant `completedAt` | map；缺失时仍 reject-import |
| message timestamps | runtime `created_at`、`chat_start_time`、`chat_end_time` | event/content timestamps | map |
| attachments/long text | `paste-files/`、`long-text/` 候选路径 | `resources` / content refs | deferred；归属和内容关联未验证 |

`map` 表示证据允许实现字段转换，不表示转换器已经交付。生产 reader 必须使用
V2 runtime adapter 或等价官方 bridge，并对每个会话重新执行完整性校验。数据库
schema 字段名和 renderer 日志都不能替代该读取路径。

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
| 验证 V2 runtime 正文、关系、reasoning/tool/timing | 已完成 |
| 产品级 session/workspace metadata 与诊断导出 | 规划允许，尚未实现 |
| 导出真实 user/assistant 正文到 IR | 证据允许，M3 尚未实现 |
| 导出 reasoning/tool payload 到 IR | 证据允许，M3 尚未实现 |
| 将真实 TRAE 会话导入 OpenCode | M4/M5 尚未实现 |
| 合成 OpenCode import/export 契约验证 | 已验证，但有未完成消息丢失边界 |

## 验收结论

M0-5 的字段映射、降级和不支持项已更新。真实 V2 回读已证明至少一条完整
user/assistant/reasoning/tool 消息链可恢复，M0 总退出条件通过。按
[ADR-0006](./adr/0006-runtime-readback-fail-closed.md)，可以进入 reader、IR 和
目标 adapter 实现；在这些实现及逐会话对账完成前，不宣称生产迁移可用。
