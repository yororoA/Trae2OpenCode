# M0-3 TRAE 消息来源定位

> TRAE CN：3.3.104；状态：运行时关系已验证，正文映射部分未验证

## 结论

TRAE CN 当前版本的会话正文不在 workspace `state.vscdb` 中。实机观察到
`ai-agent` 进程持有以下数据库及 sidecar：

```text
ModularData/ai-agent/database.db
ModularData/ai-agent/database.db-wal
ModularData/ai-agent/database.db-shm
```

数据库头不是普通 SQLite 头。客户端二进制同时包含 SQLCipher 相关实现，因此该库
应按不透明数据库处理，不能使用普通 SQLite reader 猜测或绕过其访问控制。采集器
只记录相对路径、大小、头部 hash 和 sidecar 是否存在，不读取正文，也不接受、
输出或持久化数据库密钥。

客户端历史消息调用链已定位为：

```text
_aiAgentChatService.getSessionMessages
  -> chat.getMessages
  -> lite/get_messages
```

静态 source map 将 `lite/get_messages` 保留为 `schema-observed` 候选；本次运行时
证据记录到的 RPC 标识为 `chat/get_messages`。在取得当前版本受支持的接口契约前，
不能假定二者等价或在生产代码中硬编码替换关系。

该运行时入口优先于直接访问加密数据库。后续解析器应通过受支持的本地服务接口
取得脱敏样本；若接口不可稳定调用，则 M0-3 保持未验证，不能把二进制 schema
证据升级为可用 parser profile。

2026-09-23 已从当前客户端的 renderer runtime log 取得一份脱敏运行时证据。
该日志由客户端调用 `getSessionMessages` 后生成，不是直接读取或解密数据库：

- 两次历史回读均加载 20 条消息，store 数量一致，且 `hasMore = true`。
- 同一批消息分别关联 622 和 623 个 plan item。
- 3 个连续 assistant metadata 样本的 `message_index` 为 22、24、26。
- 每个 assistant message 均通过 `reply_to_message_id` 关联 user message，并通过
  `turn_id` 关联 turn；客户端的 metadata-applied 事件再次确认 user/assistant 对。
- 34 个工具调用样本均观察到 `Running -> Exited`，同时覆盖成功和失败退出。

脱敏证据位于
[`trae-cn-3.3.104.runtime.json`](../fixtures/source-locations/trae-cn-3.3.104.runtime.json)。
原始 renderer log 不进入仓库；会话、消息、turn 和 tool call ID 只保留
SHA-256，正文、账号、绝对路径和工具输出路径均被丢弃。

同类证据可用以下命令重新采集；`session-id` 只用于本次过滤，不写入输出：

```sh
npm run collect:trae-runtime-evidence -- \
  --log "<renderer.log>" \
  --session-id "<session-id>" \
  --product-version "3.3.104" \
  --output "<redacted-evidence.json>"
```

采集器拒绝其他产品版本，避免把未知日志错误标注为当前 profile。提交前必须检查
输出的隐私标志和敏感信息扫描结果，原始日志不得进入仓库。

这足以验证 runtime 投影中的 user/assistant 身份、顺序、turn/reply 关系、
plan item 附着和工具状态配对；仍不足以证明数据库内 `message_role` 的原始枚举，
也未安全读取 `thought`、`tool_name`、`tool_params` 或 `tool_result` 正文。
因此 profile 继续标记为 `unverified`，M0-3 为部分验收而非完全通过。

## 字段来源

| 内容类型 | 本地实体 | 字段 | 当前证据 |
| --- | --- | --- | --- |
| user | runtime `get_messages`；候选实体 `chat_message` | runtime 身份与 reply 关系已验证；`content`/`message_role` 物理字段未行采样 | runtime-readback / schema-observed |
| assistant | runtime `get_messages`；候选实体 `chat_message` | runtime 身份、`message_index`、`turn_id` 已验证；正文物理字段未行采样 | runtime-readback / schema-observed |
| reasoning | `plan_item` | plan item 附着已验证；`thought` 正文和分类规则未验证 | schema-observed |
| tool | runtime 状态事件；候选实体 `plan_item` | `tool_call_id` 状态配对已验证；名称、参数、结果和数据库 join 未验证 | runtime-readback / schema-observed |

`state.vscdb` 目前只确认包含 session ID、输入历史、模型/Agent 关联、draft 和附件
恢复元数据，不能作为 assistant、reasoning 或 tool 内容的完整来源。

机器可读证据位于
`fixtures/source-locations/trae-cn-3.3.104.json`。证据等级定义如下：

- `path-observed`：只确认文件或调用路径存在。
- `schema-observed`：从当前客户端代码或二进制确认实体和字段名。
- `row-sampled`：通过脱敏样本确认字段类型、角色值和关联关系。
- `runtime-readback`：通过客户端运行时入口确认实际消息投影。

## 验收结果

| 项目 | 结果 |
| --- | --- |
| `get_messages` 脱敏运行时样本 | 通过 |
| user/assistant 顺序、reply 与 turn 关系 | 通过（runtime 投影） |
| plan item 随历史消息加载 | 通过 |
| 工具调用状态与终态配对 | 通过 |
| `message_role` 数据库原始值 | 未验证 |
| reasoning `thought` 正文与分类 | 未验证 |
| tool 名称、参数、结果及 `plan_item` join | 未验证 |

M0-3 以“部分验收、fail closed”结束。以下条件满足前，不得启用完整消息 parser：

1. 通过受支持的结构化接口安全读取 assistant 正文、reasoning 和 tool payload。
2. 验证 `plan_item.thought` 的语义与 reasoning/tool 分类规则。
3. 验证工具名称、参数、结果与 `tool_call_id`/turn 的完整关联。
4. 若未来直接解析数据库，另行验证 `message_role` 原始值和表间 join。

禁止将数据库密钥、消息正文、账号标识、绝对用户路径或原始附件写入仓库。
