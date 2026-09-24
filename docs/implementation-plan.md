# Trae2OpenCode 实现规划

> 状态：P0（M0 至 M5、M7-1 至 M7-4）已完成并合入 `main`
> 核验日期：2026-09-24
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
| M2 路径发现 | 已集成 | M2 通过 PR #13 合入 `main` |
| M2 workspace 解析 | 已集成 | 已实现 folder/workspace URI、JSONC multi-root 和逐记录诊断 |
| M2 SQLite 快照 | 已集成 | 已实现 Online Backup、WAL 一致性、完整性校验和自动清理 |
| M2 能力探测 | 已集成 | 已输出 storage profile、字段覆盖率和 runtime adapter 状态 |
| M2 recovery grading | 已集成 | 已实现逐会话四级分级、稳定缺失原因和 metadata session discovery |
| M3 TRAE 读取 | 已集成，PR #14 | 已实现各类 parser、profile 注册、IR 组装与完整性/golden 校验；production runtime bridge 在 M5 实现 |
| M4 OpenCode adapter | 已集成，PR #15 | 能力探测、IR 映射、稳定 ID、CLI adapter、路径映射与完整对账；五组 macOS 隔离实机通过 |
| M5 迁移编排 | 已集成，PR #16 | 编排、安全能力与已登录 renderer → 隔离 OpenCode 端到端验收通过 |
| M6 资源迁移 | P1，未开始 | Skill/MCP 发现、建议配置与复制可独立发布 |
| M7 兼容与发布 | 已集成，PR #17 | 三系统六任务、当前/相邻版本契约、真实中断与 tarball 安装/dry-run CI 全部通过 |

P0 工程与实机验收已完成：除合成来源到真实 OpenCode 的三平台矩阵外，
已登录 TRAE 经生产 CDP reader 导出、原生导入、回读、resume 和重复跳过均通过。
真实可写样本为 partial，覆盖 text/tool；reasoning 为 M0 真实来源与 M4/M7
目标往返的拆分证据，不宣称单一实机会话整链覆盖。P0 已集成到 main；
尚未发布 npm 包。

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
- 默认不修改 TRAE 数据，不复制凭据。底层 CLI 默认不覆盖 OpenCode 现有会话；
  一键迁移仅在旧 manifest 可验证、目标内容未变化且用户明确确认独占写入后安全覆盖。

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
- `rollback`：只预览本次新建会话；执行需精确 run ID 和显式独占声明。

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

#### M1 完成明细

| 任务 | 交付提交 | 集成 PR | 核心结果 | 完成时测试数 |
| --- | --- | --- | --- | ---: |
| M1-1 | `f76d031`、`69434d8` | #7 | CLI、lint、CI 和统一质量门禁 | 35 |
| M1-2 | `89ed76a` | #8 | IR v1、JSON Schema 和运行时校验 | 40 |
| M1-3 | `214c8af` | #9 | 错误码、diagnostic 和脱敏结构化日志 | 48 |
| M1-4 | `74ea549` | #10 | deterministic golden fixture 框架 | 51 |

M1-1 建立了可发布的 TypeScript CLI 骨架：

- 增加 `trae2opencode` 可执行入口、参数解析、帮助和版本输出。
- `doctor`、`scan`、`preview`、`export`、`migrate`、`verify`、`rollback`
  在实现前明确 fail closed，不会误执行未完成的迁移流程。
- 使用 Biome 建立 lint 门禁，并将 lint、test、typecheck、build、CLI smoke
  合并为 `npm run check`。
- 增加 GitHub Actions `Quality` workflow，使用 Node.js 20 和 `npm ci` 执行
  同一本地质量门禁。
- 固定公共 npm registry，验证打包后的 bin 具有可执行权限。

M1-2 固化了后续 scanner、reader 和 OpenCode adapter 共用的
`MigrationBundle` v1 契约：

- 定义 source、project、session、user/assistant event、text/reasoning/tool
  content、resource 和 diagnostic 类型。
- session、event、assistant content 和 resource 强制携带 `sourceRefs`，记录
  workspace storage ID、源 session ID、locator、parser profile 和 SHA-256。
