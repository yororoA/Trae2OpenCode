# M2-5 会话恢复等级

> 状态：已完成
> 核验日期：2026-09-23
> 范围：会话发现、恢复证据校验、逐会话分级

## 1. 生产入口

生产实现位于 `src/source/trae/recovery-grading.ts`：

- `gradeSessionRecovery`：根据单个会话的计数证据生成等级和缺失原因。
- `gradeSessionRecoveries`：批量评分，并拒绝重复会话身份。
- `assessTraeSessionRecoverability`：从 workspace state 发现 session ID，组合
  M2-4 capability report，并调用可选的消息证据 provider。

输入和输出只包含 ID、计数、状态及固定 reason code，不接收或输出消息正文、
reasoning、tool payload 或项目路径。

## 2. 分级规则

| 等级 | 条件 |
| --- | --- |
| `complete` | profile verified，metadata、预期消息数、user text、assistant content、完成时间和 reply 关系全部覆盖，无 invalid/dangling/corrupt |
| `partial` | profile verified，结构化消息源可用，至少恢复一条 user text 和一条 assistant content，但仍有明确缺口 |
| `metadata-only` | 只能可信恢复 session metadata，或 profile/runtime 门禁不允许使用内容 |
| `unrecoverable` | metadata 与可用内容均不足，或源证据明确损坏 |

未知或未验证 profile 即使出现形似消息的计数，也不会升级为 `partial` 或
`complete`。

## 3. 缺失原因

评分按稳定顺序输出 `T2O_RECOVERY_*` reason，覆盖：

- profile unverified/unsupported
- metadata 缺失
- message source unavailable/error
- expected message count 未知或不一致
- user message/text 缺失
- assistant message/content/completion time 缺失
- reply relation 缺失
- invalid message、dangling reference、source corrupt

计数为负、子计数大于父计数、空 session ID 或重复
`workspaceStorageId + sourceSessionId` 会以
`T2O_TRAE_RECOVERY_EVIDENCE_INVALID` 拒绝。

## 4. Session discovery

当前阶段只从 `state.vscdb` 的一致性快照读取：

- `ai-chat-v2.lastActiveSessionId`
- `chat.ChatSessionStore.index.entries` 的对象 key

ID 会去重和稳定排序。M3 runtime reader 可通过 `sessionEvidenceProvider` 提供
逐会话计数证据，复用同一评分规则；provider 返回空或抛错时，会话保持
metadata-only，并产生安全诊断。

## 5. 实机验证

当前 TRAE CN 3.3.104 在未接入生产 runtime adapter 时：

| 项目 | 结果 |
| --- | ---: |
| 发现 session | 10 |
| `complete` | 0 |
| `partial` | 0 |
| `metadata-only` | 10 |
| `unrecoverable` | 0 |

10 个会话均明确记录 message source unavailable、message count unknown、user
message missing 和 assistant message missing。该结果说明分级器没有把 M0
renderer 证据误当成当前可执行 reader，也不表示这些会话永久只能恢复 metadata。

序列化报告未包含绝对用户路径。完整正文恢复等级需在 M3 runtime reader 提供
逐会话证据后重新计算。
