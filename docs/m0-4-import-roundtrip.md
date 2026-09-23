# M0-4 OpenCode 原生导入与回读验证

> 实机：macOS，OpenCode 2.0.12；2026-09-23
>
> 状态：合成会话验证完成，存在已证实的内容丢失边界。
> 本结果不能替代 M0-3 的 TRAE 真实消息恢复验收。

## 运行方式

安装依赖并确保 `opencode --version` 为 `2.0.12`：

```sh
npm run verify:opencode
```

默认输出在 `tmp/opencode-roundtrip/`，包含结构 schema 和脱敏结果报告。
需要更新仓库证据时，显式指定输出目录：

```sh
npm run verify:opencode -- --output fixtures/opencode/2.0.12/evidence
```

脚本只使用仓库中的合成 fixture。它创建私有服务、独立数据库及 XDG 配置、
数据、缓存、状态目录，禁用项目配置、模型列表获取及自动更新；不发送模型
请求或执行 fixture 中的工具。随机服务密码仅存在于进程内存和子进程环境，
不会写入报告。每次运行结束时关闭私有服务并删除本次临时数据。
本次只在 macOS 验证，其他 OpenCode 版本会被脚本拒绝。

若命令通道异常，参见[开发环境故障排查](./development-troubleshooting.md)。

## 验证证据

- 合成输入：[session-transfer.json](../fixtures/opencode/2.0.12/session-transfer.json)。
- 实机 schema：[transfer.schema.json](../fixtures/opencode/2.0.12/evidence/transfer.schema.json)。
- 结果与内容 hash：[report.json](../fixtures/opencode/2.0.12/evidence/report.json)。
- 执行入口：`scripts/verify-opencode-roundtrip.ts`。

schema 从私有服务的 `/openapi.json` 获取，仅保留 `SessionTransfer.Data`
及其引用的结构。输入和 CLI 回读均通过该 schema 校验。
正向写入使用 `opencode session import --server <private-url>`；
回读同时使用 CLI export 和 HTTP export，两者必须一致。

| 场景 | 输入消息 | 回读消息 | 结果 |
| --- | --- | --- | --- |
| 已完成 user/assistant，包含 text、reasoning、completed/error 工具 | 2 | 2 | 所有消息字段、Unicode、空白、时间和顺序一致 |
| 尾部未完成 assistant，包含 running/streaming 工具 | 4 | 3 | 尾部 assistant 整条丢失 |
| 尾部未完成 assistant，包含 text | 4 | 3 | 尾部 assistant 整条丢失 |
| 尾部 assistant 只有 `finish: "stop"`，缺少完成时间 | 4 | 3 | 尾部 assistant 整条丢失 |
| 为对照实验给尾部 assistant 设置完成时间，仍保留活动工具状态 | 4 | 4 | running/streaming 内容也能完整回读 |
| 父会话存在后导入子会话 | 2 | 2 | 消息和 parentID 一致 |

对照实验设置完成时间仅用于定位目标端行为。迁移真实数据时不得为了通过导入
而补造完成时间，也不得将 running/streaming 工具改写成 completed。

另有三项 HTTP 负向检查：

- 重复导入相同会话 ID 返回 `409`，原会话回读内容不变。
- 父会话不存在返回 `404`，未遗留新会话。
- 非法消息类型同时被 schema 和导入接口拒绝（`400`），未遗留新会话。

退出码 `0` 表示观测符合上述契约，包括已知丢失场景得到明确报告；不代表所有
输入都可无损迁移。出现额外变化、schema 不匹配或能力缺失时返回非零退出码。
报告的 `fidelity` 为 `exact-messages` 或 `loss-observed`，不会将丢失标记为成功。

## 字段约束

当前实机格式使用 `type` 区分消息，不能套用旧的 `{ info, parts }` 格式。

| 内容 | OpenCode 2.0.12 字段 | 约束 |
| --- | --- | --- |
| 用户输入 | `messages[].type = "user"`、`text` | 带 `id` 与 `time.created` |
| assistant 正文 | `content[].type = "text"`、`text` | 内容块顺序保留 |
| reasoning | `content[].type = "reasoning"`、`text`、可选 `time` | 只映射源端实际持久化的文本 |
| 工具调用 | `content[].type = "tool"`、`id`、`name`、`state`、`time` | 工具调用 ID 为 `id` |
| 已完成工具输出 | `state.status = "completed"`、`state.content[]` | 输出是内容数组，不是顶层 `output` |
| 工具错误 | `state.status = "error"`、`state.error` | 错误包含 `type` 和 `message` |
| 未完成 assistant | 缺少 `time.completed` | 此版本 CLI/API export 均未回读该消息 |

消息 ID 在不同会话中也应唯一。本探测为每个场景添加独立后缀，后续迁移器需要
明确源会话与消息 ID 的映射。

## 会话级变化与后续决策

消息字段完全一致不等于整个会话对象不变。当前观察到：

- `info.projectID` 与 `info.subpath` 按导入目录重新计算。
- `info.time.updated` 被更新为导入时的时间；`time.created` 保留。
- 会话汇总的 `info.model.variant` 会补成 `"default"`；消息里的模型字段保留。

报告列出上述变化，未通过整体归一化掩盖它们。后续 IR/manifest 应保留源会话
更新时间和项目归属，供对账使用。

M0-5 应将以下边界纳入映射决策：已完成消息可以进入本版本原生导入路径；
缺少 assistant 完成时间的会话默认拒绝目标写入，保留在 IR/离线导出中并报告
原因，待有真实来源证据或目标兼容方案后再处理。

附件、其他原生消息类型、Windows 与相邻版本尚未覆盖。M0 总体验收仍需要至少
一个 TRAE 真实会话恢复完整消息链，当前不得宣称完整迁移已打通。