- JSON Schema 使用 Draft 2020-12，对已知对象执行
  `additionalProperties: false`，未知源字段不能被静默接受。
- 提供 `validateMigrationBundle` 和 `assertMigrationBundle` 运行时接口，以及
  checked-in 独立 Schema、合法/非法 fixture 和同步检查。
- `unknown` 恢复或工具状态只允许进入离线 IR，不自动获得 OpenCode 写入资格。
  完整契约见 [Migration Bundle IR v1](./ir-schema-v1.md)。

M1-3 统一了可供 CLI 和后续模块复用的错误与诊断边界：

- 建立稳定的 `T2O_*` 错误码与退出码，调用方无需解析英文 message。
- Schema issue 转换为可定位的 IR diagnostic，只包含 instance/schema path、
  keyword 和安全 message，不回显被校验正文。
- CLI `--json` 使用 JSON Lines 输出机器可读错误；未知异常统一转换为
  `T2O_INTERNAL_UNEXPECTED`。
- 日志 context 采用字段白名单；正文、query、reasoning、tool input/output、
  payload、token、credential 和绝对用户路径默认脱敏。
- 详细约束见 [错误、诊断与结构化日志](./error-diagnostics.md)。

M1-4 建立了 IR 变更的显式评审门禁：

- `canonicalizeMigrationBundle` 先执行 Schema 校验，再递归排序对象 key；消息、
  content block 和 resource 数组保持原始顺序。
- golden manifest 同时记录 Schema hash、bundle hash、输入路径和期望输出路径；
  即使只改变可选 Schema 字段，也会触发 CI 漂移。
- `npm run golden:check` 只读比较，不会自动覆盖期望结果。
- `npm run golden:update -- --accept` 是唯一更新入口；缺少 `--accept` 时以退出码
  2 拒绝写入，确保 IR 变化必须产生可审查 diff。
- 详细流程见 [IR Golden Fixture 工作流](./golden-fixtures.md)。

M1 里程碑分支最终通过 PR #11 合入 `main`，合并提交为 `4a9219d`。退出时
51 项单元测试、lint、TypeScript typecheck、build 和 CLI smoke 全部通过。
M1 只完成工程骨架与数据契约，不表示生产 scanner、runtime reader 或真实迁移
已经可用。

#### M2 完成明细

| 任务 | 交付提交 | 集成状态 | 核心结果 | 完成时测试数 |
| --- | --- | --- | --- | ---: |
| M2-1 | `47549eb` | PR #12 已合入 | macOS/Windows 路径发现、`--trae-root` 覆盖和稳定错误码 | 66 |
| M2-2 | `969facb` | 直接提交 `m2/trae-scanner` | folder/workspace URI、JSONC multi-root、跨平台路径规范化和逐记录诊断 | 78 |
| M2-3 | `31a569e` | 直接提交 `m2/trae-scanner` | SQLite Online Backup、WAL 一致性、`quick_check`、快照权限和自动清理 | 83 |
| M2-4 | `5571a67` | 直接提交 `m2/trae-scanner` | storage profile、字段覆盖率和 runtime adapter 能力探测 | 89 |
| M2-5 | `74a2bc4` | 直接提交 `m2/trae-scanner` | metadata session discovery、四级 recovery grading 和稳定缺失原因 | 98 |

M2-1 建立了独立于 M0 fixture collector 的生产路径发现器：

- 默认支持 macOS `~/Library/Application Support/Trae CN/User` 和 fallback
  `Trae/User`。
- Windows 支持 `%APPDATA%`、`%LOCALAPPDATA%` 及缺省推导目录。
- 显式 `--trae-root` 支持产品目录、`User` 目录和 `~` 展开，指定后不回退默认
  路径。
- 发现阶段只检查目录和能力位，不读取数据库正文；未知平台和缺失根目录使用
  `T2O_*` 错误码。

M2-2 固化了 workspace 到项目路径的解析契约：

- `workspace.json` 的 `folder` 直接映射单项目，`workspace` 指向 JSONC
  `.code-workspace` 配置。
