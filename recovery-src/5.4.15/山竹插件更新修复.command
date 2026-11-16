#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "$0")" && pwd -P)"
FIXED_SCRIPT="$SCRIPT_DIR/files/restart-update.sh"
FIXED_JSON="$SCRIPT_DIR/files/restart-update-json.js"

fail() {
  printf '\n修复失败：%s\n' "$1" >&2
  if [[ "${MANGOSTEEN_NO_PAUSE:-0}" != "1" && -t 0 ]]; then
    read -r -p "按回车键关闭窗口..." _unused || true
  fi
  exit 1
}

[[ -f "$FIXED_SCRIPT" && -f "$FIXED_JSON" ]] || fail "修复包文件不完整，请重新解压后再运行。"

if [[ -n "${MANGOSTEEN_TEST_VAULT_PATH:-}" ]]; then
  VAULT_PATH="$MANGOSTEEN_TEST_VAULT_PATH"
else
  VAULT_PATH="$(/usr/bin/osascript <<'APPLESCRIPT'
try
  POSIX path of (choose folder with prompt "请选择出现更新问题的 Obsidian 知识库文件夹")
on error number -128
  return ""
end try
APPLESCRIPT
)"
fi

VAULT_PATH="${VAULT_PATH%/}"
[[ -n "$VAULT_PATH" ]] || fail "没有选择知识库。"
[[ -d "$VAULT_PATH/.obsidian/plugins" ]] || fail "所选文件夹不是有效的 Obsidian 知识库。"

BACKUP_ROOT="$VAULT_PATH/.mangosteen-updater/repair-backup-$(/bin/date +%Y%m%d-%H%M%S)-$$"
/bin/mkdir -p "$BACKUP_ROOT"

UPDATER_DIRS=(
  "$VAULT_PATH/.obsidian/plugins/mangosteen-updater"
  "$VAULT_PATH/.obsidian/plugins/mangosteen-agent/bundled-updater"
  "$VAULT_PATH/.obsidian/plugins/mangosteen-media-core/bundled-updater"
  "$VAULT_PATH/.obsidian/plugins/mangosteen-image/bundled-updater"
  "$VAULT_PATH/.obsidian/plugins/mangosteen-video/bundled-updater"
  "$VAULT_PATH/.obsidian/plugins/mangosteen-workbench/bundled-updater"
)

repaired=0
for updater_dir in "${UPDATER_DIRS[@]}"; do
  [[ -f "$updater_dir/restart-update.sh" && -f "$updater_dir/updater-core.cjs" ]] || continue
  /usr/bin/grep -Fq "latest-v2.json" "$updater_dir/updater-core.cjs" || continue

  relative="${updater_dir#"$VAULT_PATH"/}"
  backup_dir="$BACKUP_ROOT/$relative"
  /bin/mkdir -p "$backup_dir"
  /usr/bin/ditto "$updater_dir/restart-update.sh" "$backup_dir/restart-update.sh"
  if [[ -f "$updater_dir/restart-update-json.js" ]]; then
    /usr/bin/ditto "$updater_dir/restart-update-json.js" "$backup_dir/restart-update-json.js"
  fi

  /usr/bin/ditto "$FIXED_SCRIPT" "$updater_dir/restart-update.sh"
  /usr/bin/ditto "$FIXED_JSON" "$updater_dir/restart-update-json.js"
  /bin/chmod 755 "$updater_dir/restart-update.sh"
  repaired=$((repaired + 1))
done

[[ "$repaired" -gt 0 ]] || fail "没有找到需要修复的山竹 5.4.14 更新器。"

printf '\n修复完成：已修复 %s 处更新器。\n备份位置：%s\n' "$repaired" "$BACKUP_ROOT"
if [[ "${MANGOSTEEN_NO_OPEN:-0}" != "1" ]]; then
  /usr/bin/open -a Obsidian "$VAULT_PATH" >/dev/null 2>&1 || true
fi
if [[ "${MANGOSTEEN_NO_PAUSE:-0}" != "1" && -t 0 ]]; then
  read -r -p "按回车键关闭窗口..." _unused || true
fi
