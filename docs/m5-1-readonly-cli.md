# M5-1：只读 CLI 与 runtime 接口

日期：2026-09-24。基线：TRAE CN 3.3.104、OpenCode 2.0.12。

## 已实现

- `doctor` 检查 SQLite、TRAE 安装版本、storage/runtime 能力；显式提供
  `--server` 才探测 OpenCode。没有任何目标写入。
- `scan` / `preview` 输出恢复等级、消息/资源数量、来源指纹和诊断代码；
  不输出标题、正文、工具 payload 或绝对路径。
- `export --output <new-directory>` 创建 `0700` 目录和 `0600`
  `migration-bundle.json`，已有目录拒绝覆盖。IR 文件包含待迁移的正文，应按私人
  会话数据保管；摘要报告不包含正文。
- `--input <bundle.json>` 支持离线扫描、预览与重新导出，不要求安装 OpenCode
  或启动 TRAE。可按 `--session` / `--project` 精确筛选。
- 安装版本来自 TRAE CN `product.json` 的 `appVersion`，可显式提供
  `--product-file`。未知版本不套用 parser。

## Runtime 接口

显式使用 `--cdp http://127.0.0.1:<port>` 连接已开启调试端口的 TRAE。
多个 workbench 时必须提供 `--cdp-target <id>`；没有连接时扫描仍输出
`metadata-only`，不会声称恢复了正文。程序不重启正在运行的 TRAE。

3.3.104 的 renderer 从已安装模块的 `TraeApiPort` 获取官方 `chat.getSession`
和 `chat.getMessages`。固定 `env: "local"`，使用 `page_size` / `page_token` /
`next_page_token` 分页。该 registry 模块号只属于已锁定版本，不推广到其他版本。
不使用 renderer 日志或数据库解密，不改 UI 或浏览器存储。

分页失败、身份跨会话、重复 ID 内容冲突、分页循环均拒绝整次会话读取。
单会话上限 32 MiB / 10,000 页，整批原始响应和 IR 文件上限 128 MiB。
页间相同记录去重；完整分页结束后才产生 `expectedMessageCount`。

源发现仍基于 workspace 索引和 snapshot 候选，不宣称覆盖云端未缓存会话。
未验证附件关联和工具错误 payload 的原有门禁继续有效。

## 验证

- `npm run check`：265 项测试通过，lint、typecheck、build、CLI smoke 通过。
- 新增 16 项用例覆盖分页、本机 CDP 协议、版本/身份门禁、源组装、私有导出、
  离线命令和 JSON 输出。依次执行每个测试文件，首轮均通过。
- 本机 `scan --json`：62 个会话、25 个项目；未连接 runtime 时全部为
  `metadata-only`；绝对用户路径泄漏为 0。
- 本机 `doctor --json`：SQLite 3.49.2、TRAE CN 3.3.104，
  runtime `unavailable`；未指定 OpenCode server 时明确 `probed: false`。
- 已登录 TRAE CN 3.3.104 的生产 CDP reader 已完成端到端验收。选中的
  非敏感 partial 会话包含 4 条消息、2 个 text 和 2 个 completed tool；
  原生导入、完整 hash 对账、resume 和重复跳过均通过，实际 import 1 次。
  实机发现和拆分 reasoning 覆盖边界见
  [M5 真实端到端报告](./m5-7-live-runtime-e2e.md)。

## 单测流程记录

Step1 完成工具准备；Step2 使用现有 Node `node:test` / `tsx` 风格，无 FEATURE_DIR。
Step3 限定新增 runtime-reader、runtime-cdp、collect、bundle-file、commands 和
CLI 入口；Step4 未确认业务缺陷，分页/覆盖/脱敏疑点已有显式门禁。
Step5 按文件生成、执行和复核，全部通过，无失败测试修复。
Step6 已执行 `utree flush`，但工具自更新尝试写全局 skill 目录被沙箱拒绝；
未将报告工具结果计为成功，也未改变权限配置。