- 支持 macOS file URI、Windows drive URI、Windows UNC URI、百分号解码和相对
  folder path。
- multi-root 项目按平台语义去重；损坏 metadata、失效配置和远程 URI 隔离为
  稳定诊断，不猜测路径。
- 实机解析到 14 个 workspace、11 个 folder、3 个 multi-root 和 25 个项目路径；
  2 个失效配置、1 个缺失 metadata 被保留为诊断。

M2-3 建立了运行中 TRAE SQLite 的一致性只读快照：

- 源库使用只读连接和 connection-local `query_only`，通过 Online Backup 生成
  独立快照，不复制主库/WAL 文件、不执行 checkpoint。
- 临时快照固定为 `0700` 目录、`0600` 数据库，转换为 standalone `DELETE`
  journal，`quick_check` 失败则 fail closed。
- callback 成功、失败和重复 cleanup 均有覆盖；缺失/损坏源和快照失败使用稳定
  `T2O_*` 错误码。
- 真实 TRAE 快照为 2,248,704 bytes、549 页、`quick_check=ok`；源主库与 WAL
  SHA-256 均未变化。

M2-4 将存储结构能力与消息运行能力分开探测：

- 3.3.104 且 `ItemTable(key,value)` 有效时标记 `trae-cn-workspace-v3` 为
  `verified`；旧 memento、hybrid 和未知版本保持 `unverified`/`unsupported`。
- 只检查 key 存在和 JSON 容器形状，不把 session ID、输入历史、Agent map 或
  其他数据库值写入报告。
- runtime profile `trae-cn-runtime-v2` 可以保持 evidence `verified`，但未接入
  production runtime adapter 时字段必须是 `requires-runtime`。
- 实机发现 16 个 workspace、解析 15 个，其中 15 个为 verified v3；session
  index 14/15 可用，invalid 字段为 0，报告无绝对路径。

M2-5 建立了逐会话恢复分级和可复用证据接口：

- `complete` 要求 verified profile、消息数、user text、assistant content、
  completion time 和 reply relation 全部覆盖。
- `partial` 允许存在明确缺口，但必须有可用结构化消息源及部分 user/assistant
  内容。
- 只能恢复 session metadata 时标记 `metadata-only`；源损坏且无法恢复时标记
  `unrecoverable`。
- 从 `ai-chat-v2.lastActiveSessionId` 和
  `chat.ChatSessionStore.index.entries` 发现并稳定排序 session ID；未来 M3
  runtime reader 通过 provider 注入逐会话消息证据。
- 实机发现 10 个 session；在 production runtime adapter 尚未接入时，10 个均为
  `metadata-only`，没有误报为 `partial` 或 `complete`。

M2 最终累计 98 项单元测试、lint、TypeScript typecheck、build、CLI smoke 和
实机脱敏验证均通过。M2 只读 scanner 已具备可审计的路径、workspace、SQLite、
能力和恢复等级基础，但 production runtime reader、正文标准化和真实迁移仍未
实现。M2 已通过 PR #13 合入 `main`，合并提交为 `eea2311`。

#### M2 当前进展

1. M2-1 已通过 PR #12 合入里程碑分支：支持 macOS/Windows 默认路径与显式
   `--trae-root`。详细契约见
   [M2-1 路径发现](./m2-1-path-discovery.md)。
2. M2-2 已完成 workspace 与项目路径解析，详细契约见
   [M2-2 Workspace 解析](./m2-2-workspace-resolution.md)。
3. M2-3 已完成 SQLite 一致性只读快照，WAL 与真实 TRAE 数据库验证均通过，
   详细契约见 [M2-3 SQLite 快照](./m2-3-sqlite-snapshot.md)。
4. M2-4 已完成 storage profile 与字段覆盖率探测，详细契约见
   [M2-4 能力探测](./m2-4-capability-probe.md)。
5. M2-5 已完成会话级 recovery grading；当前实机发现的 10 个 session 因
   production runtime adapter 尚未接入而全部明确标记为 `metadata-only`。
   详细契约见 [M2-5 恢复等级](./m2-5-recovery-grading.md)。
