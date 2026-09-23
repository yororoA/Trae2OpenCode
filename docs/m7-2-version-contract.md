# M7-2 OpenCode 版本契约

当前允许写入的版本仍为 **2.0.12**。相邻版本 **2.0.11** 使用 npm 官方发布的
`@opencode/cli@2.0.11` 原生二进制验证，未用 mock 版本字符串代替实机检查。

`npm run verify:versions` 验证：

1. 2.0.12 CLI 与隔离 server 版本匹配，真实 OpenAPI 的 transfer schema hash 为
   `sha256:8379854ab529739a39826bbabcb0103847c66368280803e4b5559f09415a3d32`。
2. 生产 adapter 配置为 2.0.11 后，只执行真实 `--version`；
   probe 和 import 都拒绝写入，错误为 `T2O_OPENCODE_VERSION_UNSUPPORTED`。
   import 命令数和 server 请求数均为 0，2.0.12 隔离目标中该 ID 仍不存在。
3. doctor 使用的隔离 server helper 对 2.0.11 同样拒绝启动，清理临时目录。
4. 切回 2.0.12 后原生 import/export 完整往返成功。

本机 macOS 检查已通过，完整质量门禁 339 项通过。CI 在三系统的 Node 22
任务重复上述验收，报告为 `m7-2-version-report.json`。

安装相邻二进制：

```bash
npm install --prefix tmp/opencode-adjacent --no-package-lock --no-save @opencode/cli@2.0.11
npm run verify:versions
```

可通过 `T2O_TEST_OPENCODE_BINARY` 指定当前二进制，
`T2O_TEST_ADJACENT_BINARY` 指定相邻二进制。路径作为独立参数传给进程。

相邻版本验证的结论是“准确拒写”，不是“相邻版本受支持”；没有对 2.0.11 的
写入或内部 schema 作兼容承诺。原生 import 已满足当前 P0，无需立项 SQLite
fallback（M7-5 保持 P2，后续按实际需求评估）。
