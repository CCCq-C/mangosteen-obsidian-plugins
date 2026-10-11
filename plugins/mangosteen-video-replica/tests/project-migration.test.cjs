const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const folder = "山竹视频复刻/旧项目";
const firstFrame = `${folder}/02-分镜脚本/镜头-001-开场-首帧.png`;
const video = `${folder}/03-视频片段/镜头-001-开场.mp4`;

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
  const move = async (from, to) => {
    events.push(`move:${from}->${to}`);
    if (options.failMoveFrom === from) throw new Error("injected move failure");
    if (files.has(to)) throw Object.assign(new Error("backup exists"), { code: "EEXIST" });
    if (!files.has(from)) throw Object.assign(new Error("source missing"), { code: "ENOENT" });
    files.set(to, files.get(from));
    files.delete(from);
  };
  const atomicWrite = async (operation) => {
    if (operation.type === "journal") {
      journals.set(operation.path, JSON.parse(JSON.stringify(operation.value)));
      events.push(`journal:${operation.value.state}:${operation.value.inFlight?.type || "none"}`);
      return;
    }
    assert.strictEqual(operation.type, "bundle");
    events.push("bundle");
    if (options.failBundle) throw new Error("injected bundle failure");
    for (const write of operation.writes) {
      if (files.has(write.path)) throw Object.assign(new Error("bundle destination exists"), { code: "EEXIST" });
    }
    for (const write of operation.writes) files.set(write.path, Buffer.from(write.content));
  };
  const removeNew = async (operation) => {
    events.push(`remove:${operation.to || operation.path}`);
    files.delete(operation.to || operation.path);
  };
  return { files, events, journals, copy, move, hash, atomicWrite, removeNew };
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
  assert.match(plan.backupPath, /\.mangosteen\/history\/migration-20261012-010203-004$/);
  assert.strictEqual(plan.destination, `${folder}/.mangosteen`);
  assert.deepStrictEqual(plan.deletes, []);
  assert.ok(plan.writes.some((item) => item.path === `${folder}/.mangosteen/project.json`));
  assert.ok(plan.writes.some((item) => item.path === `${folder}/.mangosteen/draft.json`));
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

  const successFs = memoryAdapters(base.contents);
  const completed = await executeProjectMigration({ plan, ...successFs });
  assert.strictEqual(completed.state, "completed");
  assert.ok(successFs.events.indexOf("bundle") > successFs.events.findIndex((item) => item.startsWith("copy:")));
  assert.ok(successFs.events.findIndex((item) => item.startsWith("move:")) > successFs.events.indexOf("bundle"));
  assert.strictEqual(await successFs.hash(`${folder}/03-分镜/001/首帧.png`), sha256("first frame"));
  assert.ok(successFs.files.has(`${folder}/.mangosteen/project.json`));
  assert.ok(!successFs.files.has(firstFrame));
  assert.ok(successFs.files.has(`${plan.backupPath}/02-分镜脚本/镜头-001-开场-首帧.png`));

  const replayEvents = successFs.events.length;
  const replayed = await executeProjectMigration({ plan: { ...plan, journal: completed }, ...successFs });
  assert.strictEqual(replayed.state, "completed");
  assert.strictEqual(successFs.events.slice(replayEvents).some((item) => item.startsWith("copy:") || item.startsWith("move:") || item === "bundle"), false, "completed replay must be idempotent");

  for (const failureOptions of [{ failCopyAt: 2 }, { hashMismatchPath: `${folder}/03-分镜/001/首帧.png` }, { failBundle: true }, { failMoveFrom: firstFrame }]) {
    const failingFs = memoryAdapters(base.contents, failureOptions);
    await assert.rejects(
      executeProjectMigration({ plan, ...failingFs }),
      /injected|SHA-256|哈希|hash|move|迁移/,
    );
    for (const source of Object.keys(base.contents)) assert.ok(failingFs.files.has(source), `rollback must restore ${source}`);
    assert.ok(!failingFs.files.has(`${folder}/03-分镜/001/首帧.png`));
    assert.ok(!failingFs.files.has(`${folder}/.mangosteen/project.json`));
    assert.strictEqual(failingFs.journals.get(plan.journalPath)?.state, "rolled-back");
  }

  const partialFs = memoryAdapters(base.contents);
  const firstCopy = plan.operations[0];
  partialFs.files.set(firstCopy.to, Buffer.from(partialFs.files.get(firstCopy.from)));
  const partialJournal = migration.createProjectMigrationJournal(plan);
  partialJournal.state = "running";
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
  let confirmationText = "";
  plugin.previewCurrentProjectMigration = () => plan;
  plugin.executeCurrentProjectMigration = async () => { executions += 1; };
  plugin.confirmMigrationPlan = (message) => { confirmationText = message; return false; };
  await command.callback();
  assert.strictEqual(executions, 0, "previewing or declining must not execute migration");
  for (const value of [String(plan.counts.files), String(plan.counts.bytes), String(plan.counts.blocked), String(plan.counts.skipped), plan.destination, plan.backupPath]) {
    assert.ok(confirmationText.includes(value), `confirmation preview must include ${value}`);
  }
  plugin.previewCurrentProjectMigration = () => ({ ...plan, blocked: true, reasons: ["active paid task"], counts: { ...plan.counts, blocked: 1 } });
  plugin.confirmMigrationPlan = () => { throw new Error("blocked plan must not ask for confirmation"); };
  await command.callback();
  assert.strictEqual(executions, 0);
  assert.ok(notices.some((message) => message.includes("active paid task")));
  let previewCalls = 0;
  plugin.previewCurrentProjectMigration = () => (++previewCalls === 1
    ? plan
    : { ...plan, blocked: true, reasons: ["task became active"], counts: { ...plan.counts, blocked: 1 } });
  plugin.confirmMigrationPlan = () => true;
  await command.callback();
  assert.strictEqual(executions, 0, "the command must revalidate paid-work blockers after confirmation");
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
  global.window = originalWindow;

  console.log("project-migration: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
