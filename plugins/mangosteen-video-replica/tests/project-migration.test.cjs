const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { createSafeMigrationFs } = require("../../migration-safe-fs.cjs");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const folder = "山竹视频复刻/旧项目";
const firstFrame = `${folder}/02-分镜脚本/镜头-001-开场-首帧.png`;
const video = `${folder}/03-视频片段/镜头-001-开场.mp4`;

function testDescriptorRelativeFs() {
  return {
    apiVersion: 1,
    name: "test-only-openat",
    vetted: true,
    createSession({ vaultRoot }) {
      const resolve = (relative, createParents = false) => {
        const parts = String(relative).split("/");
        if (!relative || parts.some((part) => !part || part === "." || part === "..")) throw new Error("test path unsafe");
        const target = path.resolve(vaultRoot, ...parts);
        if (path.relative(vaultRoot, target).startsWith("..")) throw new Error("test path outside root");
        if (createParents) fs.mkdirSync(path.dirname(target), { recursive: true });
        for (let current = path.dirname(target); current !== vaultRoot; current = path.dirname(current)) {
          if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("测试路径包含符号链接，不安全");
        }
        return target;
      };
      const parseLast = (text) => {
        const trimmed = String(text || "").trim();
        if (!trimmed) return null;
        const lines = trimmed.split(/\r?\n/);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try { return JSON.parse(lines[index]); } catch (_) {}
        }
        throw new Error("journal JSON 不可读");
      };
      const hashVerified = (relative, expected = {}) => {
        const bytes = fs.readFileSync(resolve(relative));
        const digest = sha256(bytes);
        if (expected.size !== undefined && expected.size !== bytes.length) throw new Error("size mismatch");
        if (expected.sha256 && expected.sha256 !== digest) throw new Error("hash mismatch");
        return digest;
      };
      return {
        appendJournalRecord(relative, value, validateExisting) {
          const target = resolve(relative, true);
          const existing = fs.lstatSync(target, { throwIfNoEntry: false }) ? parseLast(fs.readFileSync(target, "utf8")) : null;
          if (existing && !validateExisting?.(existing)) throw new Error("journal 被无关文件占用");
          fs.appendFileSync(target, `${JSON.stringify(value)}\n`, { flag: existing ? "a" : "wx" });
        },
        closeOwned() {},
        copyVerified(from, to, expected) {
          const source = fs.readFileSync(resolve(from));
          hashVerified(from, expected);
          fs.writeFileSync(resolve(to, true), source, { flag: "wx" });
          return { size: source.length, sha256: sha256(source) };
        },
        createOwnedExclusive(relative, value) {
          const absolutePath = resolve(relative, true);
          fs.writeFileSync(absolutePath, `${JSON.stringify(value)}\n`, { flag: "wx" });
          return { absolutePath, relativePath: relative };
        },
        hashVerified,
        manifest() { return []; },
        readLastJournalRecord(relative) { return parseLast(fs.readFileSync(resolve(relative), "utf8")); },
        readOwnedJson(handle) { return JSON.parse(fs.readFileSync(handle.absolutePath, "utf8")); },
        writeOwnedJson(handle, value) { fs.writeFileSync(handle.absolutePath, `${JSON.stringify(value)}\n`); },
        writeExclusive(relative, value, expected = {}) {
          const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
          if (expected.sha256 && expected.sha256 !== sha256(bytes)) throw new Error("hash mismatch");
          fs.writeFileSync(resolve(relative, true), bytes, { flag: "wx" });
        },
      };
    },
  };
}

function fixture(overrides = {}) {
  const contents = {
    [`${folder}/project.json`]: Buffer.from("legacy project"),
    [`${folder}/generation-request.json`]: Buffer.from("legacy request"),
    [firstFrame]: Buffer.from("first frame"),
    [video]: Buffer.from("video"),
  };
  const files = Object.entries(contents).map(([filePath, bytes]) => ({
    path: filePath,
    size: bytes.length,
    sha256: sha256(bytes),
  }));
  return {
    input: {
      projectFolder: folder,
      files,
      project: {
        folder,
        title: "旧项目",
        createdAt: "2026-09-01T02:03:04.000Z",
        shots: [{ id: "1", title: "开场", firstImagePath: firstFrame, imagePath: firstFrame, videoPath: video }],
      },
      request: { version: 5, confirmed: false, shots: [{ id: "1", title: "开场" }] },
      now: "2026-10-12T01:02:03.004Z",
      ...overrides,
    },
    contents,
  };
}

