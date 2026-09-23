# 错误、诊断与结构化日志

M1-3 统一三类对外契约：

- **错误码**：表示一次操作为何失败，并决定 CLI 退出码。
- **诊断**：定位 bundle、project、session、event 或 resource 中的具体问题。
- **结构化日志**：以 JSON Lines 输出安全的事件信息，不序列化原始异常或正文。

## 错误码

| 错误码 | 退出码 | 含义 |
| --- | ---: | --- |
| `T2O_INTERNAL_UNEXPECTED` | 1 | 未分类的内部错误 |
| `T2O_CLI_INVALID_ARGUMENTS` | 2 | CLI 参数无效 |
| `T2O_CLI_UNKNOWN_COMMAND` | 2 | CLI 命令未知 |
| `T2O_CLI_COMMAND_NOT_IMPLEMENTED` | 2 | 规划命令尚未实现 |
| `T2O_IR_SCHEMA_INVALID` | 3 | Migration Bundle 不符合 IR Schema |

调用方应依赖错误码和退出码，不应解析英文 message。新增错误必须先进入
`src/shared/error-codes.ts`，不能在各模块内自行定义退出码。

## 诊断

`Trae2OpenCodeError` 可以携带零个或多个 IR `Diagnostic`。每条诊断包含稳定 ID、
code、severity、可选 subject、source refs 和机器可读 context。

IR Schema 校验失败时：

1. 顶层错误码固定为 `T2O_IR_SCHEMA_INVALID`。
2. 每个 AJV issue 转为独立 diagnostic。
3. `instancePath`、`schemaPath` 和 `keyword` 用于定位。
4. 不把被校验值、正文或 tool payload 写入错误 message。

## 结构化日志

CLI 使用 `--json` 输出机器可读错误：

```json
{"timestamp":"2026-09-23T06:20:00.000Z","level":"error","event":"cli.error","message":"Unknown command.","code":"T2O_CLI_UNKNOWN_COMMAND","context":{"diagnosticIds":[],"exitCode":2}}
```

日志 context 采用 fail-closed 白名单。未允许的字段统一写为 `[REDACTED]`；
绝对用户路径写为 `[REDACTED_PATH]`。禁止将 `text`、`query`、`reasoning`、
`input`、`output`、`payload`、credential、token 或原始异常 message 放入日志。

普通终端错误格式为：

```text
Error [T2O_CLI_UNKNOWN_COMMAND]: Unknown command.
Run "trae2opencode --help" for usage.
```

这两种格式都不回显未知命令文本，避免用户误把会话正文或 secret 作为参数时被
错误日志再次泄露。
