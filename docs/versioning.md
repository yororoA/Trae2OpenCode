# 版本管理

Trae2OpenCode 从 `1.1.0` 开始显式维护产品版本。此前仓库一直保留初始化时的
`1.0.0`，但没有对应 Git tag、GitHub Release 或 npm 发布，不能据此还原历史版本。

## 产品版本

产品版本遵循 SemVer：

- `major`：用户命令、迁移产物或兼容性承诺发生不兼容变化。
- `minor`：新增向后兼容的迁移能力、目标方言或工作流。
- `patch`：修复缺陷，不改变已承诺的行为。

当前 `1.1.0` 是开发版本，正式发布前在 `CHANGELOG.md` 中保持 `Unreleased`。
合入 `main` 并完成发布验收后，才创建同名 `v1.1.0` tag；不为未发布的历史提交补 tag。

每次修改产品版本必须同步：

1. `package.json` 与 `package-lock.json`。
2. `CHANGELOG.md` 的对应版本条目。
3. 宣传页的软件结构化数据和可见版本。
4. `npm run verify:version`、`npm run check` 与 `npm run verify:package`。

## 格式版本

以下版本用于数据兼容性，不表示产品发布次数：

| 字段 | 当前值 | 用途 |
| --- | ---: | --- |
| `schemaVersion` | 1 | TRAE 中间格式（IR）结构 |
| `manifestVersion` | 1 | 迁移记录、续跑与回滚结构 |
| `mappingVersion` | 8 | IR 到 OpenCode 的映射语义 |
| `reportVersion` | 2 | OpenCode 独立验证报告结构 |

格式版本只在对应结构或语义变化时递增。一次产品发布可以不改变任何格式版本，也可以
同时升级一个或多个格式版本；反之亦然。

## 发布顺序

1. 更新产品版本和变更记录。
2. 通过所有本地质量与打包验收。
3. 合入 `main`，等待跨平台 CI 和网站部署通过。
4. 在确认发布时为 `main` 的准确提交创建 annotated tag。
5. 推送 tag；需要对外分发时再基于该 tag 创建 GitHub Release 或发布 npm 包。
