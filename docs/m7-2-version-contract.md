# M7-2 OpenCode 版本契约

已验证基线为 v2 **2.0.12**、**2.0.16**，以及 v1 **1.17.9**、**1.18.32**。
其他稳定 1.x/2.x 不再仅因版本号拒写，详见[协议兼容性检测](opencode-compatibility.md)。
`2.0.11` 保持不在基线清单内，用 npm 官方原生二进制验证自动准入路径，不伪造版本字符串。

`npm run verify:versions` 验证：

1. 2.0.12 CLI 与隔离 server 版本匹配，真实 OpenAPI 的 transfer schema hash 为
   `sha256:8379854ab529739a39826bbabcb0103847c66368280803e4b5559f09415a3d32`。
2. 2.0.16 CLI/server 的 import/export 路由与完整 transfer schema hash 和 2.0.12
   一致，原生 import/export 往返通过。
3. 2.0.12 CLI 连接 2.0.16 server 的混合版本 import/export 往返通过。
4. 2.0.12 与 2.0.16 均原生导入并通过 HTTP 回读 mapping v8 compaction：
   可见 `summary` 为空，角色化 `recent` 按 `16 KiB` 上限保留。
5. 2.0.11 CLI 连接 2.0.12 服务时，协议匹配但缺少同版本隔离证据，以
   `T2O_OPENCODE_COMPATIBILITY_BINARY_REQUIRED` 拒写；目标会话仍不存在。
6. 同版本 2.0.11 CLI/server 在 schema 匹配及独立临时库往返验证后获得写入资格，
   `compatibility=isolated-roundtrip`。检查实际目标仍为空，再执行 migrate、verify、
   resume 与 rollback，全流程通过。
7. 切回 2.0.12 后原生 import/export 完整往返成功。

CI 在三系统的 Node 22 任务执行 2.0.12 与 2.0.11 的验收；传入
`T2O_TEST_COMPATIBLE_BINARY` 时额外验证 2.0.16。报告为 `m7-2-version-report.json`。

安装相邻二进制：

```bash
npm install --prefix tmp/opencode-adjacent --no-package-lock --no-save @opencode/cli@2.0.11
npm run verify:versions
```

可通过 `T2O_TEST_OPENCODE_BINARY` 指定当前二进制，
`T2O_TEST_ADJACENT_BINARY` 指定未收录的 2.0.11 二进制，
`T2O_TEST_COMPATIBLE_BINARY` 指定 2.0.16 二进制。路径作为独立参数传给进程。

不因版本号更高而推定兼容。已验证基线仍检查实际协议；其他候选必须满足同版本 CLI、
路由、完整 schema 和隔离往返验证。原生 import 已满足当前需求，无需采用 SQLite
直写 fallback；后者会绕过应用层事务、事件和缓存语义。

## OpenCode v1 契约（`opencode-ai`）

`npm run verify:integration:v1` 是开发和 CI 使用的 v1 专项集成回归，覆盖迁移、
回读、续跑、冲突及回滚。日常检查本机 OpenCode 兼容性使用
`npm run verify:opencode`，该命令同时支持 v1/v2。

Windows 上常见的 OpenCode 是 v1，它与 v2 在三层上都不兼容：v1 的 OpenAPI 在 `/doc`
而不是 `/openapi.json`，没有 `/api/info`，也没有任何会话导入导出 HTTP 路由；
CLI 的 `export` / `import` 是顶层子命令且不接受 `--server` / `--directory`；
`serve` 没有 `--service`，会话 JSON 为 `{info, messages:[{info, parts:[]}]}`。
因此 v1 不能复用 v2 的 adapter，而是独立的 contract / mapping / reconciliation / adapter。

v1 基线为 **1.18.32** 与 **1.17.9**，两个都使用 npm 官方发布的原生二进制实测。
清单外稳定 1.x 需要额外通过隔离 CLI 验证。契约摘要：

1. 版本：`opencode --version` 与 `GET /global/health` 的 `version` 必须同属 v1。
   清单外版本要求两者完全一致；基线使用已有行为证据，其他版本执行隔离 import/export
   和删除保护测试，不能仅由 `/doc` schema 推断 CLI 兼容。
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
npm run verify:integration:v1
```

脚本对每个给定二进制在隔离数据目录中执行完整链路，输出
`platform`、`node`、二进制路径、版本、schema hash、消息数与部件数。
