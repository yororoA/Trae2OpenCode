# M0-3 TRAE 消息来源定位

> TRAE CN：3.3.104；状态：已完成

## 结论

TRAE CN 3.3.104 的 V2 renderer 已初始化以下结构化历史读取入口：

```text
TraeApi.chat.getMessages({ env: "local" })
  -> chat.getMessages
  -> lite/get_messages
```

真实会话回读确认该入口返回 user/assistant 正文、消息顺序与 reply/turn 关系、
reasoning、tool name/params/result/status 以及消息和工具时间字段。当前版本的
`trae-cn-runtime-v2` profile 因此标记为 `verified`，M0-3 来源定位完成。

这项结论只授权 runtime adapter。它不授权直接解析或解密
`ModularData/ai-agent/database.db`，也不授权把 renderer 日志当作迁移源。
正式迁移 reader 尚未实现，目标写入仍由后续 M3/M4 的字段校验和回读对账门禁控制。

## 真实证据

2026-09-23 对一个真实会话执行了两页结构化回读，并在 renderer 内完成脱敏：

- 50 条消息：25 user、25 assistant，非法消息项为 0。
- 25 组 assistant `reply_to_message_id` 全部匹配 user message。
- 50 个 `created_at`、25 个 `chat_start_time`、25 个 `chat_end_time` 均存在。
- 25 个 user `query` 与 25 个 user `content` 均为非空。
- 1,218 个 plan item 中，146 个 `thought` 和 270 个
  `reasoning_content` 非空。
- 1,218 个 tool call 被遍历；20 个脱敏样本均包含 name、params、result status
  和 generated/start/finish timing，其中 18 个包含 object result data，2 个
  明确为 `undefined`。
- assistant envelope、plan item、tool call 和 tool result 的实际 key 集合已固化。

canonical 证据位于
[`trae-cn-3.3.104.structured-runtime.json`](../fixtures/source-locations/trae-cn-3.3.104.structured-runtime.json)。
它只保留 schema、计数、关系、长度和 SHA-256：

- 原始探针文件：29,416 bytes。
- 原始探针 SHA-256：
  `987c8512e60ebb1d9fd575d24b204c746f6ad000536c57587da1882c4c4f6e3a`。
- fixture 不包含正文、原始 ID、绝对路径、账号数据或原始工具 payload。

探针向本地 debug server 上报时被 workbench CSP 阻止，但完整脱敏报告已在 renderer
内生成，并通过 `localStorage` 回传。传输失败不影响报告内容；fixture 同时记录
原始文件摘要和自身 canonical digest。

旧的
[`trae-cn-3.3.104.runtime.json`](../fixtures/source-locations/trae-cn-3.3.104.runtime.json)
只来自 renderer 日志，继续保持 `partial`，仅作为消息关系和工具状态的独立佐证。
官方 Markdown 导出可佐证可见 user/assistant 正文，但缺少 reasoning、tool payload
和结构化时间，因此不能作为迁移源。

## 字段来源

| 内容类型 | 已验证 runtime 路径 | 已验证字段 |
| --- | --- | --- |
| user | `getMessages#message` | `message_id`、`chat_session_id`、`role`、`query`、`content`、`message_type`、`message_index`、`created_at` |
| assistant | `getMessages#message` | `message_id`、`chat_session_id`、`turn_id`、`reply_to_message_id`、`role`、`content`、`status`、消息类型、顺序与起止时间 |
| reasoning | `assistant.messages[].plan_item` | `id`、`thought`、`reasoning_content`、`timing` |
| tool | `plan_item.tool_call_info` | `id`、`name`、`params`、`result.status`、`result.data`、`result.error_message`、generated/start/finish timing |

物理数据库只保留为环境诊断信息：

```text
ModularData/ai-agent/database.db
ModularData/ai-agent/database.db-wal
ModularData/ai-agent/database.db-shm
```

数据库头不是普通 SQLite 头，应继续按不透明存储处理。workspace `state.vscdb`
只用于 workspace/session 元数据，不能替代结构化消息入口。

## 重建与校验

同类脱敏 fixture 可用以下命令生成：

```sh
npm run collect:trae-structured-runtime-evidence -- \
  --probe "<redacted-probe.json>" \
  --output "<structured-runtime-evidence.json>"
```

normalizer 使用字段白名单，拒绝未知产品版本、缺失关键 schema、无完整 reply
关系、reasoning 为空、tool payload 不完整或时间覆盖不足的报告。fixture validator
还会校验 canonical digest 和隐私边界。

## 验收结果

| 项目 | 结果 |
| --- | --- |
| V2 `getMessages` 结构化真实回读 | 通过 |
| user/assistant 正文、顺序、reply/turn | 通过 |
| reasoning `thought` / `reasoning_content` | 通过 |
| tool name/params/result/status/timing | 通过 |
| assistant 完成时间来源 | 通过 |
| 当前 3.3.104 runtime profile | `verified` |
| 旧 `memento` profile | `unverified`，fail closed |
| 直接数据库读取 | 不支持，也不是验收依赖 |

M0-3 已证明至少一个真实会话的完整消息链可从结构化 runtime 入口恢复，满足 M0
来源侧退出条件。后续实现必须使用该 renderer adapter 或等价的官方 bridge；
不得改用日志解析、数据库解密或字段猜测。
