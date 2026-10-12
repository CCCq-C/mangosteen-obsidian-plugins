#!/usr/bin/env bash

set -euo pipefail

DEFAULT_VAULT="/Users/ziyan/ObsidianVaults"

if (( $# > 1 )); then
  printf 'Usage: %s [vault-path]\n' "$0" >&2
  exit 2
fi

vault_path="${1:-$DEFAULT_VAULT}"
plugin_root="$vault_path/.obsidian/plugins"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

fail_sync() {
  printf 'Refusing to sync: %s\n' "$1" >&2
  exit 1
}

assert_regular_directory() {
  local candidate="$1"
  [[ ! -L "$candidate" ]] || fail_sync "directory is a symbolic link: $candidate"
  [[ -d "$candidate" ]] || fail_sync "directory is missing or not regular: $candidate"
}

assert_no_symlink_components() {
  local supplied="$1"
  local candidate current component
  if [[ "$supplied" == /* ]]; then
    candidate="$supplied"
  else
    candidate="$PWD/$supplied"
  fi
  current="/"
  IFS='/' read -r -a components <<< "$candidate"
  for component in "${components[@]}"; do
    case "$component" in
      ""|.) continue ;;
      ..)
        [[ "$current" == "/" ]] || current="$(dirname -- "$current")"
        continue
        ;;
    esac
    if [[ "$current" == "/" ]]; then
      current="/$component"
    else
      current="$current/$component"
    fi
    [[ ! -L "$current" ]] || fail_sync "vault path contains a symbolic link component: $current"
  done
}

assert_directory_chain() {
  local base="$1"
  local target="$2"
  local relative current component
  assert_regular_directory "$base"
  [[ "$target" == "$base" || "$target" == "$base/"* ]] || fail_sync "directory escapes plugin root: $target"
  relative="${target#"$base"}"
  relative="${relative#/}"
  [[ -n "$relative" ]] || return 0
  current="$base"
  IFS='/' read -r -a components <<< "$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != "." && "$component" != ".." ]] || continue
    current="$current/$component"
    assert_regular_directory "$current"
  done
}

ensure_directory_chain() {
  local base="$1"
  local target="$2"
  local relative current component
  assert_regular_directory "$base"
  [[ "$target" == "$base" || "$target" == "$base/"* ]] || fail_sync "directory escapes plugin root: $target"
  relative="${target#"$base"}"
  relative="${relative#/}"
  [[ -n "$relative" ]] || return 0
  current="$base"
  IFS='/' read -r -a components <<< "$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != "." && "$component" != ".." ]] || continue
    current="$current/$component"
    if [[ -e "$current" || -L "$current" ]]; then
      assert_regular_directory "$current"
    else
      mkdir -- "$current"
      assert_regular_directory "$current"
    fi
  done
}

path_identity() {
  if stat -f '%d:%i' -- "$1" >/dev/null 2>&1; then
    stat -f '%d:%i' -- "$1"
  else
    stat -c '%d:%i' -- "$1"
  fi
}

safe_copy_file() {
  local source="$1"
  local destination="$2"
  local parent parent_identity destination_identity="" temporary
  [[ ! -L "$source" && -f "$source" ]] || fail_sync "source is not a regular non-symlink file: $source"
  parent="$(dirname -- "$destination")"
  assert_directory_chain "$plugin_root" "$parent"
  parent_identity="$(path_identity "$parent")"
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ ! -L "$destination" && -f "$destination" ]] || fail_sync "destination is a symbolic link or non-regular file: $destination"
    destination_identity="$(path_identity "$destination")"
  fi

  temporary="$(mktemp "$parent/.mangosteen-sync.XXXXXX")"
  [[ ! -L "$temporary" && -f "$temporary" ]] || fail_sync "could not create a regular temporary file in: $parent"
  if ! cp -- "$source" "$temporary"; then
    rm -f -- "$temporary"
    fail_sync "copy failed for: $destination"
  fi
  [[ ! -L "$temporary" && -f "$temporary" ]] || { rm -f -- "$temporary"; fail_sync "temporary file changed during copy: $temporary"; }
  assert_directory_chain "$plugin_root" "$parent"
  [[ "$(path_identity "$parent")" == "$parent_identity" ]] || { rm -f -- "$temporary"; fail_sync "destination parent changed during copy: $parent"; }

  if [[ -n "$destination_identity" ]]; then
    [[ ! -L "$destination" && -f "$destination" && "$(path_identity "$destination")" == "$destination_identity" ]] \
      || { rm -f -- "$temporary"; fail_sync "destination changed during copy: $destination"; }
    mv -f -- "$temporary" "$destination"
  else
    if ! ln -- "$temporary" "$destination"; then
      rm -f -- "$temporary"
      fail_sync "destination appeared during copy: $destination"
    fi
    rm -f -- "$temporary"
  fi
  [[ ! -L "$destination" && -f "$destination" ]] || fail_sync "destination is not a regular file after copy: $destination"
}

assert_no_symlink_components "$vault_path"
assert_regular_directory "$vault_path"
assert_regular_directory "$vault_path/.obsidian"
assert_regular_directory "$plugin_root"

# Shared migration runtime is copied with the same no-symlink contract as each
# plugin target. Migration execution itself remains disabled unless the runtime
# is given a vetted descriptor-relative openat/*at capability.
safe_copy_file "$repo_root/plugins/migration-safe-fs.cjs" "$plugin_root/migration-safe-fs.cjs"

copy_plugin_files() {
  local plugin="$1"
  shift
  local source_dir="$repo_root/plugins/$plugin"
  local target_dir="$plugin_root/$plugin"
  local file destination

  ensure_directory_chain "$plugin_root" "$target_dir"
  for file in "$@"; do
    destination="$target_dir/$file"
    ensure_directory_chain "$plugin_root" "$(dirname -- "$destination")"
    safe_copy_file "$source_dir/$file" "$destination"
  done
}

copy_plugin_files mangosteen-image \
  main.js image-api.cjs output-storage.cjs history-migration.cjs manifest.json styles.css \
  tests/image-api.test.cjs tests/image-plugin.test.cjs tests/output-storage.test.cjs tests/history-migration.test.cjs

copy_plugin_files mangosteen-video \
  main.js video-api.cjs output-storage.cjs history-migration.cjs manifest.json styles.css \
  tests/video-api.test.cjs tests/video-plugin.test.cjs tests/output-storage.test.cjs tests/history-migration.test.cjs

copy_plugin_files mangosteen-video-replica \
  main.js generation-policy.cjs generation-queue.cjs project-storage.cjs project-migration.cjs run-state.cjs reference-assets.cjs replica-core.cjs replica-cli.cjs replica-editor.cjs replica-logic-api.cjs replica-cockpit-model.cjs replica-cockpit.cjs replica-ui-state.cjs replica-workbench.cjs shot-timeline.cjs visual-style.cjs video-analysis-schema.json manifest.json styles.css \
  tests/generation-policy.test.cjs tests/plugin-load.test.cjs tests/reference-assets.test.cjs \
  tests/generation-queue.test.cjs tests/run-state.test.cjs tests/replica-cli.test.cjs tests/replica-core.test.cjs tests/replica-editor.test.cjs \
  tests/replica-logic-api.test.cjs tests/replica-cockpit-model.test.cjs tests/replica-cockpit.test.cjs tests/replica-ui-state.test.cjs tests/replica-workbench.test.cjs \
  tests/workbench-queue-plugin.test.cjs tests/shot-timeline.test.cjs tests/visual-style.test.cjs tests/project-migration.test.cjs

agent_main="$plugin_root/mangosteen-agent/main.js"
if [[ -e "$agent_main" || -L "$agent_main" ]]; then
  assert_directory_chain "$plugin_root" "$(dirname -- "$agent_main")"
  [[ ! -L "$agent_main" && -f "$agent_main" ]] || fail_sync "mangosteen-agent main.js is not a regular non-symlink file: $agent_main"
  node "$repo_root/scripts/patch-mangosteen-agent-structured-analysis.cjs" "$agent_main"
else
  printf 'Warning: mangosteen-agent is not installed; video analysis will remain unavailable.\n' >&2
fi

printf 'Synced allow-listed plugin code to %s\n' "$plugin_root"
