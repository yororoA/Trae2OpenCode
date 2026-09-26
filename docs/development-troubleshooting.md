# 开发环境故障排查

## 2026-09-23：执行通道 transport exception

### 执行通道现象与定位

Agent 的直连 `exec_command`（包括 `Shell` 别名）在命令启动前返回：

```text
transport exception: entity not found: No such file or directory (os error 2)
```

`pwd`、`true`，不同工作目录和显式 shell 均出现相同错误。
通过代码编排工具调用本地 `RunCommand`，同一仓库内的命令可以成功执行。
因此当前证据将故障范围缩小到直连执行通道；并非 npm 脚本报错，也不是仓库
目录消失。执行实体或连接引用失效是候选原因，尚无平台内部日志证实具体根因。
此前 reload 未消除错误，不能将切换接口描述为原通道已修复。

### 执行通道暂行方案

已确认暂时使用本地 `RunCommand`，继续开发，不再反复探测故障直连通道。
Agent 可通过代码编排接口调用该工具；普通终端直接执行对应项目命令即可。

备用执行器的 PATH 曾只包含工具注入目录，缺少系统命令和用户 Node 路径。
直接调用会导致 npm 不可用、Git hook 找不到 `uname`/`mktemp`，或 push
找不到 `ssh`。使用登录 shell 加载已有环境，例如：

```sh
/bin/zsh -lic 'npm test'
/bin/zsh -lic 'npm run typecheck'
/bin/zsh -lic 'npm run build'
/bin/zsh -lic 'git push'
```

不要将某台机器的 Node 安装路径写进项目脚本，也不要跳过 Git hook。
Git 写操作、测试和构建串行执行：备用通道曾出现
`auto review target toolcall is not pending` 回执错误。
该错误不能直接证明命令未执行；重试 commit/push 前先核对 `git status`、
`git log -1` 和上游提交，避免重复写入。

### 验证结果与恢复条件

使用备用方案已验证提交 `0598c87`：19 项单元测试、TypeScript 类型检查、
构建及暂存 diff 检查通过，推送后本地与上游提交一致。
其中新增测试最初误用未安装的 Vitest，已统一为项目的 `node:test` 和
`node:assert/strict`；这是测试文件问题，与 transport 故障分开记录。

未来恢复直连通道时，应先确认最小命令能返回退出码，再验证项目命令。
在此之前保留备用方案。临时调试服务与 `.dbg/terminal-transport*` 等产物
在接受备用方案后清理，此文档保留可复用的排查结论。

## 2026-09-23：Renderer 探针被 CSP 阻止上报

### 探针现象与定位

TRAE workbench DevTools 中的只读探针可以调用 V2
`TraeApi.chat.getMessages`，但向 `http://127.0.0.1:7777/event` 上报时被
`connect-src` CSP 拒绝。该错误只影响调试报告传输，不影响已经完成的结构化回读
和 renderer 内脱敏。

异步函数中的 `copy()` 也不能稳定写入系统剪贴板；早期 fallback 因作用域错误和
V2 session store 识别错误分别出现过 `reportForFallback is not defined` 与
`current session not found`。

### 探针回传方案

探针在 renderer 内完成白名单脱敏后，将报告写入
`localStorage["trae-m0-redacted-probe"]`。再在 DevTools 顶层执行读取与复制，
避免网络请求。回传文件只允许包含 schema、计数、长度、关系和 SHA-256；必须用
`collect:trae-structured-runtime-evidence` 重新白名单化并执行隐私扫描。

该方案仅用于生成验证 fixture。生产 reader 不得依赖 DevTools、`localStorage`
或 renderer 日志，必须使用已验证 runtime adapter 或等价官方 bridge。

## 2026-09-23：提交后钩子写入被 sandbox 拒绝

### 提交钩子现象与定位

执行 `git commit` 时，Git 已创建提交并输出提交哈希，随后 TRAE 的全局
post-commit 钩子尝试写入工作区外的文件：

```text
TRAE Sandbox Error: hit restricted
Not allow operate files: /Users/bytedance/.bytesec/commit_hook/commit_result.json
```

