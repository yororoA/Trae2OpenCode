#!/bin/zsh

set -u

input="${T2O_MIGRATION_INPUT:-$PWD/trae-export/migration-bundle.json}"
export_directory="${T2O_MIGRATION_EXPORT:-$PWD/trae-export}"
run_directory="${T2O_MIGRATION_RUN:-$PWD/migration-run}"
server="${T2O_OPENCODE_SERVER:-http://127.0.0.1:4096}"
fallback_directory="${T2O_FALLBACK_DIRECTORY:-$PWD}"
cdp="${T2O_TRAE_CDP:-http://127.0.0.1:9222}"
cdp_target="${T2O_TRAE_CDP_TARGET:-}"
session="${T2O_TRAE_SESSION:-}"
max_bytes=$((128 * 1024 * 1024))

if [[ ! -f "$input" ]]; then
  if [[ -e "$export_directory" ]]; then
    print -u2 "Input bundle not found and export directory already exists: $export_directory"
    print -u2 "Set T2O_MIGRATION_EXPORT to a new directory or remove only an unused export directory."
    exit 4
  fi

  export_args=(--cdp "$cdp" --output "$export_directory" --json)
  if [[ -n "$cdp_target" ]]; then
    export_args+=(--cdp-target "$cdp_target")
  fi
  if [[ -n "$session" ]]; then
    export_args+=(--session "$session")
  fi
  print "Migration bundle not found; exporting from TRAE through $cdp."
  node dist/cli/index.js export "${export_args[@]}" || exit $?
  input="$export_directory/migration-bundle.json"
fi

size=$(stat -f "%z" "$input")
if (( size > max_bytes )); then
  print -u2 "Input bundle exceeds 128 MiB; export fewer sessions."
  exit 4
fi

if [[ -f "$run_directory/migration-manifest.json" ]]; then
  mode=(--resume "$run_directory/migration-manifest.json")
elif [[ ! -e "$run_directory" ]]; then
  mode=(--output "$run_directory")
else
  print -u2 "Migration directory exists without a manifest: $run_directory"
  exit 4
fi

exec node dist/cli/index.js migrate \
  --input "$input" \
  --server "$server" \
  --fallback-directory "$fallback_directory" \
  "${mode[@]}" \
  --json
