const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-sync-plugin-"));
const pluginRoot = path.join(vault, ".obsidian/plugins");
const target = path.join(pluginRoot, "mangosteen-video-replica");
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, "user-owned-sentinel.txt"), "keep");

try {
  const sync = spawnSync("bash", [path.join(repoRoot, "scripts/sync-plugin-code-to-vault.sh"), vault], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.strictEqual(sync.status, 0, sync.stderr || sync.stdout);
  for (const file of [
    "main.js",
    "replica-core.cjs",
    "replica-cli.cjs",
    "replica-editor.cjs",
    "replica-ui-state.cjs",
    "replica-workbench.cjs",
    "tests/plugin-load.test.cjs",
    "tests/replica-editor.test.cjs",
    "tests/replica-ui-state.test.cjs",
    "tests/replica-workbench.test.cjs",
  ]) assert(fs.statSync(path.join(target, file), { throwIfNoEntry: false })?.isFile(), `missing synced allowlist file: ${file}`);
  assert.strictEqual(fs.readFileSync(path.join(target, "user-owned-sentinel.txt"), "utf8"), "keep", "sync must not delete user files");

  const copiedLoad = spawnSync(process.execPath, [path.join(target, "tests/plugin-load.test.cjs")], {
    cwd: vault,
    encoding: "utf8",
  });
  assert.strictEqual(copiedLoad.status, 0, copiedLoad.stderr || copiedLoad.stdout);
  assert.match(copiedLoad.stdout, /plugin-load: ok/);
} finally {
  fs.rmSync(vault, { recursive: true, force: true });
}

console.log("sync-plugin-code-to-vault: ok");