function memoryAdapters(initial, options = {}) {
  const files = new Map(Object.entries(initial).map(([filePath, value]) => [filePath, Buffer.from(value)]));
  const events = [];
  const journals = new Map();
  let copyCount = 0;
  let stageCount = 0;
  let exposeCount = 0;
  let ownershipChecks = 0;
  let ownershipLost = false;
  const hash = async (filePath) => {
    const bytes = files.get(filePath);
    if (!bytes) throw Object.assign(new Error(`missing: ${filePath}`), { code: "ENOENT" });
    if (options.hashMismatchPath === filePath) return "0".repeat(64);
    return sha256(bytes);
  };
  const copy = async (from, to) => {
    events.push(`copy:${from}->${to}`);
    copyCount += 1;
    if (copyCount === options.failCopyAt) throw new Error("injected copy failure");
    if (files.has(to)) throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
    files.set(to, Buffer.from(files.get(from)));
  };
  const backupCopy = async (from, to) => {
    events.push(`backup:${from}->${to}`);
    if (options.failBackupFrom === from) throw new Error("injected backup failure");
    if (files.has(to)) throw Object.assign(new Error("backup exists"), { code: "EEXIST" });
    if (!files.has(from)) throw Object.assign(new Error("source missing"), { code: "ENOENT" });
    files.set(to, Buffer.from(files.get(from)));
  };
  const atomicWrite = async (operation) => {
    if (operation.type === "journal") {
      journals.set(operation.path, JSON.parse(JSON.stringify(operation.value)));
      events.push(`journal:${operation.value.state}:${operation.value.inFlight?.type || "none"}`);
      return;
    }
    if (operation.type === "stage") {
      stageCount += 1;
      events.push(`stage:${operation.write.stagePath}`);
      if (stageCount === options.failStageAt) throw new Error("injected stage failure");
      if (files.has(operation.write.stagePath)) throw Object.assign(new Error("stage exists"), { code: "EEXIST" });
      files.set(operation.write.stagePath, Buffer.from(operation.write.content));
      return;
    }
    assert.strictEqual(operation.type, "expose");
    exposeCount += 1;
    events.push(`expose:${operation.write.path}`);
    if (exposeCount === options.failExposeAt) throw new Error("injected exposure failure");
    if (files.has(operation.write.path)) throw Object.assign(new Error("bundle destination exists"), { code: "EEXIST" });
    files.set(operation.write.path, Buffer.from(files.get(operation.write.stagePath)));
    if (exposeCount === options.exposeThenFailAt) throw new Error("injected post-exposure crash");
  };
  const assertMaintenanceOwned = async (phase) => {
    ownershipChecks += 1;
    events.push(`owned:${phase}`);
    if (ownershipLost || options.loseOwnershipAt === phase || ownershipChecks === options.loseOwnershipAtCheck) {
      ownershipLost = true;
      throw new Error(`maintenance lock lost at ${phase}`);
    }
  };
  return {
    files, events, journals, copy, backupCopy, hash, atomicWrite, assertMaintenanceOwned,
    clearFailures() { options.failBackupFrom = null; ownershipLost = false; options.loseOwnershipAt = null; options.loseOwnershipAtCheck = null; },
  };
}

