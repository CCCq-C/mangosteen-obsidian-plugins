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
    cp -- "$source_dir/$file" "$target_dir/$file"
  done
}

copy_plugin_files mangosteen-image \
  main.js image-api.cjs manifest.json styles.css

copy_plugin_files mangosteen-video \
  main.js video-api.cjs manifest.json styles.css

copy_plugin_files mangosteen-video-replica \
  main.js replica-core.cjs replica-cli.cjs manifest.json styles.css

printf 'Synced allow-listed plugin code to %s\n' "$plugin_root"
