# M0-3 TRAE 消息来源定位

> TRAE CN：3.3.104；状态：字段路径已定位，行级内容未验证

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

该运行时入口优先于直接访问加密数据库。后续解析器应通过受支持的本地服务接口
取得脱敏样本；若接口不可稳定调用，则 M0-3 保持未验证，不能把二进制 schema
证据升级为可用 parser profile。

## 字段来源

| 内容类型 | 本地实体 | 字段 | 当前证据 |
| --- | --- | --- | --- |
| user | `chat_message` | `content`, `message_role`, `message_index` 等 | schema-observed |
| assistant | `chat_message` | `content`, `message_role`, `message_index` 等 | schema-observed |
| reasoning | `plan_item` | `thought`, `turn_id` | schema-observed |
| tool | `plan_item` | `tool_id`, `tool_name`, `tool_params`, `tool_result`, `tool_status` | schema-observed |

`state.vscdb` 目前只确认包含 session ID、输入历史、模型/Agent 关联、draft 和附件
恢复元数据，不能作为 assistant、reasoning 或 tool 内容的完整来源。

机器可读证据位于
`fixtures/source-locations/trae-cn-3.3.104.json`。证据等级定义如下：

- `path-observed`：只确认文件或调用路径存在。
- `schema-observed`：从当前客户端代码或二进制确认实体和字段名。
- `row-sampled`：通过脱敏样本确认字段类型、角色值和关联关系。
- `runtime-readback`：通过客户端运行时入口确认实际消息投影。

## 剩余验收

M0-3 只有在以下条件满足后才能标记完成：

1. 通过 `lite/get_messages` 或经授权的 SQLCipher 只读连接获取一份脱敏结构样本。
2. 验证 `chat_message` 的角色值、消息顺序以及与 `chat_turn` 的关联。
3. 验证 `plan_item` 的 reasoning/tool 区分规则、状态值和 call/result 关联。
4. 将对应来源提升到 `row-sampled` 或 `runtime-readback`，并补充回归 fixture。

禁止将数据库密钥、消息正文、账号标识、绝对用户路径或原始附件写入仓库。
