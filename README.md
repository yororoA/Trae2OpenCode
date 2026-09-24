# Trae2OpenCode

将可恢复的 TRAE 会话转换为版本化 IR，通过 OpenCode 原生导入，并逐会话核对
消息、reasoning、工具输入输出及 hash。提供只读盘点、dry-run、断点续跑和回滚。

**P0 工程与实机验收已完成并合入 main；尚未发布 npm 包。**
三端目标/打包矩阵和真实已登录 TRAE 经生产 CDP reader 到隔离 OpenCode 的
端到端验收均已通过。真实样本为准确标记的 partial 会话，覆盖 text/tool；
reasoning 的真实来源与目标往返仍由拆分证据覆盖。
具体记录见[实现规划](docs/implementation-plan.md)和
[真实来源验收报告](docs/m5-7-live-runtime-e2e.md)。

## 支持范围

| 项目 | 当前范围 |
| --- | --- |
| TRAE 来源 | TRAE CN **3.3.104**，已登录且启用本机 CDP 的 V2 renderer |
| OpenCode 写入 | **2.0.12**，CLI 与 server 版本、transfer schema 均需通过探测 |
| 相邻目标版本 | 2.0.11 已验证为准确拒写，不在兼容范围内 |
| macOS / Windows | 默认数据目录、SQLite 快照、合成 runtime → 原生目标验收通过 |
| Linux | 支持 `--input` 离线 IR 与目标链路；不支持本地 TRAE 发现 |
| Node.js | engines ≥18.18；CI 覆盖 18.20.8 / 22，建议新安装使用 22 |

默认只迁移 `complete` / `partial`。缺少已验证消息来源、assistant 真实完成时间
或目标映射证据时会阻止该会话。附件尚不提供通用复制保证；Skill/MCP 资源迁移属于
后续 M6。未知 TRAE profile 和 OpenCode 版本拒绝套用规则。

## 安装与离线 dry-run

从候选分支构建 tarball，再安装到独立目录；下列命令可逐行用于 macOS shell、
Linux shell 或 Windows PowerShell。需要 Node.js、npm、Git：

```text
git clone --branch m7/compatibility-release https://github.com/yororoA/Trae2OpenCode.git
cd Trae2OpenCode
npm ci
npm run check
npm pack
mkdir ../t2o-local
cd ../t2o-local
npm init -y
npm install ../Trae2OpenCode/trae2opencode-1.0.0.tgz
npm exec --offline -- trae2opencode --version
npm exec --offline -- trae2opencode migrate --input ./node_modules/trae2opencode/fixtures/ir/v1/valid-trae-assembled.json --dry-run --fallback-directory "$PWD" --json
```

最后一步使用包内的**合成样本**，预期 `ready=1`、`blocked=0`、`excluded=0`、
`target.probed=false`，不会连接 TRAE 或 OpenCode。它验证安装与映射，不代表真实
数据已经迁移。tarball 包含编译后的 CLI、固定契约 schema、合成样本及文档。

下文将 `npm exec --offline -- trae2opencode` 简写为 `trae2opencode`。
也可用 `npm install -g <tarball绝对路径>` 安装此本地产物。

## 一键迁移（推荐）

确认 TRAE CN 已登录并开启本机 `9222` CDP，且已安装 OpenCode `2.0.12`，然后在
项目目录执行：

```sh
npm run migrate:local
```

程序会交互式完成全部选择，不需要用户输入 workbench ID 或 session ID：

1. 列出当前可用的 TRAE workbench，按编号选择窗口。
2. 通过该窗口的 renderer 获取当前项目 ID，并分页读取与 TRAE 历史面板相同的
   会话列表；显示会话名称、元数据状态和更新时间，按编号选择会话。
3. 自动导出 bundle，并检查大小、凭据和字段完整性；消息正文或工具 payload
   中的疑似凭据会替换为 `[REDACTED_SECRET]`。
4. 自动 dry-run；无法无损映射时在写入 OpenCode 前停止。
5. 自动执行首次迁移，或发现已有 manifest 时自动续跑。
6. 自动通过 OpenCode 原生 import、回读和 hash 对账。

