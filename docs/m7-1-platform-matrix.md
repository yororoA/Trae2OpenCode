# M7-1 跨平台集成矩阵

Quality CI 覆盖 macOS、Windows、Linux，分别执行 Node 18.20.8 和 Node 22
的完整 `npm run check`。Node 22 额外安装固定的 `@opencode/cli@2.0.12`，
执行 `npm run verify:platform`，上传仅含平台、计数和结果的报告。

## 验收范围

- macOS：隔离 home 下分别建立 `Library/Application Support/Trae CN/User`
  和 `Trae/User`，不传 `--trae-root`，验证默认发现。
- Windows：隔离 APPDATA/LOCALAPPDATA 下分别建立上述两个产品的 User
  目录，验证四个候选位置；不覆盖当前用户目录或环境变量。
- 两端在真实文件系统上使用含中文和空格的路径、workspace file URI 和 SQLite。
  无 runtime 时分级为 metadata-only；注入明确标记为合成 fixture 的 runtime
  响应后组装出完整 IR。收集前后源数据库 hash 相同。
- Linux：明确拒绝 TRAE 本地发现；使用离线 IR 验证目标链路。
- 三端均通过隔离 OpenCode 实例进行原生 CLI import、manifest、verify、
  resume 和重复迁移检查。合成 runtime 不能替代真实已登录 TRAE 的最终验收。

## 测试维护

测试入口由 Node 枚举文件后通过参数数组启动，避免依赖 cmd.exe 不支持的
shell glob。原生临时路径测试使用宿主路径类型；POSIX 权限位仅在 POSIX
断言，Windows 继续验证文件内容、源文件不变及清理，未将 mode 位当作 ACL。

bits-unit-test-gen Step1–6 已执行。范围为目录解析、SQLite 快照、原生导入
三份测试的宿主兼容性维护；没有新增业务缺陷探测用例。逐文件 7、5、9 项通过。
`utree flush` 的自动更新尝试写入全局 skill 目录，被沙箱拒绝；不影响仓库测试。

## 复现

```bash
npm ci
npm run check
npm install --prefix tmp/opencode --no-package-lock --no-save @opencode/cli@2.0.12
```

为 `verify:platform` 设置 `T2O_TEST_OPENCODE_BINARY` 到安装后的
`tmp/opencode/node_modules/@opencode/cli/bin/opencode.exe`，或使用 PATH 上的
同版本原生二进制。CI 指定完整路径以避免 Windows npm shim 的 shell 差异。

本机 macOS / Node 18.20.8：339 项单测、lint、typecheck、build、smoke 通过；
两个默认目录、原生导入与对账、resume、重复跳过通过。回读 2 条消息、
2 个 text、2 个 reasoning、1 个 tool。

首轮 CI [35929953330](https://github.com/yororoA/Trae2OpenCode/actions/runs/35929953330)
确认 macOS/Linux 的两个 Node 版本均通过，包括各自 Node 22 原生导入。
Windows 两个版本有 17 个历史测试失败：fixture 路径工具没有遵循显式平台、
测试把宿主临时目录传给 macOS path dialect、Git checkout 转换 golden 为 CRLF。

第二轮修复保留 golden 逐字节断言，通过 `.gitattributes` 固定 LF；修正 fixture
工具的显式平台选择；真实文件系统测试使用宿主平台且隔离 Windows env。
补充 Windows/Linux 纯路径用例。按 Step1–6 重新执行，逐文件 15、14、12、5 项
通过，本机完整质量门禁为 340 项通过。

第二轮 CI [35930386323](https://github.com/yororoA/Trae2OpenCode/actions/runs/35930386323)
**六个任务全部成功**（commit `bd90132`）：三系统 Node 18.20.8/22 的质量门禁、
三系统 Node 22 的默认路径/原生导入及 2.0.12/2.0.11 版本契约检查均通过，
三个平台报告已上传。M7-1/2 的跨平台退出条件满足。

## 本机 Windows 复验（OpenCode v1 目标）

在 Windows 11 + Node 24.13.0 + PowerShell 5.1 上复验，并新增 OpenCode v1 目标支持。

- 质量门禁：`npm run check` 全部通过（lint、425 项单测、typecheck、build、smoke）。
  在 agent 沙箱内运行时会有 4 项 symlink 用例因沙箱禁止创建符号链接而失败，
  写 biome 缓存也会被拦截；在沙箱外运行全部通过，属环境限制而非代码缺陷。
- `npm run migrate:local`：原脚本使用 POSIX 重定向 `>/dev/null 2>&1`，在 cmd/PowerShell
  下 `build` 与后续 node 调用都不会执行。已改为跨平台写法，复验可正常进入
  TRAE workbench 发现阶段（未开启调试端口时按既有逻辑提示并退出 4）。
- OpenCode 可执行文件解析：npm 在 Windows 只生成 `.cmd` / `.ps1` / 无扩展名的垫片，
  Node 的 `execFile` / `spawn` 对它们分别得到 `ENOENT` / `EINVAL`，默认的 `opencode`
  因此完全无法启动。新增 `resolveOpenCodeBinary`，从 PATH 上的垫片内容解析出其中的原生
  `opencode.exe`（已实测 `opencode-ai` 的三种垫片形态），并跳过 Node 托管的垫片。
  旧版 `opencode-ai`（实测 `1.14.45`）的 npm bin 本身是 Node 启动器而不是原生可执行
  文件，垫片只用 `node` 运行 `bin/opencode`，原生文件位于启动器同级的平台包
  `node_modules/opencode-windows-<arch>{,-baseline}/bin/opencode.exe`。垫片解析改为同时
  识别这两种形态：遇到 Node 启动器时沿其所在目录向上查找平台包，并优先取 x64 的
  `-baseline` 构建（该构建在有/无 AVX2 的 CPU 上都可运行，因此无需复刻启动器的 CPU
  探测）。未找到平台包时仍返回配置的原名而不会把启动器当作可执行文件返回。
- 来源侧：`%APPDATA%\Trae CN\User` 命中默认候选，路径发现无需额外参数。
- 目标侧：本机只有 v1（CLI `opencode-ai@1.18.32`、桌面端 `@opencode-aidesktop` 1.17.9），
  新增的 v1 adapter 在隔离数据目录中完成 import、export 回读、对账、verify、冲突检测
  与 rollback，详见 [M7-2](m7-2-version-contract.md#opencode-v1-契约opencode-ai)。
  合成 runtime 仍不能替代真实已登录 TRAE 的最终验收。
