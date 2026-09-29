<!-- markdownlint-disable MD013 MD033 MD041 -->

<p align="center">
  <a href="https://trae2opencode.yororoice.top/">
    <img src="./website/assets/trae2opencode-app-icon.png" width="112" alt="Trae2OpenCode">
  </a>
</p>

<h1 align="center">Trae2OpenCode</h1>

<p align="center">
  <a href="./README.md">简体中文</a>
  ·
  <a href="./README.en.md">English</a>
  ·
  <a href="./README.ja.md">日本語</a>
  ·
  <a href="./README.de.md">Deutsch</a>
  ·
  <a href="./README.ru.md">Русский</a>
  ·
  <strong>繁體中文</strong>
</p>

<p align="center">
  <strong>把 TRAE 工作階段完整帶到 OpenCode。</strong>
  <br>
  自動匯出、脫敏、映射與匯入，並在寫入後逐項回讀核驗。
</p>

<p align="center">
  <a href="https://github.com/yororoA/Trae2OpenCode/actions/workflows/quality.yml"><img src="https://github.com/yororoA/Trae2OpenCode/actions/workflows/quality.yml/badge.svg" alt="Quality"></a>
  <a href="https://github.com/yororoA/Trae2OpenCode/releases"><img src="https://img.shields.io/github/v/release/yororoA/Trae2OpenCode?style=flat&label=release&color=00843d" alt="GitHub Release"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.18-339933?style=flat&logo=nodedotjs&logoColor=white" alt="Node.js >= 18.18">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-18191c?style=flat" alt="macOS and Windows">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-ISC-606970?style=flat" alt="ISC License"></a>
</p>

<p align="center">
  <a href="https://trae2opencode.yororoice.top/">專案網站</a>
  ·
  <a href="#快速開始">快速開始</a>
  ·
  <a href="./docs/operation-manual.md">操作手冊</a>
  ·
  <a href="./docs/opencode-compatibility.md">相容性</a>
  ·
  <a href="./docs/troubleshooting.md">疑難排解</a>
  ·
  <a href="./CHANGELOG.md">更新記錄</a>
</p>

<!-- markdownlint-enable MD033 MD041 -->

---

> [!IMPORTANT]
> 首次遷移前請先閱讀[操作手冊](docs/operation-manual.md)。macOS 必須從終端機以如下偵錯參數
> 啟動 TRAE，否則工具無法讀取完整的訊息內容。

## 一條指令，完成可信遷移

開啟目標工作階段所在的 TRAE 專案視窗，然後在儲存庫根目錄執行：

```sh
npm run migrate:local
```

依編號選擇視窗與一個或多個工作階段即可。工具不會要求手動輸入 workbench ID 或 session ID，
中斷後也能依據已產生的遷移記錄安全續跑。

| 互動式選擇 | 安全處理 | 雙協定支援 | 寫入後驗證 |
| :---: | :---: | :---: | :---: |
| 自動探索專案視窗與工作階段 | 憑證辨識、脫敏與覆寫保護 | 自動辨識 OpenCode v1 / v2 | 核對訊息、推理、工具記錄與 Hash |

```mermaid
flowchart LR
    A["TRAE 工作階段<br>唯讀擷取"] --> B["匯出與脫敏<br>Migration Bundle"]
    B --> C["協定映射<br>OpenCode v1 / v2"]
    C --> D["原生匯入"]
    D --> E["回讀核驗<br>內容與 Hash 核對"]
```

## 相容性

| 元件 | 要求 |
| --- | --- |
| TRAE 來源 | TRAE CN **3.3.104**，已登入，並以本機 CDP 連接埠 `9222` 啟動 |
| OpenCode v2 目標 | 已驗證基線：**2.0.0**（legacy）、**2.0.12**、**2.0.16**；其他穩定版 2.x 會自動檢測 |
| OpenCode v1 目標 | 已驗證基線：**1.16.0 / 1.17.0**（legacy）、**1.17.9 / 1.18.32**；其他穩定版 1.x 會自動檢測 |
| 作業系統 | macOS、Windows 可直接讀取本機 TRAE；Linux 僅支援匯入已匯出的 bundle |
| Node.js | `>=18.18`，建議使用 Node.js 22 |

