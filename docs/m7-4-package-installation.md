# M7-4 安装包与操作文档

日期：2026-09-24。此阶段交付本地可安装 tarball 和 CI 安装验收，未执行
`npm publish`，未将待完成的真实来源验收标记为通过。

## 包内容

`package.json.files` 限定以下产物：

- `dist/**/*.js`，排除 `__tests__`，不打包 source map 或声明文件。
- `fixtures/opencode/2.0.12/evidence/transfer.schema.json`：生产模块启动所需的
  固定契约，安装验收与源码逐字节 hash 比对。
- `fixtures/ir/v1/valid-trae-assembled.json`：明确标注为合成的离线使用样本。
- Markdown 操作文档；npm 自动附带 README 与 package.json。

不包含本地 tmp、真实会话、源码测试、node_modules 或采集报告。`prepack`
先移除 dist 再使用已安装 TypeScript 的声明 bin 构建，防止旧编译文件残留。
从源码打包前执行完整 `npm run check`；用户安装 tarball 只需要生产依赖。

## 安装验收

`npm run verify:package`：

1. `npm pack --json`，检查必需文件与所有条目的白名单。
2. 在系统临时目录创建含空格/中文的独立安装目录，安装实际 tarball 的生产依赖；
   不是 symlink，不依赖仓库 devDependencies 或 `NODE_PATH`。
3. 通过 npm 生成的 bin 运行 version/help；doctor 打开 SQLite 内存数据库，
   确认本机 native addon 可用。
4. 对包内合成样本执行 preview/dry-run：ready=1、blocked=0、excluded=0，
   无 target 探测。计划为 2 条消息、2 个 text、2 个 reasoning、1 个 tool。
5. 导出 IR 后重新 dry-run，核对 IR/transfer hash 不变；源样本文件不变。
6. 输出仅含版本、大小、tarball hash 和计数的报告，清理隔离目录。

本机 macOS / Node 18.20.8 的安装流程通过。脚本已纳入
`tsconfig.integration.json` 和三系统 × Node 18.20.8/22 的 CI；
每项报告单独上传 `package-<os>-node-<node>` artifact。
当前运行结果保存于 `tmp/m7-4-package-report.json`。

CI [35932162689](https://github.com/yororoA/Trae2OpenCode/actions/runs/35932162689)
（commit `ce990ed`）六任务全部成功，六份安装报告及三份原生目标集成报告均已上传。
本机完整 `npm run check` 340 项通过。M7 已建立草稿
[PR #17](https://github.com/yororoA/Trae2OpenCode/pull/17)，暂以 M5 分支为 base，
等待真实来源验收和 M5 合并后再改向 main。

## 文档交付

README 已覆盖安装、合成样本 dry-run、数据目录、CDP、导出、目标启动、
认证、路径映射、迁移/verify/resume、回滚和准确支持范围。
[用户故障排查](troubleshooting.md) 按稳定错误码提供处理方式，
[实现规划](implementation-plan.md) 记录 P0 退出条件。

真实已登录 TRAE → 生产 CDP → IR → OpenCode 的整链验收仍是 M5/M7 合并与
首个 P0 可用版本的前置条件。三端合成来源与安装成功均不能替代它。
执行入口及通过条件见[真实来源验收](m5-live-runtime-acceptance.md)。
