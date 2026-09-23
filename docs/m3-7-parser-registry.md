# M3-7：版本化 parser 注册表

日期：2026-09-24。基线：TRAE CN 3.3.104。

## 范围

`profile-definitions.ts` 集中维护产品版本、profile ID、数字修订号、验证状态和
解析能力；`createTraeParser` 在任何解析前精确匹配这三项身份，并绑定产品版本。
没有 semver 范围、近似版本或默认 profile 回退，也没有可变的动态注册入口。

| Profile | 修订号 | 验证状态 | 允许能力 |
| --- | ---: | --- | --- |
| `trae-cn-workspace-v3` | 1 | verified | session metadata、query cache、local resources |
| `trae-cn-runtime-v2` | 1 | verified | runtime metadata、user、assistant、reasoning/plan、tool |
| `trae-cn-memento-v1` | 1 | unverified | 无解析资格，仅可列出描述 |
| `trae-cn-hybrid` | 1 | unverified | 无解析资格，仅可列出描述 |

产品版本、profile ID、修订号、验证状态和能力不匹配分别产生稳定的
`T2O_TRAE_PROFILE_*` 错误，退出码 4，不回显调用方输入。已有底层 parser 保留
原来的 `*_VERSION_UNSUPPORTED` 错误码，并委托统一门禁判断。

workspace parser 不暴露 runtime 消息方法，也不接受 runtime metadata provider。
runtime parser 不暴露 workspace 文件扫描方法。底层读取器仍是独立的
3.3.104 专用 API；注册表是后续编排的选型入口，不替代逐记录 schema 校验或
逐 workspace 探测。

## 缺陷分析

核查了未知版本回退、可变配置覆盖绑定版本、验证状态与运行可用性混淆三条
路径，当前实现均有明确门禁；未确认新增业务缺陷。注册信息及嵌套能力数组冻结，
不允许通过修改返回描述提升权限。

## 生成的用例

新增 12 项测试：8 项 profile 身份与能力门禁、3 项真实 parser 分派、1 项未知
版本阻止 runtime probe 回调。覆盖相邻版本、编辑器内核版本、空版本、宽松版本
字符串、未知 ID、非法修订号、旧 profile、跨来源调用和描述不可变性。分派测试
使用合成正文、工具结果与临时长文本文件，不提交私有消息。

## 验证结果

- 三个目标文件首轮均通过，无测试修复、无断言放宽。
- `npm run check` 全部通过：165 项测试、lint、类型检查、构建及 CLI smoke。
- 实机读取 `product.json.appVersion=3.3.104`：15 个 workspace 均为 verified v3。
- runtime profile 保持 verified，但 adapter 为 unavailable，6 类消息字段全部
  为 requires-runtime；没有将注册成功误报为消息已可读。
- 报告未包含绝对用户路径；保留 2 项失效 workspace 配置和 1 项缺失 metadata
  诊断。

M3-7 不提供 production runtime bridge，尚不能执行真实迁移。M3-8 将用这些
注册身份记录 IR 来源，并执行跨消息排序、去重、关联和完整性校验。
