# Trae2OpenCode 实现规划

> 状态：M0、M1 已合入 `main`；M2-1 已合入 M2 里程碑分支；M2-2 已完成
> 核验日期：2026-09-23
> 基线：TRAE CN 3.3.104、OpenCode 2.0.12

## 1. 结论

项目按“源数据审计 -> 中间格式 -> OpenCode 原生导入 -> 对账验证”推进。

首版不直接写 OpenCode SQLite。OpenCode 2.0.12 已提供
`opencode session import` 和 `POST /api/experimental/session/import`，可接收
`SessionTransfer.Data`，其中 assistant 原生支持 `text`、`reasoning` 和 `tool`
内容。优先使用该接口可避免绑定内部数据库 schema。

实机上的 TRAE CN 3.3.104 与早期调研资料存在差异：

- `state.vscdb` 仍可提供 workspace、输入历史、会话 ID、模型和 Agent 关联。
- 旧 workspace 的 `memento/icube-ai-agent-storage` 中存在会话索引，但
  `messages` 可能为空。
- 长文本和附件分散在 `long-text/`、`paste-files/` 等目录。
- V2 renderer 的 `TraeApi.chat.getMessages` 可返回结构化 user/assistant 正文、
  reasoning、工具 payload、关系和时间字段。

M0 已用真实会话确认该结构化入口，并固化为脱敏 fixture。MVP 的第一个实现阶段
仍是“可恢复性盘点器”：先按会话验证字段覆盖率，再生成 IR，避免静默丢失内容。

### 1.1 当前状态快照

| 范围 | 状态 | 当前结果 |
| --- | --- | --- |
| M0 格式勘探 | 已完成 | M0-1 至 M0-5 的证据、策略和测试均已完成 |
| M0 分支交付 | 已集成 | PR #5 已合入 `m0/format-exploration`，PR #6 已合入 `main` |
| M1 工程骨架与 IR | 已集成 | PR #7 至 #10 已合入里程碑分支，PR #11 已合入 `main` |
| M2 路径发现 | M2-1 已集成 | PR #12 已合入 `m2/trae-scanner` |
| M2 workspace 解析 | M2-2 已完成 | 已实现 folder/workspace URI、JSONC multi-root 和逐记录诊断 |
| M2 扫描后续/M3 读取 | 未开始 | 快照、能力探测、runtime reader 和 recovery grading 尚未实现 |
| M4 OpenCode adapter | 契约验证完成，实现未开始 | 2.0.12 隔离 import/export 已验证，尚无生产 capability probe 与 import adapter |
| M5-M7 | 未开始 | 编排、安全、资源迁移、兼容与发布能力均未实现 |

当前结论不能表述为“迁移工具已可用”。准确状态是：M0 已解除源数据可恢复性
阻塞，项目可以进入工程实现阶段；目前仍不能执行真实 TRAE 会话迁移。

## 2. 目标与边界

### 2.1 MVP 目标

1. 扫描 macOS 和 Windows 上的 TRAE CN 数据目录。
2. 识别 workspace、项目路径、会话 ID 及可恢复的数据类型。
3. 将已确认的数据标准化为版本化 IR，并保留字段来源。
4. 生成 OpenCode 当前版本接受的 `SessionTransfer.Data`。
5. 通过 OpenCode 原生导入能力写入，不直接修改目标数据库。
6. 迁移后逐会话对账，生成机器可读报告。
7. 支持 dry-run、幂等重跑和失败清理。

### 2.2 MVP 不承诺

- 恢复 TRAE 从未在本地持久化的隐藏推理。
- 绕过云端鉴权获取未缓存的会话正文。
- 支持未经真实 fixture 验证的旧 `memento` 存储 profile。
- 自动迁移 MCP 凭据、账号令牌或其他 secret。
- 保证任意 OpenCode 版本的内部 SQLite schema 兼容。
- 首版提供 GUI。

### 2.3 成功标准

- 对“可完整恢复”的 fixture，会话、消息顺序、文本、reasoning、工具输入输出、
  时间和附件引用对账一致。
- 对不完整数据，报告必须明确标记缺失项及证据来源，不允许静默忽略。
- 重复执行不会产生重复会话。
- 单个会话失败不影响其他会话，且可从 manifest 继续。
- 默认不修改 TRAE 数据，不覆盖 OpenCode 现有会话，不复制凭据。

