#!/bin/zsh

set -u

cli_log=$(mktemp "${TMPDIR:-/tmp}/trae2opencode-migrate.XXXXXX")
trap 'rm -f "$cli_log"' EXIT

input="${T2O_MIGRATION_INPUT:-$PWD/trae-export/migration-bundle.json}"
export_directory="${T2O_MIGRATION_EXPORT:-$PWD/trae-export}"
run_directory="${T2O_MIGRATION_RUN:-$PWD/migration-run}"
server="${T2O_OPENCODE_SERVER:-http://127.0.0.1:4096}"
fallback_directory="${T2O_FALLBACK_DIRECTORY:-$PWD}"
cdp="${T2O_TRAE_CDP:-http://127.0.0.1:9222}"
cdp_target="${T2O_TRAE_CDP_TARGET:-}"
session="${T2O_TRAE_SESSION:-}"
max_bytes=$((128 * 1024 * 1024))

print_error() {
  local code
  code=$(node - "$cli_log" 2>/dev/null <<'NODE'
const fs = require("node:fs");
const filename = process.argv[2];
const lines = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/).reverse();
for (const line of lines) {
  try {
    const value = JSON.parse(line);
    if (typeof value.code === "string") {
      process.stdout.write(value.code);
      break;
    }
  } catch {
    // Ignore non-JSON progress lines.
  }
}
NODE
  )

  case "$code" in
    T2O_TRAE_RUNTIME_UNAVAILABLE)
      print -u2 "无法连接 TRAE。请确认 TRAE 已开启 9222 调试端口；多个窗口时设置 T2O_TRAE_CDP_TARGET。"
      ;;
    T2O_TRAE_RUNTIME_LIMIT)
      print -u2 "TRAE 会话总量超过 128 MiB。请设置 T2O_TRAE_SESSION，只迁移一个会话。"
      ;;
    T2O_MIGRATION_BUNDLE_TOO_LARGE)
      print -u2 "迁移 bundle 超过 128 MiB。请减少会话范围后重试。"
      ;;
    T2O_MIGRATION_BUNDLE_INVALID_JSON)
      print -u2 "迁移 bundle 文件损坏，不是有效 JSON。请重新导出。"
      ;;
    T2O_OPENCODE_REQUEST_FAILED)
      print -u2 "无法连接 OpenCode。请确认 server 正在运行：$server"
      ;;
    T2O_OPENCODE_VERSION_UNSUPPORTED|T2O_OPENCODE_SCHEMA_UNSUPPORTED)
      print -u2 "OpenCode 版本或数据协议不受支持。需要经过验证的 OpenCode 2.0.12。"
      ;;
    T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING)
      print -u2 "检测到疑似凭据，已停止迁移。请移除凭据后重新导出。"
      ;;
    T2O_MIGRATION_PLAN_CHANGED)
      print -u2 "迁移内容与已有 manifest 不一致。请恢复原 bundle，或使用新的迁移目录。"
      ;;
    *)
      print -u2 "迁移未完成，请检查输入文件、TRAE 调试端口和 OpenCode server。"
      ;;
  esac
}

run_cli() {
  : > "$cli_log"
  if node dist/cli/index.js "$@" >"$cli_log" 2>&1; then
    return 0
  fi
  print_error
  return 1
}

print "正在准备迁移工具..."
if ! npm run build --silent >/dev/null 2>&1; then
  print -u2 "迁移工具构建失败，请运行 npm run check 查看详情。"
  exit 1
fi

if [[ ! -f "$input" ]]; then
  if [[ -e "$export_directory" ]]; then
    print -u2 "找不到迁移 bundle，且导出目录已存在：$export_directory"
    print -u2 "请设置 T2O_MIGRATION_EXPORT 指向一个新目录。"
    exit 4
  fi

  export_args=(--cdp "$cdp" --output "$export_directory" --json)
  if [[ -n "$cdp_target" ]]; then
    export_args+=(--cdp-target "$cdp_target")
  fi
  if [[ -n "$session" ]]; then
    export_args+=(--session "$session")
  fi
  print "正在从 TRAE 导出会话..."
  run_cli export "${export_args[@]}" || exit $?
  input="$export_directory/migration-bundle.json"
fi

size=$(stat -f "%z" "$input")
if (( size > max_bytes )); then
  print -u2 "迁移 bundle 超过 128 MiB，请减少会话范围后重试。"
  exit 4
fi

if [[ -f "$run_directory/migration-manifest.json" ]]; then
  mode=(--resume "$run_directory/migration-manifest.json")
elif [[ ! -e "$run_directory" ]]; then
  mode=(--output "$run_directory")
else
  print -u2 "迁移目录已存在但没有 manifest：$run_directory"
  print -u2 "请设置 T2O_MIGRATION_RUN 指向一个新目录。"
  exit 4
fi

print "正在迁移并校验，请稍候..."
if run_cli migrate \
  --input "$input" \
  --server "$server" \
  --fallback-directory "$fallback_directory" \
  "${mode[@]}" \
  --json; then
  if [[ "$mode[1]" == "--resume" ]]; then
    print "迁移续跑完成，已有会话已校验。"
  else
    print "迁移完成，结果已写入：$run_directory"
  fi
else
  exit 4
fi
