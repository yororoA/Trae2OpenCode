# M7-3 大会话与进程中断恢复

`npm run verify:resilience` 使用真实 OpenCode 2.0.12 隔离实例，所有源数据为合成
压力样本。验收包含真实 `SIGKILL`，不以抛异常替代进程中断。

## 实验

| 场景 | 工作量 | 故障时点 | 验收 |
| --- | --- | --- | --- |
| 大会话 | 2,000 条消息、1,000 个工具、单个 8 MiB output | 无 | 导出/读取 IR、计划、导入、verify、resume、重复跳过 |
| 导入前中断 | 12 个会话 | 3 个已验证，第 4 个 checkpoint 为 importing，未执行 native import | OS 释放锁，重新导入第 4 个并继续 |
| 导入后中断 | 12 个会话 | 第 4 个 native import 成功，未返回确认 | 回读认领已存在会话，继续后续会话 |
| 超限文件 | 128 MiB + 1 字节的 sparse bundle | 读取前 | 稳定拒绝，不分配完整输入/解析 JSON |

迁移 worker 和驱动脚本的 V8 堆均限制为 512 MiB。驱动持有隔离 target adapter，
worker 通过 IPC 调用它；数据实际进入 OpenCode 原生 CLI/API。中断时先验证
manifest 状态和真实锁竞争，再杀掉持有锁的 worker；target 进程保持运行。
只有故障注入会扣留成功响应。杀进程后不删除 lock 文件，直接通过原生锁重新获取
验证 crash recovery。每个批次最终 native import 恰为 12 次，无重复导入。

这是固定压力负载的验收，不能据此保证任意 128 MiB bundle 在任意内存配置上
不会 OOM。实现仍保留单会话 transfer 32 MiB、bundle/计划 128 MiB 等上限；
尚未实现流式大 bundle 或 sidecar。RSS 包含堆外内存，允许超过 V8 堆限制。

## 本机结果

macOS / Node 18.20.8，三组通过；完整质量门禁 340 项通过。

| 场景 | worker RSS 采样最大值 | 实际导入 | 重复导入 | 退出信号 |
| --- | ---: | ---: | ---: | --- |
| 大会话 | 605,421,568 bytes（约 577 MiB） | 1 | 0 | 正常 |
| 导入前中断后恢复 | 208,945,152 bytes | 12 | 0 | SIGKILL 后恢复 |
| 导入后中断后恢复 | 208,961,536 bytes | 12 | 0 | SIGKILL 后恢复 |

RSS 每 25ms 和 IPC 请求时采样，数值不是 OS 精确峰值，也不含 OpenCode 子进程。
使用 `process.memoryUsage().rss` 的字节值，避免不同 Node/libuv 组合的
`resourceUsage().maxRSS` 单位差异。机器可读报告为
`tmp/m7-3-resilience-report.json`，CI 三系统 Node 22 任务会重复验收并上传报告。

集成脚本纳入 `tsconfig.integration.json`，随 `npm run check` 做严格类型检查。

CI [35930884801](https://github.com/yororoA/Trae2OpenCode/actions/runs/35930884801)
（commit `1cae3dc`）六任务全部通过，包含 macOS/Windows/Linux 的 Node 22
真实压力与进程中断验收，三份平台报告均已上传。
