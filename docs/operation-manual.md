# Trae2OpenCode 操作手册

本手册说明如何把一个或多个 TRAE 会话迁移到 OpenCode。按顺序完成即可，正常流程只需
运行一条命令、选择一个窗口，再选择需要迁移的会话：

```sh
npm run migrate:local
```

不需要查找或输入 workbench ID、session ID，也不需要手动导出 bundle 或启动 OpenCode
server。

## 迁移前先了解三件事

1. 当前支持 TRAE CN `3.3.104` 和 OpenCode `2.0.12`。
2. TRAE 必须以本机调试端口 `9222` 启动，工具才能读取完整会话正文。
3. 目标会话所在的项目窗口必须保持打开。窗口可以在后台或最小化，不需要一直显示在前台。

TRAE 历史不会被修改或删除。工具只读取来源数据，写入 OpenCode 前会先检查可否安全迁移。

## 第一次使用

### 第 1 步：准备仓库和 Node.js

打开“终端”，克隆仓库并进入其根目录：

```sh
git clone https://github.com/yororoA/Trae2OpenCode.git
cd Trae2OpenCode
npm ci
```

`npm run migrate:local` 是仓库提供的脚本，因此必须在这个目录执行。确认 Node.js 版本
至少为 `18.18`，推荐使用 22：

```sh
node --version
```

首次安装或升级依赖后，可以运行质量检查：

```sh
npm run check
```

该检查会执行 lint、单元测试、类型检查、构建和 CLI smoke；它不会迁移任何真实会话。

### 第 2 步：安装正确版本的 OpenCode

安装并确认 OpenCode `2.0.12`：

```sh
npm install -g @opencode/cli@2.0.12
opencode --version
```

版本不是 `2.0.12` 时不要继续迁移。工具会拒绝写入未验证的版本。

不必先启动 OpenCode server。迁移程序会先连接 `127.0.0.1:4096`；该服务不可用时，
会临时启动仅本机可访问的 `127.0.0.1:4097`，迁移结束后自动关闭。

### 第 3 步：完全退出并以调试模式启动 TRAE

先在 TRAE 中保存工作，然后完全退出应用。确认菜单栏和活动监视器中没有遗留的 TRAE
主进程后，在 macOS 终端执行：

```sh
"/Applications/Trae CN.app/Contents/MacOS/Electron" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222
```

TRAE 会正常打开。登录后，在浏览器或终端访问下面地址：

```text
http://127.0.0.1:9222/json/list
```

看到 JSON 数组就表示调试端口已开启。不要使用 `open -a "Trae CN" --args ...`：
当前 TRAE 版本可能忽略调试参数，即使应用看起来已重新打开，端口仍不可用。

Windows 用户也需要先完全退出 TRAE，再从安装目录的可执行文件启动，并在命令末尾加入
相同的两个 `--remote-debugging-*` 参数。

### 第 4 步：打开来源项目

在刚启动的 TRAE 中：

1. 登录到保存历史会话的同一账号。
2. 打开目标会话所属的项目文件夹。
3. 打开历史面板，确认目标会话仍能看到。

会话和项目窗口存在绑定关系。当前工具通过项目窗口的 renderer 读取消息，因此：

- 同一项目下的非活跃历史会话也会显示，可以迁移。
- 项目窗口可以放到后台或最小化。
- 只开一个没有项目的全新空窗口，无法迁移任何会话。
- 如果会话所属项目窗口已关闭，工具不能安全读取完整内容。重新打开对应项目后再迁移。

### 第 5 步：运行一键迁移

回到仓库根目录的终端，执行：

```sh
npm run migrate:local
```

程序会先构建本地 CLI，然后列出 TRAE 窗口。输入目标窗口前的编号并按回车：

```text
发现多个 TRAE workbench，请选择：
  1. Trae2OpenCode
  2. another-project
请输入 workbench 编号：1
```

接着会列出该项目的会话。支持以下选择方式：

- 单个会话：`2`
- 多个会话：`1,3,6`
- 连续范围：`2-5`
- 混合选择：`1,3-5`
- 全部会话：`all` 或 `全部`

