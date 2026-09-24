# M7-2 OpenCode 版本契约

当前允许写入的版本为 **2.0.12** 和 **2.0.16**。拒写版本 **2.0.11** 使用 npm
官方发布的 `@opencode/cli@2.0.11` 原生二进制验证，未用 mock 版本字符串代替实机检查。
`2.0.16` 使用 OpenCode Desktop 自带原生二进制，在隔离数据库中完成兼容验证。

`npm run verify:versions` 验证：

1. 2.0.12 CLI 与隔离 server 版本匹配，真实 OpenAPI 的 transfer schema hash 为
   `sha256:8379854ab529739a39826bbabcb0103847c66368280803e4b5559f09415a3d32`。
2. 2.0.16 CLI/server 的 import/export 路由与完整 transfer schema hash 和 2.0.12
   一致，原生 import/export 往返通过。
3. 2.0.12 CLI 连接 2.0.16 server 的混合版本 import/export 往返通过。
4. 生产 adapter 配置为 2.0.11 后，只执行真实 `--version`；
   probe 和 import 都拒绝写入，错误为 `T2O_OPENCODE_VERSION_UNSUPPORTED`。
   import 命令数和 server 请求数均为 0，2.0.12 隔离目标中该 ID 仍不存在。
5. doctor 使用的隔离 server helper 对 2.0.11 同样拒绝启动，清理临时目录。
6. 切回 2.0.12 后原生 import/export 完整往返成功。

本机 macOS 检查已通过，完整质量门禁 339 项通过。CI 在三系统的 Node 22
任务重复上述验收，报告为 `m7-2-version-report.json`。

安装相邻二进制：

```bash
npm install --prefix tmp/opencode-adjacent --no-package-lock --no-save @opencode/cli@2.0.11
npm run verify:versions
```

可通过 `T2O_TEST_OPENCODE_BINARY` 指定当前二进制，
`T2O_TEST_ADJACENT_BINARY` 指定拒写二进制，
`T2O_TEST_COMPATIBLE_BINARY` 指定 2.0.16 二进制。路径作为独立参数传给进程。

版本支持仍是显式白名单，不因版本号更高而推定兼容。每个允许版本必须同时通过
版本、路由、schema 和真实往返验证。原生 import 已满足当前需求，无需采用 SQLite
直写 fallback；后者会绕过应用层事务、事件和缓存语义。
