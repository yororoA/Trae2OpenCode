# Trae2OpenCode

TRAE 会话数据勘探与 OpenCode 迁移工具。M0 格式验证已完成：TRAE CN 3.3.104
的 V2 runtime profile 已通过真实结构化回读验证，覆盖正文、reasoning、tool
payload、关系和时间字段。生产 reader 与完整迁移流程尚未实现。

## 开发与验证

```sh
npm install
npm test
npm run typecheck
npm run build
```

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
- [TRAE 消息来源定位](docs/m0-3-source-location.md)
- [OpenCode 导入验证与限制](docs/m0-4-import-roundtrip.md)
- [M0-5 字段映射与降级矩阵](docs/m0-5-mapping-matrix.md)
- [ADR-0006：运行时回读与 fail-closed 边界](docs/adr/0006-runtime-readback-fail-closed.md)
- [开发环境故障排查与备用执行方案](docs/development-troubleshooting.md)
