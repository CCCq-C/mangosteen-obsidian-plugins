const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");
const path = require("path");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function task(overrides = {}) {
  return {
    id: "image-task-1",
    createdAt: "2026-09-08T01:02:03.000Z",
    status: "completed",
    saved: true,
    submissionFingerprint: "sha256:image-task-1",
    imagePaths: ["生图记录/2026-09-08-09-02-03/图片-1.png"],
    recordPath: "生图记录/任务记录.md",
    ...overrides,
  };
}

function adapters(initial, options = {}) {
  const files = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  const events = [];
  let savedTasks = null;
  const copy = async (from, to) => {
    events.push(`copy:${from}->${to}`);
    if (files.has(to)) throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
    files.set(to, Buffer.from(files.get(from)));
  };
  const hash = async (filePath) => {
    if (!files.has(filePath)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (options.hashMismatchPath === filePath) return "f".repeat(64);
    return sha256(files.get(filePath));
  };
  const move = async (from, to) => {
    events.push(`move:${from}->${to}`);
    if (options.failMoveFrom === from) throw new Error("injected move failure");
    const entries = [...files.entries()].filter(([key]) => key === from || key.startsWith(`${from}/`));
    if (!entries.length) throw Object.assign(new Error("source missing"), { code: "ENOENT" });
    if ([...files.keys()].some((key) => key === to || key.startsWith(`${to}/`))) throw Object.assign(new Error("backup exists"), { code: "EEXIST" });
    for (const [key, value] of entries) {
      files.set(`${to}${key.slice(from.length)}`, value);
      files.delete(key);
    }
  };
  const atomicWriteSettings = async (tasks) => {
    events.push("settings");
    if (options.failSettings) throw new Error("injected settings failure");
    savedTasks = JSON.parse(JSON.stringify(tasks));
  };
  const writeJournal = async () => {};
  const removeNew = async (operation) => { files.delete(operation.to); };
  return { files, events, copy, hash, move, atomicWriteSettings, writeJournal, removeNew, get savedTasks() { return savedTasks; } };
}

(async () => {
  const migration = require("../history-migration.cjs");
  const source = task().imagePaths[0];
  const notePath = "生图记录/2026-09-08-09-02-03/note.txt";
  const files = [
    { path: source, size: 11, sha256: sha256("image bytes") },
    { path: notePath, size: 7, sha256: sha256("keep me") },
  ];
  const plan = migration.planImageHistoryMigration({
    tasks: [task()], submissionMarkers: [], files, now: "2026-10-12T01:02:03.004Z",
  });
  assert.strictEqual(plan.blocked, false);
  assert.strictEqual(plan.operations.length, 1);
  assert.strictEqual(plan.operations[0].to, "山竹创作记录/图片/2026-09/20260908-090203-image-task-1-01.png");
  assert.strictEqual(plan.counts.files, 1);
  assert.strictEqual(plan.counts.bytes, 11);
  assert.strictEqual(plan.counts.backupFiles, 2);
  assert.strictEqual(plan.counts.backupBytes, 18);
  assert.strictEqual(plan.counts.blocked, 0);
  assert.strictEqual(plan.counts.skipped, 0);
  assert.strictEqual(plan.deletes.length, 0);
  assert.match(plan.backupPath, /^\.mangosteen-image\/migration-backup\/migration-20261012-010203-004$/);
  assert.deepStrictEqual(plan.nextTasks[0].imagePaths, [plan.operations[0].to]);
  assert.strictEqual(plan.nextTasks[0].recordPath, null);

  const uncertain = migration.planImageHistoryMigration({
    tasks: [task()],
    submissionMarkers: [{ fingerprint: "sha256:image-task-1", status: "uncertain" }],
    files,
    now: "2026-10-12T01:02:03.004Z",
  });
  assert.strictEqual(uncertain.blocked, false);
  assert.strictEqual(uncertain.operations.length, 0);
  assert.strictEqual(uncertain.counts.skipped, 1);
  assert.match(uncertain.skipped[0].reason, /待核对|不确定/);
  const active = migration.planImageHistoryMigration({ tasks: [task({ status: "processing", saved: false })], submissionMarkers: [], files, now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(active.operations.length, 0);
  assert.strictEqual(active.counts.skipped, 1);
  const projectOwned = migration.planImageHistoryMigration({ tasks: [task({ outputTarget: { owner: "video-replica", destinationPath: "山竹视频复刻/p/03-分镜/001/首帧.png" } })], submissionMarkers: [], files, now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(projectOwned.operations.length, 0, "project outputs must never be moved into standalone history");

  const sharedFolder = "生图记录/2026-09-08-09-02-03";
  const uncertainSource = `${sharedFolder}/图片-2.png`;
  const sharedUncertain = migration.planImageHistoryMigration({
    tasks: [task(), task({ id: "image-task-2", submissionFingerprint: "sha256:image-task-2", imagePaths: [uncertainSource] })],
    submissionMarkers: [{ fingerprint: "sha256:image-task-2", status: "uncertain" }],
    files: [...files, { path: uncertainSource, size: 12, sha256: sha256("uncertain image") }],
    now: "2026-10-12T01:02:03.004Z",
  });
  assert.strictEqual(sharedUncertain.operations.length, 0, "a folder shared with uncertain paid work must not be touched");
  assert.strictEqual(sharedUncertain.moves.length, 0);

  const duplicate = migration.planImageHistoryMigration({
    tasks: [task()], submissionMarkers: [],
    files: [...files, { path: plan.operations[0].to, size: 5, sha256: sha256("other") }],
    now: "2026-10-12T01:02:03.004Z",
  });
  assert.strictEqual(duplicate.blocked, true);
  assert.match(duplicate.reasons.join("\n"), /目标.*存在|重复/);
  const symlink = migration.planImageHistoryMigration({ tasks: [task()], submissionMarkers: [], files: [{ ...files[0], symlink: true }], now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(symlink.blocked, true);

  const tamperedPlan = { ...plan, nextTasks: plan.nextTasks.map((item) => ({ ...item, imagePaths: ["山竹创作记录/图片/tampered.png"] })) };
  await assert.rejects(migration.executeImageHistoryMigration({ plan: tamperedPlan, ...adapters({ [source]: "image bytes" }) }), /计划.*变更|planId|不一致/);

  const success = adapters({ [source]: "image bytes", [notePath]: "keep me" });
  const completed = await migration.executeImageHistoryMigration({ plan, ...success });
  assert.strictEqual(completed.state, "completed");
  assert.deepStrictEqual(success.events.map((item) => item.split(":")[0]), ["copy", "settings", "move"]);
  assert.ok(success.files.has(plan.operations[0].to));
  assert.ok(success.files.has(`${plan.backupPath}/生图记录/2026-09-08-09-02-03/图片-1.png`));
  assert.ok(success.files.has(`${plan.backupPath}/生图记录/2026-09-08-09-02-03/note.txt`), "the whole legacy task folder must move to backup");
  assert.deepStrictEqual(success.savedTasks, plan.nextTasks);

  const mismatch = adapters({ [source]: "image bytes" }, { hashMismatchPath: plan.operations[0].to });
  await assert.rejects(migration.executeImageHistoryMigration({ plan, ...mismatch }), /SHA-256|哈希/);
  assert.ok(mismatch.files.has(source));
  assert.ok(!mismatch.files.has(plan.operations[0].to));

  const moveFailure = adapters({ [source]: "image bytes" }, { failMoveFrom: "生图记录/2026-09-08-09-02-03" });
  await assert.rejects(migration.executeImageHistoryMigration({ plan, ...moveFailure }), /injected move failure/);
  assert.ok(moveFailure.files.has(source), "failed folder move must leave the legacy source in place");
  assert.ok(!moveFailure.files.has(plan.operations[0].to), "failed folder move must remove the verified new copy");
  assert.deepStrictEqual(moveFailure.savedTasks, plan.originalTasks, "failed folder move must restore settings paths");

  const replanned = migration.planImageHistoryMigration({ tasks: plan.nextTasks, submissionMarkers: [], files: [{ path: plan.operations[0].to, size: 11, sha256: sha256("image bytes") }], now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(replanned.operations.length, 0, "a completed migration must replan idempotently");

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
  const ImagePlugin = require("../main.js");
  Module._load = originalLoad;
  const plugin = new ImagePlugin();
  const commands = [];
  plugin.app = { vault: { adapter: { getBasePath: () => path.resolve(__dirname, "../../..") } } };
  plugin.manifest = { dir: "plugins/mangosteen-image" };
  plugin.loadData = async () => ({ imageTasks: [], submissionMarkers: [] });
  plugin.saveData = async () => {};
  plugin.addRibbonIcon = plugin.registerInterval = () => {};
  plugin.addCommand = (command) => commands.push(command);
  const originalWindow = global.window;
  global.window = { setInterval: () => 1 };
  await plugin.onload();
  const command = commands.find((item) => item.name === "整理山竹生图历史记录");
  assert.ok(command);
  let executions = 0;
  let previewText = "";
  plugin.previewImageHistoryMigration = () => plan;
  plugin.executeImageHistoryMigration = async () => { executions += 1; };
  plugin.confirmMigrationPlan = (message) => { previewText = message; return false; };
  await command.callback();
  assert.strictEqual(executions, 0);
  for (const value of [String(plan.counts.files), String(plan.counts.bytes), String(plan.counts.blocked), String(plan.counts.skipped), plan.destination, plan.backupPath]) assert.ok(previewText.includes(value));
  plugin.previewImageHistoryMigration = () => ({ ...plan, blocked: true, reasons: ["duplicate target"], counts: { ...plan.counts, blocked: 1 } });
  plugin.confirmMigrationPlan = () => { throw new Error("blocked plan must not confirm"); };
  await command.callback();
  assert.strictEqual(executions, 0);
  assert.ok(notices.some((message) => message.includes("duplicate target")));
  let previewCalls = 0;
  plugin.previewImageHistoryMigration = () => (++previewCalls === 1
    ? plan
    : { ...plan, blocked: false, reasons: [], operations: [], moves: [], counts: { ...plan.counts, files: 0, skipped: 1 } });
  plugin.confirmMigrationPlan = () => true;
  await command.callback();
  assert.strictEqual(executions, 0, "the command must revalidate task certainty after confirmation");
  global.window = originalWindow;

  console.log("history-migration-image: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
