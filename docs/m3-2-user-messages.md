# M3-2 用户消息与查询缓存解析

> 状态：已完成
> 核验日期：2026-09-23
> 适用版本：TRAE CN 3.3.104

## 1. 生产入口

实现位于 `src/source/trae/user-messages.ts`：

- `parseTraeRuntimeUserMessages`：校验并规范化 V2 `getMessages` 返回的 user
  记录。
- `parseTraeQueryCache`：校验并规范化 workspace 输入历史。
- `readTraeUserMessages`：按 session 调用可选 runtime provider，并通过 M2-3
  SQLite 一致性快照读取所有 workspace 输入历史。

未知 TRAE 版本以 `T2O_TRAE_USER_MESSAGE_VERSION_UNSUPPORTED` fail closed。
当前模块提供 provider 契约，不包含 production runtime bridge；未注入 provider
时只读取 query cache，不会从日志、renderer 输出或不透明数据库补造消息。

## 2. Runtime 用户消息契约

3.3.104 runtime parser 只接受 `role = "user"` 的记录，并要求以下身份字段有效：

| 语义 | 来源 |
| --- | --- |
| 消息 ID | `message_id` |
| 会话 ID | `chat_session_id` |
| 顺序 | `message_index`，非负安全整数 |
| 创建时间 | `created_at`，epoch 秒，规范化为毫秒 |

provider 可返回数组、`messages`、`items`、`data.messages`、
`data.items`，以及对应的双层 `data` envelope。assistant 记录留给 M3-3 至
M3-5，不会被误报为非法 user 消息。

正文按以下优先级处理：

1. `content` 是非 JSON 字符串时，保留原字符串。
2. `content` 是 JSON 字符串或数组时，只拼接明确的
   `{ type: "text", text_content | text | content }` 块，保持块顺序且不插入
   分隔符。
3. `content` 无可恢复文本时，只允许从规范化 parsed query 中的直接字符串或
   `type = "text"` 项回退，并产生
   `T2O_TRAE_USER_MESSAGE_TEXT_FROM_QUERY`。
4. 只有 file、folder、web page 等上下文项时不得猜测正文，消息会被拒绝。

`query` 是 parsed-query 容器，不是直接正文。字符串值必须能解析为数组；缺失
时依次读取 `user_message_context.parsed_query` 和
`user_message_context.parsedQuery`。数组顶层只接受字符串或 JSON 对象，
对象内部必须是有限、无循环的 JSON 值。query 即使比 `content` 更长，也不会
覆盖有效正文。

## 3. Query cache 契约

读取键为：

```text
ItemTable:icube-ai-agent-storage-input-history
```

每条记录严格校验：

- `inputText: string`
- `parsedQuery: Array<string | object>`
- `multiMedia: Array<{ resource_id, resource_type }>`
- 可选 `files`，包含 `id/name/size/type/resourceUri/kind/uploadMode`，以及可选
  正整数 `width/height`

文件和多媒体 metadata 在本阶段只做结构化保留。资源存在性、复制和
`ResourceRef` 映射属于 M3-6。

query cache 当前没有 session ID、消息 ID 或时间字段，因此不能证明它属于哪个
会话。结果作为 `queryCacheEntries` 独立输出，绝不绑定 `sourceSessionId`，
也不参与会话 recovery grade。

## 4. 去重、排序与来源

runtime 消息按 `message_id` 去重：

- 同 ID 且完整记录 hash 相同：合并来源。
- 同 ID 但 hash 不同：两条都不进入结果，并产生
  `T2O_TRAE_USER_MESSAGE_DUPLICATE_CONFLICT`。

消息稳定按 `sourceSessionId`、`message_index`、`created_at`、`message_id`
排列。

query cache 按规范化后的 `inputText/parsedQuery/multiMedia/files` SHA-256
去重。重复内容保留每个 workspace、原始数组位置和原记录 SHA-256，因此去重
不会丢失来源证据。缓存结果按规范化 SHA-256 稳定排序，不把无时间字段的数组
位置解释为跨 workspace 时间顺序。

每条 runtime 消息同时保留：

- 完整原记录 SHA-256
- 正文来源 locator 与字段 SHA-256
- query 来源 locator 与字段 SHA-256

## 5. 诊断与隐私

稳定诊断覆盖无效 envelope、无效身份/时间、非法 content/query、正文缺失、
重复冲突、provider 失败、缓存结构错误和 SQLite 读取失败。

诊断只包含固定 message、记录序号、字段名及可选的 message/session/workspace
ID。异常 message、正文、query、附件 metadata 和绝对路径不会进入诊断。
provider 或单个 workspace 失败时继续处理其他 session/workspace。

## 6. 实机验证

在当前 TRAE CN 3.3.104 环境中，不注入 runtime provider 的只读验证结果：

| 项目 | 数量 |
| --- | ---: |
| 包含输入历史的 workspace | 10 |
| 原始 cache occurrence | 511 |
| 去重后的 cache entry | 477 |
| 保留的来源引用 | 511 |
| `inputText` 为空的去重 entry | 30 |
| parsed query 项 | 1281 |
| multimedia 引用 | 149 |
| file metadata | 131 |
| 解析诊断 | 0 |
| 诊断绝对路径/正文泄漏 | 0 |

全部 `state.vscdb` 均通过 SQLite Online Backup 快照读取。477 条结果只输出
规范化内容和来源 hash；验收汇总只记录计数和 hash，不写入真实正文。

M0 的真实结构化 fixture 已证明 25 条 user 记录均存在 `query` 与 `content`；
本阶段通过 parser 测试固定了字段优先级、query fallback 和冲突行为。完成
production runtime bridge 后，`readTraeUserMessages` 可直接按 M3-1 发现的
session ID 批量读取正文，无需改变解析契约。
