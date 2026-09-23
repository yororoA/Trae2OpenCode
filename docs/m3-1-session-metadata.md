# M3-1 会话索引、时间与标题解析

> 状态：已完成
> 核验日期：2026-09-23
> 适用版本：TRAE CN 3.3.104

## 1. 生产入口

实现位于 `src/source/trae/session-metadata.ts`：

- `readTraeSessionMetadata`：发现本机会话候选，并通过可选 runtime provider
  补充标题、时间和父会话。
- `parseTraeRuntimeSessionMetadata`：独立校验并规范化 runtime 返回值。

当前模块只解析会话级 metadata，不读取消息正文。M3-2 至 M3-5 将复用
`sourceSessionId` 关联消息、reasoning 和工具记录。

## 2. 会话发现

3.3.104 的候选会话 ID 从以下只读来源合并：

1. workspace `state.vscdb` 中的 `ai-chat-v2.lastActiveSessionId`
2. `chat.ChatSessionStore.index.entries`
3. `ModularData/ai-agent/snapshot/<session-id>` 目录

`state.vscdb` 始终通过 M2-3 SQLite Online Backup 读取。候选 ID 会去重；
每个来源只保留固定 locator 和 SHA-256，不在诊断中输出绝对路径。

snapshot 目录是 TRAE 自身磁盘诊断读取会话 metadata 时使用的会话枚举入口。
它只用于发现 ID，不从目录名推断标题、时间、项目或消息内容。

## 3. Runtime metadata 契约

解析器兼容 3.3.104 客户端中已确认的两种返回形态：

| 形态 | ID | 标题 | 创建时间 | 更新时间 |
| --- | --- | --- | --- | --- |
| local `chat/get_sessions` | `session_id` | `name` 或 `title` | `created_at`，epoch 秒 | `update_at`，epoch 秒 |
| V2 session metadata | `chat_session_id` | `title` 或 `name` | `created_at`，epoch 毫秒或日期字符串 | `updated_at`，epoch 毫秒或日期字符串 |

provider 可返回数组、`items`、`sessions`，以及原生响应的 `data.items` 或
`data.sessions`。一次最多请求 100 个 ID，与 TRAE 当前批量 metadata 入口一致。

时间转换按明确的字段契约执行：

- local `session_id` 形态的秒级时间乘以 1000。
- V2 `chat_session_id` 形态保留合法毫秒整数，日期字符串使用 `Date.parse`。
- 缺失、非法或倒序时间不会用当前时间或其他字段补造。

## 4. 合并与排序

同一会话的字段来源优先级为：

1. runtime metadata
2. workspace session index
3. active-session/snapshot 发现记录

同一优先级出现互相冲突的值时，该字段不进入结果，并产生 error diagnostic。
workspace 缓存与 runtime 值不同时以 runtime 为准，避免旧缓存覆盖当前 metadata。

结果稳定按以下顺序排列：

1. `updatedAt` 降序，缺失值在后
2. `createdAt` 降序，缺失值在后
3. `sourceSessionId` 字典序

## 5. 诊断与状态

每个结果带独立的 `metadataStatus`，避免与 M2 会话 recovery grade 混淆：

| 状态 | 含义 |
| --- | --- |
| `complete` | 标题、创建时间和更新时间均存在，且无诊断 |
| `partial` | 至少发现会话身份，但有缺失 metadata |
| `invalid` | 存在非法记录、冲突、非法时间或时间倒序 |

稳定诊断覆盖无效索引记录、标题/时间缺失、时间格式错误、时间倒序、metadata
冲突和 provider 失败。诊断只包含固定 message、字段名、记录序号及可选会话/
workspace ID，不包含标题正文、原始 payload 或异常 message。

未知产品版本以 `T2O_TRAE_SESSION_INDEX_VERSION_UNSUPPORTED` fail closed。

## 6. 实机验证

在当前 TRAE CN 3.3.104 环境、不注入 runtime provider 的只读验证结果：

| 项目 | 数量 |
| --- | ---: |
| 去重后的候选会话 | 62 |
| snapshot 目录来源 | 61 |
| workspace active-session 来源 | 10 |
| workspace session-index metadata | 0 |
| `partial` metadata | 62 |
| 绝对路径泄漏 | 0 |

当前 `chat.ChatSessionStore.index.entries` 在 14 个可读 workspace 中均为空。
因此本地索引不能提供真实标题与时间；62 个候选均明确产生标题、创建时间和更新
时间缺失诊断。接入 production runtime adapter 后，同一读取器会用 runtime
metadata 补齐这些字段，不需要改变发现与排序规则。

该验收表示 M3-1 的解析和诊断契约已完成，不表示 production runtime adapter
或消息正文读取已经完成。
