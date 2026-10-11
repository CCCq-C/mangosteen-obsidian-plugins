const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");
const path = require("path");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function task(overrides = {}) {
  return {
    id: "video-task-1",
    createdAt: "2026-09-08T01:02:03.000Z",
    status: "completed",
    saved: true,
    submissionFingerprint: "sha256:video-task-1",
    localPath: "山竹视频/video-task-1/这是一段很长的提示词.mp4",
    ...overrides,
  };
}

function adapters(initial, options = {}) {
  const files = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  const events = [];
  let savedTasks = null;
  return {
    files,
    events,
    get savedTasks() { return savedTasks; },
    copy: async (from, to) => {
      events.push(`copy:${from}->${to}`);
      if (files.has(to)) throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
      files.set(to, Buffer.from(files.get(from)));
    },
    hash: async (filePath) => {
      if (!files.has(filePath)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (options.hashMismatchPath === filePath) return "e".repeat(64);
      return sha256(files.get(filePath));
    },
    move: async (from, to) => {
      events.push(`move:${from}->${to}`);
      if (options.failMoveFrom === from) throw new Error("injected move failure");
      const entries = [...files.entries()].filter(([key]) => key === from || key.startsWith(`${from}/`));
      if (!entries.length) throw Object.assign(new Error("source missing"), { code: "ENOENT" });
      if ([...files.keys()].some((key) => key === to || key.startsWith(`${to}/`))) throw Object.assign(new Error("backup exists"), { code: "EEXIST" });
      for (const [key, value] of entries) {
        files.set(`${to}${key.slice(from.length)}`, value);
        files.delete(key);
      }
    },
    atomicWriteSettings: async (tasks) => {
      events.push("settings");
      if (options.failSettings) throw new Error("injected settings failure");
      savedTasks = JSON.parse(JSON.stringify(tasks));
    },
    writeJournal: async () => {},
    removeNew: async (operation) => { files.delete(operation.to); },
  };
}

(async () => {
  const migration = require("../history-migration.cjs");
  const source = task().localPath;
  const providerPath = "山竹视频/video-task-1/provider.json";
  const files = [
    { path: source, size: 11, sha256: sha256("video bytes") },
    { path: providerPath, size: 7, sha256: sha256("keep me") },
  ];
  const plan = migration.planVideoHistoryMigration({ tasks: [task()], submissionMarkers: [], files, now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(plan.blocked, false);
  assert.strictEqual(plan.operations.length, 1);
  assert.strictEqual(plan.operations[0].to, "山竹创作记录/视频/2026-09/20260908-090203-video-task-1.mp4");
  assert.strictEqual(plan.counts.files, 1);
  assert.strictEqual(plan.counts.bytes, 11);
  assert.strictEqual(plan.counts.backupFiles, 2);
  assert.strictEqual(plan.counts.backupBytes, 18);
  assert.strictEqual(plan.counts.blocked, 0);
  assert.strictEqual(plan.counts.skipped, 0);
  assert.strictEqual(plan.deletes.length, 0);
  assert.match(plan.backupPath, /^\.mangosteen-video\/migration-backup\/migration-20261012-010203-004$/);
  assert.strictEqual(plan.nextTasks[0].localPath, plan.operations[0].to);

  for (const unsafeTask of [
    task({ status: "saving", saved: false }),
    task({ status: "unknown", saved: false, paidTaskSubmitted: true }),
    task({ status: "completed", saved: true, submissionUncertain: true }),
  ]) {
    const skipped = migration.planVideoHistoryMigration({ tasks: [unsafeTask], submissionMarkers: [], files, now: "2026-10-12T01:02:03.004Z" });
    assert.strictEqual(skipped.blocked, false);
    assert.strictEqual(skipped.operations.length, 0);
    assert.strictEqual(skipped.counts.skipped, 1);
  }
  const uncertainMarker = migration.planVideoHistoryMigration({ tasks: [task()], submissionMarkers: [{ fingerprint: task().submissionFingerprint, status: "accepted" }], files, now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(uncertainMarker.operations.length, 0);
  assert.strictEqual(uncertainMarker.counts.skipped, 1);
  const projectOwned = migration.planVideoHistoryMigration({ tasks: [task({ outputTarget: { owner: "video-replica", destinationPath: "山竹视频复刻/p/03-分镜/001/视频.mp4" } })], submissionMarkers: [], files, now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(projectOwned.operations.length, 0);

  const sharedSecondSource = "山竹视频/video-task-1/另一个旧视频.mp4";
  const sharedUncertain = migration.planVideoHistoryMigration({
    tasks: [task(), task({ id: "video-task-2", submissionFingerprint: "sha256:video-task-2", localPath: sharedSecondSource })],
    submissionMarkers: [{ fingerprint: "sha256:video-task-2", status: "accepted" }],
    files: [...files, { path: sharedSecondSource, size: 12, sha256: sha256("uncertain video") }],
    now: "2026-10-12T01:02:03.004Z",
  });
  assert.strictEqual(sharedUncertain.operations.length, 0);
  assert.strictEqual(sharedUncertain.moves.length, 0);

  const duplicate = migration.planVideoHistoryMigration({ tasks: [task()], submissionMarkers: [], files: [...files, { path: plan.operations[0].to, size: 3, sha256: sha256("old") }], now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(duplicate.blocked, true);
  assert.match(duplicate.reasons.join("\n"), /目标.*存在|重复/);
  const symlink = migration.planVideoHistoryMigration({ tasks: [task()], submissionMarkers: [], files: [{ ...files[0], symlink: true }], now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(symlink.blocked, true);

  const tamperedPlan = { ...plan, nextTasks: plan.nextTasks.map((item) => ({ ...item, localPath: "山竹创作记录/视频/tampered.mp4" })) };
  await assert.rejects(migration.executeVideoHistoryMigration({ plan: tamperedPlan, ...adapters({ [source]: "video bytes" }) }), /计划.*变更|planId|不一致/);

  const success = adapters({ [source]: "video bytes", [providerPath]: "keep me" });
  const completed = await migration.executeVideoHistoryMigration({ plan, ...success });
  assert.strictEqual(completed.state, "completed");
  assert.deepStrictEqual(success.events.map((item) => item.split(":")[0]), ["copy", "settings", "move"]);
  assert.ok(success.files.has(plan.operations[0].to));
  assert.ok(success.files.has(`${plan.backupPath}/山竹视频/video-task-1/这是一段很长的提示词.mp4`));
  assert.ok(success.files.has(`${plan.backupPath}/山竹视频/video-task-1/provider.json`));
  assert.deepStrictEqual(success.savedTasks, plan.nextTasks);

  const mismatch = adapters({ [source]: "video bytes" }, { hashMismatchPath: plan.operations[0].to });
  await assert.rejects(migration.executeVideoHistoryMigration({ plan, ...mismatch }), /SHA-256|哈希/);
  assert.ok(mismatch.files.has(source));
  assert.ok(!mismatch.files.has(plan.operations[0].to));

  const moveFailure = adapters({ [source]: "video bytes" }, { failMoveFrom: "山竹视频/video-task-1" });
  await assert.rejects(migration.executeVideoHistoryMigration({ plan, ...moveFailure }), /injected move failure/);
  assert.ok(moveFailure.files.has(source));
  assert.ok(!moveFailure.files.has(plan.operations[0].to));
  assert.deepStrictEqual(moveFailure.savedTasks, plan.originalTasks);

  const replanned = migration.planVideoHistoryMigration({ tasks: plan.nextTasks, submissionMarkers: [], files: [{ path: plan.operations[0].to, size: 11, sha256: sha256("video bytes") }], now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(replanned.operations.length, 0);

  const originalLoad = Module._load;
  const notices = [];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return {
      Modal: class Modal {}, Plugin: class Plugin {},
      Notice: class Notice { constructor(message) { notices.push(String(message)); } },
      requestUrl: async () => ({ status: 200 }),
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../main.js")];
  const VideoPlugin = require("../main.js");
  Module._load = originalLoad;
  const plugin = new VideoPlugin();
  const commands = [];
  plugin.api = {};
  plugin.app = { vault: { adapter: { getBasePath: () => path.resolve(__dirname, "../../..") } } };
  plugin.manifest = { dir: "plugins/mangosteen-video" };
  plugin.loadData = async () => ({ videoTasks: [], submissionMarkers: [], resolutionsByModel: {} });
  plugin.addRibbonIcon = plugin.registerInterval = () => {};
  plugin.addCommand = (command) => commands.push(command);
  const originalWindow = global.window;
  global.window = { setInterval: () => ({ unref() {} }) };
  await plugin.onload();
  const command = commands.find((item) => item.name === "整理山竹视频历史记录");
  assert.ok(command);
  let executions = 0;
  let previewText = "";
  plugin.previewVideoHistoryMigration = () => plan;
  plugin.executeVideoHistoryMigration = async () => { executions += 1; };
  plugin.confirmMigrationPlan = (message) => { previewText = message; return false; };
  await command.callback();
  assert.strictEqual(executions, 0);
  for (const value of [String(plan.counts.files), String(plan.counts.bytes), String(plan.counts.blocked), String(plan.counts.skipped), plan.destination, plan.backupPath]) assert.ok(previewText.includes(value));
  plugin.previewVideoHistoryMigration = () => ({ ...plan, blocked: true, reasons: ["hash mismatch"], counts: { ...plan.counts, blocked: 1 } });
  plugin.confirmMigrationPlan = () => { throw new Error("blocked plan must not confirm"); };
  await command.callback();
  assert.strictEqual(executions, 0);
  assert.ok(notices.some((message) => message.includes("hash mismatch")));
  let previewCalls = 0;
  plugin.previewVideoHistoryMigration = () => (++previewCalls === 1
    ? plan
    : { ...plan, blocked: false, reasons: [], operations: [], moves: [], counts: { ...plan.counts, files: 0, skipped: 1 } });
  plugin.confirmMigrationPlan = () => true;
  await command.callback();
  assert.strictEqual(executions, 0, "the command must revalidate task certainty after confirmation");
  global.window = originalWindow;

  console.log("history-migration-video: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
