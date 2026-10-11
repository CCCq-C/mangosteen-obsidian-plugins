const crypto = require("crypto");
const path = require("path");
const { standaloneVideoPath } = require("./output-storage.cjs");

const MIGRATION_TYPE = "video-history-migration";
const MIGRATION_VERSION = 3;
const MIGRATION_SCHEMA_VERSION = 1;
const JOURNAL_ROOT = ".mangosteen-video/migration-journal";

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function timestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("历史整理时间无效。");
  const digits = date.toISOString().replace(/\D/g, "");
  return `${digits.slice(0, 8)}-${digits.slice(8, 14)}-${digits.slice(14, 17)}`;
}
function safePath(value) {
  const raw = String(value || "").trim();
  const parts = raw.split("/");
  if (!raw || raw.includes("\\") || raw.includes("\0") || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)
      || parts.some((part) => !part || part === "." || part === "..")) throw new Error(`历史文件路径不安全：${raw}`);
  return raw;
}
function descriptorIndex(files, reasons) {
  const index = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = safePath(file?.path);
    if (index.has(filePath)) reasons.push(`文件清单重复：${filePath}`);
    const item = { path: filePath, size: Number(file?.size), sha256: String(file?.sha256 || "").toLowerCase(), symlink: file?.symlink === true };
    if (item.symlink) reasons.push(`历史文件包含符号链接：${filePath}`);
    if (!Number.isFinite(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/i.test(item.sha256)) reasons.push(`历史文件状态不可读：${filePath}`);
    index.set(filePath, item);
  }
  return index;
}
function markerBlocks(task, markers) {
  return (Array.isArray(markers) ? markers : []).some((marker) => {
    const matches = (task.submissionFingerprint && marker?.fingerprint === task.submissionFingerprint)
      || (task.id && String(marker?.taskId || "") === String(task.id));
    return matches && !["resolved", "completed", "rejected"].includes(String(marker?.status || "").toLowerCase());
  });
}
function legacyFolder(filePath) {
  const parts = safePath(filePath).split("/");
  return parts[0] === "山竹视频" && parts.length >= 3 ? parts.slice(0, 2).join("/") : "";
}
function taskIsUncertain(task, submissionMarkers) {
  const status = String(task?.status || "").toLowerCase();
  return task?.submissionUncertain === true || task?.uncertain === true || markerBlocks(task, submissionMarkers)
    || (task?.paidTaskSubmitted === true && ["unknown", "retrying", "saving"].includes(status));
}
function taskIsEligible(task, submissionMarkers) {
  return String(task?.status || "").toLowerCase() === "completed" && task?.saved === true
    && !taskIsUncertain(task, submissionMarkers) && !task?.outputTarget;
}
function videoHistorySafetySnapshot(tasks, submissionMarkers) {
  return { tasks: clone(Array.isArray(tasks) ? tasks : []), submissionMarkers: clone(Array.isArray(submissionMarkers) ? submissionMarkers : []) };
}
function videoHistoryPlanId(plan) {
  return sha256(JSON.stringify({
    type: plan.type,
    version: plan.version,
    schemaVersion: plan.schemaVersion,
    journalPath: plan.journalPath,
    destination: plan.destination,
    backupPath: plan.backupPath,
    sourceDisposition: plan.sourceDisposition,
    cleanupPending: plan.cleanupPending,
    operations: plan.operations,
    moves: plan.moves,
    originalSafetySnapshot: plan.originalSafetySnapshot,
    nextSafetySnapshot: plan.nextSafetySnapshot,
    originalTasks: plan.originalTasks,
    nextTasks: plan.nextTasks,
  }));
}

function derivedVideoJournalPath(plannedAt) {
  return `${JOURNAL_ROOT}/migration-${timestamp(plannedAt)}.json`;
}

function manifestForFolder(folder, fileMap) {
  return [...fileMap.values()]
    .filter((file) => file.path.startsWith(`${folder}/`))
    .map((file) => ({
      relativePath: file.path.slice(folder.length + 1),
      size: file.size,
      sha256: file.sha256,
      type: "file",
    }))
    .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
}

