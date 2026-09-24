# M5-6：凭据边界与输出脱敏

核验日期：2026-09-24。

## 行为

生产采集的选中 bundle、离线 bundle 读取、export、preview/scan 摘要、迁移计划、
migrate、manifest、原生 import 和 CLI 最终报告均执行凭据检查。fixture 写入
也检查报告，包括动态 JSON key、标识符和来源 locator。

命中已识别格式时抛出 `T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING`，退出码 4；
提示移除所选数据中的凭据并在目标侧重新绑定。错误不含命中值、上下文片段或正文。
导出和导入检查在创建目录、写临时 transfer 或调用目标前完成。

不静默改写会话正文，也不提供跳过检查参数。敏感 bundle 的读取或导出会整体
拒绝；生产采集可以用 `--session` 缩小选择。离线输入需先在用户控制的副本中
移除凭据，再重新导出与预览。没有命中的文本、消息顺序和来源 hash 保持原样。

## 已识别范围

- GitHub、npm、OpenAI/Anthropic 常见前缀、Slack、GitLab、Hugging Face、Google
  API key、AWS access key、JWT 和 PEM 私钥。
- 敏感结构化字段：apiKey、token、password、clientSecret、privateKey、
  Authorization、Cookie 等，支持大小写、camelCase、下划线及环境变量前缀。
- JSON/文本赋值、环境变量赋值、常见 CLI secret 参数、带密码的 URL、签名 URL。
- JSON 字符串内嵌 JSON、多层转义、URL 百分号编码以及携带令牌的动态对象 key。
- 空值、显式脱敏标记、单独的环境变量引用和 `needs-rebinding` 可以保留。
  CLI secret 参数采用保守拒绝策略。

这是明确格式的检测器，不能识别任意自然语言中的无标记密码、任意二进制、
自定义编码或加密内容，不能把检测通过表述成“绝无 secret”。常见 token/password
字段即使内容是示例，也可能被保守拒绝。附件在 P0 中只保留引用，不复制文件内容。
MCP 凭据与自动运行配置不在 P0 迁移范围。

扫描采用迭代遍历，并限制深度 256、节点数 2,000,000。超限以
`T2O_SENSITIVE_SCAN_LIMIT` 拒绝，不截断正文后继续迁移。

## 输出约束

日志仍采用字段白名单，并额外检查白名单字段的值、数组元素、动态 key、
message/event/code。匹配值整体替换为 `[REDACTED_SECRET]`，不会输出部分前缀。
正文、reasoning 和工具 payload 仍不进入默认摘要、manifest 或 CLI 日志。
fixture 采集脚本不再回显输出绝对路径及异常原文，只输出完成状态或稳定错误码。

## 验证

- 范围：检测器、logger、bundle 读写、plan/executor/manifest、native adapter、
  runtime collection、CLI、fixture 采集与全部 JSON fixture。
- 缺陷分析与修复：新增用例发现 URL 前缀吞掉后续查询参数、环境变量引用截断
  两处解析问题，保留原断言并修复后通过；没有未解决的测试失败。
- 新增 14 项测试，并补充现有 manifest/runtime 用例。检测器第二轮通过；
  其余新增定向用例首轮通过。旧摘要用例更新为无凭据 opaque context，并新增
  含凭据 bundle 拒绝用例；正常正文脱敏断言保留。
- `npm run check`：339 项测试、lint、typecheck、build 和 CLI smoke 全通过。
- `scripts/verify-sensitive.ts` 用隔离 OpenCode 2.0.12 验证含凭据 transfer 拒写、
  目标会话不存在、export 目录不存在、正常原始正文完整导入并对账。
  本地结果：`tmp/m5-6-real-report.json`。
- `utree flush` 已调用，全局技能自更新仍被 workspace sandbox 拒绝；测试与报告
  均已在仓库完成。实机目标验证不等于真实已登录 TRAE runtime 的端到端验收。
