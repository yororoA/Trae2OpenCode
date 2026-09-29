# 版本管理

Trae2OpenCode 从 `1.1.0` 开始显式维护产品版本。此前仓库一直保留初始化时的
`1.0.0`，但没有对应 Git tag、GitHub Release 或 npm 发布，不能据此还原历史版本。

## 产品版本

产品版本遵循 SemVer：

- `major`：用户命令、迁移产物或兼容性承诺发生不兼容变化。
- `minor`：新增向后兼容的迁移能力、目标方言或工作流。
- `patch`：修复缺陷，不改变已承诺的行为。

`1.1.0` 已建立首个正式 tag。仓库从下一版本开始由 release-please 管理产品版本：

- 普通功能 PR 不修改 `package.json`、`package-lock.json`、网站产品版本或
  `CHANGELOG.md`，这些文件在 `main` 上保持最新已发布版本。
- PR 与合并提交使用 Conventional Commits；`feat` 触发 minor、`fix` 触发 patch，
  `!` 或 `BREAKING CHANGE` 触发 major。
- 功能合入 `main` 后，release-please 创建或更新 Release PR。该 PR 一次性更新版本、
  Changelog、manifest 和网站版本。
- 合并 Release PR 是明确的发布动作。release-please 随后创建 `v<version>` tag 和
  GitHub Release，不再手工创建或移动正式 tag。

`release-please-config.json` 记录发布规则，`.release-please-manifest.json` 记录最新
已发布版本。首次自动发布从 `1.1.0` 后的 `main` 合并提交开始，避免把历史开发提交
重复写入下一版 Changelog。由于 `v1.1.0` 指向合并前的分支提交，首次自动发布还使用
临时的 `last-release-sha` 指向 `main` 上的 `1.1.0` merge commit；`1.2.0` 发布后删除
该临时配置，后续由 release-please 的发布记录自动确定边界。

`npm run verify:version` 校验 package、lockfile、release-please manifest、网站和
Changelog 一致。Release PR 由 Actions token 创建时不会自然触发其他 workflow，因此
发布 workflow 会显式 dispatch `quality.yml` 到 Release PR 分支。

## 格式版本

以下版本用于数据兼容性，不表示产品发布次数：

| 字段 | 当前值 | 用途 |
| --- | ---: | --- |
| `schemaVersion` | 1 | TRAE 中间格式（IR）结构 |
| `manifestVersion` | 1 | 迁移记录、续跑与回滚结构 |
| `mappingVersion` | 9 | IR 到 OpenCode 的映射语义 |
| `reportVersion` | 3 | OpenCode 独立验证报告结构 |

格式版本只在对应结构或语义变化时递增。一次产品发布可以不改变任何格式版本，也可以
同时升级一个或多个格式版本；反之亦然。

## 发布顺序

1. 使用 Conventional Commit 标题合入功能 PR。
2. release-please 自动创建或更新 Release PR，并显式触发跨平台质量检查。
3. 审阅 Release PR 中的版本号和自动生成的 Changelog。
4. 合并 Release PR；release-please 自动创建 tag 和 GitHub Release。
5. 发布 workflow 从新 tag 重新执行质量与 tarball 安装验收。当前仍不执行
   `npm publish`，后续增加发布凭据时单独接入。