## 3. 核心技术决策

### ADR-001：先做单包 CLI，不提前拆 monorepo

仓库已有 M0 阶段的 TypeScript 采集、证据校验和 OpenCode 验证代码。MVP 继续
保持单包结构，并在 M1 补齐 CLI 入口后按以下目录划分边界：

```text
src/
├── cli/
├── source/trae/
├── ir/
├── target/opencode/
├── migration/
├── verification/
└── shared/
```

出现第二个源适配器后，再把 `source/trae`、`ir`、`target/opencode` 拆为独立包。

### ADR-002：OpenCode 原生 import 为主路径

目标写入优先级：

1. `opencode session import`，面向用户的稳定 CLI。
2. `POST /api/experimental/session/import`，用于集成测试或显式启用的快速路径。
3. SQLite Writer，仅在目标版本没有原生 import 时作为后续受控兼容层。

启动迁移前读取 `opencode --version` 和 `/openapi.json`，按能力选择 Adapter。
不能识别目标版本时只允许导出 IR，不允许写库。

### ADR-003：IR 必须记录来源与恢复质量

每个会话、消息和内容块都携带 `sourceRefs`，至少包含：

- workspace storage ID
- 数据库键或相对文件路径
- 源会话 ID
- 解析器 profile 版本
- 内容 hash

会话恢复质量分为：

- `complete`：关键消息链和内容均可重建。
- `partial`：至少可恢复用户输入和部分 assistant 内容。
- `metadata-only`：只能恢复会话 ID、项目或时间等元数据。
- `unrecoverable`：仅发现悬空引用或数据损坏。

默认只迁移 `complete` 和 `partial`；其余状态需要显式参数。

### ADR-004：历史记录与运行能力分开

- 历史层保存 MCP/Tool 的名称、输入、输出和状态。
- 运行时层只生成 MCP/Skill 配置建议。
- 凭据只报告“需要重新绑定”，不进入 IR、日志或迁移报告。

### ADR-005：所有写入都必须可验证

每次迁移生成 `migration-manifest.json`，记录：

- source fingerprint 与 IR hash
- 目标 OpenCode 版本和能力
- 源 ID 到目标 ID 的映射
- 各类型计划数量、实际数量和 hash
- 警告、降级、失败原因
- 本次创建的目标会话 ID

默认不删除任何既有目标数据。回滚只删除本次 manifest 记录且经确认的新会话。

### ADR-006：按版本验证 runtime profile，其他来源 fail closed

TRAE CN 3.3.104 只允许通过已验证的 V2 `TraeApi.chat.getMessages` runtime
adapter 或等价官方 bridge 读取消息。renderer log 只能作为辅助证据，不能作为
迁移源；不直接解密 TRAE 数据库，不补造 assistant 完成时间。未知版本与旧
`memento` profile 继续 fail closed。完整决策见
[ADR-0006](./adr/0006-runtime-readback-fail-closed.md)。

## 4. 数据流

```text
TRAE roots
  -> discovery
  -> read-only snapshot
  -> storage profile parser
  -> versioned IR
  -> validation and recovery grading
  -> OpenCode transfer adapter
  -> native session import
  -> target export/readback
  -> reconciliation report
```

### 4.1 TRAE 数据源优先级

1. 已验证的 V2 runtime `TraeApi.chat.getMessages({ env: "local" })`
   (`lite/get_messages`)
2. `ModularData/ai-agent/database.db`（加密/不透明；不得绕过访问控制）
3. `workspaceStorage/<id>/workspace.json`
4. `workspaceStorage/<id>/state.vscdb`
5. `workspaceStorage/<id>/long-text/`
6. `workspaceStorage/<id>/paste-files/`
7. `globalStorage/state.vscdb`
8. 经用户显式授权的其他本地缓存或官方 API

扫描数据库时使用只读连接或一致性快照，不能直接操作运行中的数据库文件。
当前版本的消息来源证据与验证状态见
[`m0-3-source-location.md`](./m0-3-source-location.md)。

### 4.2 IR 最小结构

