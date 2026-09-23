# Migration Bundle IR v1

`MigrationBundle` 是 TRAE reader 与 OpenCode adapter 之间的版本化边界。类型定义位于
`src/ir/types.ts`，运行时 JSON Schema 位于
`schemas/migration-bundle.v1.schema.json`。

## 设计约束

- `schemaVersion` 固定为 `1`。不兼容变更必须增加版本，不得复用 v1。
- 会话恢复等级与 source profile 验证状态分开记录。
- session、event、assistant content 和 resource 必须携带非空 `sourceRefs`。
- `SourceRef` 显式记录 workspace storage ID、源 session ID、结构化 locator、
  parser profile 版本和内容 SHA-256。
- user 与 assistant 使用联合类型；assistant 内容保持 text、reasoning 和 tool
  的原始顺序。
- `unknown` 状态表示源状态无法映射，不表示可写入 OpenCode。目标 adapter 仍须
  按 ADR-0006 执行 fail-closed 检查。
- Schema 对已知对象使用 `additionalProperties: false`。无法识别的源字段必须
  进入 diagnostic 或受控 sidecar，不能被静默接受。
- tool 的 input、output、error 和 diagnostic context 只接受 JSON 值，禁止
  `undefined`、函数或其他运行时对象。

## 校验接口

```ts
import {
  assertMigrationBundle,
  validateMigrationBundle,
} from "./src/ir/index.js";

const result = validateMigrationBundle(value);
if (!result.valid) {
  console.error(result.issues);
}

const bundle = assertMigrationBundle(value);
```

校验错误仅包含 schema 路径和错误类型，不回显原始正文或 tool payload。M1-3
会在此基础上统一 CLI 错误码、diagnostic 和结构化日志。

## Schema 生成与回归

```sh
npm run schema:ir
npm test
```

`schema:ir` 从 `src/ir/schema.ts` 生成 checked-in JSON Schema。测试会校验合法
fixture、额外字段、缺失 source ref、未知 tool 状态，以及生成结果与仓库文件
完全一致。
