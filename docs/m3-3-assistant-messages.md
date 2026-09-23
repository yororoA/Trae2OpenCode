# M3-3 Assistant 文本与 long-text 关联

> 状态：已完成
> 核验日期：2026-09-24
> 适用版本：TRAE CN 3.3.104

## 1. 生产入口

实现位于 `src/source/trae/assistant-messages.ts`：

- `parseTraeRuntimeAssistantMessages`：校验并规范化 V2 `getMessages` 返回的
  assistant 记录。
- `scanTraeLongTextResources`：只读扫描 workspace `long-text/`，并将 M3-2
  query cache 或调用方提供的显式路径引用关联到资源。
- `readTraeAssistantMessages`：按 session 调用可选 runtime provider，再组合
  long-text 扫描及引用关联结果。

未知 TRAE 版本以
`T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED` fail closed。当前模块只提供
provider 契约，不包含 production runtime bridge；未注入 provider 时不会从
renderer 日志或不透明数据库恢复 assistant 正文。

## 2. Runtime assistant 契约

3.3.104 parser 只接受 `role = "assistant"` 的记录，并严格校验：

| 语义 | 来源与处理 |
| --- | --- |
| 消息/会话 ID | `message_id`、`chat_session_id` |
| turn/reply 关系 | `turn_id`、`reply_to_message_id` |
| 消息类型 | `message_type` 为 `general` 或 `task` |
| 顺序 | `message_index`，非负安全整数 |
| 创建时间 | `created_at` epoch 秒，规范化为毫秒 |
| 起止时间 | `chat_start_time`、`chat_end_time`，保持毫秒 |
| 状态 | `completed`、`in_progress` 规范化为 `completed`、`in-progress` |

非法身份或关系会拒绝整条记录。非法状态规范化为 `unknown` 并告警；非法起止时间
只拒绝对应时间字段。完成状态缺少真实 `chat_end_time` 时保留离线 metadata 并
告警，不补造完成时间。

provider 支持与 M3-2 相同的数组、`messages`、`items`、`data.messages`、
`data.items` 和双层 `data` envelope。消息按 session、顺序、创建时间和消息 ID
稳定排序。同消息 ID 且原记录 hash 相同则合并来源；hash 冲突时两条都拒绝。

## 3. 正文投影

正文只使用在 TRAE CN 3.3.104 官方前端实现和 M0 runtime evidence 中确认的
语义路径：

| 消息形态 | 正文来源 |
| --- | --- |
| `message_type = general` | `content.content` |
| task proposal | `content.messages[].proposal.content.thought`，保持块顺序 |
| task chat | 第一个 `plan_item.thought` |
| task chat 最终回复 | `Finish` / `response_to_user` 的 `params.summary`，覆盖 chat thought |

`content` 可为 JSON 字符串或等价对象。每个正文块保留字段 locator 和内容
SHA-256。

`reasoning_content` 不进入 M3-3 正文。非 chat task 的普通
`plan_item.thought` 也不映射；它们由 M3-4 按持久化语义处理。没有可映射正文
时仍保留有效的消息身份、关系、状态和时间 metadata，并产生
`T2O_TRAE_ASSISTANT_MESSAGE_TEXT_MISSING`。

## 4. long-text 扫描与关联

scanner 只接受以下严格三级 UTF-8 `.txt` 布局：

```text
workspaceStorage/<workspace-id>/long-text/<scope>/<entry-id>/<file-name>.txt
```

每个资源记录 workspace ID、相对路径、scope、entry ID、文件名、字节数和内容
SHA-256，不把 scope 解释为 session ID。符号链接、其他目录深度、非 `.txt`
文件和非法 UTF-8 都拒绝读取并产生脱敏诊断。

query cache 仅检查 `filePath` 和 `relatePath`，且路径本身必须明确包含
`long-text` 路径段。关联还必须同时满足：

1. 路径规范化后仍位于来源记录对应的 workspace `long-text/` 根内。
2. 相对路径严格符合三级 `.txt` 布局。
3. 路径精确命中已扫描资源。

绝不按 basename、entry ID、scope、内容 hash 或相似路径回退。跨 workspace
引用拒绝关联；精确路径不存在时记录 missing warning；没有任何显式引用的资源
保留 metadata 并记录 unassociated warning。调用方也可传入带 workspace 和可选
session/message ID 的显式引用，适用于后续已验证的 runtime 关联字段。

## 5. 诊断与隐私

稳定诊断覆盖非法 envelope、身份/关系、状态、时间、正文结构、重复冲突、
provider 失败、long-text 布局/编码/读取错误、非法/缺失引用和孤立资源。

诊断只包含固定 message、安全 ID、记录序号、字段名以及路径或引用的 SHA-256。
provider 异常 message、assistant 正文、reasoning、long-text 内容和绝对路径都
不会写入诊断。单 session 或单资源失败不会阻断其他记录。

## 6. 实机验证

在当前 TRAE CN 3.3.104 环境中，不注入 runtime provider 的只读组合验证结果：

| 项目 | 数量 |
| --- | ---: |
| 当前去重 query cache entry | 479 |
| long-text workspace | 3 |
| 严格布局 UTF-8 资源 | 22 |
| 唯一内容 SHA-256 | 17 |
| 最小/最大资源字节数 | 12,575 / 386,433 |
| `filePath` / `relatePath` 精确引用 | 4 / 3 |
| 精确引用总数 | 7 |
| 被引用资源 | 3 |
| 未关联资源 | 19 |
| 非孤立资源诊断 | 0 |
| 诊断绝对路径/正文泄漏 | 0 |

7 个引用可重复指向同一资源，因此不能将引用数解释为关联资源数。当前 19 个未关联
资源只保留可审计 metadata，不推断会话归属。资源 metadata 聚合 SHA-256 为
`35c1c34c695f51a7095f8c770c1269cb8d76326cf4131a540ab83559cb52544b`。

新增 12 项聚焦测试后，项目累计 127 项单元测试。production runtime bridge
仍未实现；M3-4、M3-5 将分别处理 reasoning/plan 和 tool 状态机。