附件、Skill 與 MCP 資源目前不在遷移範圍內。未知的 TRAE 來源版本會被拒絕。
OpenCode 是否可遷移取決於實際協定 profile 與隔離往返測試，而不是只依賴版本號。

> [!NOTE]
> 對於未列出的 OpenCode 穩定版本，CLI 與目標服務必須使用相同版本。必要路由與 schema
> 必須完全相符或僅包含安全的新增內容。工具會先在獨立的暫存資料庫中驗證匯入、匯出、
> 回讀、衝突與刪除保護，通過後才允許遷移。

<!-- Separate adjacent GitHub alerts for Markdown renderers. -->

> [!WARNING]
> 預發佈版本、未知主要版本、破壞性 schema 變更或行為驗證失敗都會被拒絕。
> `opencode-ai@1.15.x` 無法保留安全擁有權 metadata，`1.14.x` 的 OpenAPI 不會公開完整的
> 工作階段 schema，因此這些版本也無法寫入。工具不會直接寫入舊版資料庫。

## 快速開始

### 1. 取得專案並安裝相依套件

本專案尚未發佈至 npm：

```sh
git clone https://github.com/yororoA/Trae2OpenCode.git
cd Trae2OpenCode
npm ci
```

確認本機環境可用：

```sh
node --version
npm run check
```

### 2. 安裝支援的 OpenCode 版本

OpenCode v2：

```sh
npm install -g @opencode/cli@2.0.16
opencode --version
```

OpenCode v1：

```sh
npm install -g opencode-ai@1.18.32
opencode --version
```

