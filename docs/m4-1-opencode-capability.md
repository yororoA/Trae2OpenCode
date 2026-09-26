# M4-1：OpenCode 版本与原生导入契约探测

初始契约日期：2026-09-24；2026-09-26 增加清单外稳定版本的自动兼容性检测。

## 探测契约

`probeOpenCodeCapabilities` 对用户目标只读取版本及 OpenAPI，不创建目标会话。
v2 读取 `/api/info` 和 `/openapi.json`，v1 读取 `/global/health` 和 `/doc`。
基线 v2 `2.0.12` / `2.0.16`、v1 `1.17.9` / `1.18.32` 使用已有行为证据。
其他稳定 1.x/2.x 要求同版本 CLI，在独立临时库完成导入、导出、回读和删除保护验证，
并在测试结束后重新核对实际目标的版本与 schema。
OpenAPI 的 `info.version` 为 HTTP 接口版本 `0.0.1`，不能用作产品版本门禁。

开启写入资格前同时检查：

- 原生 import POST 与 export GET 存在。
- import 请求与 export 响应封装匹配已验证格式。
- `SessionTransfer.Data` 可达的全部 schema 与 M0 固化证据匹配。
- 不接受外部 `$ref`、缺失 schema、预发布版本或未实现的主版本。
- 清单外稳定版本必须通过[隔离往返验证](opencode-compatibility.md)。

schema 对象 key 顺序不影响比较，不相关 API/schema 变化不阻断已验证能力。
可达 schema 中新增可选字段也需要重新验证，不会自行扩大支持范围。

固定 schema hash：
`sha256:8379854ab529739a39826bbabcb0103847c66368280803e4b5559f09415a3d32`。

`writable` 表示目标契约门禁通过；源 profile、完成时间、映射和逐会话对账
仍由后续写入流程校验，不能据此宣称真实迁移完成。

## 传输与隔离

`createOpenCodeTransport` 只连接显式本地 HTTP origin，禁止 URL 内凭据、
路径、query、fragment 和重定向。认证只保留在内存/子进程环境；命令使用
`execFile` 参数数组，不经过 shell。请求和子进程均有超时及 385 MiB 响应上限，
HTTP JSON 回读采用流式解析。超限会明确失败，不静默截断。原始 stdout/stderr、
服务端错误正文和认证值不会进入错误报告。

`withIsolatedOpenCodeServer` 在私有临时目录启动独立配置、数据、缓存、状态
和数据库的 OpenCode 服务，禁用项目配置、默认插件、模型获取与自动更新。用户目录也被
隔离；临时项目目录先解析为物理路径，以避免 macOS `/var` 别名影响 v1 cwd。
成功或异常退出均停止子进程并删除临时目录。Windows 运行所需的系统环境变量被保留。
以下初始测试记录只描述当时验收，新增版本覆盖见 [M7-2](m7-2-version-contract.md)。

## 范围与缺陷分析

单测覆盖 `contract.ts`、`capability-probe.ts`、`transport.ts`。分析未发现
需要保留的已证实业务缺陷。实机开发中修正了相对 temporary root 在子进程 cwd
变化后导致路径失效的问题，统一在启动前转成绝对路径。TypeScript 检查要求为
异构 JSON schema 常量显式标注 `JsonValue`，已修正。

## 生成的用例

新增 21 项测试：schema/联合类型 6 项、能力门禁 7 项、连接/命令边界 8 项。
使用项目已有 node:test + tsx；未引入新测试框架。涵盖四类工具状态、
schema 漂移、循环/外部引用、CLI/服务版本不一致、缺失能力、脱敏、参数字面量、
重定向拒绝、响应上限和超时终止。

## 验证结果

- 三个测试文件分别首轮通过，合计 21 项。
- 完整测试累计 207 项；提交前执行 `npm run check`。
- macOS OpenCode 2.0.12 与 2.0.16 实机探测通过，schema hash 匹配；2.0.12 CLI
  连接 2.0.16 server 的隔离 import/export 往返也通过。
- 确认隔离数据库已创建于本次私有目录，退出后临时目录已移除。
- 未导入真实 TRAE 数据；production runtime bridge 与映射/导入流程继续推进。