```ts
interface MigrationBundle {
  schemaVersion: 1
  source: SourceDescriptor
  projects: ProjectIR[]
  sessions: SessionIR[]
  diagnostics: Diagnostic[]
}

interface SessionIR {
  sourceId: string
  title?: string
  projectPath?: string
  parentSourceId?: string
  createdAt?: number
  updatedAt?: number
  recovery: "complete" | "partial" | "metadata-only" | "unrecoverable"
  events: EventIR[]
  resources: ResourceRef[]
  sourceRefs: SourceRef[]
}

type AssistantContentIR =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; createdAt?: number; completedAt?: number }
  | { type: "tool"; callId: string; name: string; input: unknown; output?: unknown;
      status: "running" | "completed" | "error"; createdAt?: number;
      completedAt?: number }
```

无法识别的字段进入 `Diagnostic` 和可选的原始 sidecar，不能猜测为已知类型。

## 5. CLI 设计

```bash
trae2opencode doctor
trae2opencode scan [--trae-root <path>] [--json]
trae2opencode preview [--project <path>] [--session <id>]
trae2opencode export --output <dir>
trae2opencode migrate [--dry-run] [--recovery complete,partial]
trae2opencode verify --manifest <path>
trae2opencode rollback --manifest <path>
```

- `doctor`：检查 TRAE/OpenCode 路径、版本、SQLite 能力和目标 import 能力。
- `scan`：只输出数据清单与恢复等级，不读取正文到终端。
- `preview`：显示统计、映射和告警，正文默认脱敏。
- `export`：生成版本化 IR，可在不安装 OpenCode 时使用。
- `migrate`：校验、导入、回读、对账。
- `verify`：重新读取目标并与 manifest 对账。
- `rollback`：只处理本次新建会话，默认要求交互确认。

## 6. 里程碑与任务

工期为单人净工程日估算。M0 已确认 TRAE 完整结构化消息来源，后续 reader 仍须
遵守相同版本和证据门禁。

### M0：格式勘探与决策冻结，2-4 天

| ID | 任务 | 依赖 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| M0-1 | 建立脱敏 fixture 采集脚本 | 无 | 只保留结构、类型、hash 和测试所需样本 | 已完成 |
| M0-2 | 固化 TRAE CN 3.3.104 存储 profile | M0-1 | 当前结构有真实脱敏 fixture；旧 `memento` 标记为未验证并 fail closed | 已完成 |
| M0-3 | 定位 assistant/reasoning/tool 的真实来源 | M0-2 | 每类字段有来源路径，或明确判定本地不可得 | 已完成 |
| M0-4 | 验证 OpenCode import round-trip | 无 | 原生消息类型可完整回读 | 已完成 |
| M0-5 | 固化 ADR 与映射矩阵 | M0-3, M0-4 | 字段映射、降级策略和不支持项评审通过 | 已完成 |

**退出条件**：至少一个真实会话能恢复完整消息链；若做不到，项目目标降级为
“本地可用数据导出器”，不能继续宣称完整迁移。

#### 当前进展（2026-09-23）

- M0-1、M0-2：已固化采集器、3.3.104 storage fixture 与 V2 runtime profile；
  当前 profile 为 `verified`，旧 `memento` 仍为 `unverified` 并 fail closed。
- M0-3：真实 V2 `TraeApi.chat.getMessages` 回读已验证 50 条消息、25 组 reply
  关系、正文、reasoning、1,218 个 tool call 及时间字段；来源定位完成。脱敏
  canonical evidence 和限制详见 [M0-3 来源定位](./m0-3-source-location.md)。
- M0-4：隔离原生 import/export 已验证已完成消息及四类工具状态；未完成
  assistant（缺少 `time.completed`）在回读中整条丢失，会话项目归属与
  更新时间也会被目标重算。详见 [M0-4 验证与限制](./m0-4-import-roundtrip.md)。
  目标端验证成功不能替代 TRAE 源端真实会话验收。
- M0-5：[ADR-0006](./adr/0006-runtime-readback-fail-closed.md) 与
  [字段映射矩阵](./m0-5-mapping-matrix.md) 已按新证据更新。未知或未验证 profile
  只导出 metadata/diagnostic；缺少真实完成时间的 assistant 仍拒绝目标写入。
