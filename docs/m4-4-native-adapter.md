# M4-4：原生 CLI import adapter

`createNativeOpenCodeAdapter` 提供 `importSession`、`readSession`（HTTP export）
与 `exportSession`（CLI export）。只接受显式本机 HTTP origin，每次操作重新校验
可执行文件和服务的产品版本、OpenAPI 与 transfer schema。

导入前深拷贝输入，要求已有本机绝对目录、assistant 真实完成时间、合法 session
ID 与 ≤384 MiB 的 UTF-8 transfer。检查目标 ID 不存在、parent ID 已存在后才写入。
并发冲突最终由 OpenCode 原生 409 拒绝；本工具不覆盖既有会话。

临时目录权限为 0700，输入文件为 0600，路径由 `execFile` 参数数组传递，没有
shell 插值。transfer 以分块 JSON 写入临时文件，不构造文档大小的序列化字符串。
成功或异常均清理输入文件；清理失败有独立错误码。日志不转发 CLI 输出或异常正文。
返回值必须来自实际 export 回读，不能根据 CLI 成功文本判断。逐字段内容对账由
M4-6 实现。

## 验证

- 7 项新增测试验证参数/权限、读回、已有会话/缺父、版本/目录/时间/大小门禁、
  异常清理、假成功、错 ID、调用方异步修改。首轮测试通过。
- 全量 lint 检出 `finally` 抛错写法；改为显式保存导入结果/异常再执行清理。
  重新执行全量检查通过，累计 233 项测试。
- macOS OpenCode 2.0.12 隔离实机：原生 adapter 导入 2 条消息，消息完整，
  CLI/API export 相同，重复导入明确拒绝。
- Windows 使用相同无 shell 参数路径，尚待 M7 CI/实机矩阵；未宣称 Windows
  已实机验证。

测试技能 Step1–5 完成，Step6 flush 已执行，其工作区外自更新仍被 sandbox 拒绝。
