# OpenCode 协议兼容性检测

版本清单记录已验证的基线，不再把清单外版本一律视为不兼容。TRAE 来源解析仍受独立的
精确版本约束，本规则只改变 OpenCode 目标端。

## 准入规则

| 情况 | 处理 |
| --- | --- |
| v2 `2.0.12` / `2.0.16` 或 v1 `1.17.9` / `1.18.32`，协议完全匹配 | 沿用已验证的原生行为 |
| 其他稳定 1.x / 2.x，或 schema 存在兼容增量，CLI 与服务版本一致 | 协议分析通过后执行隔离往返验证，通过才获得迁移资格 |
| 清单外版本且 CLI / 服务版本不同 | 拒绝，要求提供与目标服务同版本的 CLI |
| 预发布、无法解析或未实现的主版本 | 拒绝，不猜测协议 |
| 必要路由缺失、schema 存在破坏性变化或隔离验证失败 | 拒绝写入 |

版本号只用于选择候选规则和记录诊断，不代表协议兼容。v1/v2 的版本探针、OpenAPI
位置、必要操作、请求/响应 envelope、schema profile 和 CLI transfer 方式集中声明在
`protocol-rules.ts`；能力探测不再分别硬编码两套流程。

## Schema 兼容性分析

工具先抽取迁移可达的 schema，再相对基线做有方向的兼容分析：

| 变化 | 结果 |
| --- | --- |
| 规范化结构完全相同 | `exact` |
| 封闭对象新增非必填字段、`enum` / `anyOf` 增加候选、注释或集合顺序变化 | `compatible`，必须继续隔离往返 |
| 字段删除、类型变化、必填集合变化、枚举收窄、`oneOf` 扩展或未知验证约束 | `incompatible`，拒绝写入 |
| 不相关路由或不可达 schema 变化 | 不影响判定 |

这里的 `compatible` 只表示当前 mapper 产生的数据仍是安全候选，不表示已经获得写入资格。
新增字段可能被服务端投影到回读数据，因此必须用同版本 CLI 实际导入和回读；基线版本只要
不再是 `exact`，也不能绕过这一步。`schemaHash` 记录实际可达数据 schema，
`protocolHash` 另行绑定规则、必要操作、envelope 和数据 schema，防止验证期间只改变
接口封装而绕过重验。

## 隔离验证

工具使用已安装的同版本原生可执行文件，不自动下载或修改 OpenCode。验证环境具有独立的
用户目录、配置、数据、缓存、状态目录及数据库；不继承用户插件、模型凭据和项目配置。
临时服务仅监听回环地址，使用随机口令。

用仓库随包提供的人工合成会话，执行：

1. 导入并核对 text、reasoning、工具记录、顺序及 metadata。
2. 原生导出和回读对账。
3. 重复导入冲突检查。
4. 父子会话关联、子会话列表和父会话删除保护。
5. 错误 hash 拒删、正确 hash 删除及删除后的不存在检查。
6. v2 长历史 compaction checkpoint 的导入与 HTTP 回读。

这些会话只进入临时库。成功或失败后关闭临时服务并删除临时目录。验证期间实际目标服务
若改变版本、规则、操作 envelope 或 schema，结果失效；用户目标不会因为隔离测试通过就
跳过再次检查。

成功证据只缓存在当前 transport 实例内。可执行文件路径、文件标识/修改时间或契约变化会
触发重验；不会跨进程持久化“允许写入”标记。批量迁移的不同 CLI 子进程可能分别验证。

隔离验证证明所覆盖行为在当前二进制上成立，不能代替每个真实会话的映射和回读检查。
所有真实导入继续逐项核对，覆盖与回滚继续要求所有权、原始完整 hash 和子会话范围匹配。

## 使用方式与诊断

继续使用：

```sh
npm run migrate:local
```

不需要 `--force` 或跳过校验开关。终端区分“已验证版本，协议检查通过”和
“兼容性检测通过（协议及隔离往返）”。