程序会优先使用 `http://127.0.0.1:4096`。如果默认服务未启动或当前终端无法通过
其认证，会临时启动一个仅监听 `127.0.0.1:4097` 的 OpenCode 服务，迁移结束后
自动关闭。固定备用端口确保同一 manifest 可以安全续跑。
显式设置 `T2O_OPENCODE_SERVER` 时不会自动替换该服务。

如果存在多个 workbench 或超过单 bundle 大小限制，程序会在交互界面中明确提示，
不会猜选窗口、猜选会话或静默丢失内容。迁移产物写入 `trae-export/` 和
`migration-run/` 下按所选会话区分的目录；这两个目录包含私人会话数据，不应提交到
Git。重复选择同一会话时会复用并校验对应 bundle，选择其他会话不会误用旧 bundle。
发生凭据脱敏时会输出明确提示、把恢复等级降为 `partial` 并记录
`T2O_SENSITIVE_CONTENT_REDACTED`；对账针对脱敏后的 bundle。若疑似凭据位于
session/message ID、项目路径或来源定位等不能安全改写的字段，迁移仍会停止。
TRAE 若将工具标记为 completed 但没有持久化 output，会保留该工具调用、写入明确的
缺失输出占位符并按 `partial` 迁移，不把缺失值伪装成真实输出。
若工具连开始时间也未持久化，其原始记录会保存在消息
`metadata.trae2opencode.deferredContent` 中，不会把内部 JSON 显示成聊天正文。
若某轮没有持久化最终 assistant 正文，会显示明确的缺失提示，不会拿过程推理或
工具结果冒充最终回答。

成功校验后会保留当前会话最新的 bundle 和 manifest：bundle 用于稳定续跑及重新
映射，manifest 用于 verify、rollback 和受保护替换。属于同一来源会话、已被当前
verified 版本取代的旧终态目录会自动清理；失败、进行中、无效或显式指定路径的产物
不会自动删除。

## 从 TRAE 导出

先执行 `trae2opencode doctor --json`。默认发现位置：

- macOS：`~/Library/Application Support/Trae CN/User`，随后尝试 `Trae/User`。
- Windows：`%APPDATA%`、`%LOCALAPPDATA%` 下的 `Trae CN/User` 与 `Trae/User`。
- 自定义目录用 `--trae-root <产品数据目录或User目录>`，自定义安装用
  `--product-file <TRAE CN安装目录中的product.json>`。

读取消息正文需要已登录的 TRAE renderer。保存工作并自行完全退出 TRAE 后，
从 macOS 系统“终端”直接启动应用主程序；`open -a ... --args` 在当前版本可能
丢弃调试参数：

```sh
"/Applications/Trae CN.app/Contents/MacOS/Electron" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222
```

Windows 在 TRAE CN 安装目录的可执行文件后加同样两个参数。确认历史会话可见，
再运行以下命令；工具不会替你重启应用：

```text
trae2opencode scan --cdp http://127.0.0.1:9222 --json
trae2opencode preview --cdp http://127.0.0.1:9222 --session <源会话ID> --json
trae2opencode export --cdp http://127.0.0.1:9222 --session <源会话ID> --output ./trae-export --json
```

有多个 workbench 时，从 `http://127.0.0.1:9222/json/list` 获取所需窗口的 `id`，
额外传 `--cdp-target <id>`。只接受显式 loopback HTTP 地址和端口。
不传 `--cdp` 仍能盘点元数据，但不能据此宣称正文可恢复。

底层 `export` 默认遇到疑似凭据即拒绝。仅对实时 TRAE 导出，可显式增加
`--redact-credentials`，将标题、消息正文和工具 payload 中的已识别凭据替换为
占位符；无法可靠定位具体值的命令行或编码文本会整体替换为占位符。
`npm run migrate:local` 已自动启用该选项。

`scan` / `preview` 只输出数量、ID、hash 和诊断码。导出的
`trae-export/migration-bundle.json` **包含私人正文**；输出目录必须不存在，
其父目录必须已存在。源数据库使用一致性只读快照，不修改源会话。

## 迁移、对账与续跑

安装固定目标版本；安装包名称是 `@opencode/cli`：

```text
npm install -g @opencode/cli@2.0.12
opencode --version
opencode serve --hostname 127.0.0.1 --port 4096
```

