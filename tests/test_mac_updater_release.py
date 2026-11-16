import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LATEST = ROOT / "latest-v2.json"
RECOVERY_ARCHIVE = ROOT / "mangosteen-mac-update-repair-5.4.15.zip"
TARGETS = [
    "mangosteen-media-core",
    "mangosteen-claudian",
    "mangosteen-image",
    "mangosteen-video",
    "mangosteen-workbench",
    "mangosteen-updater",
]


def write(path, content, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(mode)


class MacUpdaterReleaseTests(unittest.TestCase):
    def latest(self):
        manifest = json.loads(LATEST.read_text(encoding="utf-8"))
        archive = ROOT / manifest["package"]
        self.assertTrue(archive.is_file(), archive)
        return manifest, archive

    def test_restart_helper_is_lf_parseable_and_python_free(self):
        _manifest, archive = self.latest()
        with zipfile.ZipFile(archive) as package:
            script = package.read("mangosteen-updater/restart-update.sh")
            self.assertNotIn(b"\r\n", script)
            self.assertNotIn(b"python3", script)
            self.assertIn("mangosteen-updater/restart-update-json.js", package.namelist())
        with tempfile.TemporaryDirectory() as temporary:
            helper = Path(temporary) / "restart-update.sh"
            helper.write_bytes(script)
            parsed = subprocess.run(
                ["/bin/bash", "-n", str(helper)],
                text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
            )
            self.assertEqual(0, parsed.returncode, parsed.stdout + parsed.stderr)

    def test_restart_helper_applies_v2_update_without_python(self):
        manifest, archive = self.latest()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            helper_dir = root / "helper"
            helper_dir.mkdir()
            with zipfile.ZipFile(archive) as package:
                available = set(package.namelist())
                for name in ("restart-update.sh", "restart-update-json.js"):
                    if f"mangosteen-updater/{name}" not in available:
                        continue
                    target = helper_dir / name
                    target.write_bytes(package.read(f"mangosteen-updater/{name}"))
                    target.chmod(0o755 if name.endswith(".sh") else 0o644)

            vault = root / "用户 知识库"
            updater_root = vault / ".mangosteen-updater"
            extracted = updater_root / "staging/extracted"
            plugins = vault / ".obsidian/plugins"
            components = {
                "mangosteen-media-core": manifest["components"]["mangosteen-media-core"],
                "mangosteen-claudian": manifest["claudianVersion"],
                "mangosteen-image": manifest["components"]["mangosteen-image"],
                "mangosteen-video": manifest["components"]["mangosteen-video"],
                "mangosteen-workbench": manifest["components"]["mangosteen-workbench"],
                "mangosteen-updater": manifest["components"]["mangosteen-updater"],
            }
            for plugin_id, version in components.items():
                write(extracted / plugin_id / "manifest.json", json.dumps({"id": plugin_id, "version": version}))
                write(extracted / plugin_id / "main.js", f"new:{plugin_id}\n")
            write(
                updater_root / "staging/pending.json",
                json.dumps({
                    "schemaVersion": 2,
                    "version": manifest["version"],
                    "components": components,
                    "removeAfterVerify": ["mangosteen-agent"],
                }),
            )
            write(plugins / "mangosteen-video/manifest.json", json.dumps({"id": "mangosteen-video", "version": "old"}))
            write(plugins / "mangosteen-video/main.js", "old\n")
            write(plugins / "mangosteen-video/data.json", '{"keep":true}\n')
            write(plugins / "mangosteen-agent/manifest.json", json.dumps({"id": "mangosteen-agent", "version": "old"}))
            write(plugins / "mangosteen-agent/main.js", "legacy\n")
            write(vault / ".obsidian/community-plugins.json", json.dumps(["mangosteen-agent", "unrelated-plugin"]))

            environment = os.environ.copy()
            environment["PATH"] = "/usr/bin:/bin"
            applied = subprocess.run(
                ["/bin/bash", str(helper_dir / "restart-update.sh"), "--vault-path", str(vault), "--skip-relaunch"],
                text=True, encoding="utf-8", errors="replace", capture_output=True, check=False, env=environment,
            )
            self.assertEqual(0, applied.returncode, applied.stdout + applied.stderr)
            result = json.loads((updater_root / "result.json").read_text(encoding="utf-8"))
            self.assertEqual({"status": "success", "version": manifest["version"], "diagnostic": ""}, result)
            self.assertFalse((plugins / "mangosteen-agent").exists())
            self.assertEqual('{"keep":true}\n', (plugins / "mangosteen-video/data.json").read_text(encoding="utf-8"))
            enabled = json.loads((vault / ".obsidian/community-plugins.json").read_text(encoding="utf-8"))
            self.assertEqual(TARGETS, enabled[: len(TARGETS)])
            self.assertIn("unrelated-plugin", enabled)

    def test_updater_does_not_force_close_after_helper_spawn(self):
        _manifest, archive = self.latest()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with zipfile.ZipFile(archive) as package:
                main_path = root / "main.js"
                main_path.write_bytes(package.read("mangosteen-updater/main.js"))
            harness = root / "harness.cjs"
            write(
                harness,
                "const Module = require('module');\n"
                "Object.defineProperty(process, 'platform', { value: 'darwin' });\n"
                "const originalLoad = Module._load;\n"
                "class Empty {}\n"
                "class Notice { hide() {} setMessage() {} }\n"
                "Module._load = function(request, parent, isMain) {\n"
                "  if (request === 'obsidian') return { Modal: Empty, Notice, Plugin: Empty, PluginSettingTab: Empty, requestUrl: async () => ({}) };\n"
                "  return originalLoad.call(this, request, parent, isMain);\n"
                "};\n"
                "let closed = 0;\n"
                "global.window = { setTimeout(fn) { fn(); return 1; }, close() { closed += 1; } };\n"
                "const Updater = require(process.argv[2]);\n"
                "const plugin = new Updater();\n"
                "plugin.app = { plugins: { setEnable: async () => {} } };\n"
                "plugin.core = { prepare: async () => ({ prepared: true, version: '5.4.15' }) };\n"
                "plugin.vaultPath = () => '/tmp/test-vault';\n"
                "plugin.ensureRequiredPluginsEnabled = async () => {};\n"
                "plugin.launchDeferredInstall = async () => 12345;\n"
                "plugin.installConfirmedUpdate().then(() => {\n"
                "  if (closed !== 0) { console.error('window.close called before helper completion'); process.exit(1); }\n"
                "}).catch((error) => { console.error(error); process.exit(2); });\n",
            )
            result = subprocess.run(
                ["node", str(harness), str(main_path)],
                text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
            )
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_recovery_command_repairs_existing_v2_updater(self):
        self.assertTrue(RECOVERY_ARCHIVE.is_file(), RECOVERY_ARCHIVE)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recovery = root / "recovery"
            extracted = subprocess.run(
                ["/usr/bin/ditto", "-x", "-k", str(RECOVERY_ARCHIVE), str(recovery)],
                text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
            )
            self.assertEqual(0, extracted.returncode, extracted.stdout + extracted.stderr)
            recovery_root = recovery / "山竹插件更新修复-5.4.15"
            command = recovery_root / "山竹插件更新修复.command"
            self.assertTrue(command.stat().st_mode & 0o111)

            vault = root / "用户 知识库"
            updater = vault / ".obsidian/plugins/mangosteen-agent/bundled-updater"
            write(updater / "updater-core.cjs", 'const feed = "latest-v2.json";\n')
            old_script = b"#!/bin/bash\r\necho broken\r\n"
            (updater / "restart-update.sh").parent.mkdir(parents=True, exist_ok=True)
            (updater / "restart-update.sh").write_bytes(old_script)

            environment = os.environ.copy()
            environment.update({
                "MANGOSTEEN_TEST_VAULT_PATH": str(vault),
                "MANGOSTEEN_NO_OPEN": "1",
            })
            repaired = subprocess.run(
                ["/bin/bash", str(command)],
                text=True, encoding="utf-8", errors="replace", capture_output=True, check=False, env=environment,
            )
            self.assertEqual(0, repaired.returncode, repaired.stdout + repaired.stderr)
            installed = (updater / "restart-update.sh").read_bytes()
            self.assertNotIn(b"\r\n", installed)
            self.assertNotIn(b"python3", installed)
            self.assertTrue((updater / "restart-update-json.js").is_file())
            backups = list((vault / ".mangosteen-updater").glob("repair-backup-*/**/restart-update.sh"))
            self.assertEqual(1, len(backups), backups)
            self.assertEqual(old_script, backups[0].read_bytes())


if __name__ == "__main__":
    unittest.main()
