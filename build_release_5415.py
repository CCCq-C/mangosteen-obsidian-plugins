#!/usr/bin/env python3
import hashlib
import json
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BASE_ARCHIVE = ROOT / "mangosteen-obsidian-plugins-5.4.14.zip"
BASE_SHA256 = "234f7d449c53f17844bdce1a6e2da63d466281b875628ea3fe6f0f2c0a3dbda4"
VERSION = "5.4.15"
OUTPUT = ROOT / f"mangosteen-obsidian-plugins-{VERSION}.zip"
RECOVERY_OUTPUT = ROOT / f"mangosteen-mac-update-repair-{VERSION}.zip"
OVERRIDES = ROOT / "release-src" / VERSION / "mangosteen-updater"
RECOVERY_SOURCE = ROOT / "recovery-src" / VERSION


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_archive(source, output):
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(item for item in source.rglob("*") if item.is_file()):
            relative = path.relative_to(source).as_posix()
            info = zipfile.ZipInfo(relative, date_time=(2026, 11, 16, 0, 0, 0))
            info.create_system = 3
            executable = path.suffix in {".sh", ".command"}
            mode = stat.S_IFREG | (0o755 if executable else 0o644)
            info.external_attr = mode << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())


def update_checksums(file_name, digest):
    checksum_file = ROOT / "SHA256SUMS"
    entries = {}
    for line in checksum_file.read_text(encoding="utf-8").splitlines():
        value, name = line.split("  ", 1)
        entries[name] = value
    entries[file_name] = digest
    checksum_file.write_text(
        "\n".join(f"{value}  {name}" for name, value in entries.items()) + "\n",
        encoding="utf-8",
    )


def main():
    if sha256(BASE_ARCHIVE) != BASE_SHA256:
        raise SystemExit("5.4.14 基础包哈希不一致")
    with tempfile.TemporaryDirectory(prefix="mangosteen-5415-") as temporary:
        stage = Path(temporary) / "package"
        with zipfile.ZipFile(BASE_ARCHIVE) as archive:
            archive.extractall(stage)
        updater = stage / "mangosteen-updater"
        main_js = (updater / "main.js").read_text(encoding="utf-8-sig")
        close_call = "      window.setTimeout(() => window.close(), 500);\n"
        if main_js.count(close_call) != 1:
            raise SystemExit("未找到唯一的提前关窗逻辑")
        (updater / "main.js").write_text(main_js.replace(close_call, ""), encoding="utf-8", newline="\n")
        for name in ("restart-update.sh", "restart-update-json.js"):
            shutil.copy2(OVERRIDES / name, updater / name)
        updater_manifest = json.loads((updater / "manifest.json").read_text(encoding="utf-8-sig"))
        updater_manifest["version"] = VERSION
        (updater / "manifest.json").write_text(
            json.dumps(updater_manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        for shell_script in stage.rglob("*.sh"):
            content = shell_script.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
            shell_script.write_text(content, encoding="utf-8", newline="\n")
            shell_script.chmod(0o755)
        write_archive(stage, OUTPUT)

        recovery_stage = Path(temporary) / "recovery"
        recovery_root = recovery_stage / f"山竹插件更新修复-{VERSION}"
        shutil.copytree(RECOVERY_SOURCE, recovery_root)
        recovery_files = recovery_root / "files"
        recovery_files.mkdir()
        for name in ("restart-update.sh", "restart-update-json.js"):
            shutil.copy2(OVERRIDES / name, recovery_files / name)
        write_archive(recovery_stage, RECOVERY_OUTPUT)

    digest = sha256(OUTPUT)
    latest_path = ROOT / "latest-v2.json"
    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    latest.update({
        "version": VERSION,
        "package": OUTPUT.name,
        "sha256": digest,
        "notes": [
            "修复 Mac 更新后 Obsidian 关闭但没有重新启动",
            "Mac 更新脚本统一为 LF，并移除 Python 3 依赖",
            "后台更新失败时保留或重新打开 Obsidian",
            "包含 5.4.14 的视频高级参考材料与重复提交保护",
        ],
    })
    latest["components"]["mangosteen-updater"] = VERSION
    latest_path.write_text(json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_checksums(OUTPUT.name, digest)
    recovery_digest = sha256(RECOVERY_OUTPUT)
    update_checksums(RECOVERY_OUTPUT.name, recovery_digest)
    print(f"{OUTPUT.name} {digest}")
    print(f"{RECOVERY_OUTPUT.name} {recovery_digest}")


if __name__ == "__main__":
    main()
