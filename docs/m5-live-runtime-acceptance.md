# P0 最后一项：真实来源端到端验收

状态：**已通过**。M0 已验证结构化来源，M5 的生产 CDP reader 与 M7 的
合成来源/真实目标/打包矩阵均已通过；生产 reader 对已登录 TRAE 的整链结果见
[M5-7 验收报告](m5-7-live-runtime-e2e.md)。

验收时使用本机正常登录的 TRAE CN 3.3.104，显式开启 loopback CDP。工具没有
自动重启 TRAE，也没有复制登录凭据。

## 准备

1. 保存工作，自行完全退出 TRAE CN。
2. 从 macOS 系统“终端”直接启动主程序。不要使用 `open -a ... --args`，当前
   版本经实机确认会启动应用但丢弃 Chromium 调试参数：

   ```sh
   "/Applications/Trae CN.app/Contents/MacOS/Electron" \
     --remote-debugging-address=127.0.0.1 \
     --remote-debugging-port=9222
   ```

3. 保持登录，确认历史会话可见。`http://127.0.0.1:9222/json/list` 应包含
   workbench 页面；多窗口时记录所需 `id` 作为 `--cdp-target`。
4. 用 `node dist/cli/index.js scan --cdp http://127.0.0.1:9222 --json` 获取源会话
   ID。优先选择 `complete` 且同时包含各类内容的会话；没有符合安全和映射门禁的
   complete 样本时，允许选择诊断明确、目标计划为 ready 的 `partial` 会话。
5. 安装 `@opencode/cli@2.0.12`。若不在 PATH，用
   `T2O_TEST_OPENCODE_BINARY` 指向其 `bin/opencode.exe` 原生文件。

## 执行

```text
npm run verify:live -- --cdp http://127.0.0.1:9222 --session <源会话ID>
```

可额外提供 `--cdp-target`、`--trae-root`、`--product-file`。该验收入口必须接入
生产 CDP reader，不接受 fixture 或 `--input` 替代。它要求会话可恢复并至少含
user、assistant text 和 tool，执行 IR 导出/再读、目录映射、原生导入、完整回读
对账、resume、重复迁移，要求实际 native import 恰好一次。未出现的内容类型
必须在报告和验收结论中列为未覆盖，不能用其他测试冒充本次实机覆盖。

目标 server、数据库、配置、项目映射、临时 IR 和 manifest 都位于隔离目录；
结束后清理。不会写入用户已有 OpenCode 数据。成功报告为
`tmp/m5-live-runtime-report.json`，只含 hash、计数、诊断码与状态，
不含源会话 ID、标题、正文或绝对路径。失败输出固定错误码，不打印断言中的原文。

## 已验证结果

- 使用真实 TRAE CN 3.3.104，生产 CDP 分页读取，无 source mock。
- partial IR 包含 4 条消息、2 个 text、2 个 completed tool；项目路径未解析的
  诊断保留，使用隔离 fallback 目录。
- verified=1，created=1，重复运行 skipped=1，实际 import=1；完整 hash 对账一致。
- reasoning=0，按下述覆盖边界准确记录，未冒充本次实机覆盖。
- M5 PR #16 已合入 main；M7 PR #17 在最终门禁通过后合入。

未获取端口、未登录、所选数据缺少 text/tool 或映射被阻止时，继续保留待验收状态，
不以压力测试、安装成功或 M0 的脱敏结构报告代替本项。若真实迁移样本没有
reasoning，必须注明 reasoning 仅由 M0 真实来源证据和 M4/M7 合成目标往返分别覆盖，
尚无单一实机会话的 source-to-target reasoning 验收。
