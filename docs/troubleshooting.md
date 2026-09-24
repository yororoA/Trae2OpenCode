# 安装与迁移故障排查

先执行 `trae2opencode --version` 和 `trae2opencode doctor --json`。尚未安装到
PATH 时使用 `npm exec --offline -- trae2opencode`。错误输出为固定 `T2O_*` 代码；
加 `--json` 后 stderr 为 JSON Lines。报告中的 `ready/blocked/excluded` 和
`hasFailures` 仍需检查：dry-run 的退出码 0 不保证所有会话可导入，doctor 的
退出码 0 也不保证每个组件可用。

## 安装

| 现象 | 处理 |
| --- | --- |
| npm registry 找不到工具 | 当前未发布 npm；按 README 从里程碑分支 `npm pack` 后安装 tarball |
| `better-sqlite3` / `NODE_MODULE_VERSION` 不匹配 | 确认 node/npm 使用同一版本；切换 Node 后在安装目录 `npm rebuild better-sqlite3` |
| native addon 无预编译包 | 使用已验证的 Node 22 / 18.20.8；若仍需源码构建，安装系统 C++ 构建工具和 Python，再重装依赖 |
| 打包后缺少 transfer schema | 重新在源码执行 `npm ci`、`npm run check`、`npm pack`；不要只复制 dist |
| `opencode` 找不到或 Windows `.cmd` 无法启动 | 用 `--binary` 指向 `@opencode/cli/bin/opencode.exe` 原生文件；三平台包均使用此文件名 |

`npm run verify:package` 从 tarball 在独立临时目录安装生产依赖，验证实际 bin、
SQLite native addon、schema、preview、dry-run 和 IR 导出再读。运行需要网络
下载依赖，不要求 TRAE/OpenCode。报告位于 `tmp/m7-4-package-report.json`。

## 来源与 CDP

| 代码/状态 | 含义与下一步 |
| --- | --- |
| `T2O_MIGRATION_BUNDLE_NOT_FOUND` | `--input` 指向的文件不存在；先执行 `pwd`、`ls -lh <input>`，确认相对路径是相对于当前终端目录 |
| `T2O_MIGRATION_BUNDLE_TOO_LARGE` | bundle 超过 128 MiB；重新导出时使用 `--session` 缩小范围，或拆成多个 bundle 分别迁移 |
| `T2O_MIGRATION_BUNDLE_INVALID_JSON` | bundle 不是完整 JSON；检查导出是否中断，使用原始导出副本重新生成 |
| `T2O_MIGRATION_BUNDLE_READ_FAILED` | 其他文件读取失败；检查文件权限、文件是否在迁移过程中被替换，以及父目录是否可读 |
| `T2O_TRAE_ROOT_NOT_FOUND` | 用 `--trae-root` 指定产品数据目录或 User；检查目录可读 |
| `T2O_TRAE_PLATFORM_UNSUPPORTED` | Linux 本地发现不支持；在 macOS/Windows 导出后使用 `--input` |
| `T2O_TRAE_VERSION_UNAVAILABLE` | 用 `--product-file` 指向已安装 TRAE CN 的 product.json |
| `T2O_TRAE_PROFILE_VERSION_UNSUPPORTED` | 仅 3.3.104 有生产 parser；不要修改版本字段伪装兼容 |
| `T2O_TRAE_RUNTIME_ENDPOINT_INVALID` | 使用 `http://127.0.0.1:端口` 或 `http://[::1]:端口`，不带路径、认证、查询参数 |
| `T2O_TRAE_RUNTIME_UNAVAILABLE` | 确认调试端口已开启、版本正确、已登录且历史可见；多 workbench 必须指定 `--cdp-target` |
| `metadata-only` | 只发现索引/元数据；未获取可验证正文，默认不迁移 |
| `T2O_MIGRATION_SELECTION_EMPTY` | 所选源会话或项目不在本地候选中；先 scan 获取 sourceId |

启动参数只在新的 TRAE 主进程上生效。保存工作、完全退出应用后按 README 从
主程序直接启动，访问 `/json/list` 确认 workbench；只开新窗口通常仍复用旧进程。
macOS 的 `open -a "Trae CN" --args ...` 经 3.3.104 实机确认可能丢弃调试参数：
进程已重启但命令行没有参数，端口也不监听。此时改用
`/Applications/Trae CN.app/Contents/MacOS/Electron` 的绝对路径。
程序不会自动重启 TRAE。不通过 renderer 日志、数据库解密或伪造消息补齐正文。

