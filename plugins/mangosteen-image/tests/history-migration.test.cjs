const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const os = require("os");
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
  const journals = new Map();
  let savedTasks = JSON.parse(JSON.stringify(options.initialTasks || [task()]));
  let savedMarkers = JSON.parse(JSON.stringify(options.initialMarkers || []));
  let removeFailures = Number(options.failRemoveAt || 0);
  let settingsFailures = Number(options.failSettingsAt || 0);
  let sourceManifestReads = 0;
  let safetyReads = 0;
  const copy = async (from, to) => {
    events.push(`copy:${from}->${to}`);
    if (files.has(to)) throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
    files.set(to, Buffer.from(files.get(from)));
  };
  const backupCopy = async (from, to) => {
    events.push(`backup:${from}->${to}`);
    if (options.failBackupFrom === from) throw new Error("injected backup failure");
    if (files.has(to)) throw Object.assign(new Error("backup exists"), { code: "EEXIST" });
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
    savedTasks = JSON.parse(JSON.stringify(tasks));
    if (settingsFailures > 0) { settingsFailures -= 1; throw new Error("injected settings failure"); }
  };
  const writeJournal = async (journalPath, value) => { journals.set(journalPath, JSON.parse(JSON.stringify(value))); };
  const removeNew = async (operation) => {
    if (removeFailures > 0) { removeFailures -= 1; throw new Error("injected rollback removal failure"); }
    files.delete(operation.to);
  };
  const readManifest = async (folder) => {
    if (folder === "生图记录/2026-09-08-09-02-03") {
      sourceManifestReads += 1;
      if (sourceManifestReads === options.mutateManifestReadAt) files.set(`${folder}/late-race.tmp`, Buffer.from("late race"));
    }
    const entries = [...files.entries()]
      .filter(([filePath]) => filePath.startsWith(`${folder}/`))
      .map(([filePath, value]) => ({ relativePath: filePath.slice(folder.length + 1), size: value.length, sha256: sha256(value), type: "file" }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return entries.length ? entries : null;
  };
  const readSettings = async () => JSON.parse(JSON.stringify(savedTasks));
  const readSafetySnapshot = async () => {
    safetyReads += 1;
    if (safetyReads === options.mutateSafetyAt) {
      if (options.mutatedTasks) savedTasks = JSON.parse(JSON.stringify(options.mutatedTasks));
      if (options.mutatedMarkers) savedMarkers = JSON.parse(JSON.stringify(options.mutatedMarkers));
    }
    return { tasks: JSON.parse(JSON.stringify(savedTasks)), submissionMarkers: JSON.parse(JSON.stringify(savedMarkers)) };
  };
  return {
    files, events, journals, options, copy, backupCopy, hash, move, atomicWriteSettings, writeJournal, removeNew, readManifest, readSettings, readSafetySnapshot,
    get savedTasks() { return savedTasks; },
    setSafety({ tasks, submissionMarkers }) { if (tasks) savedTasks = JSON.parse(JSON.stringify(tasks)); if (submissionMarkers) savedMarkers = JSON.parse(JSON.stringify(submissionMarkers)); },
    clearFailures() { options.failMoveFrom = null; removeFailures = 0; settingsFailures = 0; },
  };
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
  assert.strictEqual(plan.sourceDisposition, "retained");
  assert.ok(plan.cleanupPending.some((item) => item.path === "生图记录/2026-09-08-09-02-03"));
  assert.strictEqual(plan.moves[0].type, "copy-directory-backup-retain-source");
  assert.match(plan.backupPath, /^\.mangosteen-image\/migration-backup\/migration-20261012-010203-004$/);
  assert.deepStrictEqual(plan.nextTasks[0].imagePaths, [plan.operations[0].to]);
  assert.strictEqual(plan.nextTasks[0].recordPath, null);
  assert.deepStrictEqual(plan.moves[0].manifest, [
    { relativePath: "note.txt", size: 7, sha256: sha256("keep me"), type: "file" },
    { relativePath: "图片-1.png", size: 11, sha256: sha256("image bytes"), type: "file" },
  ]);
  assert.match(plan.journalPath, /^\.mangosteen-image\/migration-journal\/migration-/);

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
  const duplicateIds = migration.planImageHistoryMigration({ tasks: [task(), task()], submissionMarkers: [], files, now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(duplicateIds.blocked, true);
  assert.match(duplicateIds.reasons.join("\n"), /重复 ID/);

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
  const tamperedJournalPath = { ...plan, journalPath: "notes/do-not-overwrite.md" };
  assert.notStrictEqual(migration.imageHistoryPlanId(tamperedJournalPath), plan.planId);
  await assert.rejects(migration.executeImageHistoryMigration({ plan: tamperedJournalPath, ...adapters({ [source]: "image bytes", [notePath]: "keep me" }) }), /journal|计划.*变更|路径/);
  for (const tampered of [{ ...plan, type: "other" }, { ...plan, version: 999 }, { ...plan, schemaVersion: 999 }]) {
    assert.notStrictEqual(migration.imageHistoryPlanId(tampered), plan.planId);
  }
  assert.notStrictEqual(migration.imageHistoryPlanId({ ...plan, moves: plan.moves.map((item) => ({ ...item, manifest: [] })) }), plan.planId);

  for (const mutation of ["added", "removed", "changed"]) {
    const changed = adapters({ [source]: "image bytes", [notePath]: "keep me" });
    if (mutation === "added") changed.files.set("生图记录/2026-09-08-09-02-03/late.tmp", Buffer.from("late"));
    if (mutation === "removed") changed.files.delete(notePath);
    if (mutation === "changed") changed.files.set(notePath, Buffer.from("changed"));
    await assert.rejects(migration.executeImageHistoryMigration({ plan, ...changed }), /清单|manifest|变化|不一致/);
    assert.strictEqual(changed.events.some((item) => /^(copy|settings|move):?/.test(item)), false, `${mutation} manifest drift must abort before copy/settings/move`);
  }
  const lateManifestRace = adapters({ [source]: "image bytes", [notePath]: "keep me" }, { mutateManifestReadAt: 3 });
  await assert.rejects(migration.executeImageHistoryMigration({ plan, ...lateManifestRace }), /备份前.*清单.*变化/);
  assert.strictEqual(lateManifestRace.events.some((item) => item.startsWith("move:") || item === "settings"), false, "last-moment manifest drift must not move a directory or write settings");

  const success = adapters({ [source]: "image bytes", [notePath]: "keep me" });
  const completed = await migration.executeImageHistoryMigration({ plan, ...success });
  assert.strictEqual(completed.state, "completed");
  assert.deepStrictEqual(success.events.map((item) => item.split(":")[0]), ["copy", "backup", "backup", "settings"]);
  assert.ok(success.files.has(plan.operations[0].to));
  assert.ok(success.files.has(source), "portable-safe migration must retain the legacy source");
  assert.ok(success.files.has(`${plan.backupPath}/生图记录/2026-09-08-09-02-03/图片-1.png`));
  assert.ok(success.files.has(`${plan.backupPath}/生图记录/2026-09-08-09-02-03/note.txt`), "the whole legacy task folder must move to backup");
  assert.deepStrictEqual(success.savedTasks, plan.nextTasks);

  const mismatch = adapters({ [source]: "image bytes", [notePath]: "keep me" }, { hashMismatchPath: plan.operations[0].to });
  await assert.rejects(migration.executeImageHistoryMigration({ plan, ...mismatch }), /SHA-256|哈希/);
  assert.ok(mismatch.files.has(source));
  assert.ok(mismatch.files.has(plan.operations[0].to), "unknown path content is retained instead of unlinked");
  assert.strictEqual(mismatch.journals.get(plan.journalPath).state, "rollback-failed");

  const firstBackupSource = `${plan.moves[0].from}/${plan.moves[0].manifest[0].relativePath}`;
  const backupFailure = adapters({ [source]: "image bytes", [notePath]: "keep me" }, { failBackupFrom: firstBackupSource });
  await assert.rejects(migration.executeImageHistoryMigration({ plan, ...backupFailure }), /injected backup failure/);
  assert.ok(backupFailure.files.has(source), "failed backup copy must leave the legacy source in place");
  assert.ok(backupFailure.files.has(plan.operations[0].to), "verified new copies are retained for explicit cleanup, never path-unlinked");
  assert.deepStrictEqual(backupFailure.savedTasks, plan.originalTasks, "failed backup copy must leave settings paths unchanged");
  assert.ok(backupFailure.journals.get(plan.journalPath).cleanupPending.some((item) => item.path === plan.operations[0].to));

  for (const [label, safetyOptions] of [
    ["saving", { initialTasks: [task({ status: "saving", saved: false })] }],
    ["uncertain", { initialTasks: [task({ submissionUncertain: true })] }],
    ["marker", { initialMarkers: [{ fingerprint: task().submissionFingerprint, status: "uncertain" }] }],
    ["duplicate", { initialTasks: [task(), task()] }],
    ["new shared task", { initialTasks: [task(), task({ id: "image-task-2", imagePaths: [source] })] }],
  ]) {
    const changedSafety = adapters({ [source]: "image bytes", [notePath]: "keep me" }, safetyOptions);
    await assert.rejects(migration.executeImageHistoryMigration({ plan, ...changedSafety }), /安全快照.*变化/, label);
    assert.ok(changedSafety.files.has(source), `${label}: legacy source must remain`);
    assert.strictEqual(changedSafety.events.some((item) => item.startsWith("backup:") || item === "settings"), false, `${label}: no backup/settings after safety drift`);
  }

  const markerBeforeCompleted = adapters({ [source]: "image bytes", [notePath]: "keep me" }, {
    mutateSafetyAt: 4,
    mutatedMarkers: [{ fingerprint: task().submissionFingerprint, status: "uncertain" }],
  });
  await assert.rejects(migration.executeImageHistoryMigration({ plan, ...markerBeforeCompleted }), /安全快照.*变化/);
  assert.strictEqual(markerBeforeCompleted.journals.get(plan.journalPath).state, "rolled-back");
  assert.ok(markerBeforeCompleted.files.has(source));

  const settingsFailure = adapters({ [source]: "image bytes", [notePath]: "keep me" }, { failSettingsAt: 1 });
  await assert.rejects(migration.executeImageHistoryMigration({ plan, ...settingsFailure }), /settings failure/);
  assert.deepStrictEqual(settingsFailure.savedTasks, plan.originalTasks, "a write-then-throw settings failure must be detected and rolled back");
  assert.strictEqual(settingsFailure.journals.get(plan.journalPath).state, "rolled-back");

  const interruptedRollback = adapters({ [source]: "image bytes", [notePath]: "keep me" }, { failSettingsAt: 2 });
  await assert.rejects(migration.executeImageHistoryMigration({ plan, ...interruptedRollback }), /回滚|removal|injected/);
  const rollbackFailed = interruptedRollback.journals.get(plan.journalPath);
  assert.strictEqual(rollbackFailed.state, "rollback-failed");
  const forwardEventsBeforeReplay = interruptedRollback.events.filter((item) => item.startsWith("copy:") || item === "settings").length;
  interruptedRollback.clearFailures();
  await assert.rejects(
    migration.executeImageHistoryMigration({ plan: { ...plan, journal: rollbackFailed }, ...interruptedRollback }),
    /已回滚|回滚完成/,
  );
  assert.strictEqual(interruptedRollback.journals.get(plan.journalPath).state, "rolled-back");
  assert.strictEqual(interruptedRollback.events.filter((item) => item.startsWith("copy:") || item === "settings").length, forwardEventsBeforeReplay, "rollback replay must never re-enter forward execution");

  const liedAboutCopy = migration.createImageHistoryJournal(plan);
  liedAboutCopy.state = "forward";
  liedAboutCopy.completed.copies = [0];
  const tamperedCompleted = adapters({ [source]: "image bytes", [notePath]: "keep me" });
  await assert.rejects(migration.executeImageHistoryMigration({ plan: { ...plan, journal: liedAboutCopy }, ...tamperedCompleted }), /已记录|哈希|缺失|回滚/);
  assert.strictEqual(tamperedCompleted.events.includes("settings"), false, "a false completed marker must be checked before settings are changed");

  const liedAboutSettings = migration.createImageHistoryJournal(plan);
  liedAboutSettings.state = "forward";
  liedAboutSettings.completed.copies = [0];
  liedAboutSettings.completed.settings = true;
  const falseSettings = adapters({ [source]: "image bytes", [notePath]: "keep me", [plan.operations[0].to]: "image bytes" });
  await assert.rejects(migration.executeImageHistoryMigration({ plan: { ...plan, journal: liedAboutSettings }, ...falseSettings }), /settings.*不一致/);

  const liedAboutMove = migration.createImageHistoryJournal(plan);
  liedAboutMove.state = "forward";
  liedAboutMove.completed.backups = ["0:0"];
  const falseMove = adapters({ [source]: "image bytes", [notePath]: "keep me" });
  await assert.rejects(migration.executeImageHistoryMigration({ plan: { ...plan, journal: liedAboutMove }, ...falseMove }), /已记录.*备份|移动状态|不一致/);
  assert.strictEqual(falseMove.events.some((item) => item.startsWith("copy:") || item === "settings" || item.startsWith("backup:")), false, "a false completed backup must be rejected before any forward action");

  const replanned = migration.planImageHistoryMigration({ tasks: plan.nextTasks, submissionMarkers: [], files: [{ path: plan.operations[0].to, size: 11, sha256: sha256("image bytes") }], now: "2026-10-12T01:02:03.004Z" });
  assert.strictEqual(replanned.operations.length, 0, "a completed migration must replan idempotently");

  const originalLoad = Module._load;
  const notices = [];
  const mainPath = path.resolve(__dirname, "../main.js");
  const pluginRoot = path.dirname(mainPath);
  const absoluteModulePaths = [
    path.join(pluginRoot, "history-migration.cjs"),
    path.join(pluginRoot, "output-storage.cjs"),
    path.join(pluginRoot, "image-api.cjs"),
    path.join(pluginRoot, "migration-safe-fs.cjs"),
  ];
  const absoluteModuleLoads = new Map(absoluteModulePaths.map((modulePath) => [modulePath, 0]));
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent?.filename === mainPath && /^\.\.?\/.*\.cjs$/i.test(request)) {
      const error = new Error(`Cannot find module '${request}'\nRequire stack: electron/js2c/renderer_init`);
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    if (absoluteModuleLoads.has(request)) absoluteModuleLoads.set(request, absoluteModuleLoads.get(request) + 1);
    if (request === "obsidian") return {
      Modal: class Modal {}, Plugin: class Plugin {},
      Notice: class Notice { constructor(message) { notices.push(String(message)); } },
      requestUrl: async () => ({ status: 200 }),
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../main.js")];
  let ImagePlugin;
  try { ImagePlugin = require("../main.js"); }
  catch (error) { Module._load = originalLoad; throw error; }
  for (const relativeMainPath of ["../../mangosteen-image/main.js", "../../mangosteen-video/main.js"]) {
    const source = fs.readFileSync(path.resolve(__dirname, relativeMainPath), "utf8");
    const localCjsRequires = [...source.matchAll(/\brequire\s*\(\s*["'](\.\.?\/[^"']+\.cjs)["']\s*\)/g)].map((match) => match[1]);
    assert.deepStrictEqual(localCjsRequires, [], `${relativeMainPath} must not contain local relative CJS requires: ${localCjsRequires.join(", ")}`);
  }
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
  try { await plugin.onload(); }
  finally { Module._load = originalLoad; }
  for (const modulePath of absoluteModulePaths) {
    assert.strictEqual(absoluteModuleLoads.get(modulePath), 1, `Obsidian onload must load ${path.basename(modulePath)} once by its absolute installed path`);
  }
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
  assert.match(previewText, /保留原位.*不移动.*不删除/);
  assert.match(previewText, /MIGRATION_SAFE_FS_UNAVAILABLE/);
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
  plugin.previewImageHistoryMigration = () => plan;
  plugin.confirmMigrationPlan = () => true;
  await command.callback();
  assert.strictEqual(executions, 0, "production migration must remain disabled without a vetted descriptor-relative primitive");
  assert.ok(notices.some((message) => message.includes("MIGRATION_SAFE_FS_UNAVAILABLE")));
  const journalVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-image-journal-"));
  plugin.app = { vault: { adapter: { getBasePath: () => journalVault } } };
  const journalTarget = path.join(journalVault, ...plan.journalPath.split("/"));
  fs.mkdirSync(path.dirname(journalTarget), { recursive: true });
  fs.writeFileSync(journalTarget, "unrelated note");
  assert.throws(() => plugin.writeMigrationJournal(plan.journalPath, migration.createImageHistoryJournal(plan)), /MIGRATION_SAFE_FS_UNAVAILABLE/);
  assert.strictEqual(fs.readFileSync(journalTarget, "utf8"), "unrelated note", "journal writer must not clobber an unrelated file");
  fs.mkdirSync(path.join(journalVault, "notes"), { recursive: true });
  fs.writeFileSync(path.join(journalVault, "notes/project.md"), "keep project note");
  assert.throws(() => plugin.writeMigrationJournal("notes/project.md", migration.createImageHistoryJournal(plan)), /路径|journal/);
  assert.strictEqual(fs.readFileSync(path.join(journalVault, "notes/project.md"), "utf8"), "keep project note");
  fs.rmSync(path.join(journalVault, ".mangosteen-image"), { recursive: true, force: true });
  const outsideJournal = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-image-journal-outside-"));
  fs.mkdirSync(path.join(journalVault, ".mangosteen-image"), { recursive: true });
  fs.symlinkSync(outsideJournal, path.join(journalVault, ".mangosteen-image/migration-journal"));
  assert.throws(() => plugin.writeMigrationJournal(plan.journalPath, migration.createImageHistoryJournal(plan)), /MIGRATION_SAFE_FS_UNAVAILABLE/);
  fs.rmSync(outsideJournal, { recursive: true, force: true });
  fs.rmSync(journalVault, { recursive: true, force: true });
  global.window = originalWindow;

  console.log("history-migration-image: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