6. M2 里程碑任务已全部完成。后续将 M0 renderer 探针替换为 production runtime
   adapter；探针、日志和数据库解密
   均不得成为生产数据源。

#### M3 当前进展

1. 已从最新 `main` 建立并推送 `m3/trae-parser`；M3 子任务继续直接提交到
   里程碑分支，commit scope 使用 `m3-*`。
2. M3-1 已实现 `readTraeSessionMetadata`，从 workspace active session、
   workspace session index 与 `ModularData/ai-agent/snapshot` 合并候选会话。
3. M3-1 已实现 `parseTraeRuntimeSessionMetadata`，兼容 3.3.104 当前
   `chat/get_sessions` 与 V2 session metadata 的 ID、标题和时间字段。
4. runtime metadata 优先于 workspace 缓存；同优先级冲突、非法时间和时间倒序
   均产生稳定诊断，不补造标题或时间。
5. 实机只读发现 62 个去重候选，其中 61 个来自 snapshot、10 个来自 workspace
   active-session；当前 workspace session index 没有 metadata entry。未接入
   runtime provider 时，62 个会话均明确标记为 metadata `partial`。
6. M3-2 已实现 `parseTraeRuntimeUserMessages`，严格校验 user 身份、顺序和
   时间；正文优先来自 `content` text block，仅在 parsed query 含明确文本时
   回退。
7. M3-2 已通过 M2-3 快照读取
   `icube-ai-agent-storage-input-history`，按规范化内容去重并保留每个
   workspace 原记录 hash，不将无 session ID/时间的缓存关联到会话。
8. 实机 10 个 workspace 的 511 个 cache occurrence 全部通过严格解析，去重为
   477 条，保留 511 个来源引用，未产生解析诊断。
9. M3-3 已实现 `parseTraeRuntimeAssistantMessages`，严格校验 assistant 身份、
   turn/reply、顺序、状态与真实时间，并按已验证的 general、proposal 和 chat
   语义投影正文；chat / solo agent 的全部非空 plan thought 作为进度正文按顺序
   保留，最终 summary 随后输出，`reasoning_content` 仍留给 M3-4。
10. M3-3 已实现 `scanTraeLongTextResources`，只接受严格三级 UTF-8 `.txt`
    布局；query cache 关联必须精确命中同一 workspace 的 long-text 路径，不按
    basename、scope、entry ID 或内容 hash 猜测归属。
11. 当前实机只读扫描 22 个 long-text 资源和 479 条去重 cache entry，7 个精确
    引用落到 3 个资源；其余 19 个资源保留 metadata 并产生 unassociated warning，
    非孤立资源诊断与绝对路径泄漏均为 0。
12. M3-3 不等于 production runtime bridge 已完成。M3-4、M3-5 仍需实现
    reasoning/plan 与 tool 状态机；当前累计 127 项单元测试。
13. M3-4 已完成持久化 reasoning 与 plan 来源解析，空值不补造、冲突 ID
    fail closed；已映射为 chat / solo agent 进度正文的 thought 不重复进入
    reasoning，其他 task thought 仅保留 hash/长度与诊断。详见
    [M3-4 验证](./m3-4-reasoning-plan.md)。
14. M3-5 已完成按 call ID 的工具终态归并、payload 保留、冲突拒绝和孤儿诊断。
    非空错误 payload 明确标记待内容验证；累计 142 项测试，详见
    [M3-5 验证](./m3-5-tool-calls.md)。
15. M3-6 已完成图片、文件和长文本资源解析，记录 hash/MIME/缺失与待解析状态，
    修正长文本根符号链接与文件字段兼容。实机发现 134 个可读本地资源，缓存
    不推断会话归属；累计 153 项测试，详见 [M3-6 验证](./m3-6-resources.md)。
16. M3-7 已完成产品版本/profile ID/修订号精确匹配、统一能力门禁及 parser
    分派；旧 profile 无解析资格，runtime 可用性独立判断。累计 165 项测试，
    详见 [M3-7 验证](./m3-7-parser-registry.md)。
