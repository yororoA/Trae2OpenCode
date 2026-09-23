# IR Golden Fixture 工作流

M1-4 为 Migration Bundle IR 建立确定性 golden 测试。它用于发现 schema、字段、
顺序或序列化规则的非预期变化，不替代 M2/M3 的真实 TRAE parser fixture。

## 目录

```text
fixtures/ir/v1/
├── valid-*.json
├── invalid-*.json
└── golden/
    ├── manifest.json
    └── valid-*.json
```

- `valid-*.json` 是合法 IR 输入。
- `invalid-*.json` 用于 Schema 拒绝测试，不生成 golden。
- `golden/valid-*.json` 是对象 key 排序后的规范化输出；数组顺序保持不变。
- `golden/manifest.json` 记录 Schema hash、每个 case 的输入/输出路径及 bundle
  hash。

## 检查

```sh
npm run golden:check
npm test
```

检查过程只读，不会自动修改 golden。以下变化会导致失败：

- 合法 fixture 的字段或值变化。
- 消息、content block 或资源数组顺序变化。
- case 新增、删除或遗留多余 golden 文件。
- IR JSON Schema 变化，即使现有 fixture 的规范化内容未变化。

## 显式更新

先检查 schema 和 golden diff，再执行：

```sh
npm run golden:update -- --accept
```

没有 `--accept` 时命令以退出码 2 拒绝写入。更新后必须审查
`fixtures/ir/v1/golden/` 的差异，并重新运行 `npm run check`。

## 规范化和 hash

`canonicalizeMigrationBundle` 会先执行 IR Schema 校验，再递归排序对象 key；
数组保持原始顺序，以便消息顺序变化能被检测。`hashMigrationBundle` 对带尾随换行的
规范化 JSON 计算 SHA-256，供后续 manifest、幂等判断和迁移对账复用。
