const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  MIGRATION_SAFE_FS_UNAVAILABLE,
  createSafeMigrationFs,
} = require("../../migration-safe-fs.cjs");

function fixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-safe-fs-vault-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-safe-fs-outside-"));
  fs.mkdirSync(path.join(vault, "source"));
  fs.mkdirSync(path.join(vault, "preview"));
  fs.mkdirSync(path.join(vault, "target"));
  fs.mkdirSync(path.join(vault, "journal"));
  fs.writeFileSync(path.join(vault, "preview/item.bin"), "preview bytes");
  fs.writeFileSync(path.join(outside, "sentinel.bin"), "outside sentinel");
  // A hardlink defeats checks that trust an inode comparison after reopening by path.
  fs.linkSync(path.join(outside, "sentinel.bin"), path.join(vault, "source/sentinel.bin"));
  return { vault, outside };
}

function assertOutsideUntouched(outside) {
  assert.deepStrictEqual(fs.readdirSync(outside), ["sentinel.bin"]);
  assert.strictEqual(fs.readFileSync(path.join(outside, "sentinel.bin"), "utf8"), "outside sentinel");
}

(() => {
  const raced = fixture();
  const safe = createSafeMigrationFs({ vaultRoot: raced.vault });
  assert.deepStrictEqual(safe.capability, {
    available: false,
    code: MIGRATION_SAFE_FS_UNAVAILABLE,
    reason: "当前 Obsidian Node 运行时没有经过验证的 descriptor-relative openat/*at 文件系统能力；迁移仅可预览，不能执行。",
  });
  const preview = safe.previewManifest("preview");
  assert.deepStrictEqual(preview, [{
    relativePath: "item.bin",
    sha256: preview[0].sha256,
    size: Buffer.byteLength("preview bytes"),
    type: "file",
  }]);

  // Simulate a parent swap after the last path validation. The production facade
  // must reject before journal/copy/settings/bundle work instead of reopening paths.
  fs.lstatSync(path.join(raced.vault, "source/sentinel.bin"));
  fs.renameSync(path.join(raced.vault, "source"), path.join(raced.vault, "source-original"));
  fs.symlinkSync(raced.outside, path.join(raced.vault, "source"), "dir");
  const settings = { confirmed: false };
  for (const run of [
    () => safe.hashVerified("source/sentinel.bin", {}),
    () => safe.copyVerified("source/sentinel.bin", "target/copy.bin", {}),
    () => safe.writeExclusive("target/bundle.json", Buffer.from("{}"), {}),
    () => safe.appendJournalRecord("journal/migration.jsonl", { state: "forward" }, () => true),
    () => safe.createOwnedExclusive("target/maintenance.lock", { token: "one" }),
  ]) {
    assert.throws(run, (error) => error?.code === MIGRATION_SAFE_FS_UNAVAILABLE);
  }
  assert.deepStrictEqual(settings, { confirmed: false });
  assert.deepStrictEqual(fs.readdirSync(path.join(raced.vault, "target")), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(raced.vault, "journal")), []);
  assertOutsideUntouched(raced.outside);

  const calls = [];
  const primitive = {
    apiVersion: 1,
    name: "test-openat",
    vetted: true,
    createSession({ vaultRoot }) {
      calls.push(["session", vaultRoot]);
      return Object.fromEntries([
        "appendJournalRecord", "closeOwned", "copyVerified", "createOwnedExclusive",
        "hashVerified", "manifest", "readLastJournalRecord", "readOwnedJson",
        "writeOwnedJson", "writeExclusive",
      ].map((name) => [name, (...args) => {
        calls.push([name, ...args]);
        return name === "hashVerified" ? "hash" : name === "manifest" ? [] : undefined;
      }]));
    },
  };
  const injected = createSafeMigrationFs({ vaultRoot: raced.vault, descriptorRelativeFs: primitive });
  assert.strictEqual(injected.capability.available, true);
  assert.strictEqual(injected.capability.name, "test-openat");
  assert.strictEqual(injected.hashVerified("source-original/sentinel.bin", {}), "hash");
  injected.writeExclusive("target/injected.bin", Buffer.from("x"), {});
  assert.deepStrictEqual(calls.map((entry) => entry[0]), ["session", "hashVerified", "writeExclusive"]);

  assert.throws(
    () => createSafeMigrationFs({ vaultRoot: raced.vault, descriptorRelativeFs: { name: "broken", vetted: true, apiVersion: 1, createSession: () => ({}) } }),
    /不完整/,
  );
  console.log("migration-safe-fs: ok");
})();