因此命令最终退出码为 1，但 `git status` 和 `git log -1` 均确认提交已经成功。
该问题不属于仓库内 hook，也不影响后续 `git push`。

### 提交钩子处理方式

看到此错误后先核对 HEAD、工作区和上游状态，不要直接重复提交。当前 sandbox
会话中保留全局 hook，不通过 `--no-verify` 绕过检查；提交已存在时直接继续执行
后续验证与推送。若需要彻底消除误报，应在 TRAE 权限配置中显式允许该 hook
写入目标路径。

## 2026-09-23：better-sqlite3 Node ABI 不一致

### ABI 现象与定位

运行 SQLite 快照测试时，原生模块加载失败：

```text
better_sqlite3.node was compiled against NODE_MODULE_VERSION 137
This version of Node.js requires NODE_MODULE_VERSION 108
```

仓库曾在不同 Node 版本下复用同一 `node_modules`。当前测试进程为 Node.js
18.20.8（ABI 108），已有 `better-sqlite3` 二进制则由 Node.js 24（ABI 137）
安装。该错误发生在模块加载阶段，与数据库内容和快照实现无关。

### ABI 处理方式

先确认 `node` 与 `npm` 来自同一版本环境：

```sh
which node
which npm
node -p 'process.version + " ABI=" + process.versions.modules'
```

再在当前 Node 环境重建原生依赖：

```sh
npm rebuild better-sqlite3
```

重建后应先用内存数据库验证模块可加载，再运行项目测试。CI 使用固定 Node.js 20
和全新的 `npm ci`，不会复用本机其他 Node 版本编译的二进制。

## 2026-09-24：单测报告工具自更新被 sandbox 拒绝

M4-1 单测流程末尾执行 `utree flush --repo-path ...` 时，工具试图写入工作区外
的 `bits-unit-test-gen/.skill_update_*` 文件，返回 `TRAE Sandbox Error:
hit restricted`，退出码 1。该失败发生于报告工具的自更新阶段，不能据此认定
单测失败，也不能声称 flush 已成功落盘。

本次保留 sandbox 边界，不绕过权限。测试范围、分析、用例和实际验证结果记录在
仓库 `docs/m4-1-opencode-capability.md`；项目 `npm run check` 已独立成功。

## 2026-09-26：迁移通过但 verify:opencode 拒绝相同版本

本机 OpenCode 2.0.18 已通过 `migrate:local` 的协议与隔离往返检测，但
`npm run verify:opencode` 仍提示 `Only OpenCode 2.0.12 is mapped; refusing this version`。
根因是公开验证入口仍使用 M0 的固定版本实验脚本，未接入后续共用兼容性逻辑。

现已让公开命令与迁移探测共用隔离场景，并将该脚本纳入类型检查和三系统的原生命令
回归。实跑 2.0.18、2.0.12、1.18.31、1.18.32 均通过；版本号、schema 与行为检查
继续生效。遇到类似入口不一致时，应直接回归用户执行的 npm 命令，不能仅凭 adapter
测试通过判断完成。新版报告与历史 M0 证据的区别见[兼容性文档](opencode-compatibility.md)。

## 2026-09-26：Windows 同时安装 v1 桌面端和 v2 CLI 时只写入 v2

原一键入口只解析一个 `opencode` 命令并维护一组 server、binary 和 manifest。
PATH 指向 v2 CLI 时，工具会启动或连接 v2 服务，因此迁移结果只出现在 v2 数据库；
已安装但未被选作目标的 v1 桌面端不会自动同步。

现改为发现 PATH 与桌面端内置 CLI，按方言提供多选。同一份脱敏 bundle 可串行迁移到
v1、v2，每个目标独立执行协议检查、原生导入、回读和 manifest 管理。清理与 replacement
证据也按方言过滤，不能拿 v2 manifest 覆盖 v1 会话。标准安装目录无法发现时，通过
`T2O_OPENCODE_V1_BINARY` / `T2O_OPENCODE_V2_BINARY` 指定；自动化可设置
`T2O_OPENCODE_TARGETS=v1,v2`。三系统 CI 使用真实 v1/v2 二进制复用一份合成 IR 验收。
