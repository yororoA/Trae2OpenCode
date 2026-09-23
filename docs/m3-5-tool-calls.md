# M3-5 Tool call/result 归并

状态：完成；基线 TRAE CN 3.3.104。

`parseTraeToolCalls` 已接入 assistant parser，按所属 assistant envelope 内的
`plan_item.tool_call_info.id` 归并 observation。保留原始工具名称及 JSON
params/result data，不应用 TRAE UI 的名称别名、路径改写或参数补齐。

显式 `success` 映射 completed，`failed` 映射 error，`running` 保持 running。
pending/canceled/interrupted 等无已验证目标映射的状态保留 unknown 并告警。
完成时间来自真实 `timing.tool_call_finished_at_ms`；缺失时不补造。
没有 result 时标记 orphan warning；success 的 undefined data 可合法保留，
对应 M0 中已观察到的无输出工具。非零 exit code 不决定工具状态。

同 call ID 的有效终态优先于活动记录，与输入顺序无关。名称、输入、终态
payload 或时间冲突时，整个 call ID fail closed；不混合两次不同调用的结果。
所有 observation 保留 locator/hash；内容顺序取首次出现的位置。
独立 assistant 的相同 call ID 不跨消息归并，跨消息完整性留给 M3-8。

非空错误 payload 只作为离线数据保留，同时生成
`T2O_TRAE_TOOL_ERROR_UNVERIFIED`；当前真实 fixture 仅覆盖 success，这条诊断
必须阻止未经内容验证的目标写入。非法 JSON、缺少 call ID/name/input、非法结果
与时间均产生固定脱敏诊断，诊断不包含工具名称、params、output 或异常 message。

测试范围：tool parser 与 assistant 集成。新增 8 项，覆盖输入不可变性、原始
名称与 payload、乱序终态、冲突、孤儿结果、缺失时间、错误验证边界和版本门禁。
首轮全部通过，无新增已证实缺陷；累计 142 项，完整 `npm run check` 通过。
未新增真实消息回读，真实 production bridge 与 IR 对账继续在后续实现。