function planVideoHistoryMigration({ tasks = [], submissionMarkers = [], files = [], now, journal = null } = {}) {
  const reasons = [];
  const skipped = [];
  const fileMap = descriptorIndex(files, reasons);
  const ids = new Set();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = String(task?.id || "");
    if (!id) reasons.push("历史任务存在空 ID，已拒绝整理。");
    else if (ids.has(id)) reasons.push(`历史任务存在重复 ID：${id}`);
    ids.add(id);
  }
  const nextTasks = clone(Array.isArray(tasks) ? tasks : []);
  const operations = [];
  const targetPaths = new Set();
  const folders = new Set();
  const plannedAt = new Date(now === undefined ? Date.now() : now).toISOString();
  const stamp = timestamp(plannedAt);
  const destination = "山竹创作记录/视频";
  const backupPath = `.mangosteen-video/migration-backup/migration-${stamp}`;
  const journalPath = derivedVideoJournalPath(plannedAt);
  const protectedFolders = new Set();
  for (const task of nextTasks) {
    if (taskIsEligible(task, submissionMarkers)) continue;
    if (task?.localPath) {
      const folder = legacyFolder(task.localPath);
      if (folder) protectedFolders.add(folder);
    }
  }

  for (const task of nextTasks) {
    const status = String(task?.status || "").toLowerCase();
    const uncertain = taskIsUncertain(task, submissionMarkers);
    const eligible = taskIsEligible(task, submissionMarkers);
    if (!eligible) {
      skipped.push({ taskId: String(task?.id || ""), reason: uncertain ? "付费提交仍待核对或状态不确定" : "任务未完成、未保存或属于项目直存" });
      continue;
    }
    const source = safePath(task.localPath);
    const folder = legacyFolder(source);
    if (!folder) {
      skipped.push({ taskId: String(task.id || ""), reason: "任务已在新的月份目录或路径不属于旧历史" });
      continue;
    }
    if (protectedFolders.has(folder)) {
      skipped.push({ taskId: String(task.id || ""), reason: `旧目录还包含未完成或待核对任务：${folder}` });
      continue;
    }
    const descriptor = fileMap.get(source);
    if (!descriptor) {
      reasons.push(`已完成任务的视频不存在或不可读：${source}`);
      continue;
    }
    const target = standaloneVideoPath({ now: task.createdAt, taskId: task.id });
    if (fileMap.has(target) || targetPaths.has(target)) {
      reasons.push(`整理目标已存在或重复，已拒绝覆盖：${target}`);
      continue;
    }
    targetPaths.add(target);
    folders.add(folder);
    operations.push({ type: "copy", from: source, to: target, size: descriptor.size, sha256: descriptor.sha256 });
    task.localPath = target;
    task.historyMigratedAt = plannedAt;
    task.historyBackupPath = backupPath;
  }
  const moves = [...folders].sort().map((from) => ({
    type: "copy-directory-backup-retain-source",
    from,
    to: `${backupPath}/${from}`,
    manifest: manifestForFolder(from, fileMap),
  }));
  for (const move of moves) if ([...fileMap.keys()].some((filePath) => filePath === move.to || filePath.startsWith(`${move.to}/`))) reasons.push(`迁移备份已存在，已拒绝覆盖：${move.to}`);
  const uniqueReasons = [...new Set(reasons)];
  const blocked = uniqueReasons.length > 0;
  const safeOperations = blocked ? [] : operations;
  const safeMoves = blocked ? [] : moves;
  const backupFiles = blocked ? [] : [...fileMap.values()].filter((file) => [...folders].some((folder) => file.path.startsWith(`${folder}/`)));
  const plan = {
    version: MIGRATION_VERSION, schemaVersion: MIGRATION_SCHEMA_VERSION, type: MIGRATION_TYPE, planId: "", plannedAt, destination, backupPath, journalPath,
    sourceDisposition: "retained",
    cleanupPending: safeMoves.map((operation) => ({ type: "legacy-source-directory", path: operation.from, reason: "portable no-follow directory move is unavailable; source retained for separate cleanup" })),
    blocked, reasons: uniqueReasons, skipped, operations: safeOperations, moves: safeMoves,
    originalTasks: clone(tasks), nextTasks: blocked ? clone(tasks) : nextTasks, deletes: [], journal: journal ? clone(journal) : null,
    originalSafetySnapshot: videoHistorySafetySnapshot(tasks, submissionMarkers),
    nextSafetySnapshot: videoHistorySafetySnapshot(blocked ? tasks : nextTasks, submissionMarkers),
    counts: {
      files: safeOperations.length,
      bytes: safeOperations.reduce((sum, item) => sum + item.size, 0),
      backupFiles: backupFiles.length,
      backupBytes: backupFiles.reduce((sum, item) => sum + item.size, 0),
      blocked: uniqueReasons.length,
      skipped: skipped.length,
    },
  };
  plan.planId = videoHistoryPlanId(plan);
  return plan;
}