底层 `doctor --server ... --json` 和 `migrate --dry-run --server ... --json` 的
`compatibility` 可能为：

| 值 | 含义 |
| --- | --- |
| `verified-release` | 基线版本且实际协议与 schema 完全匹配 |
| `isolated-roundtrip` | 未收录版本或兼容 schema 增量的隔离行为验证通过 |
| `protocol-only` | 协议匹配，但同版本 CLI 或隔离验证条件未满足；`writable=false` |
| `unsupported` | 版本格式、协议或 schema 未通过 |

这些只读命令不会修改用户目标，但可能在临时库执行合成会话测试。应检查 `writable` 与
`reasons`，不要仅根据进程退出码或 `nativeImport` 字段判断是否可迁移。

- `T2O_OPENCODE_COMPATIBILITY_BINARY_REQUIRED`：通过 `--binary` 或交互式迁移的
  `T2O_OPENCODE_BINARY` 指定与目标服务同版本的原生 CLI。
- `T2O_OPENCODE_COMPATIBILITY_UNVERIFIED`：隔离验证未通过；使用已验证基线，或提交
  不含会话正文的版本、系统和错误码。
- `T2O_OPENCODE_SCHEMA_UNSUPPORTED`：当前 adapter 无法证明此 schema 兼容，仍拒绝。
- `T2O_MIGRATION_TARGET_CHANGED`：隔离验证期间目标发生变化，或续跑证据不再匹配。

manifest 保留实际版本号和 schema hash。读取 manifest 本身不授予目标写入权限；续跑时
仍会重新检查兼容性，以及目标所有权和完整内容 hash。

## 独立验证本机 OpenCode

| 命令 | 用途 |
| --- | --- |
| `npm run verify:opencode` | 日常兼容性检查，自动识别本机 OpenCode v1/v2 |
| `npm run verify:integration:v1` | 开发 / CI 的 v1 专项集成回归，覆盖迁移、续跑、冲突与回滚 |

无需启动 TRAE 或现有 OpenCode 服务：

```sh
npm run verify:opencode
npm run verify:opencode -- --binary /path/to/opencode --output tmp/my-opencode-check
npm run --silent verify:opencode -- --json
```

命令复用迁移的 `requireOpenCodeCapabilities` 与隔离往返场景，不维护另一份版本清单。
稳定 v1/v2 先检查实际版本、路由和完整 schema，再执行原生导入导出、回读、重复导入
保护、父子会话关联、删除保护及 v2 compaction 回读。基线版本也会完整执行这些场景。
`--binary` 优先于集成测试使用的 `T2O_TEST_OPENCODE_BINARY`，未设置时从 PATH 解析
`opencode`，Windows 同样支持 npm 垫片解析。

默认终端显示实际版本和简洁结果。`--json` 输出单行 JSON，失败保留 `T2O_*` 错误码与
对应非零退出码；非法命令参数返回 `2`。成功报告位于 `tmp/opencode-roundtrip/report.json`，
可通过 `--output` 修改目录：

| 产物 | 内容 |
| --- | --- |
| `report.json` | `reportVersion: 3`、实际版本、规则、协议/schema hash、兼容分析和已通过的检查 |
| `transfer.schema.json`（v2） | 从私有服务抽取的可达 transfer schema |
| `session.schema.json`（v1） | 从私有服务抽取的 Session/Message/Part schema |

报告不含会话正文、随机会话 ID、服务口令或临时路径。退出码 `0` 表示本次合成映射
场景全部通过；真实会话仍需独立映射和回读。失败不会生成本次成功报告；若重复使用
输出目录，应同时检查退出码与已有报告的 `checkedAt`。

[M0 历史报告](m0-4-import-roundtrip.md) 的未完成 assistant 丢失实验保持归档，
不再由此命令重跑。新版使用随包提供的合成 IR，通过生产 mapper 生成各方言输入。

