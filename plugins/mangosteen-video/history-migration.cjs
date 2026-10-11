const crypto = require("crypto");
const path = require("path");
const { standaloneVideoPath } = require("./output-storage.cjs");

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
function videoHistoryPlanId(plan) {
  return sha256(JSON.stringify({
    destination: plan.destination,
    backupPath: plan.backupPath,
    operations: plan.operations,
    moves: plan.moves,
    originalTasks: plan.originalTasks,
    nextTasks: plan.nextTasks,
  }));
}

function planVideoHistoryMigration({ tasks = [], submissionMarkers = [], files = [], now, journal = null } = {}) {
  const reasons = [];
  const skipped = [];
  const fileMap = descriptorIndex(files, reasons);
  const nextTasks = clone(Array.isArray(tasks) ? tasks : []);
  const operations = [];
  const targetPaths = new Set();
  const folders = new Set();
  const plannedAt = new Date(now === undefined ? Date.now() : now).toISOString();
  const stamp = timestamp(plannedAt);
  const destination = "山竹创作记录/视频";
  const backupPath = `.mangosteen-video/migration-backup/migration-${stamp}`;
  const journalPath = `.mangosteen-video/migration-journal/migration-${stamp}.json`;
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
  const moves = [...folders].sort().map((from) => ({ type: "move-directory", from, to: `${backupPath}/${from}` }));
  for (const move of moves) if ([...fileMap.keys()].some((filePath) => filePath === move.to || filePath.startsWith(`${move.to}/`))) reasons.push(`迁移备份已存在，已拒绝覆盖：${move.to}`);
  const uniqueReasons = [...new Set(reasons)];
  const blocked = uniqueReasons.length > 0;
  const safeOperations = blocked ? [] : operations;
  const safeMoves = blocked ? [] : moves;
  const backupFiles = blocked ? [] : [...fileMap.values()].filter((file) => [...folders].some((folder) => file.path.startsWith(`${folder}/`)));
  const plan = {
    version: 1, type: "video-history-migration", planId: "", plannedAt, destination, backupPath, journalPath,
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
  plan.planId = videoHistoryPlanId(plan);
  return plan;
}

async function missingAsNull(hash, filePath) { try { return await hash(filePath); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
function newJournal(plan) { return { version: 1, planId: plan.planId, state: "planned", completedCopies: [], settingsWritten: false, completedMoves: [], inFlight: null, error: "", planSnapshot: { ...clone(plan), journal: null } }; }
async function saveJournal(writeJournal, plan, journal) { await writeJournal(plan.journalPath, clone(journal)); }

async function executeVideoHistoryMigration({ plan, copy, move, hash, atomicWriteSettings, writeJournal, removeNew }) {
  if (!plan || plan.blocked) throw new Error(`历史整理计划已阻止：${plan?.reasons?.join("；") || "计划不可用"}`);
  for (const [name, callback] of Object.entries({ copy, move, hash, atomicWriteSettings, writeJournal, removeNew })) if (typeof callback !== "function") throw new Error(`历史整理缺少 ${name}。`);
  if (videoHistoryPlanId(plan) !== plan.planId) throw new Error("历史整理计划内容已变更，与 planId 不一致，已拒绝执行。");
  const journal = plan.journal ? clone(plan.journal) : newJournal(plan);
  if (journal.planId !== plan.planId) throw new Error("历史整理 journal 与计划不一致，已拒绝继续。");
  if (journal.state === "completed") {
    for (const operation of plan.operations) if (await hash(operation.to) !== operation.sha256) throw new Error(`已完成整理的目标哈希不一致：${operation.to}`);
    return journal;
  }
  journal.state = "running";
  await saveJournal(writeJournal, plan, journal);
  try {
    for (const [index, operation] of plan.operations.entries()) {
      if (journal.completedCopies.includes(index)) continue;
      const existing = await missingAsNull(hash, operation.to);
      if (existing !== null) {
        if (journal.inFlight?.type !== "copy" || journal.inFlight.index !== index || existing !== operation.sha256) throw new Error(`整理目标已存在或哈希不一致：${operation.to}`);
      } else {
        journal.inFlight = { type: "copy", index };
        await saveJournal(writeJournal, plan, journal);
        await copy(operation.from, operation.to, { exclusive: true });
      }
      if (await hash(operation.to) !== operation.sha256) throw new Error(`复制后 SHA-256 哈希不一致：${operation.to}`);
      journal.completedCopies.push(index);
      journal.inFlight = null;
      await saveJournal(writeJournal, plan, journal);
    }
    if (!journal.settingsWritten) {
      journal.inFlight = { type: "settings" };
      await saveJournal(writeJournal, plan, journal);
      await atomicWriteSettings(clone(plan.nextTasks));
      journal.settingsWritten = true;
      journal.inFlight = null;
      await saveJournal(writeJournal, plan, journal);
    }
    for (const [index, operation] of plan.moves.entries()) {
      if (journal.completedMoves.includes(index)) continue;
      journal.inFlight = { type: "move", index };
      await saveJournal(writeJournal, plan, journal);
      await move(operation.from, operation.to, { exclusive: true });
      journal.completedMoves.push(index);
      journal.inFlight = null;
      await saveJournal(writeJournal, plan, journal);
    }
    journal.state = "completed";
    await saveJournal(writeJournal, plan, journal);
    return journal;
  } catch (error) {
    journal.error = String(error?.message || error);
    journal.state = "rolling-back";
    await saveJournal(writeJournal, plan, journal);
    const moved = new Set(journal.completedMoves);
    if (journal.inFlight?.type === "move") moved.add(journal.inFlight.index);
    for (const index of [...moved].sort((a, b) => b - a)) {
      const operation = plan.moves[index];
      try { await move(operation.to, operation.from, { exclusive: true, rollback: true }); } catch (rollbackError) { if (rollbackError?.code !== "ENOENT") throw rollbackError; }
    }
    if (journal.settingsWritten) await atomicWriteSettings(clone(plan.originalTasks));
    const copied = new Set(journal.completedCopies);
    if (journal.inFlight?.type === "copy") copied.add(journal.inFlight.index);
    for (const index of [...copied].sort((a, b) => b - a)) await removeNew(plan.operations[index], { rollback: true });
    journal.state = "rolled-back";
    journal.inFlight = null;
    await saveJournal(writeJournal, plan, journal);
    throw error;
  }
}

module.exports = { executeVideoHistoryMigration, planVideoHistoryMigration, videoHistoryPlanId };