(async () => {
  const migration = require("../project-migration.cjs");
  const { planLegacyProjectMigration, executeProjectMigration } = migration;
  const base = fixture();
  const plan = planLegacyProjectMigration(base.input);
  assert.strictEqual(plan.blocked, false);
  assert.ok(plan.operations.some((item) => item.from.includes("02-分镜脚本") && item.to.endsWith("03-分镜/001/首帧.png")));
  assert.strictEqual(plan.deletes.length, 0);
  assert.strictEqual(plan.counts.files, 2);
  assert.strictEqual(plan.counts.bytes, Buffer.byteLength("first frame") + Buffer.byteLength("video"));
  assert.strictEqual(plan.counts.backupFiles, 4);
  assert.strictEqual(plan.counts.backupBytes, Object.values(base.contents).reduce((sum, value) => sum + value.length, 0));
  assert.strictEqual(plan.counts.writeFiles, 2);
  assert.strictEqual(plan.counts.blocked, 0);
  assert.strictEqual(plan.counts.skipped, 0);
  assert.strictEqual(plan.sourceDisposition, "retained");
  assert.ok(plan.cleanupPending.some((item) => item.path === firstFrame));
  assert.ok(plan.moves.every((item) => item.type === "copy-backup-retain-source"));
  assert.match(plan.backupPath, /\.mangosteen\/history\/migration-20261012-010203-004$/);
  assert.strictEqual(plan.destination, `${folder}/.mangosteen`);
  assert.deepStrictEqual(plan.deletes, []);
  assert.ok(plan.writes.some((item) => item.path === `${folder}/.mangosteen/project.json`));
  assert.ok(plan.writes.some((item) => item.path === `${folder}/.mangosteen/draft.json`));
  assert.strictEqual(plan.writes[0].activation, false, "draft must be exposed before the v6 activation member");
  assert.strictEqual(plan.writes[1].activation, true, "project.json must be the final v6 activation member");
  assert.ok(plan.writes.every((item) => item.stagePath.startsWith(`${folder}/.mangosteen/history/.migration-stage-`)));
  assert.strictEqual(plan.backupManifest.length, plan.moves.length);
  assert.match(plan.journalPath, /\.mangosteen\/history\/\.migration-journal-/);
  assert.strictEqual(plan.project.shots[0].firstImagePath, `${folder}/03-分镜/001/首帧.png`);
  assert.strictEqual(plan.project.shots[0].videoPath, `${folder}/03-分镜/001/视频.mp4`);

  for (const status of ["queued", "processing", "stopping"]) {
    const blocked = planLegacyProjectMigration(fixture({ activeRun: { status, shots: {} } }).input);
    assert.strictEqual(blocked.blocked, true, `${status} must block migration`);
    assert.match(blocked.reasons.join("\n"), /运行|任务/);
    assert.strictEqual(blocked.operations.length, 0);
  }
  const confirmedWithoutTerminalState = planLegacyProjectMigration(fixture({ request: { version: 5, confirmed: true, shots: [{ id: "1" }] } }).input);
  assert.strictEqual(confirmedWithoutTerminalState.blocked, true, "a confirmed request without a terminal run is still queued paid work");
  const projectMarkedActive = planLegacyProjectMigration(fixture({ project: { ...base.input.project, status: "processing" } }).input);
  assert.strictEqual(projectMarkedActive.blocked, true);
  const safetyBlockers = [
    { activeRun: { status: "saving", shots: {} } },
    { activeRun: { status: "completed", stage: "provider-saving", shots: {} } },
    { activeRun: { status: "failed", submissionReservation: { reservationId: "reservation-top-level" }, shots: {} } },
    { activeRun: { status: "failed", paidTaskSubmitted: true, submissionUncertain: true, shots: {} } },
    { activeRun: { status: "completed", shots: { "001": { status: "saving", stage: "provider-saving" } } } },
    { activeRun: { status: "failed", shots: { "001": { submissionReservation: { reservationId: "reservation-1" } } } } },
    { pendingStop: { status: "pending", runId: "run-1" } },
    { activeRun: { status: "failed", shots: { "001": { paidTaskSubmitted: true, submissionUncertain: true } } } },
    { readErrors: { generationQueue: "invalid JSON" } },
  ];
  for (const blocker of safetyBlockers) {
    const blocked = planLegacyProjectMigration(fixture(blocker).input);
    assert.strictEqual(blocked.blocked, true, JSON.stringify(blocker));
    assert.strictEqual(blocked.operations.length, 0);
  }
  const lockBytes = Buffer.from("queue lock");
  const locked = planLegacyProjectMigration(fixture({
    files: [...base.input.files, { path: `${folder}/.work/generation-queue.lock`, size: lockBytes.length, sha256: sha256(lockBytes) }],
  }).input);
  assert.strictEqual(locked.blocked, true);
  assert.match(locked.reasons.join("\n"), /锁|lock/i);

  const unsafe = planLegacyProjectMigration(fixture({
    files: [{ path: `${folder}/02-分镜脚本/link.png`, size: 1, sha256: sha256("x"), symlink: true }],
  }).input);
  assert.strictEqual(unsafe.blocked, true);
  assert.match(unsafe.reasons.join("\n"), /符号链接/);
  assert.throws(
    () => planLegacyProjectMigration(fixture({ files: [{ path: "山竹视频复刻/别的项目/file.png", size: 1, sha256: sha256("x") }] }).input),
    /项目范围/,
  );

  const duplicateTarget = `${folder}/03-分镜/001/首帧.png`;
  const duplicate = planLegacyProjectMigration(fixture({
    files: [...base.input.files, { path: duplicateTarget, size: 3, sha256: sha256("old") }],
  }).input);
  assert.strictEqual(duplicate.blocked, true);
  assert.match(duplicate.reasons.join("\n"), /目标.*存在|重复/);

  const tamperedPlan = { ...plan, operations: plan.operations.map((item, index) => index === 0 ? { ...item, to: `${folder}/03-分镜/999/首帧.png` } : item) };
  await assert.rejects(
    executeProjectMigration({ plan: tamperedPlan, ...memoryAdapters(base.contents) }),
    /计划.*变更|planId|不一致/,
  );
  const tamperedSafetySnapshot = { ...plan, project: { ...plan.project, status: "processing" } };
  await assert.rejects(
    executeProjectMigration({ plan: tamperedSafetySnapshot, ...memoryAdapters(base.contents) }),
    /计划.*变更|planId|不一致/,
  );
  const tamperedJournalPath = { ...plan, journalPath: `${folder}/project.json` };
  assert.notStrictEqual(migration.projectMigrationPlanId(tamperedJournalPath), plan.planId);
  await assert.rejects(executeProjectMigration({ plan: tamperedJournalPath, ...memoryAdapters(base.contents) }), /journal|计划.*变更|路径/);
  for (const tampered of [{ ...plan, type: "other" }, { ...plan, version: 999 }, { ...plan, schemaVersion: 999 }]) {
    assert.notStrictEqual(migration.projectMigrationPlanId(tampered), plan.planId);
  }
  assert.notStrictEqual(migration.projectMigrationPlanId({ ...plan, backupManifest: [] }), plan.planId);

  const successFs = memoryAdapters(base.contents);
  const completed = await executeProjectMigration({ plan, ...successFs });
  assert.strictEqual(completed.state, "completed");
  assert.ok(successFs.events.findIndex((item) => item.startsWith("expose:")) > successFs.events.findIndex((item) => item.startsWith("copy:")));
  assert.ok(successFs.events.findIndex((item) => item.startsWith("backup:")) > successFs.events.findIndex((item) => item.startsWith("expose:")));
  assert.strictEqual(await successFs.hash(`${folder}/03-分镜/001/首帧.png`), sha256("first frame"));
  assert.ok(successFs.files.has(`${folder}/.mangosteen/project.json`));
  assert.ok(successFs.files.has(firstFrame), "portable-safe migration must retain every legacy project source");
  assert.ok(successFs.files.has(`${plan.backupPath}/02-分镜脚本/镜头-001-开场-首帧.png`));

  const replayEvents = successFs.events.length;
  const replayed = await executeProjectMigration({ plan: { ...plan, journal: completed }, ...successFs });
  assert.strictEqual(replayed.state, "completed");
  assert.strictEqual(successFs.events.slice(replayEvents).some((item) => /^(copy|backup|stage|expose):/.test(item)), false, "completed replay must be idempotent");
  assert.ok(plan.writes.every((write) => successFs.files.has(write.stagePath)), "verified hidden stage files are retained for separate cleanup");
  assert.ok(completed.cleanupPending.some((item) => item.type === "verified-stage-file"));

  for (const failureOptions of [
    { failCopyAt: 2 },
    { hashMismatchPath: `${folder}/03-分镜/001/首帧.png` },
    { failStageAt: 1 },
    { failExposeAt: 1 },
    { failExposeAt: 2 },
    { exposeThenFailAt: 1 },
    { exposeThenFailAt: 2 },
    { failBackupFrom: firstFrame },
  ]) {
    const failingFs = memoryAdapters(base.contents, failureOptions);
    await assert.rejects(
      executeProjectMigration({ plan, ...failingFs }),
      /injected|SHA-256|哈希|hash|backup|迁移|回滚/,
    );
    for (const source of Object.keys(base.contents)) assert.ok(failingFs.files.has(source), `safe failure must retain ${source}`);
    const failedJournal = failingFs.journals.get(plan.journalPath);
    const activatedV6 = plan.writes.some((write) => write.activation === true && failingFs.files.has(write.path));
    assert.strictEqual(failedJournal?.state, activatedV6 || failureOptions.hashMismatchPath ? "rollback-failed" : "rolled-back", JSON.stringify(failureOptions));
    for (const filePath of [...failingFs.files.keys()].filter((item) => !base.contents[item])) {
      const expected = plan.operations.some((item) => item.to === filePath && item.sha256 === sha256(failingFs.files.get(filePath)))
        || plan.writes.some((item) => [item.path, item.stagePath].includes(filePath) && item.sha256 === sha256(failingFs.files.get(filePath)))
        || plan.moves.some((item) => item.to === filePath && item.sha256 === sha256(failingFs.files.get(filePath)));
      assert.ok(expected, `rollback may retain only verified migration output: ${filePath}`);
    }
  }

  const partialFs = memoryAdapters(base.contents);
  const firstCopy = plan.operations[0];
  partialFs.files.set(firstCopy.to, Buffer.from(partialFs.files.get(firstCopy.from)));
  const partialJournal = migration.createProjectMigrationJournal(plan);
  partialJournal.state = "forward";
  partialJournal.inFlight = { type: "copy", index: 0 };
  const resumed = await executeProjectMigration({ plan: { ...plan, journal: partialJournal }, ...partialFs });
  assert.strictEqual(resumed.state, "completed", "matching in-flight copy must resume without overwrite");

  const mismatchedPartialFs = memoryAdapters(base.contents);
  mismatchedPartialFs.files.set(firstCopy.to, Buffer.from("unexpected destination"));
  await assert.rejects(
    executeProjectMigration({ plan: { ...plan, journal: partialJournal }, ...mismatchedPartialFs }),
    /不一致|fail-closed|拒绝/,
  );
  assert.strictEqual(mismatchedPartialFs.files.get(firstCopy.to).toString(), "unexpected destination", "fail-closed replay must not delete an unknown destination");

  const partialBundleFs = memoryAdapters(base.contents);
  for (const operation of plan.operations) partialBundleFs.files.set(operation.to, Buffer.from(partialBundleFs.files.get(operation.from)));
  for (const write of plan.writes) partialBundleFs.files.set(write.stagePath, Buffer.from(write.content));
  partialBundleFs.files.set(plan.writes[0].path, Buffer.from(plan.writes[0].content));
  const partialBundleJournal = migration.createProjectMigrationJournal(plan);
  partialBundleJournal.state = "forward";
  partialBundleJournal.completed.copies = plan.operations.map((_, index) => index);
  partialBundleJournal.completed.staged = plan.writes.map((_, index) => index);
  partialBundleJournal.inFlight = { type: "bundle-expose", index: 0 };
  const resumedBundle = await executeProjectMigration({ plan: { ...plan, journal: partialBundleJournal }, ...partialBundleFs });
  assert.strictEqual(resumedBundle.state, "completed", "a matching partial v6 bundle must expose the missing member and finish");
  assert.ok(partialBundleFs.files.has(plan.writes[1].path));
  for (const write of plan.writes) assert.strictEqual(partialBundleFs.files.has(write.stagePath), true, "verified stage files remain hidden for separate cleanup");

  const missingStageFs = memoryAdapters(base.contents);
  for (const operation of plan.operations) missingStageFs.files.set(operation.to, Buffer.from(missingStageFs.files.get(operation.from)));
  missingStageFs.files.set(plan.writes[0].path, Buffer.from(plan.writes[0].content));
  const missingStageJournal = migration.createProjectMigrationJournal(plan);
  missingStageJournal.state = "forward";
  missingStageJournal.completed.copies = plan.operations.map((_, index) => index);
  missingStageJournal.completed.staged = [0];
  missingStageJournal.inFlight = { type: "bundle-expose", index: 0, created: true };
  await assert.rejects(executeProjectMigration({ plan: { ...plan, journal: missingStageJournal }, ...missingStageFs }), /暂存|回滚/);
  assert.strictEqual(missingStageFs.files.has(plan.writes[0].path), true, "unsafe path unlink is forbidden; hidden draft target is retained for cleanup");
  assert.strictEqual(missingStageFs.files.has(plan.writes.find((write) => write.activation).path), false, "project activation member must never appear before draft is complete");
  assert.strictEqual(missingStageFs.journals.get(plan.journalPath).state, "rolled-back");

  const rollbackOnlyFs = memoryAdapters(base.contents);
  rollbackOnlyFs.files.set(firstCopy.to, Buffer.from(rollbackOnlyFs.files.get(firstCopy.from)));
  const rollbackOnlyJournal = migration.createProjectMigrationJournal(plan);
  rollbackOnlyJournal.state = "rolling-back";
  rollbackOnlyJournal.completed.copies = [0];
  const rollbackEventStart = rollbackOnlyFs.events.length;
  await assert.rejects(executeProjectMigration({ plan: { ...plan, journal: rollbackOnlyJournal }, ...rollbackOnlyFs }), /已回滚|回滚完成/);
  assert.strictEqual(rollbackOnlyFs.journals.get(plan.journalPath).state, "rolled-back");
  assert.ok(rollbackOnlyFs.files.has(firstCopy.to), "known generated copy is retained for safe later cleanup");
  assert.strictEqual(rollbackOnlyFs.events.slice(rollbackEventStart).some((item) => /^(copy|stage|expose|backup):/.test(item)), false, "rolling-back replay must never resume forward work");

  const falseCompletedCopy = migration.createProjectMigrationJournal(plan);
  falseCompletedCopy.state = "forward";
  falseCompletedCopy.completed.copies = [0];
  const falseCompletedFs = memoryAdapters(base.contents);
  await assert.rejects(executeProjectMigration({ plan: { ...plan, journal: falseCompletedCopy }, ...falseCompletedFs }), /已记录|哈希|缺失|回滚/);
  assert.strictEqual(falseCompletedFs.events.some((item) => item.startsWith("stage:") || item.startsWith("expose:")), false);

  const falseCompletedMove = migration.createProjectMigrationJournal(plan);
  falseCompletedMove.state = "forward";
  falseCompletedMove.completed.backups = [0];
  const falseMoveFs = memoryAdapters(base.contents);
  await assert.rejects(executeProjectMigration({ plan: { ...plan, journal: falseCompletedMove }, ...falseMoveFs }), /已记录.*复制|备份.*不一致|状态不一致/);
  assert.strictEqual(falseMoveFs.events.some((item) => /^(copy|stage|expose|backup):/.test(item)), false, "a false completed backup must be rejected before any forward action");

  for (const phase of ["copy:0", "copy:hash:0", "bundle-stage:0", "bundle-expose:0", "backup-copy:0", "completed"]) {
    const lockLossFs = memoryAdapters(base.contents, { loseOwnershipAt: phase });
    await assert.rejects(executeProjectMigration({ plan, ...lockLossFs }), /maintenance lock lost|回滚/);
    assert.strictEqual(lockLossFs.journals.get(plan.journalPath).state, "rollback-failed", `lock loss at ${phase} must be durable`);
    const lossIndex = lockLossFs.events.indexOf(`owned:${phase}`);
    assert.ok(lossIndex >= 0);
    assert.strictEqual(lockLossFs.events.slice(lossIndex + 1).some((item) => /^(copy|backup|stage|expose):/.test(item)), false, `no forward filesystem operation after ${phase}`);
    for (const source of Object.keys(base.contents)) assert.ok(lockLossFs.files.has(source));
  }

  const interruptedProjectRollback = memoryAdapters(base.contents, { loseOwnershipAt: "rollback:copy:0" });
  interruptedProjectRollback.files.set(firstCopy.to, Buffer.from(interruptedProjectRollback.files.get(firstCopy.from)));
  const interruptedJournal = migration.createProjectMigrationJournal(plan);
  interruptedJournal.state = "rolling-back";
  interruptedJournal.completed.copies = [0];
  await assert.rejects(executeProjectMigration({ plan: { ...plan, journal: interruptedJournal }, ...interruptedProjectRollback }), /maintenance lock lost|回滚/);
  const projectRollbackFailed = interruptedProjectRollback.journals.get(plan.journalPath);
  assert.strictEqual(projectRollbackFailed.state, "rollback-failed");
  interruptedProjectRollback.clearFailures();
  await assert.rejects(executeProjectMigration({ plan: { ...plan, journal: projectRollbackFailed }, ...interruptedProjectRollback }), /已回滚|回滚完成/);
  assert.strictEqual(interruptedProjectRollback.journals.get(plan.journalPath).state, "rolled-back");

  const originalLoad = Module._load;
  const notices = [];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return {
      ItemView: class ItemView {}, Modal: class Modal {}, Plugin: class Plugin {},
      Notice: class Notice { constructor(message) { notices.push(String(message)); } },
      requestUrl: async () => ({ status: 200, arrayBuffer: new ArrayBuffer(0) }),
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../main.js")];
  const ReplicaPlugin = require("../main.js");
  Module._load = originalLoad;
  const plugin = new ReplicaPlugin();
  const commands = [];
  plugin.app = { vault: { adapter: { getBasePath: () => path.resolve(__dirname, "../../..") }, on: () => ({}) }, workspace: { getLeavesOfType: () => [] } };
  plugin.manifest = { dir: "plugins/mangosteen-video-replica" };
  plugin.loadData = async () => ({});
  plugin.addRibbonIcon = plugin.registerEvent = plugin.registerInterval = plugin.register = plugin.registerView = () => {};
  plugin.addCommand = (command) => commands.push(command);
  const originalWindow = global.window;
  global.window = { setInterval: () => 1, setTimeout: () => 2, clearTimeout: () => {} };
  await plugin.onload();
  const command = commands.find((item) => item.name === "整理当前视频复刻项目");
  assert.ok(command, "explicit project migration command must be registered");
  let executions = 0;
  let confirmationCalls = 0;
  let lockAcquisitions = 0;
  plugin.previewCurrentProjectMigration = () => plan;
  plugin.executeCurrentProjectMigration = async () => { executions += 1; };
  plugin.acquireProjectMaintenanceLock = () => {
    lockAcquisitions += 1;
    return { folder, lockPath: "test-lock", token: "test-token" };
  };
  plugin.assertProjectMaintenanceLockOwned = () => true;
  plugin.assertProjectGenerationIdle = () => true;
  plugin.releaseProjectMaintenanceLock = () => {};
  plugin.isProjectMigrationLocked = () => false;
  plugin.confirmMigrationPlan = () => {
    confirmationCalls += 1;
    throw new Error("unavailable migration must not ask for execution confirmation");
  };
  const noticesBeforeUnavailable = notices.length;
  await command.callback();
  assert.strictEqual(confirmationCalls, 0, "unavailable migration must not enter execution confirmation");
  assert.strictEqual(lockAcquisitions, 0, "unavailable migration must not acquire the execution lock");
  assert.strictEqual(executions, 0, "unavailable migration must not execute");
  const unavailablePreview = notices.slice(noticesBeforeUnavailable).join("\n");
  for (const value of [String(plan.counts.files), String(plan.counts.bytes), String(plan.counts.blocked), String(plan.counts.skipped), plan.destination, plan.backupPath]) {
    assert.ok(unavailablePreview.includes(value), `read-only preview must include ${value}`);
  }
  assert.match(unavailablePreview, /保留原目录.*不移动.*不删除/);
  assert.match(unavailablePreview, /只读预览/);
  assert.match(unavailablePreview, /当前不可执行/);
  assert.match(unavailablePreview, /MIGRATION_SAFE_FS_UNAVAILABLE/);
  assert.doesNotMatch(unavailablePreview, /确认后才会执行/);
  plugin.previewCurrentProjectMigration = () => ({ ...plan, blocked: true, reasons: ["active paid task"], counts: { ...plan.counts, blocked: 1 } });
  plugin.confirmMigrationPlan = () => { throw new Error("blocked plan must not ask for confirmation"); };
  await command.callback();
  assert.strictEqual(executions, 0);
  assert.ok(notices.some((message) => message.includes("active paid task")));
  plugin.migrationSafeFs = createSafeMigrationFs({
    vaultRoot: path.resolve(__dirname, "../../.."),
    descriptorRelativeFs: testDescriptorRelativeFs(),
  });
  let previewCalls = 0;
  let confirmationText = "";
  plugin.previewCurrentProjectMigration = () => (++previewCalls === 1
    ? plan
    : { ...plan, blocked: true, reasons: ["task became active"], counts: { ...plan.counts, blocked: 1 } });
  plugin.confirmMigrationPlan = (message) => { confirmationText = message; return true; };
  await command.callback();
  assert.strictEqual(executions, 0, "the command must revalidate paid-work blockers after confirmation");
  assert.match(confirmationText, /确认后才会执行/);
  assert.doesNotMatch(confirmationText, /当前不可执行/);
  const metadataOnlyFixture = fixture({
    project: { ...base.input.project, shots: [] },
    request: { ...base.input.request, shots: [] },
    files: base.input.files.filter((item) => item.path.endsWith("project.json") || item.path.endsWith("generation-request.json")),
  });
  const metadataOnlyPlan = planLegacyProjectMigration(metadataOnlyFixture.input);
  assert.strictEqual(metadataOnlyPlan.operations.length, 0);
  assert.ok(metadataOnlyPlan.writes.length > 0 && metadataOnlyPlan.moves.length > 0);
  plugin.previewCurrentProjectMigration = () => metadataOnlyPlan;
  plugin.confirmMigrationPlan = () => true;
  await command.callback();
  assert.strictEqual(executions, 1, "a legacy project with no media still needs its v6 bundle and backup migration");

  const lockVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-maintenance-lock-"));
  const lockRoot = path.join(lockVault, ...folder.split("/"));
  fs.mkdirSync(path.join(lockRoot, ".work"), { recursive: true });
  fs.writeFileSync(path.join(lockRoot, "project.json"), JSON.stringify(base.input.project));
  fs.writeFileSync(path.join(lockRoot, "generation-request.json"), JSON.stringify(base.input.request));
  const pluginA = new ReplicaPlugin();
  const pluginB = new ReplicaPlugin();
  for (const [index, instance] of [pluginA, pluginB].entries()) {
    instance.instanceId = `instance-${index + 1}`;
    instance.app = { vault: { adapter: { getBasePath: () => lockVault }, on: () => ({}) }, workspace: { getLeavesOfType: () => [] }, plugins: { getPlugin: () => null } };
    instance.manifest = { dir: "plugins/mangosteen-video-replica" };
    instance.queueApis = new Map();
    instance.activeQueueObjects = new Map();
    instance.queueRunnerLocks = new Map();
    instance.queueRunnerLockRequired = new Set();
    instance.processing = new Set();
    instance.queueRuns = new Map();
    instance.migrationSafeFs = createSafeMigrationFs({ vaultRoot: lockVault, descriptorRelativeFs: testDescriptorRelativeFs() });
  }
  const maintenanceFirst = pluginA.acquireProjectMaintenanceLock(folder);
  await assert.rejects(() => pluginB.previewWorkbenchGeneration(folder, ["001"]), /维护|迁移/);
  assert.throws(() => pluginB.workbenchQueueApi(folder).enqueue({}), /维护|迁移/);
  await assert.rejects(() => pluginB.startWorkbenchGeneration(folder, {}), /维护|迁移/);
  let legacyRuns = 0;
  pluginB.runGeneration = async () => { legacyRuns += 1; };
  fs.writeFileSync(path.join(lockRoot, "generation-request.json"), JSON.stringify({ ...base.input.request, confirmed: true }));
  await pluginB.processRequest(path.join(lockRoot, "generation-request.json"), false);
  assert.strictEqual(legacyRuns, 0, "legacy confirmed flow must not start while the maintenance lock exists");
  assert.throws(() => pluginB.acquireWorkbenchQueueLock(folder), /维护|迁移/);
  pluginA.releaseProjectMaintenanceLock(maintenanceFirst);
  assert.strictEqual(pluginA.hasProjectMaintenanceLock(folder), false, "released lock remains as a non-active ownership record");
  fs.rmSync(maintenanceFirst.lockPath, { force: true }); // explicit test-only/manual cleanup; migration code never unlinks it
  const queueFirst = pluginB.acquireWorkbenchQueueLock(folder);
  const maintenanceSecond = pluginA.acquireProjectMaintenanceLock(folder);
  assert.throws(() => pluginA.assertProjectGenerationIdle(folder), /生成|队列|运行/);
  pluginA.releaseProjectMaintenanceLock(maintenanceSecond);
  pluginB.releaseWorkbenchQueueLock(queueFirst);
  fs.rmSync(maintenanceSecond.lockPath, { force: true }); // explicit test-only/manual cleanup

  fs.writeFileSync(path.join(lockRoot, "generation-request.json"), JSON.stringify({
    ...base.input.request,
    confirmed: false,
    settings: { imageModel: "image-model", videoModel: "video-model" },
  }));
  let migrationDuringRefresh = null;
  let confirmedRunCount = 0;
  pluginB.refreshGenerationModelCatalog = async () => {
    migrationDuringRefresh = pluginA.acquireProjectMaintenanceLock(folder);
    return { imageModels: ["image-model"], videoModels: ["video-model"] };
  };
  pluginB.requestWorkbenchRefresh = () => {};
  pluginB.processRequest = async () => { confirmedRunCount += 1; };
  await assert.rejects(() => pluginB.confirmWorkbenchDraft(folder), /维护|迁移/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(lockRoot, "generation-request.json"), "utf8")).confirmed, false, "maintenance acquisition during model refresh must prevent confirmed=true write");
  assert.strictEqual(confirmedRunCount, 0);
  pluginA.releaseProjectMaintenanceLock(migrationDuringRefresh);
  fs.rmSync(migrationDuringRefresh.lockPath, { force: true }); // explicit test-only/manual cleanup

  const staleMaintenance = pluginA.acquireProjectMaintenanceLock(folder);
  const uncertainJournal = migration.createProjectMigrationJournal(plan);
  uncertainJournal.state = "rollback-failed";
  pluginA.writeProjectMigrationJournal(folder, plan.journalPath, uncertainJournal);
  const staleTime = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(staleMaintenance.lockPath, staleTime, staleTime);
  assert.throws(() => pluginB.acquireProjectMaintenanceLock(folder), /不会自动清理|维护锁/);
  assert.ok(fs.existsSync(staleMaintenance.lockPath), "an old maintenance lock protecting an uncertain journal must require manual recovery");
  pluginA.releaseProjectMaintenanceLock(staleMaintenance, { retain: true });
  fs.rmSync(staleMaintenance.lockPath, { force: true });
  fs.rmSync(path.join(lockVault, ...plan.journalPath.split("/")), { force: true });

  const projectJournalTarget = path.join(lockVault, ...plan.journalPath.split("/"));
  fs.mkdirSync(path.dirname(projectJournalTarget), { recursive: true });
  fs.writeFileSync(projectJournalTarget, "unrelated project note");
  assert.throws(() => pluginA.writeProjectMigrationJournal(folder, plan.journalPath, migration.createProjectMigrationJournal(plan)), /无关|占用|journal|JSON/);
  assert.strictEqual(fs.readFileSync(projectJournalTarget, "utf8"), "unrelated project note");
  assert.throws(() => pluginA.writeProjectMigrationJournal(folder, `${folder}/project.json`, migration.createProjectMigrationJournal(plan)), /路径|journal/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(lockRoot, "project.json"), "utf8")), base.input.project, "tampered journal path must not overwrite project.json");
  fs.rmSync(path.join(lockRoot, ".mangosteen/history"), { recursive: true, force: true });
  const outsideProjectJournal = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-project-journal-outside-"));
  fs.symlinkSync(outsideProjectJournal, path.join(lockRoot, ".mangosteen/history"));
  assert.throws(() => pluginA.writeProjectMigrationJournal(folder, plan.journalPath, migration.createProjectMigrationJournal(plan)), /符号链接|不安全/);
  fs.rmSync(outsideProjectJournal, { recursive: true, force: true });
  fs.rmSync(lockVault, { recursive: true, force: true });

  const cacheVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-layout-cache-"));
  const cacheRoot = path.join(cacheVault, ...folder.split("/"));
  fs.mkdirSync(path.join(cacheRoot, ".work"), { recursive: true });
  const queueRequest = {
    version: 3,
    confirmed: false,
    character: { id: "hero", prompt: "same hero", voiceProfile: "clear voice" },
    products: [],
    scenes: [{ id: "room", prompt: "same room" }],
    settings: { imageModel: "image-model", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
    shots: [{ id: "001", title: "shot", sceneId: "room", productIds: [], duration: 4, dialogue: "hello", imagePrompt: "hero", videoPrompt: "wave" }],
  };
  fs.writeFileSync(path.join(cacheRoot, "project.json"), JSON.stringify({ ...base.input.project, folder }));
  fs.writeFileSync(path.join(cacheRoot, "generation-request.json"), JSON.stringify(queueRequest));
  const cachePlugin = new ReplicaPlugin();
  cachePlugin.instanceId = "cache-instance";
  cachePlugin.app = { vault: { adapter: { getBasePath: () => cacheVault }, on: () => ({}) }, workspace: { getLeavesOfType: () => [] }, plugins: { getPlugin: () => null } };
  cachePlugin.queueApis = new Map();
  cachePlugin.activeQueueObjects = new Map();
  cachePlugin.queueRuns = new Map();
  cachePlugin.queueRunnerLocks = new Map();
  cachePlugin.queueRunnerLockRequired = new Set();
  cachePlugin.processing = new Set();
  cachePlugin.requestWorkbenchRefresh = () => {};
  cachePlugin.migrationSafeFs = createSafeMigrationFs({ vaultRoot: cacheVault, descriptorRelativeFs: testDescriptorRelativeFs() });
  const legacyApi = cachePlugin.workbenchQueueApi(folder);
  assert.strictEqual(legacyApi.__mangosteenLayoutVersion, "legacy");
  fs.mkdirSync(path.join(cacheRoot, ".mangosteen"), { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, ".mangosteen/project.json"), JSON.stringify({ ...base.input.project, folder, schemaVersion: 6 }));
  fs.writeFileSync(path.join(cacheRoot, ".mangosteen/draft.json"), JSON.stringify(queueRequest));
  const realExecuteProjectMigration = migration.executeProjectMigration;
  migration.executeProjectMigration = async () => ({ state: "completed" });
  try {
    await ReplicaPlugin.prototype.executeCurrentProjectMigration.call(cachePlugin, { projectFolder: folder }, { token: "test" });
  } finally {
    migration.executeProjectMigration = realExecuteProjectMigration;
  }
  assert.strictEqual(cachePlugin.queueApis.has(folder), false, "successful v6 activation must invalidate the legacy queue API closure");
  assert.throws(() => legacyApi.preview(queueRequest, ["001"]), /布局已变化|已失效/, "a caller holding the old legacy closure must not use it after activation");
  const v6Api = cachePlugin.workbenchQueueApi(folder);
  assert.notStrictEqual(v6Api, legacyApi);
  assert.strictEqual(v6Api.__mangosteenLayoutVersion, "v6");
  const queuePlan = v6Api.preview(queueRequest, ["001"]);
  await v6Api.enqueue(v6Api.confirm(queuePlan, queueRequest));
  assert.ok(fs.existsSync(path.join(cacheRoot, ".mangosteen/active-run.json")), "next queue write must use the v6 active-run path");
  assert.strictEqual(fs.existsSync(path.join(cacheRoot, ".work/generation-queue.json")), false, "a legacy cache must never write the old .work queue after activation");
  fs.rmSync(cacheVault, { recursive: true, force: true });
  global.window = originalWindow;

  console.log("project-migration: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
