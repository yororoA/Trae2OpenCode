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

## OpenCode v1 契约（`opencode-ai`）

Windows 上常见的 OpenCode 是 v1，它与 v2 在三层上都不兼容：v1 的 OpenAPI 在 `/doc`
而不是 `/openapi.json`，没有 `/api/info`，也没有任何会话导入导出 HTTP 路由；
CLI 的 `export` / `import` 是顶层子命令且不接受 `--server` / `--directory`；
`serve` 没有 `--service`，会话 JSON 为 `{info, messages:[{info, parts:[]}]}`。
因此 v1 不能复用 v2 的 adapter，而是独立的 contract / mapping / reconciliation / adapter。

v1 允许写入的版本为 **1.18.32** 与 **1.17.9**，两个都使用 npm 官方发布的原生二进制
实测，未用 mock 版本字符串代替。契约摘要：

1. 版本：`opencode --version` 与 `GET /global/health` 的 `version` 必须同时命中白名单，
   且与二进制同属 v1；`--help` 输出到 stderr，transport 有意不读取 stderr，因此 CLI
   能力由“版本已实测”而非解析帮助文本来断言。
2. 路由：`GET /doc` 的 OpenAPI 必须包含 `DELETE /session/{sessionID}` 与
   `GET /session/{sessionID}/children`，否则拒绝写入。
3. schema：`fixtures/opencode/1.18.32/evidence/session.schema.json` 是从 v1 `/doc` 的
   `Session` / `Message` / `Part` 三个根定义按 `$ref` 递归抽取出的 envelope，其规范化
   hash 为 `sha256:e110d00a7c579aac2ff85453d7661bbbdd7b5720efa12caa3da9ceb2c722a132`；
   新版本必须让 `extractV1SessionSchema` 的 hash 与之一致。
4. 真实往返：两个版本都在隔离数据目录中完成 probe、plan、`opencode import`（以目标
   目录为 cwd）、`opencode export` 回读、逐项对账、`verify`、重复迁移冲突检测与
   `rollback`。合成 fixture 的 2 条消息、2 个 text、2 个 reasoning、1 个 tool 全部无损。

实测确认的 v1 语义（写 adapter 时必须遵守）：

| 行为 | 实测结果 |
| --- | --- |
| 会话目录 | `import` 会把 `info.directory` 改写为**导入进程的 cwd**；因此必须以目标目录为 cwd 导入 |
| `projectID` | 由导入目录派生，payload 中的值被丢弃 |
| `path` | 由目录派生（Windows 上为去掉盘符的相对形式），不是原样保存 |
| 消息顺序 | 读取时按 `time_created` 再按 id 排序 |
| 部件顺序 | 读取时按 `part.id` 字典序排序，因此 part id 必须按预期顺序可排序 |
| reasoning | `time.start` 为**必填**，缺失时 import 直接失败（`Missing key at ["time"]["start"]`） |
| 消息 metadata | 会被丢弃；会话级 `Session.metadata` 则逐字节保留 |
| compaction | 只有不带摘要的 `CompactionPart`，无法承载 v2 的 checkpoint 摘要 |
| 删除 | `DELETE /session/{sessionID}` 级联删除，`.../children` 只返回直接子会话 |
| 认证 | 设置 `OPENCODE_SERVER_PASSWORD` 后强制 Basic 认证（用户名 `opencode`） |

复现（`tmp/opencode-v1-adjacent` 与 v2 的相邻二进制目录约定一致）：

```bash
npm install --prefix tmp/opencode-v1-adjacent --no-package-lock --no-save opencode-ai@1.17.9
T2O_TEST_OPENCODE_BINARY="$(command -v opencode)" \
T2O_TEST_V1_ADJACENT_BINARY="$PWD/tmp/opencode-v1-adjacent/node_modules/opencode-ai/bin/opencode.exe" \
npm run verify:v1
```

脚本对每个给定二进制在隔离数据目录中执行完整链路，输出
`platform`、`node`、二进制路径、版本、schema hash、消息数与部件数。
