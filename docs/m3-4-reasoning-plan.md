# M3-4 持久化 reasoning 与 plan

状态：完成；基线 TRAE CN 3.3.104。

`parseTraeReasoningPlan` 已接入 assistant parser，输出独立的 `reasoningBlocks`
与 `planItems`。只接受 general 的 `content.reasoning_content`、proposal 的
`content.reasoning_content` 和 plan item 的 `reasoning_content`。保留 Unicode、
空白、原始数组位置与字段 hash；空值不生成内容，不从 thought 补造 reasoning。
TRAE UI 对首个 plan reasoning 的展示提升不生成第二份内容。

plan item 以源 ID 去重；同 ID 同 hash 合并，冲突 ID 全部排除并告警。
chat / solo agent 的非空 thought 作为已持久化进度正文映射，不重复告警；
其他 task 类型的 thought 只保留长度、locator 和 hash，未映射时产生诊断。
未知块类型有诊断，未知产品版本拒绝解析。
不将 tool 执行时间解释为 reasoning 时间。

证据为 M0 structured-runtime fixture（1,218 个 plan item、270 个非空
reasoning）与 3.3.104 官方 `IPlanItemParser` / `IAgentMessageParser`。
本次同时修正小写 `finish` 的 summary 正文路径。

测试范围：reasoning parser 和 assistant 集成。新增 7 项，累计 134 项。
覆盖原文保真、顺序、相同文本不同 ID、冲突去重、非法字段、空值、版本门禁和
finish 摘要。两次文件级运行均首轮通过，未发现新增可证实缺陷。
历史测试只调整正文/独立 reasoning 的新契约断言，保留诊断隐私断言。
技能报告命令 `utree flush` 已调用，但技能更新写入工作区外目录被 sandbox
拒绝；本文件保存本次测试范围和结果，完整 `npm run check` 已通过。

本阶段没有新增真实消息回读，不将 M0 的脱敏计数 fixture 当正文迁移测试；
production bridge 与全链路 IR 对账仍待后续实现。
