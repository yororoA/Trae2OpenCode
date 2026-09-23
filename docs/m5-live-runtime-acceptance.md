# P0 最后一项：真实来源端到端验收

状态：**待运行**。M0 已验证结构化来源，M5 的生产 CDP reader 已实现，
M7 的合成来源/真实目标/打包矩阵均通过；尚缺生产 reader 对已登录 TRAE 的整链证据。

当前本机 TRAE CN 3.3.104 主进程未提供 CDP 监听端口。先前的隔离初始实例
未登录，不能替代正常会话来源。工具不自动重启正在使用的 TRAE，不复制登录凭据。

## 准备

1. 保存工作，自行完全退出 TRAE CN。
2. macOS 重新启动：

   ```sh
   open -a "Trae CN" --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
   ```

3. 保持登录，确认历史会话可见。`http://127.0.0.1:9222/json/list` 应包含
   workbench 页面；多窗口时记录所需 `id` 作为 `--cdp-target`。
4. 用 `node dist/cli/index.js scan --cdp http://127.0.0.1:9222 --json` 获取源会话
   ID。选择已完成、同时包含 user、assistant text、reasoning 和 tool 的会话。
5. 安装 `@opencode/cli@2.0.12`。若不在 PATH，用
   `T2O_TEST_OPENCODE_BINARY` 指向其 `bin/opencode.exe` 原生文件。

## 执行

```text
npm run verify:live -- --cdp http://127.0.0.1:9222 --session <源会话ID>
```

可额外提供 `--cdp-target`、`--trae-root`、`--product-file`。该验收入口必须接入
生产 CDP reader，不接受 fixture 或 `--input` 替代。它检查一个 complete 会话
确有各类内容，执行 IR 导出/再读、目录映射、原生导入、完整回读对账、resume、
重复迁移，要求实际 native import 恰好一次。

目标 server、数据库、配置、项目映射、临时 IR 和 manifest 都位于隔离目录；
结束后清理。不会写入用户已有 OpenCode 数据。成功报告为
`tmp/m5-live-runtime-report.json`，只含 hash、计数、诊断码与状态，
不含源会话 ID、标题、正文或绝对路径。失败输出固定错误码，不打印断言中的原文。

## 通过条件

- 使用真实 TRAE CN 3.3.104，生产 CDP 分页读取，无 source mock。
- 完整 IR 含 user/assistant/text/reasoning/tool，各类计数与消息 hash 对账一致。
- verified=1，created=1，重复运行 skipped=1，实际 import=1。
- 记录机器可读报告与局限，再将 M5 PR #16 标为 ready 并合入 main。
- M7 PR #17 当前以 M5 为 base；M5 合并后改向 main，确认 CI 再合并。

未获取端口、未登录、所选数据缺少关键类型或映射被阻止时，继续保留待验收状态，
不以压力测试、安装成功或 M0 的脱敏结构报告代替本项。
