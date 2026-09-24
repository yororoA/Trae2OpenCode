# Trae2OpenCode

把可恢复的 TRAE 会话迁移到 OpenCode，并在写入后逐项回读核对。日常使用只需要：

1. 打开要迁移会话所在的 TRAE 项目窗口。
2. 在本仓库根目录运行 `npm run migrate:local`。
3. 按编号选择窗口和一个或多个会话，等待批量迁移完成。

工具会自动导出、脱敏、检查兼容性、导入、回读核验，并在中断后安全续跑。不会要求输入
workbench ID 或 session ID。

> **首次使用请按 [操作手册](docs/operation-manual.md) 完成准备。**
> 特别是 macOS 必须从终端以调试参数启动 TRAE，否则工具无法读取完整消息正文。

## 适用范围

| 组件 | 要求 |
| --- | --- |
| TRAE 来源 | TRAE CN **3.3.104**，已登录，并以本机 CDP 端口 `9222` 启动 |
| OpenCode 目标 | **2.0.12** |
| 系统 | macOS、Windows 可直接读取本机 TRAE；Linux 只支持导入已导出的 bundle |
| Node.js | `>=18.18`，推荐 Node.js 22 |

附件、Skill 与 MCP 资源不在当前迁移范围内。未知的 TRAE 或 OpenCode 版本会被拒绝，
而不是按未经验证的规则写入数据。

## 快速开始

### 1. 获取项目并安装依赖

本项目尚未发布到 npm。克隆仓库后，进入仓库根目录安装依赖：

```sh
git clone https://github.com/yororoA/Trae2OpenCode.git
cd Trae2OpenCode
npm ci
```

确认本地环境可用：

```sh
node --version
npm run check
```

### 2. 安装 OpenCode 2.0.12

```sh
npm install -g @opencode/cli@2.0.12
opencode --version
```

看到版本为 `2.0.12` 后即可继续。`migrate:local` 会读取 OpenCode 当前 service
descriptor 发现动态端口，并检查本机 `http://127.0.0.1:4096`。没有可用服务时会
临时启动仅监听本机的 `4097` 进程，沿用当前本地 OpenCode 会话库，迁移结束后只关闭
该临时进程。
因此通常不需要手动启动 OpenCode server。

如果发现正在运行的 OpenCode 桌面端或服务不是 `2.0.12`，程序会要求先停止该服务，
不会再启动一个共享同一数据库的 `2.0.12` 进程。OpenCode 桌面端 `2.0.16` 用户应在
迁移前完全退出桌面端，迁移完成后再重新打开。

### 3. 以调试模式启动 TRAE

保存工作并完全退出 TRAE，再从终端启动。macOS 示例：

```sh
"/Applications/Trae CN.app/Contents/MacOS/Electron" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222
```

不要使用 `open -a ... --args`：当前 TRAE 版本可能忽略其中的调试参数。
启动后登录 TRAE，打开包含目标会话的项目窗口，并确认能在历史面板看到这些会话。

### 4. 运行一键迁移

在仓库根目录运行：

```sh
npm run migrate:local
```

程序会显示可用的 TRAE 窗口和该窗口所属项目的会话。会话支持单选、逗号分隔、
连续范围或全部选择：

```text
发现多个 TRAE workbench，请选择：
  1. Trae2OpenCode
  2. another-project
请输入 workbench 编号：1

请选择要迁移的 TRAE 会话（支持多选）：
  1. 修复迁移流程 · complete · 2026/09/24 15:30:00
  2. 阅读 README · partial · 2026/09/24 14:20:00
  3. 发布检查 · complete · 2026/09/24 13:10:00
请输入编号（如 1,3-5；输入 all 全选）：1,3
```

随后工具依次完成：

1. 为每个所选会话创建独立 bundle 和 manifest。
2. 自动剥离正文、标题和工具 payload 中已识别的凭据。
3. 在真正写入前检查迁移完整性和 OpenCode 兼容性。
4. 逐个导入到 OpenCode，并回读消息、reasoning、工具记录和 hash；单个失败不阻止后续会话。
5. 成功后保留最新迁移记录，清理同一会话已被替代的旧终态记录。

如果目标中已存在同一来源会话，并且本地保留着本工具上次成功迁移的 manifest，程序会
提示输入 `OVERWRITE`。确认后先校验旧会话未被修改，再安全覆盖；外来会话、已修改会话
或缺少可信 manifest 的目标不会被删除。

