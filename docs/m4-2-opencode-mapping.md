# M4-2：IR 到 OpenCode 映射

基线：TRAE CN 3.3.104 runtime profile v1 → OpenCode 2.0.12。
入口为 `mapOpenCodeSession`，纯函数返回 transfer 和诊断，不执行写入。

## 字段与门禁

- 先检查 IR schema、ID/order/reply/父关系完整性及相关 error diagnostic。
  `T2O_TRAE_TOOL_ERROR_UNVERIFIED` 即使是 warning 也拒绝写入。
- 每个消息与内容块都要求同一会话、当前 runtime profile 的 `getMessages`
  来源引用；未知产品版本、未验证 profile 不获得写入资格。
- user、assistant 与 tool 的必填时间必须存在。assistant 必须有真实完成时间和
  最终状态；不补造时间，不以 `finish=stop` 绕过目标回读限制。
- text/reasoning 保持正文与块顺序。reply、turn、源状态、所有块时间保存在
  `message.metadata.trae2opencode`；reasoning 原生时间字段能表示时同时映射。
- completed tool 要求 object input、output 与完成时间。string output 原样保留；
  其他 JSON 值编码为 canonical JSON，metadata 记录编码和原值 hash。
- running 使用 object input，streaming 使用 string input，均不允许携带会被
  丢弃的 output。工具 error/unknown 及非空 error payload 继续拒绝写入。
- 消息 Agent/model 无已验证来源，使用明确的 `trae-import-unknown` / `unknown`
  标记。会话必填 cost/tokens 使用 0，metadata 明确这些字段的源值未知。
  它们不是对源模型或实际用量的推断。
- 资源保留于 IR，并输出 `T2O_OPENCODE_RESOURCES_DEFERRED`；不猜测消息附件归属。
- target ID 由调用方传入，M4-3 负责稳定生成；目录落地策略由 M4-5 负责。
  本层最终校验完整的 `SessionTransfer.Data` schema。

## 验证

2026-09-24，13 项新增单测覆盖内容、时间、来源、状态、错误诊断、ID、父关系、
资源告警与输入不可变性；首轮全部通过，TypeScript 与 lint 通过。

隔离 OpenCode 2.0.12 实机使用 `valid-trae-assembled.json`（合成 parser-to-IR
fixture）原生 CLI import/export：

- 2 条消息、5 个 assistant 内容块完整回读。
- 所有 messages（包括 metadata）逐字段相同；session metadata 相同。
- 消息 hash：
  `sha256:b1ee3bfa75757250847d6bfc34b4b0c83f422fbbdd23e2b31cbc4dd8c4834b44`。
- 目标重算 projectID、time.updated 与 subpath，符合 M0 证据。
- 未写入用户 OpenCode 数据；验证退出后隔离目录与服务自动清理。

测试技能 Step1–5 完成，Step6 `utree flush` 已执行，但技能自更新写入工作区外
目录被 sandbox 拒绝，未宣称 flush 成功。这不影响仓库测试结果。

此次验证确认映射契约，不代表 production TRAE runtime bridge 已接通，也不代表
Windows 已实机验证。