```text
请选择要迁移的 TRAE 会话（支持多选）：
  1. 修复迁移流程 · complete · 2026/09/24 15:30:00
  2. 阅读 README · partial · 2026/09/24 14:20:00
  3. 发布检查 · complete · 2026/09/24 13:10:00
请输入编号（如 1,3-5；输入 all 全选）：1,3
```

列表中的 `complete` 或 `partial` 是来源恢复等级，不是失败提示。`partial` 表示 TRAE
没有持久化某些字段，但其余可验证内容仍可能安全迁移。每个会话使用独立 bundle 和
manifest；某个会话失败后，程序会继续处理其余选项并在最后汇总成功、失败数量。

## 迁移过程中程序会做什么

选择完成后无需继续输入内容。程序会依次执行以下操作：

1. 从所选 workbench 的 renderer 逐个导出会话。
2. 分别检查每个 bundle 是否超过 `128 MiB`。
3. 自动替换标题、消息正文和工具 payload 中已识别的凭据。
4. 进行 dry-run，确认 OpenCode 版本和数据映射。
5. 导入到 OpenCode。
6. 回读 OpenCode 内容，对比消息、reasoning、工具记录和 hash。
7. 保留当前最新记录，并清理同一会话已被替代的旧终态记录。

在第 4 步失败时，程序不会写入 OpenCode。不要修改 bundle、manifest 或错误码来绕过
检查，它们用于防止把不完整或错误关联的会话写入目标。

## 怎样判断成功

终端显示以下任一消息，即表示已经完成导入并通过回读核验：

```text
迁移完成，结果已写入：.../migration-run/session-.../
```

```text
迁移续跑完成，已有会话已校验。
```

然后在 OpenCode 中打开对应项目，确认：

1. 会话标题与来源相符。
2. 消息顺序和最近一轮内容正确。
3. 工具记录没有被显示为大段 JSON 聊天正文。
4. 完整性存在缺口时，界面显示的是明确缺失提示，而不是伪造的回答或输出。

TRAE 中的原始会话仍会保留，迁移不会删除或改写它。

## 本地文件说明

迁移成功后，仓库根目录会有两个私有目录：

| 目录 | 内容 | 用途 |
| --- | --- | --- |
| `trae-export/session-.../migration-bundle.json` | 已脱敏后的会话正文和结构化记录 | 重试、重新映射和断点续跑 |
| `migration-run/session-.../migration-manifest.json` | 迁移状态、回读 hash 和目标归属信息 | 续跑、核验、受保护回滚 |

`trae-export/` 含会话内容，`migration-run/` 含迁移痕迹。二者都不应提交到 Git、发送给
他人或上传到公开位置。它们已被 `.gitignore` 忽略。

每个会话只保留当前最新、已核验的版本。工具只会自动清理同一来源会话已被该版本替代的
旧终态目录，不会删除失败、进行中、无效或手动指定路径的记录。

## 中断、重复运行和续跑

终端被关闭、网络暂时异常或 OpenCode 服务中断时：

1. 保留 `trae-export/` 和 `migration-run/`，不要手动删除其中的文件。
2. 重新启动 TRAE 调试端口，并重新打开同一个来源项目。
3. 回到仓库根目录，再次运行：

   ```sh
   npm run migrate:local
   ```

4. 选择相同的项目窗口和会话。

程序会校验已有 bundle 是否仍属于该会话；已有 manifest 时自动续跑，而不是重复导入。
当来源内容或导出规则变化、目标中已存在旧版本会话时，程序会查找本工具上次成功迁移的
manifest。找到可信记录后会显示：

```text
检测到 1 个由本工具迁移的已有会话，将先校验内容未被修改，再覆盖为新版本。
输入 OVERWRITE 确认覆盖：
```

先暂停其他 OpenCode 写入操作，再准确输入 `OVERWRITE`。覆盖流程会：

1. 验证目标会话仍归属于旧迁移 run。
2. 核对完整内容 hash，确认用户没有在 OpenCode 中修改它。
3. 检查是否存在未包含在迁移范围内的子会话。
4. 持久化删除意图后删除旧会话。
5. 导入新版本并完成回读核验。

任何检查失败都会在删除前停止。外来会话、已修改会话、缺少 deletion hash 或找不到可信
manifest 的目标绝不会被自动覆盖。相同 bundle 和 manifest 的普通重试仍按断点续跑处理，
不会无意义地删除并重建完全相同的会话。

