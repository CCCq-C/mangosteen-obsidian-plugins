const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "scripts/sync-plugin-code-to-vault.sh");
const temporaryRoots = [];
const temporary = (prefix) => {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(result);
  return result;
};
const run = (vault) => spawnSync("bash", [script, vault], { cwd: repoRoot, encoding: "utf8" });

function attackFixture() {
  const vault = temporary("mangosteen-sync-attack-vault-");
  const outside = temporary("mangosteen-sync-attack-outside-");
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside sentinel");
  return { vault, outside };
}

function assertAttackFails(name, setup) {
  const { vault, outside } = attackFixture();
  setup({ vault, outside });
  const result = run(vault);
  assert.notStrictEqual(result.status, 0, `${name} must fail\n${result.stdout}\n${result.stderr}`);
  assert.strictEqual(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "outside sentinel", `${name} changed outside sentinel`);
  assert.deepStrictEqual(fs.readdirSync(outside).sort(), ["sentinel.txt"], `${name} wrote outside the vault`);
}

try {
  const vault = temporary("mangosteen-sync-plugin-");
  const pluginRoot = path.join(vault, ".obsidian/plugins");
  const target = path.join(pluginRoot, "mangosteen-video-replica");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "user-owned-sentinel.txt"), "keep");
  const sync = run(vault);
  assert.strictEqual(sync.status, 0, sync.stderr || sync.stdout);
  const sharedRuntime = path.join(pluginRoot, "migration-safe-fs.cjs");
  assert(fs.lstatSync(sharedRuntime).isFile() && !fs.lstatSync(sharedRuntime).isSymbolicLink(), "missing regular shared migration runtime");
  assert.strictEqual(fs.readFileSync(sharedRuntime, "utf8"), fs.readFileSync(path.join(repoRoot, "plugins/migration-safe-fs.cjs"), "utf8"));
  for (const file of [
    "main.js", "replica-core.cjs", "replica-cli.cjs", "replica-editor.cjs", "replica-ui-state.cjs",
    "replica-workbench.cjs", "shot-timeline.cjs", "visual-style.cjs", "tests/plugin-load.test.cjs",
    "tests/replica-editor.test.cjs", "tests/replica-ui-state.test.cjs", "tests/replica-workbench.test.cjs",
    "tests/visual-style.test.cjs",
  ]) assert(fs.lstatSync(path.join(target, file)).isFile(), `missing synced allowlist file: ${file}`);
  assert.strictEqual(fs.readFileSync(path.join(target, "user-owned-sentinel.txt"), "utf8"), "keep", "sync must not delete user files");
  fs.writeFileSync(path.join(target, "main.js"), "stale copy");
  const replacementSync = run(vault);
  assert.strictEqual(replacementSync.status, 0, replacementSync.stderr || replacementSync.stdout);
  assert.strictEqual(fs.readFileSync(path.join(target, "main.js"), "utf8"), fs.readFileSync(path.join(repoRoot, "plugins/mangosteen-video-replica/main.js"), "utf8"), "validated replacement must refresh an existing regular destination");
  const copiedLoad = spawnSync(process.execPath, [path.join(target, "tests/plugin-load.test.cjs")], { cwd: vault, encoding: "utf8" });
  assert.strictEqual(copiedLoad.status, 0, copiedLoad.stderr || copiedLoad.stdout);
  assert.match(copiedLoad.stdout, /plugin-load: ok/);

  assertAttackFails("plugin root symlink", ({ vault: attacked, outside }) => {
    fs.mkdirSync(path.join(attacked, ".obsidian"));
    fs.symlinkSync(outside, path.join(attacked, ".obsidian/plugins"), "dir");
  });
  assertAttackFails("plugin directory symlink", ({ vault: attacked, outside }) => {
    fs.mkdirSync(path.join(attacked, ".obsidian/plugins"), { recursive: true });
    fs.symlinkSync(outside, path.join(attacked, ".obsidian/plugins/mangosteen-image"), "dir");
  });
  assertAttackFails("destination file symlink", ({ vault: attacked, outside }) => {
    const dir = path.join(attacked, ".obsidian/plugins/mangosteen-image");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(outside, "sentinel.txt"), path.join(dir, "main.js"));
  });
  assertAttackFails("destination parent symlink", ({ vault: attacked, outside }) => {
    const dir = path.join(attacked, ".obsidian/plugins/mangosteen-image");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "tests"), "dir");
  });
  assertAttackFails("shared runtime symlink", ({ vault: attacked, outside }) => {
    const root = path.join(attacked, ".obsidian/plugins");
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(path.join(outside, "sentinel.txt"), path.join(root, "migration-safe-fs.cjs"));
  });
} finally {
  for (const root of temporaryRoots.reverse()) fs.rmSync(root, { recursive: true, force: true });
}

console.log("sync-plugin-code-to-vault: ok");