17. M3-8 已完成 IR 组装、来源指纹、交错内容排序、ID/order/reply/父图完整性
    检查及保守分级；新增 parser-to-IR golden，累计 186 项测试。本机 62 个
    会话仍为 metadata-only，详见 [M3-8 验证](./m3-8-ir-assembly.md)。
18. M3 已通过 PR #14 合入 `main`，合并提交为 `cb3af1e`；里程碑 push 与
    PR CI 均通过。后续开发进入 `m4/opencode-import`。

### M1：工程骨架与 IR，2-3 天

| ID | 任务 | 依赖 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| M1-1 | 完善 TypeScript CLI 入口、lint、test、build | M0-5 | CLI 可执行，本地和 CI 可检查与构建 | 已完成并集成 |
| M1-2 | 定义版本化 IR 和 JSON Schema | M0-5 | 合法/非法 fixture 校验覆盖 | 已完成并集成 |
| M1-3 | 统一错误码、诊断和结构化日志 | M1-1 | CLI 错误可定位且正文不泄露 | 已完成并集成 |
| M1-4 | 建立 golden fixture 测试框架 | M1-1, M1-2 | IR 变化必须显式更新 golden | 已完成并集成 |

### M2：TRAE 扫描与恢复等级，3-5 天

| ID | 任务 | 依赖 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| M2-1 | macOS/Windows 路径发现器 | M1-1 | 支持默认路径和 `--trae-root` | 已完成并集成 |
| M2-2 | workspace 与项目路径解析 | M2-1 | folder/workspace URI 均可规范化 | 已完成 |
| M2-3 | SQLite 一致性只读快照 | M2-1 | TRAE 运行时扫描也不写源库 | 已完成 |
| M2-4 | 数据源能力探测器 | M2-2, M2-3 | 输出 storage profile 和字段覆盖率 | 已完成 |
| M2-5 | 会话级 recovery grading | M2-4 | 每个会话都有等级和缺失原因 | 已完成 |

### M3：TRAE Parser 与 IR 标准化，6-10 天

| ID | 任务 | 依赖 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| M3-1 | 会话索引、时间、标题解析 | M2-4 | 顺序稳定，缺失字段有诊断 | 已完成 |
| M3-2 | 用户消息与查询缓存解析 | M3-1 | 去重且保留来源 hash | 已完成 |
| M3-3 | assistant 文本与 long-text 关联 | M0-3, M3-1 | 不按文件名猜测错误归属 | 已完成 |
| M3-4 | reasoning/plan 解析 | M0-3, M3-1 | 仅映射实际持久化内容 | 已完成 |
| M3-5 | tool call/result 状态机归并 | M0-3, M3-1 | call/result 一一关联，孤儿项有告警 | 已完成 |
| M3-6 | 图片、文件和长文本附件解析 | M3-2 | 缺失文件、mime、hash 均有记录 | 已完成 |
| M3-7 | profile 解析器注册表 | M3-1..6 | 未验证或未知版本拒绝静默套用规则 | 已完成 |
| M3-8 | IR 排序、去重与完整性校验 | M3-1..7 | golden fixture 全部通过 | 已完成 |

### M4：OpenCode 原生导入，4-6 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M4-1 | 版本与 OpenAPI capability probe | M1-1 | 已完成：双端版本、import/export 封装及可达 schema 严格校验 |
| M4-2 | IR -> `SessionTransfer.Data` 映射 | M1-2, M0-4 | 已完成：可映射联合类型通过 schema，未验证 error/unknown 拒写 |
| M4-3 | 稳定 ID 与父子依赖排序 | M4-2 | 已完成：内容更新 ID 稳定，父先于子，缺父/环/重复拒绝 |
| M4-4 | 原生 CLI import adapter | M4-1..3 | 已实现并通过 macOS 实机；Windows 无 shell 参数路径待 M7 矩阵验证 |
| M4-5 | 项目目录与不存在路径策略 | M4-2 | 已完成：默认保留原路径，显式 path map/fallback，不自动创建目录 |
| M4-6 | 导入后 export/readback 对账 | M4-4 | 已完成：数量、顺序、类型、metadata 与 hash；只允许已确认的 session 投影差异 |

