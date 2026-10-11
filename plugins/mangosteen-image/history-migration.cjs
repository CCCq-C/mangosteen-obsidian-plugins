const crypto = require("crypto");
const path = require("path");
const { standaloneImagePath } = require("./output-storage.cjs");

const MIGRATION_TYPE = "image-history-migration";
const MIGRATION_VERSION = 2;
const MIGRATION_SCHEMA_VERSION = 1;
const JOURNAL_ROOT = ".mangosteen-image/migration-journal";

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
  return parts[0] === "生图记录" && parts.length >= 3 ? parts.slice(0, 2).join("/") : "";
}
function taskIsUncertain(task, submissionMarkers) {
  return task?.submissionUncertain === true || task?.uncertain === true || markerBlocks(task, submissionMarkers);
}
function taskIsEligible(task, submissionMarkers) {
  return task?.status === "completed" && task?.saved === true && !taskIsUncertain(task, submissionMarkers) && !task?.outputTarget;
}
function imageHistoryPlanId(plan) {
  return sha256(JSON.stringify({
    type: plan.type,
    version: plan.version,
    schemaVersion: plan.schemaVersion,
    journalPath: plan.journalPath,
    destination: plan.destination,
    backupPath: plan.backupPath,
    operations: plan.operations,
    moves: plan.moves,
    originalTasks: plan.originalTasks,
    nextTasks: plan.nextTasks,
  }));
}

