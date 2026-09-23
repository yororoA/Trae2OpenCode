# M2-4 数据源能力探测

> 状态：已完成
> 核验日期：2026-09-23
> 基线：TRAE CN 3.3.104

## 1. 生产入口

生产探测器位于 `src/source/trae/capability-probe.ts`。入口
`probeTraeCapabilities` 组合：

1. M2-1 数据根目录。
2. M2-2 workspace 与项目路径解析。
3. M2-3 SQLite 一致性只读快照。
4. 已验证版本的 storage/runtime profile 门禁。

报告只包含 profile、字段状态、证据等级、计数和固定诊断，不包含数据库值、
会话 ID、原始 URI 或绝对路径。

## 2. Storage profile

| Profile | 验证状态 | 启用条件 |
| --- | --- | --- |
| `trae-cn-workspace-v3` | `verified` | 版本为 3.3.104，存在结构正确的 `ItemTable` |
| `trae-cn-memento-v1` | `unverified` | 只发现旧 memento storage |
| `trae-cn-hybrid` | `unverified` | 同时发现 v3 `ItemTable` 和旧 memento storage |
| `unknown` | `unsupported` | 未知版本或未识别结构 |

未知产品版本即使具有相似表结构，也只报告 `unverified` 字段，不套用 3.3.104
解析规则。

## 3. 字段覆盖率

每个 workspace 固定报告以下字段：

| 字段 | 探测方式 |
| --- | --- |
| `workspace-metadata` | `workspace.json` 已成功结构化解析 |
| `project-path` | folder 或 multi-root workspace 产生规范化项目路径 |
| `workspace-state` | 快照中存在结构正确的 `ItemTable(key,value)` |
| `active-session-id` | 静态 key 存在且值为非空字符串 |
| `session-index` | 静态 key 存在且 `entries` 为对象映射 |
| `input-history` | 静态 key 存在且值为 JSON array |
| `agent-mode-map` | 静态 key 存在且值为 JSON object |
| `long-text` | workspace 下存在对应目录 |
| `paste-files` | workspace 下存在对应目录 |

状态为 `available`、`missing`、`invalid` 或 `unverified`。探测器只验证容器和字段
形状，不把任何值放入报告。

## 4. Runtime 能力

历史消息能力与当前可执行能力分开：

- 3.3.104 的 `trae-cn-runtime-v2` 契约保持 `verified`。
- 未传入生产 runtime probe 时，adapter 为 `unavailable`，正文、assistant、
  reasoning、tool、关系和时间字段均标记为 `requires-runtime`。
- runtime probe 返回可用后，这些字段才标记为 `available`。
- probe 抛错时输出 `T2O_TRAE_RUNTIME_PROBE_FAILED`，不保留原始异常。

该设计不会把 M0 renderer 探针误当成生产 reader。

## 5. 实机验证

当前 TRAE CN 3.3.104 脱敏汇总：

| 项目 | 结果 |
| --- | ---: |
| 发现 workspace | 16 |
| 成功解析 workspace | 15 |
| verified v3 profile | 15 |
| project path 可用 | 13 |
| active session ID 可用 | 10 |
| session index 可用 | 14 |
| input history 可用 | 10 |
| Agent mode map 可用 | 13 |
| long-text 目录 | 3 |
| paste-files 目录 | 4 |
| invalid 字段 | 0 |

另有 2 个历史 workspace 配置文件失效、1 个 workspace metadata 缺失，均作为
既有 M2-2 诊断保留。完整报告序列化后未发现绝对用户路径。
