# M4-3：稳定 ID 与父子依赖

`stableOpenCodeSessionId` / `stableOpenCodeMessageId` 使用版本化 JSON tuple 的
SHA-256。session ID 由 namespace 与源 session ID 决定；message ID 另加入
源 message ID。同一 message ID 出现在不同 session 时不会冲突。message ID
还包含固定宽度的源 order 前缀：同一会话内严格递增，并整体排在迁移后生成的
OpenCode 原生时间 ID 之前，满足 Desktop Revert 的边界比较规则。

默认 namespace 为 `trae-cn`。迁移 manifest 必须保存显式 namespace，重跑时沿用；
更换 namespace 表示有意创建另一组目标身份。内容、标题、采集时间、产品升级版本
和 sourceFingerprint 不参与 ID 计算，避免会话新增消息后被识别为新会话。
内容变化由后续 manifest/hash 冲突策略处理。源 order 属于消息结构身份；改变
order 会生成不同 ID，防止把改变顺序的消息误认成原目标。

`createOpenCodeIdentityMap` 先校验 IR schema，再迭代处理父链。结果先父后子，
对相同输入集合不受数组排列影响。排序使用 code point，避免依赖机器 locale。
缺父、环、自引用、重复 session/message ID 均以
`T2O_OPENCODE_IDENTITY_INVALID` 拒绝。父会话是否已成功写入由 import adapter
再次检查。

2026-09-24 验证：新增 6 项单测首轮通过，覆盖更新稳定性、namespace 与 tuple
隔离、父排序、缺失/环/重复、12,000 层深链及空集合。深链无递归栈溢出。
累计 226 项测试；完整质量门禁通过。

测试技能 Step1–5 完成；Step6 flush 已执行，其全局技能自更新仍被 sandbox 拒绝。
当前新增能力为 ID/计划构建，不执行目标写入。