function derivedImageJournalPath(plannedAt) {
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

function planImageHistoryMigration({ tasks = [], submissionMarkers = [], files = [], now, journal = null } = {}) {
  const reasons = [];
  const skipped = [];
  const fileMap = descriptorIndex(files, reasons);
  const nextTasks = clone(Array.isArray(tasks) ? tasks : []);
  const operations = [];
  const targetPaths = new Set();
  const folders = new Set();
  const plannedAt = new Date(now === undefined ? Date.now() : now).toISOString();
  const stamp = timestamp(plannedAt);
  const destination = "山竹创作记录/图片";
  const backupPath = `.mangosteen-image/migration-backup/migration-${stamp}`;
  const journalPath = derivedImageJournalPath(plannedAt);
  const protectedFolders = new Set();
  for (const task of nextTasks) {
    if (taskIsEligible(task, submissionMarkers)) continue;
    for (const imagePath of Array.isArray(task?.imagePaths) ? task.imagePaths : []) {
      const folder = legacyFolder(imagePath);
      if (folder) protectedFolders.add(folder);
    }
  }

  for (const [taskIndex, task] of nextTasks.entries()) {
    const uncertain = taskIsUncertain(task, submissionMarkers);
    const eligible = taskIsEligible(task, submissionMarkers);
    if (!eligible) {
      skipped.push({ taskId: String(task?.id || ""), reason: uncertain ? "付费提交仍待核对或状态不确定" : "任务未完成、未保存或属于项目直存" });
      continue;
    }
    const sources = Array.isArray(task.imagePaths) ? task.imagePaths : [];
    if (!sources.length) {
      skipped.push({ taskId: String(task.id || ""), reason: "任务没有已保存图片路径" });
      continue;
    }
    const sharedProtectedFolder = sources.map(legacyFolder).find((folder) => folder && protectedFolders.has(folder));
    if (sharedProtectedFolder) {
      skipped.push({ taskId: String(task.id || ""), reason: `旧目录还包含未完成或待核对任务：${sharedProtectedFolder}` });
      continue;
    }
    const migrated = [];
    for (const [imageIndex, rawSource] of sources.entries()) {
      const source = safePath(rawSource);
      const folder = legacyFolder(source);
      if (!folder) {
        migrated.push(source);
        continue;
      }
      const descriptor = fileMap.get(source);
      if (!descriptor) {
        reasons.push(`已完成任务的图片不存在或不可读：${source}`);
        continue;
      }
      const extension = path.posix.extname(source).slice(1);
      const target = standaloneImagePath({ now: task.createdAt, taskId: task.id, index: imageIndex + 1, extension });
      if (fileMap.has(target) || targetPaths.has(target)) {
        reasons.push(`整理目标已存在或重复，已拒绝覆盖：${target}`);
        continue;
      }
      targetPaths.add(target);
      folders.add(folder);
      operations.push({ type: "copy", taskIndex, from: source, to: target, size: descriptor.size, sha256: descriptor.sha256 });
      migrated.push(target);
    }
    if (migrated.length === sources.length) {
      task.imagePaths = migrated;
      task.recordPath = null;
      task.historyMigratedAt = plannedAt;
      task.historyBackupPath = backupPath;
    }
  }
  const moves = [...folders].sort().map((from) => ({
    type: "move-directory",
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
    blocked, reasons: uniqueReasons, skipped, operations: safeOperations, moves: safeMoves,
    originalTasks: clone(tasks), nextTasks: blocked ? clone(tasks) : nextTasks, deletes: [], journal: journal ? clone(journal) : null,
    counts: {
      files: safeOperations.length,
      bytes: safeOperations.reduce((sum, item) => sum + item.size, 0),
      backupFiles: backupFiles.length,
      backupBytes: backupFiles.reduce((sum, item) => sum + item.size, 0),
      blocked: uniqueReasons.length,
      skipped: skipped.length,
    },
  };
  plan.planId = imageHistoryPlanId(plan);
  return plan;
}

async function missingAsNull(hash, filePath) { try { return await hash(filePath); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
function createImageHistoryJournal(plan) {
  return {
    version: MIGRATION_VERSION,
    type: `${MIGRATION_TYPE}-journal`,
    planId: plan.planId,
    journalPath: plan.journalPath,
    state: "planned",
    completed: { copies: [], settings: false, moves: [] },
    rollback: { moves: [], settings: false, copies: [] },
    inFlight: null,
    error: "",
    rollbackError: "",
    planSnapshot: { ...clone(plan), journal: null },
  };
}
async function saveJournal(writeJournal, plan, journal) { await writeJournal(plan.journalPath, clone(journal)); }
function sameManifest(left, right) { return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right); }
function missingManifest(value) { return value === null; }
function affectedTaskIds(plan) { return new Set(plan.operations.map((operation) => String(plan.originalTasks?.[operation.taskIndex]?.id || ""))); }
function taskView(task) {
  return {
    id: String(task?.id || ""), imagePaths: clone(task?.imagePaths || []), recordPath: task?.recordPath ?? null,
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
function validatePlan(plan) {
  if (!plan || plan.blocked) throw new Error(`历史整理计划已阻止：${plan?.reasons?.join("；") || "计划不可用"}`);
  if (plan.type !== MIGRATION_TYPE || plan.version !== MIGRATION_VERSION || plan.schemaVersion !== MIGRATION_SCHEMA_VERSION) throw new Error("历史整理计划类型或版本无效。");
  if (plan.journalPath !== derivedImageJournalPath(plan.plannedAt)) throw new Error("历史整理 journal 路径不属于固定迁移目录。");
  if (imageHistoryPlanId(plan) !== plan.planId) throw new Error("历史整理计划内容已变更，与 planId 不一致，已拒绝执行。");
}
async function verifyMove(readManifest, operation, direction = "forward") {
  const source = await readManifest(operation.from);
  const backup = await readManifest(operation.to);
  if (direction === "forward") return missingManifest(source) && sameManifest(backup, operation.manifest);
  return sameManifest(source, operation.manifest) && missingManifest(backup);
}
async function verifyCompleted({ plan, journal, hash, readManifest, readSettings }) {
  for (const operation of plan.operations) if (await missingAsNull(hash, operation.to) !== operation.sha256) throw new Error(`已完成整理的目标哈希不一致：${operation.to}`);
  if (!settingsMatch(await readSettings(), plan.nextTasks, plan)) throw new Error("已完成整理的 settings 与计划不一致。");
  for (const operation of plan.moves) if (!await verifyMove(readManifest, operation, "forward")) throw new Error(`已完成整理的备份清单不一致：${operation.from}`);
}
async function verifyForwardProgress({ plan, journal, hash, readManifest, readSettings }) {
  for (const index of completedIndexes(journal, "copies", plan.operations.length, "复制完成")) {
    const operation = plan.operations[index];
    if (await missingAsNull(hash, operation.to) !== operation.sha256) throw new Error(`已记录的复制目标哈希不一致：${operation.to}`);
  }
  if (typeof journal?.completed?.settings !== "boolean") throw new Error("历史整理 journal 的 settings 完成记录无效。");
  if (journal.completed.settings && !settingsMatch(await readSettings(), plan.nextTasks, plan)) throw new Error("已记录的 settings 写入状态不一致。");
  for (const index of completedIndexes(journal, "moves", plan.moves.length, "备份移动完成")) {
    const operation = plan.moves[index];
    if (!await verifyMove(readManifest, operation, "forward")) throw new Error(`已记录的备份移动状态不一致：${operation.from}`);
  }
}
async function resumeImageHistoryRollback(context, journal) {
  const { plan, move, hash, atomicWriteSettings, writeJournal, removeNew, readManifest, readSettings } = context;
  journal.state = "rolling-back";
  await saveJournal(writeJournal, plan, journal);
  try {
    const moved = new Set(journal.completed.moves);
    if (journal.inFlight?.type === "move") moved.add(journal.inFlight.index);
    for (const index of [...moved].sort((a, b) => b - a)) {
      const operation = plan.moves[index];
      if (journal.rollback.moves.includes(index)) {
        if (!await verifyMove(readManifest, operation, "rollback")) throw new Error(`已记录的目录回滚状态不一致：${operation.from}`);
        continue;
      }
      const source = await readManifest(operation.from);
      const backup = await readManifest(operation.to);
      if (missingManifest(source) && sameManifest(backup, operation.manifest)) await move(operation.to, operation.from, { exclusive: true, rollback: true });
      else if (!sameManifest(source, operation.manifest) || !missingManifest(backup)) throw new Error(`目录回滚清单不一致：${operation.from}`);
      if (!await verifyMove(readManifest, operation, "rollback")) throw new Error(`目录回滚后校验失败：${operation.from}`);
      journal.rollback.moves.push(index);
      await saveJournal(writeJournal, plan, journal);
    }
    const settingsMayHaveChanged = journal.completed.settings || journal.inFlight?.type === "settings";
    if (settingsMayHaveChanged && !journal.rollback.settings) {
      const current = await readSettings();
      if (settingsMatch(current, plan.nextTasks, plan)) await atomicWriteSettings(clone(plan.originalTasks));
      else if (!settingsMatch(current, plan.originalTasks, plan)) throw new Error("settings 回滚状态不一致。");
      if (!settingsMatch(await readSettings(), plan.originalTasks, plan)) throw new Error("settings 回滚后校验失败。");
      journal.rollback.settings = true;
      await saveJournal(writeJournal, plan, journal);
    } else if (journal.rollback.settings && !settingsMatch(await readSettings(), plan.originalTasks, plan)) throw new Error("已记录的 settings 回滚状态不一致。");
    const copied = new Set(journal.completed.copies);
    if (journal.inFlight?.type === "copy") copied.add(journal.inFlight.index);
    for (const index of [...copied].sort((a, b) => b - a)) {
      const operation = plan.operations[index];
      if (journal.rollback.copies.includes(index)) {
        if (await missingAsNull(hash, operation.to) !== null) throw new Error(`已记录的复制回滚状态不一致：${operation.to}`);
        continue;
      }
      const targetHash = await missingAsNull(hash, operation.to);
      const ownedMismatch = journal.inFlight?.type === "copy" && journal.inFlight.index === index && journal.inFlight.created === true;
      if (targetHash === operation.sha256 || (targetHash !== null && ownedMismatch)) await removeNew(operation, { rollback: true, owned: ownedMismatch });
      else if (targetHash !== null) throw new Error(`复制回滚目标内容不一致：${operation.to}`);
      if (await missingAsNull(hash, operation.to) !== null) throw new Error(`复制回滚后目标仍存在：${operation.to}`);
      journal.rollback.copies.push(index);
      await saveJournal(writeJournal, plan, journal);
    }
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

async function executeImageHistoryMigration(context) {
  const { plan, copy, move, hash, atomicWriteSettings, writeJournal, removeNew, readManifest, readSettings } = context;
  for (const [name, callback] of Object.entries({ copy, move, hash, atomicWriteSettings, writeJournal, removeNew, readManifest, readSettings })) if (typeof callback !== "function") throw new Error(`历史整理缺少 ${name}。`);
  validatePlan(plan);
  const journal = plan.journal ? clone(plan.journal) : createImageHistoryJournal(plan);
  if (journal.planId !== plan.planId || journal.journalPath !== plan.journalPath || journal.type !== `${MIGRATION_TYPE}-journal`) throw new Error("历史整理 journal 与计划不一致，已拒绝继续。");
  if (["rolling-back", "rollback-failed"].includes(journal.state)) {
    await resumeImageHistoryRollback(context, journal);
    throw new Error("历史整理回滚完成；未恢复正向迁移。");
  }
  if (journal.state === "rolled-back") throw new Error("历史整理已回滚，需重新生成计划。");
  if (journal.state === "completed") { await verifyCompleted({ plan, journal, hash, readManifest, readSettings }); return journal; }
  if (!["planned", "forward"].includes(journal.state)) throw new Error(`历史整理 journal 状态无效：${journal.state}`);
  journal.state = "forward";
  await saveJournal(writeJournal, plan, journal);
  try {
    await verifyForwardProgress({ plan, journal, hash, readManifest, readSettings });
    for (const [index, operation] of plan.moves.entries()) {
      if (journal.completed.moves.includes(index)) continue;
      if (!sameManifest(await readManifest(operation.from), operation.manifest) || !missingManifest(await readManifest(operation.to))) throw new Error(`备份清单已变化，已拒绝整理：${operation.from}`);
    }
    for (const [index, operation] of plan.operations.entries()) {
      if (journal.completed.copies.includes(index)) {
        if (await missingAsNull(hash, operation.to) !== operation.sha256) throw new Error(`已记录的复制目标哈希不一致：${operation.to}`);
        continue;
      }
      const existing = await missingAsNull(hash, operation.to);
      if (existing !== null) {
        if (journal.inFlight?.type !== "copy" || journal.inFlight.index !== index || existing !== operation.sha256) throw new Error(`整理目标已存在或哈希不一致：${operation.to}`);
      } else {
        journal.inFlight = { type: "copy", index };
        await saveJournal(writeJournal, plan, journal);
        await copy(operation.from, operation.to, { exclusive: true });
        journal.inFlight.created = true;
        await saveJournal(writeJournal, plan, journal);
      }
      if (await hash(operation.to) !== operation.sha256) throw new Error(`复制后 SHA-256 哈希不一致：${operation.to}`);
      journal.completed.copies.push(index);
      journal.inFlight = null;
      await saveJournal(writeJournal, plan, journal);
    }
    if (journal.completed.settings && !settingsMatch(await readSettings(), plan.nextTasks, plan)) throw new Error("已记录的 settings 写入状态不一致。");
    for (const [index, operation] of plan.moves.entries()) {
      if (journal.completed.moves.includes(index)) {
        if (!await verifyMove(readManifest, operation, "forward")) throw new Error(`已记录的备份移动状态不一致：${operation.from}`);
        continue;
      }
      const source = await readManifest(operation.from);
      const backup = await readManifest(operation.to);
      if (journal.inFlight?.type === "move" && journal.inFlight.index === index && missingManifest(source) && sameManifest(backup, operation.manifest)) {
        journal.completed.moves.push(index);
        journal.inFlight = null;
        await saveJournal(writeJournal, plan, journal);
        continue;
      }
      if (!sameManifest(source, operation.manifest) || !missingManifest(backup)) throw new Error(`移动前备份清单已变化：${operation.from}`);
      journal.inFlight = { type: "move", index };
      await saveJournal(writeJournal, plan, journal);
      if (!sameManifest(await readManifest(operation.from), operation.manifest) || !missingManifest(await readManifest(operation.to))) throw new Error(`重命名前备份清单已变化：${operation.from}`);
      await move(operation.from, operation.to, { exclusive: true });
      if (!await verifyMove(readManifest, operation, "forward")) throw new Error(`目录移动后清单校验失败：${operation.from}`);
      journal.completed.moves.push(index);
      journal.inFlight = null;
      await saveJournal(writeJournal, plan, journal);
    }
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
    journal.inFlight = null;
    await verifyCompleted({ plan, journal, hash, readManifest, readSettings });
    journal.state = "completed";
    await saveJournal(writeJournal, plan, journal);
    return journal;
  } catch (error) {
    journal.error = String(error?.message || error);
    try { await resumeImageHistoryRollback(context, journal); }
    catch (rollbackError) {
      error.message = `${error.message}；迁移回滚失败：${String(rollbackError?.message || rollbackError)}`;
      throw error;
    }
    throw error;
  }
}

module.exports = {
  createImageHistoryJournal,
  derivedImageJournalPath,
  executeImageHistoryMigration,
  imageHistoryPlanId,
  planImageHistoryMigration,
};
