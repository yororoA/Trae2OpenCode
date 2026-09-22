# Trae2OpenCode 实现规划

> 状态：Draft
> 核验日期：2026-09-22
> 基线：TRAE CN 3.3.104、OpenCode 2.0.12

## 1. 结论

项目按“源数据审计 -> 中间格式 -> OpenCode 原生导入 -> 对账验证”推进。

首版不直接写 OpenCode SQLite。OpenCode 2.0.12 已提供
`opencode session import` 和 `POST /api/experimental/session/import`，可接收
`SessionTransfer.Data`，其中 assistant 原生支持 `text`、`reasoning` 和 `tool`
内容。优先使用该接口可避免绑定内部数据库 schema。

当前最大不确定性在 TRAE 侧。实机上的 TRAE CN 3.3.104 与早期调研资料存在差异：

- `state.vscdb` 仍可提供 workspace、输入历史、会话 ID、模型和 Agent 关联。
- 旧 workspace 的 `memento/icube-ai-agent-storage` 中存在会话索引，但
  `messages` 可能为空。
- 长文本和附件分散在 `long-text/`、`paste-files/` 等目录。
- 仅凭当前已确认的本地字段，不能保证恢复每个会话的完整 assistant 正文、
  reasoning 和工具结果。

因此，MVP 的第一个交付物不是迁移写入器，而是“可恢复性盘点器”。只有先确定
每个会话有哪些可验证的数据，后续迁移才不会静默丢失内容。

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

仓库目前没有代码。MVP 使用一个 TypeScript 包，通过目录划分边界：

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

1. `workspaceStorage/<id>/workspace.json`
2. `workspaceStorage/<id>/state.vscdb`
3. `workspaceStorage/<id>/long-text/`
4. `workspaceStorage/<id>/paste-files/`
5. `globalStorage/state.vscdb`
6. 经用户显式授权的其他本地缓存或官方 API

扫描数据库时使用只读连接或一致性快照，不能直接操作运行中的数据库文件。

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

工期为单人净工程日估算。TRAE 完整正文的数据源尚未确认，因此 M0 是继续实施的门槛。

### M0：格式勘探与决策冻结，2-4 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M0-1 | 建立脱敏 fixture 采集脚本 | 无 | 只保留结构、类型、hash 和测试所需样本 |
| M0-2 | 覆盖至少两个 TRAE 存储 profile | M0-1 | 旧 `memento` 与 3.3.104 当前结构均有 fixture |
| M0-3 | 定位 assistant/reasoning/tool 的真实来源 | M0-2 | 每类字段有来源路径，或明确判定本地不可得 |
| M0-4 | 验证 OpenCode import round-trip | 无 | 原生消息类型可完整回读 |
| M0-5 | 固化 ADR 与映射矩阵 | M0-3, M0-4 | 字段映射、降级策略和不支持项评审通过 |

**退出条件**：至少一个真实会话能恢复完整消息链；若做不到，项目目标降级为
“本地可用数据导出器”，不能继续宣称完整迁移。

### M1：工程骨架与 IR，2-3 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M1-1 | 初始化 TypeScript CLI、lint、test、build | M0-5 | 本地和 CI 可构建 |
| M1-2 | 定义版本化 IR 和 JSON Schema | M0-5 | 合法/非法 fixture 校验覆盖 |
| M1-3 | 统一错误码、诊断和结构化日志 | M1-1 | CLI 错误可定位且正文不泄露 |
| M1-4 | 建立 golden fixture 测试框架 | M1-1, M1-2 | IR 变化必须显式更新 golden |

### M2：TRAE 扫描与恢复等级，3-5 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M2-1 | macOS/Windows 路径发现器 | M1-1 | 支持默认路径和 `--trae-root` |
| M2-2 | workspace 与项目路径解析 | M2-1 | folder/workspace URI 均可规范化 |
| M2-3 | SQLite 一致性只读快照 | M2-1 | TRAE 运行时扫描也不写源库 |
| M2-4 | 数据源能力探测器 | M2-2, M2-3 | 输出 storage profile 和字段覆盖率 |
| M2-5 | 会话级 recovery grading | M2-4 | 每个会话都有等级和缺失原因 |

### M3：TRAE Parser 与 IR 标准化，6-10 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M3-1 | 会话索引、时间、标题解析 | M2-4 | 顺序稳定，缺失字段有诊断 |
| M3-2 | 用户消息与查询缓存解析 | M3-1 | 去重且保留来源 hash |
| M3-3 | assistant 文本与 long-text 关联 | M0-3, M3-1 | 不按文件名猜测错误归属 |
| M3-4 | reasoning/plan 解析 | M0-3, M3-1 | 仅映射实际持久化内容 |
| M3-5 | tool call/result 状态机归并 | M0-3, M3-1 | call/result 一一关联，孤儿项有告警 |
| M3-6 | 图片、文件和长文本附件解析 | M3-2 | 缺失文件、mime、hash 均有记录 |
| M3-7 | 多 profile 解析器注册表 | M3-1..6 | 未知版本拒绝静默套用旧规则 |
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
| TRAE 正文只在云端或临时缓存 | 无法完整迁移 | M0 先证实；按会话标记恢复等级 |
| TRAE 不同版本字段漂移 | 误解析或丢数据 | storage profile + fixture + fail closed |
| OpenCode 实验性 import 变化 | 导入失败或静默丢字段 | OpenAPI 探测 + round-trip 对账 |
| 运行中的 SQLite/WAL 不一致 | 扫描结果损坏 | 一致性快照，只读解析 |
| 附件路径失效 | 会话内容不完整 | hash、缺失告警、可选复制 |
| MCP 配置包含 secret | 凭据泄露 | 永不写入报告或 IR，要求重新绑定 |
| 大型 tool result 导致内存峰值 | OOM | 流式读取、大小上限、sidecar |