OpenCode import 是实验性能力。M4-6 必须验证实际导入结果，不能只依赖 HTTP 200；
当前探测已证明形状不正确的消息可能没有进入最终投影。

M4-1 已通过 macOS OpenCode 2.0.12 实机验证，新增 21 项测试，累计 207 项。
探测不创建会话，未知版本/schema 继续 fail closed。详细契约和验证见
[M4-1 能力探测](./m4-1-opencode-capability.md)。

M4-2 已实现有来源门禁的纯映射，新增 13 项测试，累计 220 项。实机隔离
import/export 的 2 条消息、5 个内容块及 metadata 均完整回读；工具 JSON 输出
保留编码/hash，缺少完成时间和未验证错误继续拒写。详见
[M4-2 映射验证](./m4-2-opencode-mapping.md)。

M4-3 已实现版本化稳定 ID 和非递归父链排序，新增 6 项测试，累计 226 项。
12,000 层父链、源更新、namespace 隔离均通过。详见
[M4-3 稳定身份](./m4-3-stable-identity.md)。

M4-4 原生 CLI adapter 已完成，累计 233 项测试。macOS 实机 CLI/API 回读一致，
重复导入明确拒绝；详见 [M4-4 原生导入](./m4-4-native-adapter.md)。

M4-5 只读目录策略已完成，累计 240 项测试；详见
[M4-5 项目目录](./m4-5-project-directory.md)。

M4-6 已将完整回读对账接入 adapter，累计 249 项测试。五组 macOS OpenCode
2.0.12 隔离 import/export 全部 verified；详见
[M4-6 回读对账](./m4-6-readback-reconciliation.md)。

M4 已通过 PR #15 合入 `main`，合并提交为 `e80d744`；里程碑 CI 通过。

### M5：迁移编排与安全性，3-5 天

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| M5-1 | `doctor/scan/preview/export` | M2, M3 | 已实现并通过本机只读及已登录 CDP 正文端到端验收 |
| M5-2 | `migrate --dry-run` | M4 | 已实现：共享 transfer 计划、目录策略、恢复筛选与脱敏统计 |
| M5-3 | manifest、checkpoint、resume | M4 | 已实现：持久化先于写入、原子 checkpoint、失败隔离、恢复与 verify |
| M5-4 | 冲突与幂等策略 | M5-3 | 已实现：默认 skip，旧 manifest + 完整 hash + 显式独占声明保护替换 |
| M5-5 | rollback | M5-3 | 已实现：默认预览、本轮归属/hash/子会话保护、显式确认与中断恢复 |
| M5-6 | 敏感信息过滤 | M1-3 | 已实现：默认拒写；实时交互导出可对内容字段脱敏并降级为 partial，标识/路径仍拒写 |

M5-1 累计 265 项测试通过，CLI 实机发现 62 个会话、25 个项目；无 runtime 时
明确标记 metadata-only。接口与验证边界见 [M5-1 只读 CLI](./m5-1-readonly-cli.md)。

M5-2 累计 275 项测试通过；实机 dry-run 排除全部 62 个 metadata-only 会话，
未误报可导入。详见 [M5-2 dry-run](./m5-2-dry-run.md)。

M5-3 累计 292 项测试通过；隔离 OpenCode 实机已验证导入响应丢失后的恢复，
重复执行只 import 一次。详见 [M5-3 manifest/resume](./m5-3-manifest-resume.md)。

M5-4 累计 310 项测试通过；隔离实机已验证父子图默认 skip、外来子会话保护、
原生删除响应丢失后的续跑与 2 个会话完整替换。删除依赖暂停目标其他写入者的
显式声明；没有条件删除时不宣称跨进程原子保护。详见
[M5-4 幂等与替换](./m5-4-idempotency-replacement.md)。

M5-5 累计 325 项测试通过；隔离实机验证默认预览、外来子会话保护、原生删除
响应丢失后的恢复与重复回滚。回滚开始后禁止原 manifest 再次用于迁移续跑；
verify 校验已回滚 ID 不存在。详见 [M5-5 回滚](./m5-5-rollback.md)。