async function missingAsNull(hash, filePath) { try { return await hash(filePath); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
function createVideoHistoryJournal(plan) {
  return {
    version: MIGRATION_VERSION,
    type: `${MIGRATION_TYPE}-journal`,
    planId: plan.planId,
    journalPath: plan.journalPath,
    state: "planned",
    completed: { copies: [], settings: false, backups: [] },
    rollback: { settings: false, cleanupRecorded: false },
    cleanupPending: [],
    inFlight: null,
    error: "",
    rollbackError: "",
    planSnapshot: { ...clone(plan), journal: null },
  };
}
async function saveJournal(writeJournal, plan, journal) { await writeJournal(plan.journalPath, clone(journal)); }
function sameManifest(left, right) { return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right); }
function affectedTaskIds(plan) { return new Set(plan.operations.map((operation) => {
  const original = (plan.originalTasks || []).find((task) => task?.localPath === operation.from);
  return String(original?.id || "");
})); }
function taskView(task) {
  return {
    id: String(task?.id || ""), localPath: String(task?.localPath || ""),
    historyMigratedAt: task?.historyMigratedAt ?? null, historyBackupPath: task?.historyBackupPath ?? null,
  };
}
function settingsMatch(actual, expected, plan) {
  const ids = affectedTaskIds(plan);
  const actualById = new Map((Array.isArray(actual) ? actual : []).map((task) => [String(task?.id || ""), taskView(task)]));
  return (Array.isArray(expected) ? expected : []).filter((task) => ids.has(String(task?.id || "")))
    .every((task) => JSON.stringify(actualById.get(String(task.id || ""))) === JSON.stringify(taskView(task)));
}
function completedIndexes(journal, key, length, label) {
  const values = journal?.completed?.[key];
  if (!Array.isArray(values) || values.some((index) => !Number.isInteger(index) || index < 0 || index >= length)
      || new Set(values).size !== values.length) throw new Error(`历史整理 journal 的${label}记录无效。`);
  return values;
}
function backupEntries(plan) {
  return plan.moves.flatMap((operation, moveIndex) => operation.manifest.map((descriptor, fileIndex) => ({
    key: `${moveIndex}:${fileIndex}`,
    moveIndex,
    fileIndex,
    from: `${operation.from}/${descriptor.relativePath}`,
    to: `${operation.to}/${descriptor.relativePath}`,
    size: descriptor.size,
    sha256: descriptor.sha256,
  })));
}
function completedBackupKeys(journal, plan) {
  const allowed = new Set(backupEntries(plan).map((item) => item.key));
  const values = journal?.completed?.backups;
  if (!Array.isArray(values) || values.some((key) => !allowed.has(String(key))) || new Set(values.map(String)).size !== values.length) {
    throw new Error("历史整理 journal 的备份复制完成记录无效。");
  }
  return values.map(String);
}
function addCleanupPending(journal, item) {
  if (!journal.cleanupPending.some((current) => current.path === item.path && current.type === item.type)) journal.cleanupPending.push(item);
}
function validatePlan(plan) {
  if (!plan || plan.blocked) throw new Error(`历史整理计划已阻止：${plan?.reasons?.join("；") || "计划不可用"}`);
  if (plan.type !== MIGRATION_TYPE || plan.version !== MIGRATION_VERSION || plan.schemaVersion !== MIGRATION_SCHEMA_VERSION) throw new Error("历史整理计划类型或版本无效。");
  if (plan.sourceDisposition !== "retained" || plan.moves.some((item) => item.type !== "copy-directory-backup-retain-source")) throw new Error("历史整理计划包含不安全的源目录清理方式。");
  if (plan.journalPath !== derivedVideoJournalPath(plan.plannedAt)) throw new Error("历史整理 journal 路径不属于固定迁移目录。");
  if (videoHistoryPlanId(plan) !== plan.planId) throw new Error("历史整理计划内容已变更，与 planId 不一致，已拒绝执行。");
}
async function assertSafetySnapshot(readSafetySnapshot, expected, label) {
  const actual = await readSafetySnapshot();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`历史任务安全快照在${label}前已变化。`);
}
async function verifyBackup(readManifest, operation) {
  return sameManifest(await readManifest(operation.from), operation.manifest)
    && sameManifest(await readManifest(operation.to), operation.manifest);
}
async function verifyCompleted({ plan, journal, hash, readManifest, readSettings, readSafetySnapshot }) {
  for (const operation of plan.operations) if (await missingAsNull(hash, operation.to) !== operation.sha256) throw new Error(`已完成整理的目标哈希不一致：${operation.to}`);
  if (!settingsMatch(await readSettings(), plan.nextTasks, plan)) throw new Error("已完成整理的 settings 与计划不一致。");
  await assertSafetySnapshot(readSafetySnapshot, plan.nextSafetySnapshot, "完成校验");
  for (const operation of plan.moves) if (!await verifyBackup(readManifest, operation)) throw new Error(`已完成整理的源或备份清单不一致：${operation.from}`);
}
async function verifyForwardProgress({ plan, journal, hash, readManifest, readSettings }) {
  for (const index of completedIndexes(journal, "copies", plan.operations.length, "复制完成")) {
    const operation = plan.operations[index];
    if (await missingAsNull(hash, operation.to) !== operation.sha256) throw new Error(`已记录的复制目标哈希不一致：${operation.to}`);
  }
  if (typeof journal?.completed?.settings !== "boolean") throw new Error("历史整理 journal 的 settings 完成记录无效。");
  if (journal.completed.settings && !settingsMatch(await readSettings(), plan.nextTasks, plan)) throw new Error("已记录的 settings 写入状态不一致。");
  const entries = new Map(backupEntries(plan).map((item) => [item.key, item]));
  for (const key of completedBackupKeys(journal, plan)) {
    const entry = entries.get(key);
    if (await missingAsNull(hash, entry.from) !== entry.sha256 || await missingAsNull(hash, entry.to) !== entry.sha256) {
      throw new Error(`已记录的备份复制状态不一致：${entry.from}`);
    }
  }
  for (const operation of plan.moves) if (!sameManifest(await readManifest(operation.from), operation.manifest)) throw new Error(`源目录清单已变化：${operation.from}`);
}
async function resumeVideoHistoryRollback(context, journal) {
  const { plan, hash, atomicWriteSettings, writeJournal, readManifest, readSettings, assertMaintenanceOwned } = context;
  journal.state = "rolling-back";
  await saveJournal(writeJournal, plan, journal);
  try {
    const own = typeof assertMaintenanceOwned === "function" ? assertMaintenanceOwned : async () => true;
    const settingsMayHaveChanged = journal.completed.settings || journal.inFlight?.type === "settings";
    if (settingsMayHaveChanged && !journal.rollback.settings) {
      await own("rollback-settings");
      const current = await readSettings();
      if (settingsMatch(current, plan.nextTasks, plan)) await atomicWriteSettings(clone(plan.originalTasks));
      else if (!settingsMatch(current, plan.originalTasks, plan)) throw new Error("settings 回滚状态不一致。");
      if (!settingsMatch(await readSettings(), plan.originalTasks, plan)) throw new Error("settings 回滚后校验失败。");
      journal.rollback.settings = true;
      await saveJournal(writeJournal, plan, journal);
    }
    await own("rollback-source-verify");
    for (const operation of plan.moves) {
      if (!Array.isArray(await readManifest(operation.from))) throw new Error(`回滚时旧源目录不可读：${operation.from}`);
    }
    const copied = new Set(journal.completed.copies);
    if (journal.inFlight?.type === "copy") copied.add(journal.inFlight.index);
    for (const index of copied) {
      await own("rollback-copy-record");
      const operation = plan.operations[index];
      const actual = await missingAsNull(hash, operation.to);
      if (actual !== null && actual !== operation.sha256) throw new Error(`回滚保留目标内容不一致：${operation.to}`);
      if (actual === operation.sha256) addCleanupPending(journal, { type: "orphan-target-copy", path: operation.to, sha256: operation.sha256, reason: "safe path unlink is unavailable; retained for separate cleanup" });
      await saveJournal(writeJournal, plan, journal);
    }
    const entries = new Map(backupEntries(plan).map((item) => [item.key, item]));
    const backedUp = new Set(journal.completed.backups.map(String));
    if (journal.inFlight?.type === "backup") backedUp.add(String(journal.inFlight.key));
    for (const key of backedUp) {
      await own("rollback-backup-record");
      const entry = entries.get(key);
      if (!entry) throw new Error("回滚备份记录无效。");
      const actual = await missingAsNull(hash, entry.to);
      if (actual !== null && actual !== entry.sha256) throw new Error(`回滚保留备份内容不一致：${entry.to}`);
      if (actual === entry.sha256) addCleanupPending(journal, { type: "orphan-backup-copy", path: entry.to, sha256: entry.sha256, reason: "safe path unlink is unavailable; retained for separate cleanup" });
      await saveJournal(writeJournal, plan, journal);
    }
    journal.rollback.cleanupRecorded = true;
    journal.inFlight = null;
    journal.state = "rolled-back";
    await saveJournal(writeJournal, plan, journal);
    return journal;
  } catch (error) {
    journal.state = "rollback-failed";
    journal.rollbackError = String(error?.message || error);
    await saveJournal(writeJournal, plan, journal);
    throw error;
  }
}

