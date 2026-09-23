# M2-1 TRAE 路径发现

> 状态：已完成
> 核验日期：2026-09-23
> 范围：macOS、Windows、显式 `--trae-root`

## 1. 生产入口

生产路径发现位于 `src/source/trae/path-discovery.ts`，与 M0 的
`fixture-collector/discovery.ts` 分离。M0 模块继续服务于证据采集，不作为后续
scanner 的依赖。

公开接口：

- `getDefaultTraeUserDataPaths`：生成当前平台的有序默认候选。
- `discoverTraeRoot`：返回第一个有效根目录，找不到时返回 `null`。
- `requireTraeRoot`：找不到时抛出稳定的 `T2O_*` 错误。

发现阶段只检查目录存在性，不打开数据库、不读取消息正文，也不修改 TRAE 数据。

## 2. 默认目录

候选按下表顺序检查；同一平台上的重复路径会去重。

| 平台 | 候选 |
| --- | --- |
| macOS | `~/Library/Application Support/Trae CN/User` |
| macOS fallback | `~/Library/Application Support/Trae/User` |
| Windows | `%APPDATA%\Trae CN\User`、`%APPDATA%\Trae\User` |
| Windows fallback | `%LOCALAPPDATA%\Trae CN\User`、`%LOCALAPPDATA%\Trae\User` |

Windows 环境变量缺失时，从用户目录推导 `AppData\Roaming` 和
`AppData\Local`。路径构造固定使用目标平台语义，因此可在非 Windows CI 上验证
Windows 路径。

## 3. 显式根目录

`traeRoot`（CLI 形式为 `--trae-root <path>`）接受两种布局：

1. 产品数据目录，例如 `.../Trae CN`，其下应有 `User/`。
2. `User` 数据目录本身，或包含 `globalStorage/`、`workspaceStorage/` 的自定义
   名称目录。

显式路径支持 `~` 展开。指定后不会回退到系统默认路径，避免参数拼写错误时扫描
到另一份数据。

发现器优先返回包含 `globalStorage` 或 `workspaceStorage` 的候选；如果只发现空
`User` 目录，则仍返回它及能力位，供后续 `doctor` 输出可定位诊断。

## 4. 错误契约

| 错误码 | 退出码 | 含义 |
| --- | --- | --- |
| `T2O_TRAE_ROOT_NOT_FOUND` | 4 | 支持的平台上未找到可读 TRAE 根目录 |
| `T2O_TRAE_PLATFORM_UNSUPPORTED` | 4 | 当前平台不是 macOS 或 Windows |

错误消息不包含用户绝对路径。结构化日志仍由 M1-3 的字段白名单负责脱敏。

## 5. 验证

- macOS 默认路径与 TRAE CN 优先级。
- Windows roaming/local 路径及环境变量缺省回退。
- 产品目录、`User` 目录和自定义名称目录覆盖。
- 显式覆盖不回退默认目录。
- 空安装目录、unsupported platform 和稳定错误码。
- 当前 macOS 实机只读冒烟识别到 `trae-cn`，`globalStorage`、
  `workspaceStorage`、`ModularData` 均存在。

`scan` 命令在 M5-1 前仍明确返回“尚未实现”；M2-1 只建立
`--trae-root` 参数契约和可复用的生产发现 API。
