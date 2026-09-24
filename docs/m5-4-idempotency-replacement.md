# M5-4：默认跳过与显式替换

核验日期：2026-09-24。目标契约：OpenCode 2.0.12。

## 使用方式

默认迁移遇到现有目标 ID 就 `skipped`，不认领、不修改。父子会话全部已存在时
也全部跳过，不再把已跳过的父会话误报为子会话缺失依赖。只有子会话是新增、
父会话属于另一轮迁移或用户时，拒绝附加，要求保持可验证的本轮父依赖。

替换需要旧 manifest 的完整回读证据：

```bash
trae2opencode migrate --input updated-bundle.json \
  --server http://127.0.0.1:4096 --output new-run \
  --replace old-run/migration-manifest.json --exclusive-target
```

`--replace` 的值是旧 manifest 路径。只处理旧 manifest 中 `verified`、
本工具创建、source ID / parent ID 均一致、首次完整回读 hash 仍相同的会话。
未出现在旧 manifest 中的 ID 沿用默认冲突策略，不因工具 metadata 标记就获得
覆盖资格。旧 manifest 缺少 `deletionHash` 时不支持替换。

`--exclusive-target` 表示操作期间已停止所有其他目标写入者，包括 OpenCode
聊天、自动化和其他迁移。OpenCode 2.0.12 的 CLI/API 删除都会级联删除子会话，
没有条件 DELETE、版本条件或原子“只删叶子”参数。该开关是操作者前提声明，
不是本工具获得了目标全局锁；manifest 文件锁只串行化同一 checkpoint 的使用。
无法暂停其他目标写入时，应继续使用默认 skip。

## 删除证据和恢复

- 原始首次回读的 `deletionHash` 包含所有字段，包括 import 对账允许目标重算的
  `time.updated`、project 和 model variant。新增消息、改标题或这些字段变化
  都拒绝删除；resume 不会刷新已持久化的删除证据。
- 完整预检所有待替换会话及分页子会话列表。选择范围外的子会话、新增子会话、
  缺失旧会话、内容漂移均在第一笔删除前拒绝。
- 子会话先删、父会话后删；每次 native delete 前重新列子会话，必须为空，
  并重新检查完整 hash。调用保持无 shell 参数数组。
- 每次删除前落盘 `replacement.state=deleting`，确认目标不存在后记录
  `deleted`，再按父先子的顺序执行正常 import/readback。
- 删除后响应丢失，续跑凭 `deleting` 加目标不存在继续；仅 `pending` 却发现
  目标消失不能推断为本次删除。旧实例仍存在时重新检查所有保护条件。
- `--resume new-run/migration-manifest.json` 仍需相同新 IR/选项。尚有旧实例待删时
  仍需 `--exclusive-target`；旧实例全部删除后恢复 import 无须重复此声明。
- 新 manifest 只保存旧 run ID、完整 hash 和删除阶段，不保存正文。
  summary 分开统计 `created` 与 `replaced`；内部 `created` 表示本轮导入的实例。
- 替换不是恢复旧内容的备份机制：删除后 import 失败可从新 IR 续跑，但不能从
  只有 hash 的旧 manifest 还原旧会话。应保留旧 IR 导出；后续 rollback 只清理
  本轮新建 ID，不把替换操作当作可恢复旧会话的事务。

## 原生契约证据

`fixtures/opencode/2.0.12/evidence/deletion.contract.json` 取自隔离实机公开 OpenAPI，
包含 session DELETE、按 parentID 分页 list、响应形状及既有 import/export 操作。
删除模块逐次检查双端版本、transfer 契约以及删除/list/响应的固定 hash。
child list 对缺失游标、游标循环、重复 ID、错误父 ID 和超限分页 fail closed。
没有把默认只列 root 的 `opencode session list` 当作完整子会话盘点。

## 验证

- 单测范围：executor、replacement、manifest、原生删除适配器与 CLI 参数边界。
- 缺陷分析：实现阶段修正父子图默认 skip 的错误依赖判断；测试阶段未报告新的
  已证实业务缺陷。原中断测试同步移除新增 hash，保持手工构造状态合法。
- 新增 18 项，累计 310 项；`npm run check` 全部通过。
- `scripts/verify-replacement.ts` 使用 synthetic parser-to-IR fixture 和真实
  macOS OpenCode 2.0.12 隔离服务：2 个会话重复迁移全部 skip；1 个外来子会话
  阻止全部替换；原生 child delete 成功后注入响应/即时回读故障，续跑按逆父子
  顺序总共删除 2 次、替换 2 个、新建 ID 0、完整 verify 2 个。
- 上述故障注入不是进程 SIGKILL，源 fixture 也不是已登录 TRAE runtime 验收。
- bits-unit-test-gen Step1–Step6 已执行；Step6 `utree flush` 的全局 skill 自更新
  路径被 workspace sandbox 拒绝，不影响仓库测试/报告，未扩大授权范围。
