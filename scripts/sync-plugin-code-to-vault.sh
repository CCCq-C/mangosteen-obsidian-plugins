#!/usr/bin/env bash

set -euo pipefail

DEFAULT_VAULT="/Users/ziyan/ObsidianVaults"

if (( $# > 1 )); then
  printf 'Usage: %s [vault-path]\n' "$0" >&2
  exit 2
fi

vault_path="${1:-$DEFAULT_VAULT}"
plugin_root="$vault_path/.obsidian/plugins"

if [[ ! -d "$plugin_root" ]]; then
  printf 'Refusing to sync: target is missing .obsidian/plugins: %s\n' "$vault_path" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

copy_plugin_files() {
  local plugin="$1"
  shift
  local source_dir="$repo_root/plugins/$plugin"
  local target_dir="$plugin_root/$plugin"
  local file

  mkdir -p -- "$target_dir"
  for file in "$@"; do
    mkdir -p -- "$(dirname -- "$target_dir/$file")"
    cp -- "$source_dir/$file" "$target_dir/$file"
  done
}

copy_plugin_files mangosteen-image \
  main.js image-api.cjs output-storage.cjs manifest.json styles.css \
  tests/image-api.test.cjs tests/image-plugin.test.cjs tests/output-storage.test.cjs

copy_plugin_files mangosteen-video \
  main.js video-api.cjs output-storage.cjs manifest.json styles.css \
  tests/video-api.test.cjs tests/video-plugin.test.cjs tests/output-storage.test.cjs

copy_plugin_files mangosteen-video-replica \
  main.js generation-policy.cjs generation-queue.cjs project-storage.cjs reference-assets.cjs replica-core.cjs replica-cli.cjs replica-editor.cjs replica-logic-api.cjs replica-ui-state.cjs replica-workbench.cjs shot-timeline.cjs visual-style.cjs video-analysis-schema.json manifest.json styles.css \
  tests/generation-policy.test.cjs tests/plugin-load.test.cjs tests/reference-assets.test.cjs \
  tests/generation-queue.test.cjs tests/replica-cli.test.cjs tests/replica-core.test.cjs tests/replica-editor.test.cjs \
  tests/replica-logic-api.test.cjs tests/replica-ui-state.test.cjs tests/replica-workbench.test.cjs \
  tests/workbench-queue-plugin.test.cjs tests/shot-timeline.test.cjs tests/visual-style.test.cjs

agent_main="$plugin_root/mangosteen-agent/main.js"
if [[ -f "$agent_main" ]]; then
  node "$repo_root/scripts/patch-mangosteen-agent-structured-analysis.cjs" "$agent_main"
else
  printf 'Warning: mangosteen-agent is not installed; video analysis will remain unavailable.\n' >&2
fi

printf 'Synced allow-listed plugin code to %s\n' "$plugin_root"