- M0 退出条件已满足：至少一个真实会话的完整消息链可从结构化 runtime 入口恢复。
  这允许进入 M1-M3 实现，不表示生产迁移 reader 或目标写入已经完成。
- M0 最新任务提交为 `22213ed`；已通过 PR #5 合入 `m0/format-exploration`，
  再通过 PR #6 合入 `main`。
- 开发执行通道曾发生 transport 故障，原因、备用方案与复现方法见
  [开发环境故障排查](./development-troubleshooting.md)。

#### M1 完成与 M2 启动

1. M1-1 已通过 PR #7 合入里程碑分支；可执行 CLI、lint、CI 和统一质量门禁
   已建立。
2. M1-2 已通过 PR #8 合入里程碑分支；IR v1、JSON Schema、运行时 validator
   和 fixture 校验已建立。
3. M1-3 已通过 PR #9 合入里程碑分支；错误码、退出码、diagnostic 和脱敏
   结构化日志已统一。
4. M1-4 已通过 PR #10 合入里程碑分支：golden fixture 只读检查、显式更新、
   Schema hash 和 bundle hash 已建立。
5. M1 已通过 PR #11 合入 `main`。
6. M2-1 已通过 PR #12 合入里程碑分支：支持 macOS/Windows 默认路径与显式
   `--trae-root`。详细契约见
   [M2-1 路径发现](./m2-1-path-discovery.md)。
7. M2-2 已完成 workspace 与项目路径解析，详细契约见
   [M2-2 Workspace 解析](./m2-2-workspace-resolution.md)。
8. 后续将 M0 renderer 探针替换为生产 runtime adapter；探针、日志和数据库解密
   均不得成为生产数据源。

### M1：工程骨架与 IR，2-3 天

| ID | 任务 | 依赖 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| M1-1 | 完善 TypeScript CLI 入口、lint、test、build | M0-5 | CLI 可执行，本地和 CI 可检查与构建 | 已完成 |
| M1-2 | 定义版本化 IR 和 JSON Schema | M0-5 | 合法/非法 fixture 校验覆盖 | 已完成 |
| M1-3 | 统一错误码、诊断和结构化日志 | M1-1 | CLI 错误可定位且正文不泄露 | 已完成 |
| M1-4 | 建立 golden fixture 测试框架 | M1-1, M1-2 | IR 变化必须显式更新 golden | 已完成 |

### M2：TRAE 扫描与恢复等级，3-5 天

| ID | 任务 | 依赖 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| M2-1 | macOS/Windows 路径发现器 | M1-1 | 支持默认路径和 `--trae-root` | 已完成并集成 |
| M2-2 | workspace 与项目路径解析 | M2-1 | folder/workspace URI 均可规范化 | 已完成 |
| M2-3 | SQLite 一致性只读快照 | M2-1 | TRAE 运行时扫描也不写源库 | 未开始 |
| M2-4 | 数据源能力探测器 | M2-2, M2-3 | 输出 storage profile 和字段覆盖率 | 未开始 |
| M2-5 | 会话级 recovery grading | M2-4 | 每个会话都有等级和缺失原因 | 未开始 |

### M3：TRAE Parser 与 IR 标准化，6-10 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M3-1 | 会话索引、时间、标题解析 | M2-4 | 顺序稳定，缺失字段有诊断 |
| M3-2 | 用户消息与查询缓存解析 | M3-1 | 去重且保留来源 hash |
| M3-3 | assistant 文本与 long-text 关联 | M0-3, M3-1 | 不按文件名猜测错误归属 |
| M3-4 | reasoning/plan 解析 | M0-3, M3-1 | 仅映射实际持久化内容 |
| M3-5 | tool call/result 状态机归并 | M0-3, M3-1 | call/result 一一关联，孤儿项有告警 |
| M3-6 | 图片、文件和长文本附件解析 | M3-2 | 缺失文件、mime、hash 均有记录 |
| M3-7 | profile 解析器注册表 | M3-1..6 | 未验证或未知版本拒绝静默套用规则 |
| M3-8 | IR 排序、去重与完整性校验 | M3-1..7 | golden fixture 全部通过 |

