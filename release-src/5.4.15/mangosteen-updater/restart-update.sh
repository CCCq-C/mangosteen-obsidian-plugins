#!/bin/bash
set -Eeuo pipefail

VAULT_PATH=""
WAIT_PROCESS_ID=0
SKIP_RELAUNCH=0
REQUEST_QUIT=0
LAST_ERROR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault-path) VAULT_PATH="${2:-}"; shift 2 ;;
    --wait-process-id) WAIT_PROCESS_ID="${2:-0}"; shift 2 ;;
    --skip-relaunch) SKIP_RELAUNCH=1; shift ;;
    --request-quit) REQUEST_QUIT=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ "$VAULT_PATH" == /* && -d "$VAULT_PATH" ]] || { echo "知识库路径无效" >&2; exit 2; }
SCRIPT_DIR="$(cd "$(/usr/bin/dirname "$0")" && pwd -P)"
JSON_HELPER="$SCRIPT_DIR/restart-update-json.js"
[[ -f "$JSON_HELPER" ]] || { echo "缺少 Mac JSON 更新组件" >&2; exit 2; }
UPDATER_ROOT="$VAULT_PATH/.mangosteen-updater"
STAGING="$UPDATER_ROOT/staging"
EXTRACTED="$STAGING/extracted"
PENDING="$STAGING/pending.json"
PLUGINS="$VAULT_PATH/.obsidian/plugins"
ENABLED="$VAULT_PATH/.obsidian/community-plugins.json"
BACKUP="$UPDATER_ROOT/backup"
COMPONENTS="$UPDATER_ROOT/components.tsv"
JOURNAL="$BACKUP/journal.tsv"
VERSION_FILE="$UPDATER_ROOT/version.txt"
RESULT="$UPDATER_ROOT/result.json"
TARGETS=(mangosteen-media-core mangosteen-claudian mangosteen-image mangosteen-video mangosteen-workbench mangosteen-updater)
LEGACY=(mangosteen-agent)

run_json() {
  /usr/bin/osascript -l JavaScript "$JSON_HELPER" "$@"
}

write_result() {
  run_json write-result "$RESULT" "$1" "$2" "${3:-}" >/dev/null
}

relaunch_obsidian() {
  [[ "$SKIP_RELAUNCH" == "1" ]] && return 0
  /usr/bin/open -a Obsidian "$VAULT_PATH" >/dev/null 2>&1 || true
}

rollback() {
  [[ -f "$JOURNAL" ]] || return 0
  while IFS=$'\t' read -r plugin_id had_original; do
    [[ -n "$plugin_id" ]] || continue
    destination="$PLUGINS/$plugin_id"
    rm -rf "$destination"
    if [[ "$had_original" == "1" && -d "$BACKUP/plugins/$plugin_id" ]]; then
      /usr/bin/ditto "$BACKUP/plugins/$plugin_id" "$destination"
    fi
  done < "$JOURNAL"
  if [[ -f "$BACKUP/community-plugins.existed" ]]; then
    cp "$BACKUP/community-plugins.json" "$ENABLED"
  else
    rm -f "$ENABLED"
  fi
}

failed() {
  local status="${1:-1}" line="${2:-unknown}" command="${3:-unknown}"
  trap - ERR
  rollback || true
  local version diagnostic
  version="$(cat "$VERSION_FILE" 2>/dev/null || true)"
  diagnostic="$UPDATER_ROOT/mac-update-error.txt"
  {
    printf '山竹插件更新失败，旧版本已恢复。\n'
    [[ -n "$LAST_ERROR" ]] && printf '原因：%s\n' "$LAST_ERROR"
    printf '位置：第 %s 行\n命令：%s\n' "$line" "$command"
  } > "$diagnostic"
  write_result "failed" "$version" "$diagnostic" || true
  relaunch_obsidian
  exit "$status"
}
trap 'failed "$?" "$LINENO" "$BASH_COMMAND"' ERR

[[ -f "$PENDING" && -d "$EXTRACTED" ]] || { echo "更新暂存文件不完整" >&2; exit 1; }
mkdir -p "$UPDATER_ROOT" "$PLUGINS"
rm -rf "$BACKUP"
mkdir -p "$BACKUP/plugins"
rm -f "$COMPONENTS" "$VERSION_FILE"

if validation_output="$(run_json validate "$PENDING" "$EXTRACTED" "$COMPONENTS" "$VERSION_FILE" 2>&1)"; then
  :
else
  validation_status="$?"
  LAST_ERROR="$validation_output"
  printf '%s\n' "$LAST_ERROR" >&2
  failed "$validation_status" "$LINENO" "校验更新清单"
fi

if [[ "$REQUEST_QUIT" == "1" ]]; then
  /usr/bin/osascript -e 'tell application id "md.obsidian" to quit' >/dev/null 2>&1 || {
    LAST_ERROR="无法请求 Obsidian 完整退出"
    false
  }
fi
if [[ "$WAIT_PROCESS_ID" =~ ^[0-9]+$ && "$WAIT_PROCESS_ID" -gt 0 ]]; then
  for _attempt in $(seq 1 60); do
    kill -0 "$WAIT_PROCESS_ID" 2>/dev/null || break
    sleep 2
  done
  if kill -0 "$WAIT_PROCESS_ID" 2>/dev/null; then
    LAST_ERROR="等待 Obsidian 退出超时"
    false
  fi
fi

if [[ -f "$ENABLED" ]]; then
  cp "$ENABLED" "$BACKUP/community-plugins.json"
  : > "$BACKUP/community-plugins.existed"
fi
for plugin_id in "${TARGETS[@]}" "${LEGACY[@]}"; do
  destination="$PLUGINS/$plugin_id"
  had_original=0
  if [[ -d "$destination" ]]; then
    /usr/bin/ditto "$destination" "$BACKUP/plugins/$plugin_id"
    had_original=1
  fi
  printf '%s\t%s\n' "$plugin_id" "$had_original" >> "$JOURNAL"
done

while IFS=$'\t' read -r plugin_id _version; do
  [[ -n "$plugin_id" ]] || continue
  destination="$PLUGINS/$plugin_id"
  incoming="$EXTRACTED/$plugin_id"
  preserved="$UPDATER_ROOT/$plugin_id.data.json"
  rm -f "$preserved"
  [[ -f "$destination/data.json" ]] && cp "$destination/data.json" "$preserved"
  replaced=0
  for _attempt in $(seq 1 60); do
    if rm -rf "$destination" && /usr/bin/ditto "$incoming" "$destination"; then
      replaced=1
      break
    fi
    sleep 2
  done
  if [[ "$replaced" != "1" ]]; then
    LAST_ERROR="插件文件占用超时：$plugin_id"
    false
  fi
  [[ -f "$preserved" ]] && cp "$preserved" "$destination/data.json"
done < "$COMPONENTS"

run_json update-enabled "$ENABLED" "${TARGETS[@]}" >/dev/null
rm -rf "$PLUGINS/mangosteen-agent"

version="$(cat "$VERSION_FILE")"
if [[ "$SKIP_RELAUNCH" != "1" ]]; then
  /usr/bin/open -a Obsidian "$VAULT_PATH"
  started=0
  for _attempt in $(seq 1 30); do
    if /usr/bin/pgrep -x Obsidian >/dev/null 2>&1; then
      started=1
      break
    fi
    sleep 1
  done
  if [[ "$started" != "1" ]]; then
    LAST_ERROR="Obsidian 重新启动失败"
    false
  fi
fi

write_result "success" "$version" ""
rm -rf "$STAGING"
exit 0
