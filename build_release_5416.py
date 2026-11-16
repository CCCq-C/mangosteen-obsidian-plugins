#!/usr/bin/env python3
import hashlib
import json
import re
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BASE_ARCHIVE = ROOT / "mangosteen-obsidian-plugins-5.4.15.zip"
BASE_SHA256 = "9576cd348ad7b6a26da56b7a1112bb26b73520edfab3a7cc18ac96cce9af11db"
VERSION = "5.4.16"
OUTPUT = ROOT / f"mangosteen-obsidian-plugins-{VERSION}.zip"
OVERRIDES = ROOT / "release-src" / VERSION / "mangosteen-updater"
TEXT_SUFFIXES = {".js", ".cjs", ".json", ".ps1", ".sh", ".md", ".txt"}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_release_boundary(root):
    for path in root.rglob("*"):
        if "codex-weixin" in path.name.lower():
            raise SystemExit("UNRELATED_PROJECT_FOUND")
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8-sig", errors="ignore")
        if re.search(r"(?i)\.?codex-weixin", text):
            raise SystemExit("UNRELATED_PROJECT_FOUND")
        if re.search(r"(?i)[A-Z]:\\Users\\[^\\\r\n]+\\", text):
            raise SystemExit("DEVELOPER_PATH_FOUND")


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
        raise SystemExit("5.4.15 基础包哈希不一致")
    with tempfile.TemporaryDirectory(prefix="mangosteen-5416-") as temporary:
        stage = Path(temporary) / "package"
        with zipfile.ZipFile(BASE_ARCHIVE) as archive:
            archive.extractall(stage)
        updater = stage / "mangosteen-updater"
        shutil.rmtree(updater)
        shutil.copytree(OVERRIDES, updater)
        for shell_script in stage.rglob("*.sh"):
            content = shell_script.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
            shell_script.write_text(content, encoding="utf-8", newline="\n")
            shell_script.chmod(0o755)
        assert_release_boundary(stage)
        write_archive(stage, OUTPUT)

    digest = sha256(OUTPUT)
    latest_path = ROOT / "latest-v2.json"
    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    latest.update({
        "version": VERSION,
        "package": OUTPUT.name,
        "sha256": digest,
        "notes": [
            "修复 Windows 自定义安装路径无法重新启动 Obsidian",
            "Windows 更新器使用当前正在运行的 Obsidian 可执行文件路径",
            "继承 Mac 5.4.15 重启修复，并移除 Python 3 依赖",
            "Windows 5.4.15 如未自动关闭 Obsidian，请手动退出一次完成升级",
            "包含 5.4.14 的视频高级参考材料与重复提交保护",
        ],
    })
    latest["components"]["mangosteen-updater"] = VERSION
    latest_path.write_text(json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_checksums(OUTPUT.name, digest)
    print(f"{OUTPUT.name} {digest}")


if __name__ == "__main__":
    main()
