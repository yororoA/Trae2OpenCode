# Trae2OpenCode

TRAE 会话数据勘探与 OpenCode 迁移工具。M0 格式验证和 M1 工程骨架已完成：
TRAE CN 3.3.104 的 V2 runtime profile 已通过真实结构化回读验证，覆盖正文、
reasoning、tool payload、关系和时间字段。M2-1 已提供 macOS/Windows 生产路径
发现，M2-2 已实现 workspace 与项目路径解析，M2-3 已实现 SQLite 一致性只读
快照，M2-4/M2-5 已实现 capability probe 与会话恢复分级；runtime reader 与
完整迁移流程尚未实现。

## 开发与验证

```sh
npm ci
npm run check
```

`check` 会依次执行 lint、单元测试、类型检查、构建和 CLI 冒烟检查。构建后可查看
当前命令入口：

```sh
npm run build
node dist/cli/index.js --help
```

M1-1 仅建立 CLI 骨架；`doctor`、`scan`、`preview`、`export`、`migrate`、
`verify` 和 `rollback` 会在对应里程碑实现前明确返回“尚未实现”，不会执行迁移。

真实 runtime 探针只能提交脱敏后的 canonical evidence：

```sh
npm run collect:trae-structured-runtime-evidence -- \
  --probe "<redacted-probe.json>" \
  --output "<structured-runtime-evidence.json>"
```

安装 OpenCode 2.0.12 后，可运行隔离的合成会话导入/回读检查：

```sh
npm run verify:opencode
```

结果写入 `tmp/opencode-roundtrip/`。已完成消息可完整回读；未完成 assistant
会丢失，检查报告会明确记录该限制。

## 文档

- [实现规划与当前验收状态](docs/implementation-plan.md)
- [Migration Bundle IR v1](docs/ir-schema-v1.md)
- [IR Golden Fixture 工作流](docs/golden-fixtures.md)
- [错误、诊断与结构化日志](docs/error-diagnostics.md)
- [M2-1 TRAE 路径发现](docs/m2-1-path-discovery.md)
- [M2-2 Workspace 与项目路径解析](docs/m2-2-workspace-resolution.md)
- [M2-3 SQLite 一致性只读快照](docs/m2-3-sqlite-snapshot.md)
- [M2-4 数据源能力探测](docs/m2-4-capability-probe.md)
- [M2-5 会话恢复等级](docs/m2-5-recovery-grading.md)
- [TRAE 消息来源定位](docs/m0-3-source-location.md)
- [OpenCode 导入验证与限制](docs/m0-4-import-roundtrip.md)
- [M0-5 字段映射与降级矩阵](docs/m0-5-mapping-matrix.md)
- [ADR-0006：运行时回读与 fail-closed 边界](docs/adr/0006-runtime-readback-fail-closed.md)
- [开发环境故障排查与备用执行方案](docs/development-troubleshooting.md)