## 验证记录

2026-09-26，macOS / Node 18.20.8：

- 范围：候选版本识别、协议准入、原生写入保护、manifest 与续跑，以及隔离测试生命周期。
- 缺陷分析：初始版本门禁会在协议检查之前拒绝新版本，manifest 也只接受固定版本。
  实现过程中由回归验证发现并修正了 CLI 参数校验顺序和合成子会话的来源关系。
- 生成用例：新增 10 项单测，覆盖未收录版本准入、schema-only 拒写、验证失败、
  验证期间目标变化、未知版本持久化/续跑及已有目标内容保护；更新旧错误码预期。
- 验证结果：446 项单测、lint、TypeScript、构建及 smoke 通过。

原生二进制使用人工合成来源，未迁移用户私人会话：

| 版本 | 验证结果 |
| --- | --- |
| v2 `2.0.11`（不在基线清单） | 隔离准入、目标库无测试数据、migrate、verify、resume、rollback 通过 |
| v2 `2.0.12` / `2.0.16` | 原有协议、混合连接与 compaction HTTP 回读通过 |
| v1 `1.18.31`（不在基线清单） | 隔离准入、原生导入导出、manifest、verify、resume、冲突与 rollback 通过 |
| v1 `1.17.9` / `1.18.32` | 原生导入导出及回读通过；`1.17.9` 另验证 resume |

CI 已配置三系统的 v2 `2.0.12` / `2.0.11` 与 v1 `1.18.32` / `1.18.31` 验收。
本机记录不代替 Windows/Linux 的 CI 结果，也不代表任意来源状态或用户路径都能无损映射。

### 公开验证命令回归（2026-09-26）

- 范围：`verify:opencode` 入口、迁移共用的隔离场景、命令参数和报告输出。
- 缺陷分析：旧入口仍断言 `2.0.12`，导致迁移可用的 `2.0.18` 在此命令中失败。
  已移除独立的版本断言，复用协议检查与隔离场景；历史 M0 证据保持归档。
- 生成用例：新增 9 项测试，覆盖两个方言的基线与未收录版本、报告真实版本、
  协议不匹配时拒写、证据绑定、消息丢失、版本变化、清理、参数优先级和失败退出。
- 验证结果：macOS / Node 18.20.8，455 项测试、lint、类型检查、构建、smoke、
  `verify:versions`、`verify:integration:v1` 与 `verify:package` 通过。实际运行 `verify:opencode`
  验证 `2.0.18`、`2.0.12`、`1.18.31`、`1.18.32`，四者均通过。

CI 新增三系统直接执行上述四个版本的公开命令，并上传报告和 schema。单测辅助工具
`utree flush` 已尝试，但其全局技能自更新写入被 sandbox 拒绝；此处记录实际测试结果。

### Schema 兼容分析与声明式规则（2026-09-27）

- `protocol-rules.ts` 集中描述两个协议族的版本范围、版本探针、OpenAPI 路径、
  必要操作、envelope、transfer 方式和 schema profile。
- `schema-compatibility.ts` 对基线与实际 schema 做有界、失败关闭的结构分析；
  报告只记录 schema 位置和数量，不包含目标数据。
- 完全匹配继续使用 `verified-release`；兼容增量即使出现在基线版本上，也只能在
  同版本 CLI 的隔离往返成功后使用 `isolated-roundtrip`。
- `protocolHash` 把规则、必要操作、envelope 与数据 schema 绑定到验证证据；
  验证期间任一部分变化都会触发 `T2O_MIGRATION_TARGET_CHANGED`。
- 470 项测试、lint、类型检查、版本一致性、构建和 smoke 通过。实际
  `verify:opencode` 验证 v2 `2.0.18` / `2.0.12` 与 v1 `1.18.31` / `1.18.32`；
  `verify:versions`、`verify:integration:v1` 和安装包验收通过。
