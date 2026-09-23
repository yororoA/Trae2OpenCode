# M3-8：IR 组装、排序与完整性

核验日期：2026-09-24。TRAE CN 3.3.104，IR schema v1。

## 交付

`assembleTraeMigrationBundle` 接收 metadata、workspace、资源报告以及逐会话
runtime 读取结果，输出经过 JSON Schema 和关系校验的 `MigrationBundle`。
这是纯组装接口，不负责连接 renderer，也不执行目标写入。

- `available / unavailable / error` 必须由读取方明确提供；`expectedMessageCount`
  必须来自完整读取证据，不能由已成功解析的消息数反推。
- 未知 TRAE 版本、报告版本不一致、非法总数和相互矛盾的读取结果拒绝组装，
  使用稳定 `T2O_*` 错误码。
- 相同 runtime 记录去重；跨角色 message ID 冲突与跨 session 返回值排除并诊断。
- event 按源 `message_index` 排序。相同 order 仍保留审计证据并报错，不自行修复。
- assistant 内容按原始 envelope entry 位置交错排列。同一 entry 的顺序为
  persisted reasoning、可映射 text、tool；general envelope 采用 reasoning/text。
- 不推断未持久化时间。工具优先使用实际 startedAt，其次实际 generatedAt；
  assistant 保留源 createdAt 和存在时的 completedAt。
- 来源引用记录明确 session/message/字段 locator、workspace、profile 修订与 hash。
  runtime-only 来源的 workspace 为 null，不通过路径猜测。
- 项目按规范化路径身份去重，Windows 比较忽略大小写。仅在一个明确项目候选时
  关联 session；multi-root 或跨 workspace 的歧义保留诊断。
- 资源仅通过显式 session 引用进入会话。未关联资源的类型、可用性、相对路径、
  hash 和来源保留在 resource diagnostic；输入历史只参与指纹，不变造为会话消息。
- workspace project 来源 hash 针对 resolver 的 `{path, source}` 投影，
  locator 明确标记 `workspace.json#resolved-project`，不是原始文件字节 hash。
- fingerprint 包含来源、读取状态、预期计数、拒绝记录的证据、资源及 cache hash；
  与采集时间无关。返回值与输入可变 payload 脱离。

`validateMigrationBundleIntegrity` 可独立用于离线 IR，校验项目/会话/消息/资源
身份、event 顺序、reply 的 user 身份和前序位置、时间、source session、工具 ID
和父会话引用。父图使用迭代遍历，避免深链递归溢出。

`complete` 同时需要 recovery coverage 与本次组装的会话诊断通过；未知总数、
缺失完成时间、运行中工具、不可用资源、未映射内容或关系冲突都会保留降级原因。
恢复等级只描述源数据；`partial` 不自动获得目标写入资格，M4 仍须执行目标门禁，
尤其是缺少 assistant 完成时间及 `T2O_TRAE_TOOL_ERROR_UNVERIFIED`。

## 测试范围

新增组装 15 项、关系完整性 6 项测试，总计 186 项通过。测试使用项目既有
`node:test + tsx`，未增加框架。

覆盖完整消息/内容交错、相同记录去重、ID/order/reply 冲突、外来 session、
completion/count 缺失、runtime 不可用/失败/非法响应、multi-root、资源缺失、
版本/读取契约、runtime-only 来源、payload 隔离与 2,000 层父链。

新增 `fixtures/source/trae-cn-3.3.104/assembly.json` 为人工合成的公开测试输入，
不含真实会话正文。`valid-trae-assembled.json` 固定其 parser-to-IR 输出，
与既有 fixture 一起进入 golden manifest 和只读检查。更新入口仍是：

```bash
npm run golden:update -- --accept
npm run check
```

## 缺陷分析与修正

生成测试前发现并复现两项问题，失败断言保留：

1. 读取失败状态与被拒绝记录没有进入 fingerprint，可能把不同证据当成同一源。
   现已纳入读取状态、预期总数和诊断 sourceRefs。
2. message 级计数足够时，运行中的 tool 可能被标为完整。
   现已增加终态检查，保留 running 内容并产生 `T2O_IR_CONTENT_INCOMPLETE`。

定向缺陷测试第一轮 2 项失败；修正实现后组装文件 15 项通过，完整性文件 6 项
通过，随后 `npm run check` 的 lint、186 项测试、typecheck、build 和 CLI smoke
全部通过。

## 本机只读验证

读取安装产品的 `product.json.appVersion` 确认为 3.3.104，源数据库通过一致性
只读快照访问。只输出计数，未将会话正文或真实路径提交仓库。

| 项目 | 结果 |
| --- | ---: |
| workspace | 15 |
| 去重项目 | 25 |
| 会话 | 62 |
| runtime event | 0 |
| 资源记录（含 missing/deferred） | 284 |
| 未关联资源 diagnostic | 284 |
| metadata-only | 62 |
| complete / partial / unrecoverable | 0 / 0 / 0 |
| IR 关系完整性错误 | 0 |
| diagnostic 绝对用户路径泄漏 | 0 |

当前生产 runtime bridge 尚未接入。本次验证证明离线来源能够组成可审计 IR，
不能视为真实正文已迁移或 OpenCode import 已完成。