M5-6 累计 339 项测试通过，已覆盖已识别凭据格式、结构化字段、嵌套编码、
动态 key、日志与所有 JSON fixture。隔离实机确认凭据 transfer 未写入目标、
凭据 export 未创建目录，正常正文完整导入并对账。未知编码/无标记密码不在
检测保证内。后续交互入口增加显式内容字段脱敏：保留来源 hash、降级为 partial，
不可安全改写的标识/路径继续拒绝。详见
[M5-6 凭据边界](./m5-6-sensitive-content.md)。

M5 真实来源验收累计 344 项测试通过；已登录 TRAE CN 3.3.104 经生产 CDP
读取后，partial 会话的 4 条消息、2 个 text 和 2 个 completed tool 原生导入
OpenCode 2.0.12，expected/actual 计数和 hash 一致。resume 与重复跳过通过，
实际 import 1 次。详见 [真实端到端报告](./m5-7-live-runtime-e2e.md)。

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
| M7-1 | macOS/Windows 集成矩阵 | M5 | 已通过三系统 Node 18.20.8/22；macOS/Windows 默认源目录与三端目标链路通过 |
| M7-2 | OpenCode 版本契约测试 | M4 | 已通过：2.0.12 原生写入/回读，真实 2.0.11 准确拒写 |
| M7-3 | 大会话与异常中断测试 | M5 | 已通过三端：512 MiB 堆固定负载、两组真实 kill/resume，无重复 import |
| M7-4 | 安装包、README、故障排查 | M7-1..3 | 已通过：白名单 tarball、隔离安装/SQLite/bin/dry-run；三端六任务安装 CI 成功 |
| M7-5 | 可选 SQLite fallback 评估 | M7-2 | 当前原生 import 满足 P0，不立项 |

M7-1/2 的 CI [35930386323](https://github.com/yororoA/Trae2OpenCode/actions/runs/35930386323)
六任务成功。M7-3 的 CI
[35930884801](https://github.com/yororoA/Trae2OpenCode/actions/runs/35930884801)
六任务成功，三份平台报告已上传。M7-4 的 CI
[35932162689](https://github.com/yororoA/Trae2OpenCode/actions/runs/35932162689)
六任务成功，六份安装报告已上传。完整质量门禁累计 344 项单测。
各项范围和局限见 [平台](m7-1-platform-matrix.md)、
[版本](m7-2-version-contract.md)、[压力恢复](m7-3-resilience.md)、
[安装验收](m7-4-package-installation.md)。

P0 最后一项来源验收已使用已登录的 TRAE CN 3.3.104 workbench 完成：
生产 reader 导出、隔离 OpenCode 导入、逐消息回读、resume 与重复迁移均通过。
过程中修复了实际 workbench 路径/应用根、metadata 失败隔离、`solo_agent`
正文投影、空工具占位和跨 workspace 资源诊断归属。详见
[M5-7 报告](m5-7-live-runtime-e2e.md)。M5 PR #16 与 M7 PR #17 均已合入 main。

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
| 大型 tool result 导致内存峰值 | OOM | 当前采用大小上限及固定压力验收；流式大 bundle/sidecar 尚未实现 |

## 10. 推荐执行顺序

1. M0、M1 已完成并合入 `main`。
2. M2-1 至 M2-5 已完成，并通过 PR #13 合入 `main`。
3. M3-1 至 M3-8 已完成；进入 production runtime bridge 与 M4 原生导入。
4. 接通已验证 runtime 来源和可审计 IR，并打通真实来源到 OpenCode 的
   import/export 对账。
5. 增加批量迁移、manifest、resume 和 rollback。
6. 最后处理附件、Skill、MCP；SQLite Writer 保持为可选项。

原始 P0 估算为 20-30 个工程日。当前 M0–M7 的 P0 工程、验收与 main 集成
均已完成；M6 资源迁移保留为 P1，不按测试数量折算完成比例。

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