### M4：OpenCode 原生导入，4-6 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M4-1 | 版本与 OpenAPI capability probe | M1-1 | 可判断 import/export/schema 能力 |
| M4-2 | IR -> `SessionTransfer.Data` 映射 | M1-2, M0-4 | 所有目标联合类型通过 schema |
| M4-3 | 稳定 ID 与父子依赖排序 | M4-2 | 重跑可识别同一会话 |
| M4-4 | 原生 CLI import adapter | M4-1..3 | Windows/macOS 均可导入 |
| M4-5 | 项目目录与不存在路径策略 | M4-2 | 保留原路径或应用显式 path map |
| M4-6 | 导入后 export/readback 对账 | M4-4 | 数量、顺序、类型和 hash 一致 |

OpenCode import 是实验性能力。M4-6 必须验证实际导入结果，不能只依赖 HTTP 200；
当前探测已证明形状不正确的消息可能没有进入最终投影。

### M5：迁移编排与安全性，3-5 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M5-1 | `doctor/scan/preview/export` | M2, M3 | 全流程无目标写入 |
| M5-2 | `migrate --dry-run` | M4 | 计划与实际映射使用同一代码路径 |
| M5-3 | manifest、checkpoint、resume | M4 | 中断后从最后成功会话继续 |
| M5-4 | 冲突与幂等策略 | M5-3 | 默认 skip，显式 replace 才覆盖本工具产物 |
| M5-5 | rollback | M5-3 | 只删除 manifest 记录的新会话 |
| M5-6 | 敏感信息过滤 | M1-3 | 日志、报告、fixture 不含凭据和默认正文 |

### M6：资源迁移，4-7 天，可独立发布

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M6-1 | Skill 发现、校验和冲突预览 | M3 | 不覆盖同名 Skill |
| M6-2 | Skill 复制与来源 manifest | M6-1 | 可回滚且文件 hash 可验证 |
| M6-3 | MCP 配置发现与脱敏 | M3 | secret 只显示“需重新绑定” |
| M6-4 | TRAE -> OpenCode MCP 映射 | M6-3 | 只生成建议配置，默认不启用 |
| M6-5 | runtime readiness 检查 | M6-2, M6-4 | 区分“历史已保留”和“当前可执行” |

### M7：兼容与发布，3-5 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M7-1 | macOS/Windows 集成矩阵 | M5 | 两端默认数据目录通过 |
| M7-2 | OpenCode 版本契约测试 | M4 | 至少覆盖当前版和一个相邻版本 |
| M7-3 | 大会话与异常中断测试 | M5 | 不 OOM，可恢复，无重复 |
| M7-4 | 安装包、README、故障排查 | M7-1..3 | 新机器按文档可完成 dry-run |
| M7-5 | 可选 SQLite fallback 评估 | M7-2 | 仅在原生 import 无法满足时立项 |

## 7. 优先级

### P0：首个可用版本

- M0 全部
- M1 全部
- M2 全部
- M3-1 至 M3-5、M3-7、M3-8
- M4 全部
- M5 全部
- M7-1 至 M7-4

### P1：增强完整性

- M3-6 附件迁移
- M6 Skill/MCP 资源迁移
- 旧 `memento` profile 的真实 fixture、验证与解析支持
- 更多 TRAE storage profile

### P2：仅按实际需求立项

- OpenCode SQLite Writer
- GUI
- Cursor、Claude Code、Codex 等其他源适配器

## 8. 测试策略

### 单元测试

- URI 与跨平台路径规范化。
- 各 TRAE key 的 profile 识别。
- 消息排序、去重、tool call/result 归并。
- IR schema、OpenCode transfer schema 和 ID 生成。
- 脱敏与 hash 稳定性。

### 契约测试

- 从运行中的 OpenCode 获取 `/openapi.json`。
- 用当前 schema 校验生成的 `SessionTransfer.Data`。
- 在隔离的 OpenCode data 目录执行 import/export round-trip。
- 对比 source IR 与 readback IR。

### 集成测试

- 空 workspace。
- 只有输入历史。
- 完整会话。
- reasoning 缺失。
- tool result 缺失或超长。
- 附件丢失。
- 重复迁移。
- 进程在批处理中断后恢复。
- OpenCode import 不可用或 schema 不兼容。