将 server 保持运行，在另一终端执行。先用 dry-run 检查 `ready/blocked/excluded`
和诊断码，再执行导入：

```text
trae2opencode migrate --input ./trae-export/migration-bundle.json --dry-run --server http://127.0.0.1:4096 --fallback-directory "$PWD" --json
trae2opencode migrate --input ./trae-export/migration-bundle.json --server http://127.0.0.1:4096 --fallback-directory "$PWD" --output ./migration-run --json
trae2opencode verify --manifest ./migration-run/migration-manifest.json --server http://127.0.0.1:4096 --json
```

原项目存在时沿用该项目；否则 `--fallback-directory` 指定现有目录的绝对路径
（`"$PWD"` 在上述 shell / PowerShell 中表示当前目录），
或用 `--path-map <源绝对根路径=目标绝对根路径>` 精确映射。路径含空格需整体加引号。
不会自动创建项目目录。目标可执行文件可通过 `--binary <原生可执行文件绝对路径>`
指定，Windows 使用安装目录中的 `bin/opencode.exe`，避免 `.cmd` shim。

若 server 设置了认证，在运行 CLI 的终端提供同一
`OPENCODE_SERVER_PASSWORD`，可选 `OPENCODE_SERVER_USERNAME`；凭据不放进 URL。
迁移会执行原生 import，再完整回读对账。重复迁移默认跳过已有目标 ID。
查看 `hasFailures` 与逐会话状态，不将 `skipped/excluded` 计为本轮导入。

中断后保留同一 IR、同一 server 数据和端口、同一映射/筛选参数，以原 manifest 续跑：

```text
trae2opencode migrate --input ./trae-export/migration-bundle.json --server http://127.0.0.1:4096 --fallback-directory "$PWD" --resume ./migration-run/migration-manifest.json --json
```

manifest 不含消息正文，不能独立恢复数据。替换旧的工具会话需旧 manifest、未改变
的完整回读 hash 和显式独占声明，见[替换规则](docs/m5-4-idempotency-replacement.md)。

## 回滚

默认只预览本轮可删除的会话：

```text
trae2opencode rollback --manifest ./migration-run/migration-manifest.json --server http://127.0.0.1:4096 --json
```

核对预览中的 `runId` 和范围，暂停其他目标写入者后，用
`--confirm <runId> --exclusive-target` 执行。回滚保护已改变的内容和外来子会话；
开始后该 manifest 不再允许迁移续跑。替换前的旧内容没有备份，不能靠回滚恢复。
详见[回滚与恢复](docs/m5-5-rollback.md)。

## 开发与验证

```text
npm ci
npm run check
npm run verify:package
```

`check` 执行 lint、单元测试、类型检查、构建和 CLI smoke。
`verify:package` 从 tarball 安装到隔离目录，验证 bin、schema、离线 dry-run 和
导出再读取。三系统 CI 的两个 Node 版本均执行安装验收；Node 22 另执行原生
目标、相邻版本拒写及 512 MiB 堆下的大会话/真实进程中断恢复。

## 文档

- [实现规划与验收矩阵](docs/implementation-plan.md)
- [安装与迁移故障排查](docs/troubleshooting.md)
- [IR v1](docs/ir-schema-v1.md)、[Golden fixture](docs/golden-fixtures.md)
- [只读 CLI / CDP](docs/m5-1-readonly-cli.md)、[dry-run](docs/m5-2-dry-run.md)
- [manifest 与续跑](docs/m5-3-manifest-resume.md)、[凭据边界](docs/m5-6-sensitive-content.md)
- [真实来源端到端验收步骤](docs/m5-live-runtime-acceptance.md)
- [真实来源端到端验收报告](docs/m5-7-live-runtime-e2e.md)
- [跨平台矩阵](docs/m7-1-platform-matrix.md)、[版本契约](docs/m7-2-version-contract.md)
- [压力与中断恢复](docs/m7-3-resilience.md)、[打包验收](docs/m7-4-package-installation.md)
- [TRAE 消息来源](docs/m0-3-source-location.md)、[OpenCode 投影限制](docs/m0-4-import-roundtrip.md)
- [运行时回读决策](docs/adr/0006-runtime-readback-fail-closed.md)
- [开发环境故障排查](docs/development-troubleshooting.md)
