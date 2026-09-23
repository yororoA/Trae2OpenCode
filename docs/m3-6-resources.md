# M3-6 图片、文件和长文本附件解析

状态：完成；基线 TRAE CN 3.3.104。资源发现不等同于附件可写入目标。

`scanTraeResources` 统一扫描 `paste-files/<file>` 和已验证的三级
`long-text/<scope>/<entry>/<file>.txt`。每个可读文件记录相对路径、字节数、
SHA-256、MIME 和来源；只按同一 workspace 的完整路径解析引用，支持本机
file URI，不按文件名、资源 ID、scope 或 hash 猜测归属。

缓存 `files[].resourceUri`、parsedQuery 的 `filePath/relatePath` 和显式引用
保留独立 provenance。缓存本身没有会话 ID，因此不被自动分配到会话；
资源 ID 和远端 URI 缺少已验证的本地关联时标记 `deferred`，不会联网获取。
合法本地引用不存在时标记 `missing`；文件不可读或符号链接标记 deferred
并输出诊断。不能取得 bytes 时不补造 hash/size/MIME。

读取器逐段校验目录边界、拒绝符号链接和特殊文件，以 64 KiB 分块计算 hash，
检查 UTF-8 与读取前后文件状态。MIME 由 PNG/JPEG/GIF/WebP/PDF 签名或完整
UTF-8 内容识别，其他内容为 `application/octet-stream` 并告警。
long-text 根符号链接和过深目录也被拒绝。所有诊断仅保留安全 ID/hash。

官方 3.3.104 `ai-modules-chat/dist/index.mjs` 输入历史反序列化器确认：
`files[].uploadMode` 可缺省，图片维度字段为 `imageWidth/imageHeight`。
本阶段修正此前过严的必填条件，并保留已有 width/height 别名兼容。

## 实机只读验证

2026-09-24，从安装的 `product.json.appVersion` 确认版本为 3.3.104：

| 项目 | 结果 |
| --- | ---: |
| 去重 query cache | 481 |
| 可读本地资源 | 134 |
| PNG / long-text | 112 / 22 |
| 无已验证本地路径、待解析引用 | 150 |
| 总资源记录 | 284 |
| 资源引用 | 273 |
| 明确会话关联 | 0 |
| metadata mismatch / invalid reference 诊断 | 9 / 16 |
| cache 解析异常 / 诊断绝对路径 | 0 / 0 |

9 个声明元数据不一致及 16 个超出支持范围的路径保留为诊断，不覆盖实际 bytes
检测结果。所有资源因缺少会话关联保留 unassociated 诊断；不宣称附件迁移已经
通过真实会话验收。附件目标映射仍受 ADR-0006 门禁约束。

## 测试报告

- 范围：资源读取器、资源扫描器、long-text 扫描、输入缓存文件字段。
- 缺陷分析：当前实现未发现新增可证实缺陷；根符号链接与 optional uploadMode
  是本阶段实施时修复的既有问题。
- 用例：新增 11 项，覆盖分块 UTF-8、hash、不变源文件、MIME、符号链接、
  精确归属、缺失/远端资源、元数据冲突、深目录和版本拒绝。
- 验证：资源测试首轮存在导入名错误，修正测试后通过；门禁发现的 3 处
  forEach callback lint 已修正。最终 `npm run check` 153 项全部通过，
  typecheck、lint、build、CLI smoke 均通过。

测试技能 Step1–6 已执行；语言默认缺失的 target-filter 文档使用 scope.md
现有排除规则，沿用项目 `node:test + tsx`。
