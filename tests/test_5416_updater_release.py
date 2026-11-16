import hashlib
import json
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION = "5.4.16"
ARCHIVE = ROOT / f"mangosteen-obsidian-plugins-{VERSION}.zip"
BASE_ARCHIVE = ROOT / "mangosteen-obsidian-plugins-5.4.15.zip"
LATEST = ROOT / "latest-v2.json"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Updater5416ReleaseTests(unittest.TestCase):
    def test_manifest_hash_and_component_versions_match_archive(self):
        latest = json.loads(LATEST.read_text("utf-8"))
        self.assertEqual(VERSION, latest["version"])
        self.assertEqual(ARCHIVE.name, latest["package"])
        self.assertEqual(sha256(ARCHIVE), latest["sha256"])
        self.assertEqual(VERSION, latest["components"]["mangosteen-updater"])
        with zipfile.ZipFile(ARCHIVE) as package:
            manifest = json.loads(package.read("mangosteen-updater/manifest.json"))
        self.assertEqual(VERSION, manifest["version"])

    def test_windows_launcher_passes_the_running_obsidian_executable(self):
        with zipfile.ZipFile(ARCHIVE) as package:
            main = package.read("mangosteen-updater/main.js").decode("utf-8-sig")
            helper = package.read("mangosteen-updater/restart-update.ps1").decode("utf-8-sig")
        self.assertIn('if (process.platform === "win32") window.setTimeout(() => window.close(), 500);', main)
        self.assertIn("-ObsidianExecutable ${psLiteral(process.execPath)}", main)
        self.assertIn("[string]$ObsidianExecutable", helper)
        self.assertIn("$ObsidianExecutable,", helper)

    def test_mac_5415_repair_is_preserved_byte_for_byte(self):
        with zipfile.ZipFile(BASE_ARCHIVE) as previous, zipfile.ZipFile(ARCHIVE) as current:
            for name in ("restart-update.sh", "restart-update-json.js"):
                path = f"mangosteen-updater/{name}"
                self.assertEqual(previous.read(path), current.read(path), name)
            shell = current.read("mangosteen-updater/restart-update.sh")
        self.assertNotIn(b"\r\n", shell)
        self.assertNotIn(b"python3", shell)

    def test_archive_contains_no_local_project_or_machine_state(self):
        text_suffixes = {".js", ".cjs", ".json", ".ps1", ".sh", ".md", ".txt"}
        with zipfile.ZipFile(ARCHIVE) as package:
            for name in package.namelist():
                lowered = name.lower()
                self.assertNotIn("codex-weixin", lowered, name)
                self.assertFalse(lowered.endswith(("data.json", ".log", ".jsonl")), name)
                if Path(name).suffix.lower() in text_suffixes:
                    text = package.read(name).decode("utf-8-sig", errors="ignore").lower()
                    self.assertNotIn("codex-weixin", text, name)
                    self.assertNotIn("c:\\users\\c1773", text, name)


if __name__ == "__main__":
    unittest.main()