## 10. 推荐执行顺序

1. 完成 M0，不通过退出条件就调整产品定位。
2. 实现 IR、scanner 和 `export`，先形成稳定、可审计的离线产物。
3. 打通一个完整 fixture 的 OpenCode import/export round-trip。
4. 增加批量迁移、manifest、resume 和 rollback。
5. 最后处理附件、Skill、MCP；SQLite Writer 保持为可选项。

按当前不确定性，P0 预计 20-30 个工程日。M0 结束后再给出更可信的剩余工期。

## 11. 分支命名规范

### 11.1 命名格式

| 层级 | 格式 | 示例 |
| --- | --- | --- |
| 里程碑分支 | `m{编号}/{kebab-case-short-name}` | `m0/format-exploration` |
| 任务分支 | `m{编号}-{序号}/{kebab-case-short-name}` | `m0-1/fixture-collection` |

### 11.2 合并策略

```text
任务分支 ──PR──▶ 里程碑分支 ──PR──▶ main
```

- 任务分支完成后通过 PR 合入对应的里程碑分支。
- 每个里程碑的退出条件满足后，里程碑分支合入 `main`。
- `main` 始终是可发布状态（P0 完成后即具备首个可用版本）。

### 11.3 分支一览

```text
main
│
├── m0/format-exploration           # M0：格式勘探与决策冻结
│   ├── m0-1/fixture-collection     #   建立脱敏 fixture 采集脚本
│   ├── m0-2/storage-profiles       #   覆盖至少两个 TRAE 存储 profile
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
│   ├── m2-1/path-discovery         #   macOS/Windows 路径发现器
│   ├── m2-2/workspace-resolution   #   workspace 与项目路径解析
│   ├── m2-3/sqlite-snapshot        #   SQLite 一致性只读快照
│   ├── m2-4/capability-probe       #   数据源能力探测器
│   └── m2-5/recovery-grading       #   会话级 recovery grading
│
├── m3/trae-parser                  # M3：TRAE Parser 与 IR 标准化
│   ├── m3-1/session-index          #   会话索引、时间、标题解析
│   ├── m3-2/user-messages          #   用户消息与查询缓存解析
│   ├── m3-3/assistant-longtext     #   assistant 文本与 long-text 关联
│   ├── m3-4/reasoning-parser       #   reasoning/plan 解析
│   ├── m3-5/tool-call-merge        #   tool call/result 状态机归并
│   ├── m3-6/attachment-parser      #   图片、文件、长文本附件解析 [P1]
│   ├── m3-7/profile-registry       #   多 profile 解析器注册表
│   └── m3-8/ir-validation          #   IR 排序、去重与完整性校验
│
├── m4/opencode-import              # M4：OpenCode 原生导入
│   ├── m4-1/capability-probe       #   版本与 OpenAPI capability probe
│   ├── m4-2/ir-to-transfer         #   IR → SessionTransfer.Data 映射
│   ├── m4-3/stable-id-ordering     #   稳定 ID 与父子依赖排序
│   ├── m4-4/cli-import-adapter     #   原生 CLI import adapter
│   ├── m4-5/project-path-strategy  #   项目目录与不存在路径策略
│   └── m4-6/roundtrip-verify       #   导入后 export/readback 对账
│
├── m5/migration-orchestration      # M5：迁移编排与安全性
│   ├── m5-1/doctor-scan-preview    #   doctor/scan/preview/export 命令
│   ├── m5-2/dry-run                #   migrate --dry-run
│   ├── m5-3/manifest-checkpoint    #   manifest、checkpoint、resume
│   ├── m5-4/idempotent-strategy    #   冲突与幂等策略
│   ├── m5-5/rollback               #   rollback
│   └── m5-6/sensitive-filter       #   敏感信息过滤
│
├── m6/resource-migration           # M6：资源迁移 [P1，可独立发布]
│   ├── m6-1/skill-discovery        #   Skill 发现、校验与冲突预览
│   ├── m6-2/skill-copy             #   Skill 复制与来源 manifest
│   ├── m6-3/mcp-discovery          #   MCP 配置发现与脱敏
│   ├── m6-4/mcp-mapping            #   TRAE → OpenCode MCP 映射
│   └── m6-5/runtime-readiness      #   runtime readiness 检查
│
└── m7/compatibility-release        # M7：兼容与发布
    ├── m7-1/os-matrix              #   macOS/Windows 集成矩阵
    ├── m7-2/version-contract       #   OpenCode 版本契约测试
    ├── m7-3/stress-recovery        #   大会话与异常中断测试
    ├── m7-4/install-docs           #   安装包、README、故障排查
    └── m7-5/sqlite-fallback        #   可选 SQLite fallback 评估 [P2]
```