async function executeVideoHistoryMigration(context) {
  const { plan, copy, backupCopy, hash, atomicWriteSettings, writeJournal, readManifest, readSettings, readSafetySnapshot } = context;
  for (const [name, callback] of Object.entries({ copy, backupCopy, hash, atomicWriteSettings, writeJournal, readManifest, readSettings, readSafetySnapshot })) {
    if (typeof callback !== "function") throw new Error(`历史整理缺少 ${name}。`);
  }
  validatePlan(plan);
  const journal = plan.journal ? clone(plan.journal) : createVideoHistoryJournal(plan);
  if (journal.planId !== plan.planId || journal.journalPath !== plan.journalPath || journal.type !== `${MIGRATION_TYPE}-journal`) throw new Error("历史整理 journal 与计划不一致，已拒绝继续。");
  if (["rolling-back", "rollback-failed"].includes(journal.state)) {
    await resumeVideoHistoryRollback(context, journal);
    throw new Error("历史整理回滚完成；未恢复正向迁移。");
  }
  if (journal.state === "rolled-back") throw new Error("历史整理已回滚，需人工处理 cleanupPending 后重新生成计划。");
  if (journal.state === "completed") { await verifyCompleted({ plan, journal, hash, readManifest, readSettings, readSafetySnapshot }); return journal; }
  if (!["planned", "forward"].includes(journal.state)) throw new Error(`历史整理 journal 状态无效：${journal.state}`);
  journal.state = "forward";
  await saveJournal(writeJournal, plan, journal);
  try {
    await verifyForwardProgress({ plan, journal, hash, readManifest, readSettings });
    for (const [index, operation] of plan.operations.entries()) {
      if (journal.completed.copies.includes(index)) continue;
      const existing = await missingAsNull(hash, operation.to);
      if (existing !== null) {
        if (journal.inFlight?.type !== "copy" || journal.inFlight.index !== index || existing !== operation.sha256) throw new Error(`整理目标已存在或哈希不一致：${operation.to}`);
      } else {
        journal.inFlight = { type: "copy", index, created: false };
        await saveJournal(writeJournal, plan, journal);
        await copy(operation.from, operation.to, { exclusive: true, size: operation.size, sha256: operation.sha256 });
        journal.inFlight.created = true;
        await saveJournal(writeJournal, plan, journal);
      }
      if (await hash(operation.to) !== operation.sha256) throw new Error(`复制后 SHA-256 哈希不一致：${operation.to}`);
      journal.completed.copies.push(index);
      journal.inFlight = null;
      await saveJournal(writeJournal, plan, journal);
    }
    const completedBackups = new Set(completedBackupKeys(journal, plan));
    for (const entry of backupEntries(plan)) {
      await assertSafetySnapshot(readSafetySnapshot, plan.originalSafetySnapshot, "备份复制");
      const directory = plan.moves[entry.moveIndex];
      if (!sameManifest(await readManifest(directory.from), directory.manifest)) throw new Error(`备份前源目录清单已变化：${directory.from}`);
      if (completedBackups.has(entry.key)) continue;
      const existing = await missingAsNull(hash, entry.to);
      if (existing !== null) {
        if (journal.inFlight?.type !== "backup" || String(journal.inFlight.key) !== entry.key || existing !== entry.sha256) throw new Error(`备份目标已存在或不一致：${entry.to}`);
      } else {
        journal.inFlight = { type: "backup", key: entry.key, created: false };
        await saveJournal(writeJournal, plan, journal);
        await backupCopy(entry.from, entry.to, { exclusive: true, size: entry.size, sha256: entry.sha256 });
        journal.inFlight.created = true;
        await saveJournal(writeJournal, plan, journal);
      }
      if (await hash(entry.from) !== entry.sha256 || await hash(entry.to) !== entry.sha256) throw new Error(`备份复制后 SHA-256 不一致：${entry.from}`);
      journal.completed.backups.push(entry.key);
      completedBackups.add(entry.key);
      journal.inFlight = null;
      await saveJournal(writeJournal, plan, journal);
    }
    await assertSafetySnapshot(readSafetySnapshot, plan.originalSafetySnapshot, "settings 写入");
    if (!journal.completed.settings) {
      const current = await readSettings();
      if (journal.inFlight?.type === "settings" && settingsMatch(current, plan.nextTasks, plan)) {
        journal.completed.settings = true;
        journal.inFlight = null;
        await saveJournal(writeJournal, plan, journal);
      } else {
        if (!settingsMatch(current, plan.originalTasks, plan)) throw new Error("settings 在迁移前已变化。");
        journal.inFlight = { type: "settings" };
        await saveJournal(writeJournal, plan, journal);
        await atomicWriteSettings(clone(plan.nextTasks));
        if (!settingsMatch(await readSettings(), plan.nextTasks, plan)) throw new Error("settings 写入后校验失败。");
        journal.completed.settings = true;
        journal.inFlight = null;
        await saveJournal(writeJournal, plan, journal);
      }
    }
    await assertSafetySnapshot(readSafetySnapshot, plan.nextSafetySnapshot, "完成");
    await verifyCompleted({ plan, journal, hash, readManifest, readSettings, readSafetySnapshot });
    journal.cleanupPending = clone(plan.cleanupPending);
    journal.state = "completed";
    journal.inFlight = null;
    await saveJournal(writeJournal, plan, journal);
    return journal;
  } catch (error) {
    journal.error = String(error?.message || error);
    try { await resumeVideoHistoryRollback(context, journal); }
    catch (rollbackError) {
      error.message = `${error.message}；迁移回滚失败：${String(rollbackError?.message || rollbackError)}`;
      throw error;
    }
    throw error;
  }
}

module.exports = {
  createVideoHistoryJournal,
  derivedVideoJournalPath,
  executeVideoHistoryMigration,
  videoHistorySafetySnapshot,
  videoHistoryPlanId,
  planVideoHistoryMigration,
};
