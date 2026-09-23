# M5-3 迁移记录与断点恢复

核验日期：2026-09-24。源 fixture 为人工合成的 parser-to-IR 样本；目标为隔离的
macOS OpenCode 2.0.12。此结果不代替真实已登录 TRAE renderer 端到端验收。

## CLI

```bash
trae2opencode migrate --input export/migration-bundle.json \
  --server http://127.0.0.1:4096 --fallback-directory /existing/project \
  --output migration-run

trae2opencode migrate --input export/migration-bundle.json \
  --server http://127.0.0.1:4096 --fallback-directory /existing/project \
  --resume migration-run/migration-manifest.json

trae2opencode verify --server http://127.0.0.1:4096 \
  --manifest migration-run/migration-manifest.json
```

`--output` 必须是新目录；`--resume` 使用原有 manifest。续跑要求提供同一份 IR
及等价的目录、namespace、恢复筛选和会话选择参数。manifest 不保存正文或目录，
不能单凭 manifest 重建消息。源数据变化时拒绝续跑，需重新导出并建立新迁移。

CLI 输出机器可读报告；存在 failed、blocked、pending 或 importing 项时退出码
为 5。excluded 和 skipped 有明确原因，不计为导入成功。

## 持久化与恢复

- 每个 run 使用随机 UUID；目标 metadata 带有 run ID、源会话 ID 和映射版本。
- manifest v1 记录源指纹、IR/计划 hash、目标地址 hash、版本、schema hash、
  源目标映射、计划/实际类型计数与 hash、尝试次数和本次创建标记。
- 目标描述符是地址与契约指纹。OpenCode 当前没有暴露稳定数据库身份；更换端口
  会拒绝续跑，相同端口背后的不同库不能只靠该指纹区分。
- 续跑在写入前核验已 verified 的会话，缺失、所有权不符或被修改均停止写入。
  首次写入前切换同地址数据库、或尚无成功会话的 run 不能依赖此检查识别换库。
- 导入前必须先保存 importing checkpoint。会话已写入但进程/响应丢失时，续跑
  根据迁移标记和完整 hash 恢复为 verified，不重新 import。
- 部分写入标记 created + failed，保留实际计数/hash；不自动重写或删除。
  外来冲突不获得 created 标记。
- 单会话的导入和读回失败隔离；父失败时子会话不写入。checkpoint 保存失败是
  全局停止条件，不能继续产生未记录写入。
- 输出目录 `0700`，checkpoint `0600`；同目录临时文件 fsync 后原子 rename，
  POSIX 同步父目录。Windows 不宣称 POSIX mode 或目录 fsync 的保证。
- `.lock` 为工具自己的 SQLite 文件，`BEGIN EXCLUSIVE` 提供进程互斥，
  正常退出和进程终止均由操作系统释放锁；不接触 OpenCode 数据库。
- manifest 有严格结构、大小上限和 checksum。checksum 用于发现意外损坏，
  不提供数字签名或抵御同一账户恶意修改的保证。

## 测试报告

范围：manifest 的读取、校验与原子保存；migration executor 与 verify；
目标门禁；CLI 参数及退出行为。沿用 node:test + tsx，无新增测试框架。

缺陷分析：前置分析没有确认缺陷。首轮常规执行器测试发现保存时替换 session
数组使执行器持有旧引用，导入结果未进入下一 checkpoint；修正为仅更新保存
版本和 checksum 后，保留原断言全部通过。

生成用例：新增 17 项，覆盖保存先于写入、并发锁、校验和、持久化失败、响应
丢失、部分写入、外来冲突、重试、源/目标变更和参数组合；更新一项过期 CLI
断言。完整质量门禁累计 292 项测试通过。

验证命令：

```bash
perl -e 'alarm shift; exec @ARGV' 120 node --import tsx --test \
  src/migration/__tests__/manifest.test.ts src/migration/__tests__/executor.test.ts
perl -e 'alarm shift; exec @ARGV' 120 node --import tsx scripts/verify-migration.ts
perl -e 'alarm shift; exec @ARGV' 300 npm run check
```

实机：原生 import 成功后注入响应/回读故障，续跑 verified=1、created=1；
第二个 run skipped=1、created=0；实际 import=1。目标 2 条消息、2 个 text、
2 个 reasoning、1 个 tool 全部对账一致，manifest 无正文。
当前实机故障是确定性注入；真实 SIGKILL、大数据和 Windows 集成留待 M7。

bits-unit-test-gen Step1–Step5 已完成，Step6 的 `utree flush` 已执行，但工具
自更新全局技能目录被 sandbox 拒绝；本报告保留验证结果，不申请全局目录写权限。