`--input` 不能与 `--cdp/--cdp-target/--trae-root/--product-file` 混用。
`--session` 能限制消息正文读取；`--project` 为结果筛选，不保证减少 runtime
总读取量。超限时优先选择单个较小会话。单会话 runtime 32 MiB，批次/IR 文件
128 MiB；完整大 bundle 当前仍在内存处理，大小上限不是 OOM 保证。

## 计划与目标

| 代码/状态 | 处理 |
| --- | --- |
| `T2O_OPENCODE_DIRECTORY_INVALID` | 指定已存在的绝对项目目录；工具不会 mkdir |
| `T2O_OPENCODE_PATH_MAP_INVALID` | `--path-map` 两侧及 `--fallback-directory` 均需绝对路径；含空格整体加引号 |
| `T2O_OPENCODE_VERSION_UNSUPPORTED` | CLI 和 server 必须均为 2.0.12；2.0.11 是拒写验收对象 |
| `T2O_OPENCODE_SCHEMA_UNSUPPORTED` | 实际 schema 与固定契约不同；保留 IR，等待经验证的 adapter |
| `T2O_OPENCODE_REQUEST_FAILED` | 检查 server 进程、端口和认证环境变量；server URL 不含凭据 |
| `T2O_OPENCODE_MAPPING_REJECTED` | 源会话缺少完成时间/映射证据或包含不支持内容；不会补造字段 |
| `T2O_OPENCODE_PARENT_MISSING` | 先包括可导入的父会话，不能只选依赖它的子会话 |
| `T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING` | 当前选中数据含已识别凭据；从独立输入副本移除凭据值并重新验证，凭据另行绑定 |
| `target.probed=false` | dry-run 尚未探测目标；提供 `--server` 后才验证目标契约 |

成功导入必须有回读对账。`partial` 表示来源不完整，不保证任意缺失都能映射。
凭据检测只覆盖已识别格式、结构和有限嵌套编码；不保证识别所有无标记密码。

## 续跑与删除保护

| 代码 | 处理 |
| --- | --- |
| `T2O_MIGRATION_EXPORT_FAILED` | output 必须是新目录且父目录存在，不覆盖上次导出 |
| `T2O_MIGRATION_BUNDLE_READ_FAILED` | `--input` 读取失败时，先独立验证输入文件；`--resume` 尚未读取或写入目标 |
| `T2O_MIGRATION_LOCKED` | 同一 manifest 正被使用；结束持有它的迁移进程后重试，不删除运行中的 lock 文件 |
| `T2O_MIGRATION_PLAN_CHANGED` | 恢复原 IR 与目录/namespace/筛选参数；真实源变化则新建迁移 |
| `T2O_MIGRATION_TARGET_CHANGED` | 核对 server 端口、数据库和此前写入内容；不要改 manifest 绕过校验 |
| `T2O_MIGRATION_PARTIAL_WRITE` | 目标未完整对账；保留 manifest 和 IR，根据回读证据处理，不盲目重复导入 |
| `T2O_MIGRATION_CHILDREN_PROTECTED` | 待删除范围含外来或未选中子会话，禁止级联删除 |
| `T2O_MIGRATION_EXCLUSIVE_REQUIRED` | 暂停其他目标写入者后才可声明 `--exclusive-target` |
| `T2O_MIGRATION_ROLLBACK_STARTED` | 已进入回滚，只能继续同一 rollback；不能 migrate resume |

`npm run migrate:local` 检测到同一来源会话的旧 verified manifest 时，会要求输入
`OVERWRITE` 后调用受保护 replacement。目标已被修改、含外来子会话或缺少可信
manifest 时不会覆盖。多选迁移逐会话隔离执行，一个会话失败不会停止后续会话。

中断后 OS 会释放 manifest 的 SQLite 排他锁；用同一 manifest 续跑即可。
端点 hash 不是数据库身份；保留同一个 server 数据目录和端口，不在中途切库。
Windows 不承诺 POSIX `0700/0600` 权限位的 ACL 效果，应使用自己的受限目录。
manifest 校验和用于发现损坏，不是数字签名。

## 退出码

| 码 | 含义 |
| ---: | --- |
| 0 | 命令已完成；仍需查看 doctor/dry-run 的逐项结果 |
| 1 | 未预期内部错误 |
| 2 | 参数或确认条件错误 |
| 3 | IR schema 校验失败 |
| 4 | 源读取、敏感内容、文件、manifest 或 checkpoint 问题 |
| 5 | 目标/对账失败，或迁移报告含 failed、blocked、pending、importing |

提交故障信息时保留版本、命令类型、代码及脱敏摘要即可。IR、工具 payload 与
导入临时文件含私人会话正文。开发工具相关故障另见
[开发环境故障排查](development-troubleshooting.md)。
