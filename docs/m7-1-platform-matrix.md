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
