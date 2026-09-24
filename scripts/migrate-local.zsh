#!/bin/zsh

set -u

input="${T2O_MIGRATION_INPUT:-$PWD/trae-export/migration-bundle.json}"
run_directory="${T2O_MIGRATION_RUN:-$PWD/migration-run}"
server="${T2O_OPENCODE_SERVER:-http://127.0.0.1:4096}"
fallback_directory="${T2O_FALLBACK_DIRECTORY:-$PWD}"
max_bytes=$((128 * 1024 * 1024))

if [[ ! -f "$input" ]]; then
  print -u2 "Input bundle not found: $input"
  exit 4
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