工具會為支援的版本自動選擇 current 或 legacy profile。也可以執行
`npm run verify:opencode`，單獨檢查本機安裝，支援 `--binary`、`--output` 與 `--json`；
詳見[相容性說明](docs/opencode-compatibility.md#独立验证本机-opencode)。

`migrate:local` 會探索正在執行的 OpenCode 服務與動態連接埠。若沒有可用服務，工具會在
本機連接埠 `4097` 啟動暫存程序，沿用目前的本機工作階段資料庫，並在遷移結束時只關閉
該暫存程序。

Windows 上的 npm 僅會產生 `.cmd` / `.ps1` 包裝程式，工具會自動解析原生
`opencode.exe`。若解析失敗，可使用 `T2O_OPENCODE_BINARY` 或 `--binary` 指定。

### 3. 以偵錯模式啟動 TRAE

儲存工作並完全結束 TRAE，然後在 macOS 終端機中執行：

```sh
"/Applications/Trae CN.app/Contents/MacOS/Electron" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222
```

請勿使用 `open -a ... --args`；目前的 TRAE 版本可能會忽略其中的偵錯參數。

Windows PowerShell：

```powershell
& "$env:LOCALAPPDATA\Programs\Trae CN\Trae CN.exe" `
  --remote-debugging-address=127.0.0.1 `
  --remote-debugging-port=9222
```

若 TRAE 安裝於其他位置，請替換執行檔路徑。登入 TRAE、開啟目標專案，並確認歷史記錄面板
中可看到所需工作階段。

### 4. 執行遷移

```sh
npm run migrate:local
```

可以預先指定覆寫策略：

```sh
npm run migrate:local -y  # 自動確認 OVERWRITE
npm run migrate:local -n  # 略過需要 OVERWRITE 的工作階段
```

這些參數只控制替換策略，workbench 與工作階段仍從互動式清單中選擇。未附加參數時，
程式會要求輸入 `OVERWRITE`。

工具會為每個選取的工作階段：

1. 建立獨立的 bundle 與 manifest。
2. 從內文、標題與工具 payload 中移除已辨識的憑證。
3. 在寫入前檢查遷移完整性與 OpenCode 相容性。
4. 匯入 OpenCode，再回讀訊息、推理、工具記錄與 Hash。
5. 保留最新的已驗證遷移記錄，僅清除已被取代的舊終態記錄。

若目標中已有相同來源工作階段，工具會要求先前成功遷移所留下的可信 manifest。
替換前會確認舊工作階段未被修改。外部工作階段、已編輯的工作階段，以及缺少可信擁有權
證據的目標都不會被刪除。

### 5. 確認結果

在 OpenCode 中開啟對應專案，檢查工作階段標題、訊息數量與最近一輪內容。
來源 TRAE 歷史始終保持唯讀，不會被刪除。

詳細的續跑與復原流程請參閱[操作手冊](docs/operation-manual.md)。

## 重要限制

- 必須保持目標工作階段所屬的 TRAE workbench 開啟。視窗可以置於背景或最小化，
  但已關閉的專案視窗無法提供完整訊息內容。
- 單一 bundle 上限為 `1 GiB`，單一工作階段 runtime / transfer 資料上限為 `384 MiB`。
- 可安全定位的憑證會替換為 `[REDACTED_SECRET]`，工作階段會標記為 `partial`。
  若憑證位於 ID、路徑或其他無法安全改寫的欄位，遷移會停止。
- 已儲存的 assistant 進度會轉換成 OpenCode 原生 reasoning，最終回覆維持一般文字。
- TRAE 的 `exec_command` 會轉換為可展開的 OpenCode 原生 shell 工具，並保留已儲存輸出。
- 大型 v2 歷史可能加入少量原生 compaction checkpoint。OpenCode v1 沒有 carry-summary，
  因此大型 v1 歷史會維持原樣匯入。
- 不會虛構 TRAE 未儲存的工具輸出或最終 assistant 文字。缺失內容會有明確標記。

## 遷移資料與隱私

每次成功遷移會建立：

| 目錄 | 用途 | 是否包含工作階段內文 |
| --- | --- | --- |
| `trae-export/` | 用於重新映射與續跑的最新 bundle | 是 |
| `migration-run/` | manifest、回讀證據與遷移狀態 | 否 |

> [!CAUTION]
> 這些目錄包含本機私人遷移資料，已列入 `.gitignore`。請勿提交、分享或上傳。

工具只會自動清理由目前 verified 版本取代的舊終態記錄。失敗、進行中或無法確認安全性的
記錄會保留，以便續跑或疑難排解。

## 常見問題

| 終端機訊息 | 處理方式 |
| --- | --- |
| `无法发现 TRAE workbench` | 完全結束 TRAE，以前述終端機指令重新啟動，並保持目標專案視窗開啟。 |
| `所选 workbench 没有可迁移的本地会话` | 選擇正確的專案視窗，並在 TRAE 中開啟該專案。 |
| `无法自动启动 OpenCode` | 確認 `opencode --version` 可執行，再執行 `npm run verify:opencode`。 |
| `OpenCode 版本或协议不受支持` | 使用能通過協定與安全檢查的穩定版 1.x 或 2.x。 |
| `未收录的 OpenCode 版本需要同版本 CLI` | 安裝與目標服務相同版本的 CLI，或設定 `T2O_OPENCODE_BINARY`。 |
| `所选会话包含当前无法无损映射的内容` | 尚未寫入 OpenCode。保留產物並查看[疑難排解](docs/troubleshooting.md)。 |

## 文件

詳細專案文件目前以簡體中文撰寫。

| 主題 | 文件 |
| --- | --- |
| 開始使用 | [操作手冊](docs/operation-manual.md) |
| 相容性 | [OpenCode 相容性](docs/opencode-compatibility.md) · [版本管理](docs/versioning.md) · [更新記錄](CHANGELOG.md) |
| 疑難排解 | [錯誤與常見問題](docs/troubleshooting.md) · [開發環境疑難排解](docs/development-troubleshooting.md) |
| 遷移機制 | [離線 CLI、dry-run、匯入與回讀](docs/m5-1-readonly-cli.md) · [manifest 與續跑](docs/m5-3-manifest-resume.md) |
| 安全與復原 | [憑證處理](docs/m5-6-sensitive-content.md) · [回復](docs/m5-5-rollback.md) |
| 設計與驗收 | [實作規劃](docs/implementation-plan.md) · [真實執行環境報告](docs/m5-7-live-runtime-e2e.md) |

## 授權條款

Copyright © 2026 yororoA。本專案採用 [ISC License](LICENSE)。