## 常见问题

### 看不到任何 workbench

现象：

```text
无法发现 TRAE workbench，请确认 TRAE 已开启本机调试端口。
```

处理：

1. 完全退出 TRAE。
2. 使用本手册第 3 步的 `Electron --remote-debugging-port=9222` 命令重新启动。
3. 访问 `http://127.0.0.1:9222/json/list`，确认能看到 JSON。
4. 重新运行 `npm run migrate:local`。

### 选中的项目没有会话，或目标会话不在列表中

确保选择的是目标会话所属项目的 workbench。关闭项目窗口后，历史会话不能通过其 renderer
取得完整正文；重新打开该项目即可。不要尝试把其他项目窗口中的 session ID 填入命令。

### 工具提示无法自动启动 OpenCode

运行：

```sh
opencode --version
```

确认输出为 `2.0.12`。若命令不存在，重新执行：

```sh
npm install -g @opencode/cli@2.0.12
```

然后重新运行一键迁移。

### 工具提示会话无法无损映射

这是安全停止，表示尚未向 OpenCode 写入数据。常见原因包括来源缺少关键时间、关联证据
或出现无法安全脱敏的字段。保留本地产物，阅读[故障排查](troubleshooting.md)中对应的
`T2O_*` 错误码；不要通过编辑 JSON 补造字段。

### 看到“已自动将疑似凭据替换为脱敏占位符”

这是正常提示。可安全识别的凭据会被替换为 `[REDACTED_SECRET]`，迁移继续进行且会话
标记为 `partial`。如果凭据在 ID、项目路径或来源定位中，工具会停止，因为这些字段不能
安全地猜测或重写。

### bundle 超过 128 MiB

单个读取 bundle 的上限为 `128 MiB`。请选择较小的会话，或将工作拆分为多个会话后分别
迁移。不要直接删减 bundle 内容来缩小文件。

## 手动核验和回滚

一键流程已经在导入后自动回读核验。只有排查或需要撤销时才使用底层 CLI，并且必须连接
到与迁移时相同的 OpenCode server 数据。

先使用终端成功提示中的实际 manifest 路径替换下方 `<manifest 路径>`：

```sh
node dist/cli/index.js verify \
  --manifest "<manifest 路径>" \
  --server http://127.0.0.1:4096 \
  --json
```

回滚默认只预览，不删除任何数据：

```sh
node dist/cli/index.js rollback \
  --manifest "<manifest 路径>" \
  --server http://127.0.0.1:4096 \
  --json
```

真正回滚前必须停止所有其他 OpenCode 写入者，并从预览输出取得精确 `runId`。再显式确认：

```sh
node dist/cli/index.js rollback \
  --manifest "<manifest 路径>" \
  --server http://127.0.0.1:4096 \
  --confirm "<runId>" \
  --exclusive-target \
  --json
```

回滚只删除本次迁移新建、并且仍可验证归属和内容未被修改的会话。它不会恢复迁移前被
替换的旧内容。详细保护规则见[回滚与恢复](m5-5-rollback.md)。

## 自定义环境

通常不需要设置环境变量。以下情况才需要：

| 变量 | 何时使用 |
| --- | --- |
| `T2O_TRAE_CDP` | TRAE 调试端口不是 `http://127.0.0.1:9222`。 |
| `T2O_OPENCODE_SERVER` | 需要迁移到自行维护的 OpenCode server。设置后工具不会启动临时服务。 |
| `T2O_MIGRATION_EXPORT` | 将 bundle 保存到受控的自定义私有目录。 |
| `T2O_MIGRATION_RUN` | 将 manifest 保存到受控的自定义私有目录。 |
| `T2O_REPLACE_EXISTING=1` | 无交互确认覆盖；仅用于已确保没有其他 OpenCode 写入者的自动化环境。 |

设置自定义 bundle 或 manifest 路径时，工具不会自动清理那些目录。保留它们直到确认不再
需要续跑、核验或回滚。多选迁移不能共用单个自定义 bundle/manifest 路径；多选时请取消
这两个路径覆盖，让程序为每个会话创建独立目录。

更多底层 CLI 用法、错误码及安全边界见[故障排查](troubleshooting.md)和
[迁移记录与续跑](m5-3-manifest-resume.md)。