## 9. 主要风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| runtime adapter 在非 renderer 场景不可调用 | 无法执行批量读取 | M2 capability probe；必要时使用等价官方 bridge |
| TRAE 不同版本字段漂移 | 误解析或丢数据 | storage profile + fixture + fail closed |
| OpenCode 实验性 import 变化 | 导入失败或静默丢字段 | OpenAPI 探测 + round-trip 对账 |
| 运行中的 SQLite/WAL 不一致 | 扫描结果损坏 | 一致性快照，只读解析 |
| 附件路径失效 | 会话内容不完整 | hash、缺失告警、可选复制 |
| MCP 配置包含 secret | 凭据泄露 | 永不写入报告或 IR，要求重新绑定 |
| 大型 tool result 导致内存峰值 | OOM | 流式读取、大小上限、sidecar |

## 10. 推荐执行顺序

1. M0、M1 已完成并合入 `main`。
2. M2-1、M2-2 已完成；下一步进入 M2-3 SQLite 一致性只读快照。
3. 完成 runtime capability probe 和 recovery grading。
4. 生成可审计 IR，并打通真实来源到 OpenCode 的 import/export 对账。
5. 增加批量迁移、manifest、resume 和 rollback。
6. 最后处理附件、Skill、MCP；SQLite Writer 保持为可选项。

原始 P0 估算为 20-30 个工程日。当前完成的是高风险的 M0 勘探，不宜按任务数直接
折算整体百分比；M1-M5 和 M7 仍包含主要产品实现工作，剩余工期应在 M1 拆分后
重新评估。

## 11. 分支与提交规范

### 11.1 里程碑分支

| 层级 | 格式 | 示例 |
| --- | --- | --- |
| 里程碑分支 | `m{编号}/{kebab-case-short-name}` | `m0/format-exploration` |

M0、M1 已使用并完成任务分支流程。自 M2-2 起不再创建任务分支，任务直接提交到
对应里程碑分支。

### 11.2 提交格式

提交使用 Conventional Commits，scope 固定为任务 ID：

```text
feat(m2-2): resolve workspace project paths
fix(m2-2): reject ambiguous workspace metadata
test(m2-2): cover Windows file URI normalization
docs(m2-2): record workspace resolution contract
chore(m2-2): update task tooling
```

类型按提交内容选择，不把功能实现标为 `chore`。一个任务允许多个提交，但每个
提交都必须保留对应任务 scope。

### 11.3 合并策略

```text
任务提交 ──▶ 里程碑分支 ──PR──▶ main
```

- 任务提交直接推送至当前里程碑分支。
- 每个任务提交前必须通过完整质量门禁。
- 每个里程碑的退出条件满足后，里程碑分支通过 PR 合入 `main`。
- `main` 始终是可发布状态（P0 完成后即具备首个可用版本）。

### 11.4 分支一览

M0、M1 的子分支仅作为既有历史保留；M2 起仅维护里程碑分支，M2-1 的既有 PR
记录仍保留在 Git 历史中。

```text
main
│
├── m0/format-exploration           # M0：格式勘探与决策冻结
│   ├── m0-1/fixture-collection     #   建立脱敏 fixture 采集脚本
│   ├── m0-2/storage-profiles       #   固化 3.3.104 profile，旧 memento 标记未验证
│   ├── m0-3/source-location        #   定位 assistant/reasoning/tool 真实来源
│   ├── m0-4/import-roundtrip       #   验证 OpenCode import round-trip
│   └── m0-5/adr-mapping            #   固化 ADR 与映射矩阵
│
├── m1/engineering-skeleton         # M1：工程骨架与 IR
│   ├── m1-1/init-cli               #   初始化 TS CLI、lint、test、build
│   ├── m1-2/ir-schema              #   定义版本化 IR 与 JSON Schema
│   ├── m1-3/error-diagnostics      #   统一错误码、诊断与结构化日志
│   └── m1-4/golden-fixtures        #   建立 golden fixture 测试框架
│
├── m2/trae-scanner                 # M2：TRAE 扫描与恢复等级
├── m3/trae-parser                  # M3：TRAE Parser 与 IR 标准化
├── m4/opencode-import              # M4：OpenCode 原生导入
├── m5/migration-orchestration      # M5：迁移编排与安全性
├── m6/resource-migration           # M6：资源迁移 [P1，可独立发布]
└── m7/compatibility-release        # M7：兼容与发布
```
