# 开发环境故障排查

## 2026-09-23：执行通道 transport exception

### 现象与定位

Agent 的直连 `exec_command`（包括 `Shell` 别名）在命令启动前返回：

```text
transport exception: entity not found: No such file or directory (os error 2)
```

`pwd`、`true`，不同工作目录和显式 shell 均出现相同错误。
通过代码编排工具调用本地 `RunCommand`，同一仓库内的命令可以成功执行。
因此当前证据将故障范围缩小到直连执行通道；并非 npm 脚本报错，也不是仓库
目录消失。执行实体或连接引用失效是候选原因，尚无平台内部日志证实具体根因。
此前 reload 未消除错误，不能将切换接口描述为原通道已修复。

### 暂行方案

已确认暂时使用本地 `RunCommand`，继续开发，不再反复探测故障直连通道。
Agent 可通过代码编排接口调用该工具；普通终端直接执行对应项目命令即可。

备用执行器的 PATH 曾只包含工具注入目录，缺少系统命令和用户 Node 路径。
直接调用会导致 npm 不可用、Git hook 找不到 `uname`/`mktemp`，或 push
找不到 `ssh`。使用登录 shell 加载已有环境，例如：

```sh
/bin/zsh -lic 'npm test'
/bin/zsh -lic 'npm run typecheck'
/bin/zsh -lic 'npm run build'
/bin/zsh -lic 'git push'
```

不要将某台机器的 Node 安装路径写进项目脚本，也不要跳过 Git hook。
Git 写操作、测试和构建串行执行：备用通道曾出现
`auto review target toolcall is not pending` 回执错误。
该错误不能直接证明命令未执行；重试 commit/push 前先核对 `git status`、
`git log -1` 和上游提交，避免重复写入。

### 验证结果与恢复条件

使用备用方案已验证提交 `0598c87`：19 项单元测试、TypeScript 类型检查、
构建及暂存 diff 检查通过，推送后本地与上游提交一致。
其中新增测试最初误用未安装的 Vitest，已统一为项目的 `node:test` 和
`node:assert/strict`；这是测试文件问题，与 transport 故障分开记录。

未来恢复直连通道时，应先确认最小命令能返回退出码，再验证项目命令。
在此之前保留备用方案。临时调试服务与 `.dbg/terminal-transport*` 等产物
在接受备用方案后清理，此文档保留可复用的排查结论。
