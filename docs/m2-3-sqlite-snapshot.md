# M2-3 SQLite 一致性只读快照

> 状态：已完成
> 核验日期：2026-09-23
> 范围：TRAE `state.vscdb`、SQLite WAL、临时快照生命周期

## 1. 生产入口

生产实现位于 `src/source/trae/sqlite-snapshot.ts`：

- `createReadonlySqliteSnapshot`：创建具有显式清理句柄的独立快照。
- `withReadonlySqliteSnapshot`：在 callback 结束或抛错后自动清理快照。

默认应使用 callback 形式，避免扫描完成后遗留包含历史 metadata 的临时数据库。

## 2. 一致性与只读边界

实现使用 SQLite Online Backup API，而不是分别复制主库和 WAL：

1. 使用 `readonly: true`、`fileMustExist: true` 打开源数据库。
2. 对源连接启用 connection-local `query_only`。
3. 通过 Online Backup 将同一读事务视图写入独立临时目录。
4. 只在临时副本上将 journal mode 固定为 `DELETE`，清理副本 sidecar。
5. 使用 `PRAGMA quick_check` 验证快照，再计算大小、页数和 SHA-256。

源主库及其 `-wal`、`-shm` 不执行复制、checkpoint、journal mode 切换或其他写入。
Online Backup 能包含已提交但尚未 checkpoint 的 WAL 数据，避免普通文件复制产生
跨时点组合。

不透明的 `ModularData/ai-agent/database.db` 不会因为本任务而获得解密或解析
资格；无法作为普通 SQLite 校验的来源会使用稳定错误码 fail closed。

## 3. 临时文件安全

- 快照目录权限固定为 `0700`。
- 快照数据库权限固定为 `0600`。
- 快照统一位于 `trae2opencode-sqlite-*` 临时目录。
- 快照转换为 standalone `DELETE` journal，不遗留 `-wal` 或 `-shm`。
- callback 成功或失败时均执行幂等清理。
- backup 支持分页推进和超时，避免活跃数据库导致无限等待。

直接调用 `createReadonlySqliteSnapshot` 时，调用方必须在 `finally` 中执行
`snapshot.cleanup()`。

## 4. 验证

单元测试覆盖：

- 活跃 WAL 中的已提交记录进入一致快照。
- 创建前后源主库与 WAL 的 SHA-256 保持不变。
- 快照 standalone、`quick_check=ok`、权限和 hash 符合契约。
- 缺失/损坏 SQLite 使用安全的 `T2O_*` 错误。
- 无效参数不创建临时文件。
- callback 正常返回或抛错时均清理快照。

当前运行中的 TRAE CN 实机只读验证：

| 项目 | 结果 |
| --- | ---: |
| 快照大小 | 2,248,704 bytes |
| 快照页数 | 549 |
| 可读表数 | 1 |
| `quick_check` | `ok` |
| standalone | 是 |
| 源主库 hash | 未变化 |
| 源 WAL hash | 未变化 |

验证输出只包含大小、计数、状态和布尔结果，不包含源路径、数据库 key 或内容。
