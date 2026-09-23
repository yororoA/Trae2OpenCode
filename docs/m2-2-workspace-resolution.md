# M2-2 Workspace 与项目路径解析

> 状态：已完成
> 核验日期：2026-09-23
> 范围：TRAE workspace metadata、本地 file URI、VS Code workspace 配置

## 1. 生产入口

生产解析器位于 `src/source/trae/workspace-resolution.ts`：

- `normalizeWorkspaceFileUri`：按目标平台规范化本地 file URI。
- `resolveWorkspaceLocation`：区分 `workspace.json` 中的 `folder` 与
  `workspace`。
- `resolveTraeWorkspaces`：按稳定顺序解析全部 workspace storage，并隔离单条
  记录错误。

解析结果保留 workspace storage ID、metadata 路径、规范化位置、目标是否存在及
项目路径来源。原始 URI 不进入结果；规范化后的绝对路径仍属于敏感字段，不得由
后续 `scan` 或结构化日志默认输出。

## 2. 路径规则

### Folder workspace

`{"folder":"file://..."}` 直接解析为单个项目路径。URI 的百分号编码会解码，
路径中的 `.` 和 `..` 会按目标平台规范化。

### Multi-root workspace

`{"workspace":"file://.../*.code-workspace"}` 先解析 workspace 配置路径，再使用
JSONC parser 读取 `folders`：

- `{"path":"relative/or/absolute"}`：相对路径以 workspace 文件所在目录为基准。
- `{"uri":"file://..."}`：使用同一 URI 规范化规则。
- 重复项目路径会按平台语义去重，Windows 比较不区分大小写。

workspace 配置缺失时仍保留 workspace 记录，但项目列表为空并产生诊断，不使用
配置文件父目录猜测项目路径。

### 平台边界

- macOS 仅接受本地 `file:` URI；非本地主机和其他 scheme 均拒绝。
- Windows 支持 drive URI 和 UNC URI。
- URI query、fragment 及编码后的路径分隔符拒绝解析。
- `vscode-remote:` 等远程 workspace 当前 fail closed。

## 3. 故障隔离

单个 workspace 的 metadata 缺失、损坏、URI 不支持或 workspace 配置失效，不会
阻止其他 workspace 被解析。所有问题均使用稳定的 `T2O_*` code，且 message
不包含原始 URI 或绝对路径。

## 4. 验证

单元测试覆盖：

- macOS file URI 解码与规范化。
- Windows drive 和 UNC URI。
- 不支持 scheme 与编码路径分隔符拒绝。
- folder/workspace 区分及歧义 metadata 拒绝。
- JSONC、多根 workspace、相对路径、URI 条目和路径去重。
- 缺失/损坏记录隔离与稳定诊断。

当前 macOS 实机只读冒烟结果：

| 项目 | 结果 |
| --- | ---: |
| 已解析 workspace | 14 |
| folder workspace | 11 |
| multi-root workspace | 3 |
| 已解析项目路径 | 25 |
| 已失效 workspace 配置 | 2 |
| 缺失 workspace metadata | 1 |

冒烟输出仅包含计数、类型和错误码，不包含项目路径或 URI。
