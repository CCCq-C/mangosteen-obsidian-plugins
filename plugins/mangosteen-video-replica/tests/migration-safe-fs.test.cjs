const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSafeMigrationFs } = require("../../migration-safe-fs.cjs");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-safe-fs-vault-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-safe-fs-outside-"));
  fs.mkdirSync(path.join(vault, "source"));
  fs.mkdirSync(path.join(vault, "target"));
  fs.mkdirSync(path.join(vault, "journal"));
  fs.writeFileSync(path.join(vault, "source/input.bin"), "inside bytes");
  fs.writeFileSync(path.join(outside, "input.bin"), "outside secret");
  return { vault, outside };
}

function replaceParentWithOutside(vault, outside, relativeParent) {
  const parent = path.join(vault, relativeParent);
  fs.renameSync(parent, `${parent}-original`);
  fs.symlinkSync(outside, parent, "dir");
}

function assertOutsideUntouched(outside, expected = ["input.bin"]) {
  assert.deepStrictEqual(fs.readdirSync(outside).sort(), expected.slice().sort());
  assert.strictEqual(fs.readFileSync(path.join(outside, "input.bin"), "utf8"), "outside secret");
}

(() => {
  const normal = fixture();
  const safe = createSafeMigrationFs({ vaultRoot: normal.vault });
  const expected = { size: Buffer.byteLength("inside bytes"), sha256: sha256("inside bytes") };
  assert.strictEqual(safe.hashVerified("source/input.bin", expected), expected.sha256);
  safe.copyVerified("source/input.bin", "target/copied.bin", expected);
  assert.strictEqual(fs.readFileSync(path.join(normal.vault, "target/copied.bin"), "utf8"), "inside bytes");
  safe.writeExclusive("target/new.json", Buffer.from("{}\n"), { sha256: sha256("{}\n") });
  safe.appendJournalRecord("journal/migration.jsonl", { type: "test-journal", planId: "p1", state: "forward" }, (value) => value.type === "test-journal" && value.planId === "p1");
  safe.appendJournalRecord("journal/migration.jsonl", { type: "test-journal", planId: "p1", state: "completed" }, (value) => value.type === "test-journal" && value.planId === "p1");
  assert.strictEqual(safe.readLastJournalRecord("journal/migration.jsonl").state, "completed");
  const owned = safe.createOwnedExclusive("target/maintenance.lock", { token: "one", state: "active" });
  assert.strictEqual(safe.readOwnedJson(owned).token, "one");
  safe.writeOwnedJson(owned, { token: "one", state: "released" });
  assert.strictEqual(safe.readOwnedJson(owned).state, "released");
  safe.closeOwned(owned);

  for (const attack of [
    {
      name: "source read",
      operation: "open-read",
      path: "source/input.bin",
      parent: "source",
      run: (guarded) => guarded.hashVerified("source/input.bin", expected),
    },
    {
      name: "destination write",
      operation: "open-write",
      path: "target/new.bin",
      parent: "target",
      run: (guarded) => guarded.writeExclusive("target/new.bin", Buffer.from("new"), { sha256: sha256("new") }),
    },
    {
      name: "copy destination",
      operation: "open-write",
      path: "target/copied.bin",
      parent: "target",
      run: (guarded) => guarded.copyVerified("source/input.bin", "target/copied.bin", expected),
    },
    {
      name: "copy source",
      operation: "open-read",
      path: "source/input.bin",
      parent: "source",
      run: (guarded) => guarded.copyVerified("source/input.bin", "target/copied.bin", expected),
    },
    {
      name: "recursive manifest",
      operation: "readdir",
      path: "source",
      parent: "source",
      run: (guarded) => guarded.manifest("source"),
    },
    {
      name: "parent creation",
      operation: "mkdir",
      path: "target/new-parent",
      parent: "target",
      run: (guarded) => guarded.writeExclusive("target/new-parent/new.bin", Buffer.from("new"), { sha256: sha256("new") }),
    },
    {
      name: "journal append",
      operation: "open-append",
      path: "journal/migration.jsonl",
      parent: "journal",
      run: (guarded) => guarded.appendJournalRecord("journal/migration.jsonl", { type: "test-journal", planId: "p1", state: "forward" }, () => true),
    },
  ]) {
    const attacked = fixture();
    let injected = false;
    const guarded = createSafeMigrationFs({
      vaultRoot: attacked.vault,
      beforeFileOp(event) {
        if (!injected && event.type === attack.operation && event.path === attack.path) {
          injected = true;
          replaceParentWithOutside(attacked.vault, attacked.outside, attack.parent);
        }
      },
    });
    assert.throws(() => attack.run(guarded), /符号链接|超出|不安全|替换/, `${attack.name} must fail closed`);
    assert.strictEqual(injected, true, `${attack.name} fault was not injected`);
    assertOutsideUntouched(attacked.outside);
  }

  const unrelated = fixture();
  fs.writeFileSync(path.join(unrelated.vault, "journal/migration.jsonl"), "user note");
  const protectedJournal = createSafeMigrationFs({ vaultRoot: unrelated.vault });
  assert.throws(
    () => protectedJournal.appendJournalRecord("journal/migration.jsonl", { type: "test-journal", planId: "p1" }, () => true),
    /不可读|无关|journal/,
  );
  assert.strictEqual(fs.readFileSync(path.join(unrelated.vault, "journal/migration.jsonl"), "utf8"), "user note");

  const ownedAttack = fixture();
  const ownedSafe = createSafeMigrationFs({ vaultRoot: ownedAttack.vault });
  const ownedLock = ownedSafe.createOwnedExclusive("target/maintenance.lock", { token: "one", state: "active" });
  replaceParentWithOutside(ownedAttack.vault, ownedAttack.outside, "target");
  assert.throws(() => ownedSafe.readOwnedJson(ownedLock), /符号链接|替换|不安全/);
  ownedSafe.closeOwned(ownedLock);
  assertOutsideUntouched(ownedAttack.outside);

  console.log("migration-safe-fs: ok");
})();