OpenCode 服务重启后动态端口可能改变。已有 manifest 至少包含一个成功会话时，工具会
同时核验目标版本、schema、迁移所有权、完整性快照和整条内容 hash；全部证据匹配后才会
把 manifest 安全绑定到新端口。尚无成功会话或目标内容发生变化时仍会停止。

### 5. 确认结果

成功时终端会显示以下之一：

```text
迁移完成，结果已写入：.../migration-run/session-.../
```

```text
迁移续跑完成，已有会话已校验。
```

然后在 OpenCode 中打开对应项目，检查会话标题、消息数量和最近一轮内容。迁移完成不代表
TRAE 本身的历史被删除，源数据始终保持只读。

完整的逐步说明、失败处理、续跑和回滚见 [操作手册](docs/operation-manual.md)。

## 使用前应了解的限制

- 必须打开目标会话所属项目的 TRAE workbench。窗口可在后台或最小化，但不能关闭；
  完整消息正文由该窗口的 renderer 提供。空白新窗口没有项目上下文，不能用于迁移。
- 同一个 workbench 中会列出该项目的全部本地会话，不限于当前前台会话。关闭的项目窗口
  对应会话当前只能发现部分元数据，不能安全迁移完整内容。
- 单个 bundle 最大为 `128 MiB`。超过限制时需选择更小的会话。
- 发现可安全定位的凭据会替换为 `[REDACTED_SECRET]`，会话标记为 `partial`；
  若凭据位于 ID、路径或来源定位等不可安全改写字段，迁移会停止。
- assistant 在任务执行期间已持久化的进度描述会按原顺序保留，并与最终输出共同显示；
  私有 `reasoning_content` 不会被当作进度正文。存在任务过程时，最终正文前会插入
  Markdown 水平分隔线，便于区分过程与结果。
- TRAE 的 `exec_command` 会映射为 OpenCode 原生 shell 工具，可展开查看具体命令和
  已持久化的终端输出；原始工具字段仍保存在 metadata 中。
- TRAE 未持久化的工具输出或最终 assistant 正文不会被编造。工具记录会保留缺失标识；
  缺失的最终正文会显示明确提示，内部工具 JSON 不会作为聊天正文显示。

## 迁移产物与隐私

每次成功迁移会在仓库根目录生成：

| 目录 | 用途 | 是否含会话正文 |
| --- | --- | --- |
| `trae-export/` | 最新 bundle，用于重新映射和续跑 | 是 |
| `migration-run/` | manifest、回读证据和迁移状态 | 否 |

这两个目录均为本地私人数据，已经在 `.gitignore` 中忽略，**不要提交、共享或上传**。
工具只自动清理由当前 verified 版本替代的旧终态目录；失败、进行中或无法确认安全性的记录
会保留，供续跑或排查使用。

## 常见情况

| 终端提示 | 处理 |
| --- | --- |
| `无法发现 TRAE workbench` | 完全退出后，用上面的终端命令重新启动 TRAE；确认目标项目窗口已打开。 |
| `所选 workbench 没有可迁移的本地会话` | 选择正确的项目窗口，并在 TRAE 中打开该项目后再运行。 |
| `无法自动启动 OpenCode` | 安装并确认 `@opencode/cli@2.0.12`，再运行命令。 |
| `检测到正在运行的 OpenCode 2.0.16` | 完全退出 OpenCode 桌面端或停止该服务，再重新运行；不要让不同版本并发使用同一数据库。 |
| `所选会话包含当前无法无损映射的内容` | 工具尚未写入 OpenCode。保留产物并查看[故障排查](docs/troubleshooting.md)。 |
| `目标会话已存在，但缺少可验证的旧 manifest` | 目标归属无法证明，因此不会覆盖；恢复对应 manifest 或在 OpenCode 中人工确认处理。 |
| `迁移 bundle 超过 128 MiB` | 选择更小的会话；不要修改 bundle 来绕过限制。 |

## 高级操作与文档

- [操作手册：从准备到验证、续跑与回滚](docs/operation-manual.md)
- [故障排查与错误码](docs/troubleshooting.md)
- [离线 CLI、dry-run、导入与回读](docs/m5-1-readonly-cli.md)、[迁移记录与续跑](docs/m5-3-manifest-resume.md)
- [凭据处理边界](docs/m5-6-sensitive-content.md)、[回滚与恢复](docs/m5-5-rollback.md)
- [实现规划与验收矩阵](docs/implementation-plan.md)、[真实来源验收报告](docs/m5-7-live-runtime-e2e.md)
- [开发环境故障排查](docs/development-troubleshooting.md)
