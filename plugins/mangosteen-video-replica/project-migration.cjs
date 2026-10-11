const crypto = require("crypto");
const path = require("path");

const ACTIVE_RUN_STATUSES = new Set(["queued", "processing", "stopping"]);
const PROVIDER_SAVING_STATUSES = new Set(["saving", "provider-saving"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "completed_with_errors", "partial-failure", "failed", "stopped"]);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function migrationTimestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("迁移时间无效。");
  const digits = date.toISOString().replace(/\D/g, "");
  return `${digits.slice(0, 8)}-${digits.slice(8, 14)}-${digits.slice(14, 17)}`;
}

function normalizeRelativePath(value, label = "项目文件") {
  const raw = String(value ?? "").trim();
  const segments = raw.split("/");
  if (!raw || raw.includes("\0") || raw.includes("\\") || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)
      || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label}路径不安全。`);
  }
  return raw;
}

function normalizeProjectFolder(value) {
  const folder = normalizeRelativePath(value, "项目目录");
  if (!folder.startsWith("山竹视频复刻/") || folder === "山竹视频复刻") {
    throw new Error("项目目录必须位于 山竹视频复刻/ 下。");
  }
  return folder;
}

function assertInsideProject(projectFolder, value) {
  const filePath = normalizeRelativePath(value);
  if (!filePath.startsWith(`${projectFolder}/`)) throw new Error(`项目文件超出当前项目范围：${filePath}`);
  return filePath;
}

function validHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function fileIndex(projectFolder, files, reasons) {
  const index = new Map();
  for (const descriptor of Array.isArray(files) ? files : []) {
    const filePath = assertInsideProject(projectFolder, descriptor?.path);
    if (index.has(filePath)) {
      reasons.push(`迁移清单包含重复文件：${filePath}`);
      continue;
    }
    const item = {
      path: filePath,
      size: Number(descriptor?.size),
      sha256: String(descriptor?.sha256 || "").toLowerCase(),
      symlink: descriptor?.symlink === true,
      readable: descriptor?.readable !== false,
    };
    if (item.symlink) reasons.push(`项目文件包含符号链接，已拒绝迁移：${filePath}`);
    if (!item.readable || !Number.isFinite(item.size) || item.size < 0 || !validHash(item.sha256)) {
      reasons.push(`项目文件状态不可读，已拒绝迁移：${filePath}`);
    }
    index.set(filePath, item);
  }
  return index;
}

function objectValues(value) {
  return value && typeof value === "object" ? Object.values(value) : [];
}

function stateShots(state) {
  if (!state || typeof state !== "object") return [];
  if (Array.isArray(state.shots)) return state.shots;
  return objectValues(state.shots);
}

function projectMigrationSafetyReasons(input) {
  const reasons = [];
  const states = [
    input.activeRun, input.run, input.legacyQueue, input.legacyState,
    input.generationQueue, input.generationState,
  ].filter((item) => item && typeof item === "object");
  const projectStatus = String(input.project?.status || "").toLowerCase();
  if (ACTIVE_RUN_STATUSES.has(projectStatus) || projectStatus === "generating") reasons.push(`项目记录仍标记为运行中：${input.project.status}`);
  if (PROVIDER_SAVING_STATUSES.has(projectStatus)) reasons.push("项目记录仍处于媒体保存阶段。");
  if (input.project?.submissionReservation) reasons.push("项目记录存在未解决的付费提交预留。");
  if (input.project?.submissionUncertain === true || input.project?.uncertain === true) reasons.push("项目记录存在待核对的付费任务。");
  if (input.request?.confirmed === true && !states.some((state) => TERMINAL_RUN_STATUSES.has(String(state.status || "").toLowerCase()))) {
    reasons.push("已确认的生成请求尚无可核对的终态，视为排队中的付费任务。");
  }
  for (const state of states) {
    const status = String(state.status || "").toLowerCase();
    const stage = String(state.stage || "").toLowerCase();
    if (ACTIVE_RUN_STATUSES.has(status)) {
      reasons.push(`项目仍有运行中的任务：${state.status}`);
    }
    if (PROVIDER_SAVING_STATUSES.has(status) || PROVIDER_SAVING_STATUSES.has(stage)) reasons.push("项目仍处于供应商结果保存阶段。");
    if (state.submissionReservation) reasons.push("项目存在未解决的付费提交预留。");
    if (state.submissionUncertain === true || state.uncertain === true
        || (state.paidTaskSubmitted === true && ["unknown", "retrying", "recovery-pending"].includes(status))) {
      reasons.push("项目存在待核对的已接受付费任务。");
    }
    if (state.stopRequested === true) reasons.push("项目存在尚未核对的停止请求。");
    for (const shot of stateShots(state)) {
      const status = String(shot?.status || "").toLowerCase();
      const stage = String(shot?.stage || "").toLowerCase();
      if (PROVIDER_SAVING_STATUSES.has(status) || PROVIDER_SAVING_STATUSES.has(stage)) {
        reasons.push("项目仍处于供应商结果保存阶段。");
      }
      if (shot?.submissionReservation) reasons.push("项目存在未解决的付费提交预留。");
      if (shot?.submissionUncertain === true || shot?.uncertain === true
          || (shot?.paidTaskSubmitted === true && ["unknown", "retrying", "recovery-pending"].includes(status))) {
        reasons.push("项目存在待核对的已接受付费任务。");
      }
    }
  }
  if (input.pendingStop && input.pendingStop.status !== "resolved") reasons.push("项目存在尚未完成的停止请求。");
  if (input.stopRequest && input.stopRequest.status !== "resolved") reasons.push("项目存在尚未完成的停止请求。");
  const readErrors = input.readErrors && typeof input.readErrors === "object" ? Object.values(input.readErrors).filter(Boolean) : [];
  if (readErrors.length) reasons.push(`项目运行状态不可读：${readErrors.join("；")}`);
  for (const shot of Array.isArray(input.project?.shots) ? input.project.shots : []) {
    const status = String(shot?.status || "").toLowerCase();
    const stage = String(shot?.stage || "").toLowerCase();
    if (PROVIDER_SAVING_STATUSES.has(status) || PROVIDER_SAVING_STATUSES.has(stage)) reasons.push("项目媒体仍在保存，不能迁移。");
    if (shot?.submissionReservation) reasons.push("项目镜头存在未解决的付费提交预留。");
    if (shot?.submissionUncertain === true || shot?.uncertain === true) reasons.push("项目镜头存在待核对的付费任务。");
  }
  return [...new Set(reasons)];
}

function normalizedShotId(value, index) {
  const raw = String(value ?? "").trim();
  const numeric = /^\d{1,3}$/.test(raw) ? Number(raw) : index + 1;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 999) throw new Error("迁移镜头 ID 无效。");
  return String(numeric).padStart(3, "0");
}

function projectMigrationPlanId(plan) {
  return sha256(JSON.stringify({
    projectFolder: plan.projectFolder,
    backupPath: plan.backupPath,
    operations: plan.operations,
    writes: plan.writes,
    moves: plan.moves,
    project: plan.project,
    request: plan.request,
  }));
}

function planLegacyProjectMigration(input = {}) {
  const projectFolder = normalizeProjectFolder(input.projectFolder);
  if (!input.project || typeof input.project !== "object" || Array.isArray(input.project)) throw new Error("旧项目 project.json 不可读。");
  if (!input.request || typeof input.request !== "object" || Array.isArray(input.request)) throw new Error("旧项目 generation-request.json 不可读。");
  if (String(input.project.folder || "").replace(/\\/g, "/") !== projectFolder) throw new Error("project.json 的项目目录与迁移范围不一致。");

  const reasons = projectMigrationSafetyReasons(input);
  if (Number(input.project.schemaVersion) >= 6) reasons.push("当前项目已经是版本 6，无需迁移。");
  const files = fileIndex(projectFolder, input.files, reasons);
  for (const filePath of files.keys()) {
    const relative = filePath.slice(projectFolder.length + 1);
    if (relative.startsWith(".work/") && /(?:^|\/)\w[^/]*\.lock$/i.test(relative)) {
      reasons.push(`项目仍存在未核对的运行锁，已拒绝迁移：${relative}`);
    }
  }
  const plannedAt = new Date(input.now === undefined ? Date.now() : input.now).toISOString();
  const stamp = migrationTimestamp(plannedAt);
  const destination = `${projectFolder}/.mangosteen`;
  const backupPath = `${destination}/history/migration-${stamp}`;
  const journalPath = `${destination}/history/.migration-journal-${stamp}.json`;
  if ([...files.keys()].some((filePath) => filePath === destination || filePath.startsWith(`${destination}/`))) {
    reasons.push("版本 6 目标或迁移备份已存在，已拒绝覆盖。");
  }

  const operations = [];
  const targetPaths = new Set();
  const usedShotIds = new Set();
  const migratedProject = clone(input.project);
  const shots = Array.isArray(migratedProject.shots) ? migratedProject.shots : [];

  const addCopy = (fromValue, toValue) => {
    if (!String(fromValue || "").trim()) return null;
    const from = assertInsideProject(projectFolder, fromValue);
    const to = assertInsideProject(projectFolder, toValue);
    if (from === to) return to;
    const source = files.get(from);
    if (!source) {
      reasons.push(`项目记录引用的文件不存在或不可读：${from}`);
      return null;
    }
    if (files.has(to) || targetPaths.has(to)) {
      reasons.push(`迁移目标已存在或重复，已拒绝覆盖：${to}`);
      return null;
    }
    targetPaths.add(to);
    operations.push({ type: "copy", from, to, size: source.size, sha256: source.sha256 });
    return to;
  };

  for (const [index, shot] of shots.entries()) {
    const id = normalizedShotId(shot?.id, index);
    if (usedShotIds.has(id)) reasons.push(`迁移项目包含重复镜头 ID：${id}`);
    usedShotIds.add(id);
    shot.id = id;
    const root = `${projectFolder}/03-分镜/${id}`;
    const firstSource = shot.firstImagePath || shot.imagePath || "";
    const first = addCopy(firstSource, `${root}/首帧.png`);
    const last = addCopy(shot.lastImagePath || "", `${root}/尾帧.png`);
    const shotVideo = addCopy(shot.videoPath || "", `${root}/视频.mp4`);
    if (first) {
      shot.firstImagePath = first;
      shot.imagePath = first;
    }
    if (last) shot.lastImagePath = last;
    if (shotVideo) shot.videoPath = shotVideo;
    shot.currentArtifacts = {
      ...(shot.currentArtifacts && typeof shot.currentArtifacts === "object" ? shot.currentArtifacts : {}),
      ...(first ? { firstFrame: first } : {}),
      ...(last ? { lastFrame: last } : {}),
      ...(shotVideo ? { video: shotVideo } : {}),
    };
  }

  migratedProject.schemaVersion = 6;
  migratedProject.layoutVersion = 6;
  migratedProject.projectId = String(migratedProject.projectId || migratedProject.id || path.posix.basename(projectFolder));
  migratedProject.id = String(migratedProject.id || migratedProject.projectId);
  migratedProject.folder = projectFolder;
  migratedProject.updatedAt = plannedAt;
  const migratedRequest = clone(input.request);
  migratedRequest.schemaVersion = 6;
  migratedRequest.version = Math.max(5, Number(migratedRequest.version) || 5);
  migratedRequest.confirmed = false;
  if (Array.isArray(migratedRequest.shots)) {
    migratedRequest.shots = migratedRequest.shots.map((shot, index) => ({ ...shot, id: normalizedShotId(shot?.id, index) }));
  }

  const writes = [
    { type: "write", path: `${destination}/project.json`, content: `${JSON.stringify(migratedProject, null, 2)}\n` },
    { type: "write", path: `${destination}/draft.json`, content: `${JSON.stringify(migratedRequest, null, 2)}\n` },
  ].map((item) => ({ ...item, size: Buffer.byteLength(item.content), sha256: sha256(item.content) }));
  for (const write of writes) if (files.has(write.path)) reasons.push(`版本 6 文档目标已存在，已拒绝覆盖：${write.path}`);

  const moveSources = new Set(operations.map((item) => item.from));
  for (const filePath of files.keys()) {
    const relative = filePath.slice(projectFolder.length + 1);
    if (relative === "project.json" || relative === "generation-request.json"
        || relative.startsWith(".work/") || relative.startsWith("02-分镜脚本/") || relative.startsWith("03-视频片段/")) {
      moveSources.add(filePath);
    }
  }
  const moves = [...moveSources].sort().map((from) => {
    const source = files.get(from);
    return {
      type: "move",
      from,
      to: `${backupPath}/${from.slice(projectFolder.length + 1)}`,
      size: source?.size ?? 0,
      sha256: source?.sha256 || "",
    };
  });
  for (const move of moves) if (files.has(move.to)) reasons.push(`迁移备份目标已存在，已拒绝覆盖：${move.to}`);

  const uniqueReasons = [...new Set(reasons)];
  const blocked = uniqueReasons.length > 0;
  const effectiveOperations = blocked ? [] : operations;
  const effectiveWrites = blocked ? [] : writes;
  const effectiveMoves = blocked ? [] : moves;
  const plan = {
    version: 1,
    type: "legacy-project-migration",
    planId: "",
    plannedAt,
    projectFolder,
    destination,
    backupPath,
    journalPath,
    blocked,
    reasons: uniqueReasons,
    operations: effectiveOperations,
    writes: effectiveWrites,
    moves: effectiveMoves,
    deletes: [],
    project: migratedProject,
    request: migratedRequest,
    counts: {
      files: effectiveOperations.length,
      bytes: effectiveOperations.reduce((sum, item) => sum + item.size, 0),
      backupFiles: effectiveMoves.length,
      backupBytes: effectiveMoves.reduce((sum, item) => sum + item.size, 0),
      writeFiles: effectiveWrites.length,
      writeBytes: effectiveWrites.reduce((sum, item) => sum + item.size, 0),
      blocked: uniqueReasons.length,
      skipped: 0,
    },
    journal: input.journal ? clone(input.journal) : null,
  };
  plan.planId = projectMigrationPlanId(plan);
  return plan;
}

function createProjectMigrationJournal(plan) {
  if (!plan?.planId) throw new Error("迁移计划缺少 planId。");
  return {
    version: 1,
    type: "legacy-project-migration-journal",
    planId: plan.planId,
    projectFolder: plan.projectFolder,
    state: "planned",
    inFlight: null,
    completed: { copies: [], bundle: false, moves: [] },
    error: "",
    planSnapshot: { ...clone(plan), journal: null },
  };
}

function failClosed(message) {
  const error = new Error(message);
  error.failClosed = true;
  return error;
}

async function missingAsNull(hash, filePath) {
  try { return await hash(filePath); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function persistJournal(atomicWrite, plan, journal) {
  await atomicWrite({ type: "journal", path: plan.journalPath, value: clone(journal) });
}

async function rollbackProjectMigration({ journal, plan, move, removeNew, hash }) {
  const moveIndexes = new Set(journal.completed?.moves || []);
  if (journal.inFlight?.type === "move") moveIndexes.add(journal.inFlight.index);
  for (const index of [...moveIndexes].sort((left, right) => right - left)) {
    const operation = plan.moves[index];
    if (!operation) continue;
    if (typeof hash === "function") {
      const sourceHash = await missingAsNull(hash, operation.from);
      const backupHash = await missingAsNull(hash, operation.to);
      if (sourceHash === operation.sha256 && backupHash === null) continue;
      if (sourceHash !== null || backupHash !== operation.sha256) {
        throw failClosed(`回滚文件状态不一致，已停止：${operation.from}`);
      }
    }
    try { await move(operation.to, operation.from, { exclusive: true, rollback: true }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  if (journal.completed?.bundle || journal.inFlight?.type === "bundle") {
    for (const write of [...plan.writes].reverse()) await removeNew(write, { rollback: true });
  }
  const copyIndexes = new Set(journal.completed?.copies || []);
  if (journal.inFlight?.type === "copy") copyIndexes.add(journal.inFlight.index);
  for (const index of [...copyIndexes].sort((left, right) => right - left)) {
    const operation = plan.operations[index];
    if (operation) await removeNew(operation, { rollback: true });
  }
  journal.inFlight = null;
  journal.completed = { copies: [], bundle: false, moves: [] };
  journal.state = "rolled-back";
  return journal;
}

async function executeProjectMigration({ plan, copy, move, hash, atomicWrite, removeNew }) {
  if (!plan || plan.blocked) throw new Error(`迁移计划已阻止：${plan?.reasons?.join("；") || "计划不可用"}`);
  for (const [name, callback] of Object.entries({ copy, move, hash, atomicWrite, removeNew })) {
    if (typeof callback !== "function") throw new Error(`迁移执行器缺少 ${name}。`);
  }
  if (projectMigrationPlanId(plan) !== plan.planId) throw failClosed("迁移计划内容已变更，与 planId 不一致，已拒绝执行。");
  const journal = plan.journal ? clone(plan.journal) : createProjectMigrationJournal(plan);
  if (journal.planId !== plan.planId) throw failClosed("迁移 journal 与计划不一致，已 fail-closed。 ");
  if (["blocked", "rollback-failed"].includes(journal.state)) throw failClosed(journal.error || "迁移 journal 已阻止，需人工核对。");
  if (journal.state === "completed") {
    for (const operation of plan.operations) if (await hash(operation.to) !== operation.sha256) throw failClosed(`已完成迁移的目标哈希不一致：${operation.to}`);
    for (const write of plan.writes) if (await hash(write.path) !== write.sha256) throw failClosed(`已完成迁移的版本 6 文档哈希不一致：${write.path}`);
    for (const operation of plan.moves) {
      if (await missingAsNull(hash, operation.from) !== null || await hash(operation.to) !== operation.sha256) throw failClosed(`已完成迁移的备份状态不一致：${operation.from}`);
    }
    return journal;
  }
  journal.state = "running";
  await persistJournal(atomicWrite, plan, journal);

  try {
    for (const [index, operation] of plan.operations.entries()) {
      if (journal.completed.copies.includes(index)) {
        if (await missingAsNull(hash, operation.to) !== operation.sha256) throw failClosed(`已记录的迁移目标哈希不一致，拒绝继续：${operation.to}`);
        continue;
      }
      const replaying = journal.inFlight?.type === "copy" && journal.inFlight.index === index;
      const existingHash = await missingAsNull(hash, operation.to);
      if (existingHash !== null) {
        if (!replaying || existingHash !== operation.sha256) throw failClosed(`迁移目标存在且内容不一致，拒绝覆盖：${operation.to}`);
        journal.completed.copies.push(index);
        journal.inFlight = null;
        await persistJournal(atomicWrite, plan, journal);
        continue;
      }
      journal.inFlight = { type: "copy", index };
      await persistJournal(atomicWrite, plan, journal);
      await copy(operation.from, operation.to, { exclusive: true });
      if (await hash(operation.to) !== operation.sha256) throw new Error(`复制后 SHA-256 哈希不一致：${operation.to}`);
      journal.completed.copies.push(index);
      journal.inFlight = null;
      await persistJournal(atomicWrite, plan, journal);
    }

    if (!journal.completed.bundle) {
      const replaying = journal.inFlight?.type === "bundle";
      const hashes = await Promise.all(plan.writes.map((write) => missingAsNull(hash, write.path)));
      if (hashes.some((value) => value !== null)) {
        if (!replaying || hashes.some((value, index) => value !== plan.writes[index].sha256)) {
          throw failClosed("版本 6 文档已部分存在或哈希不一致，拒绝覆盖。");
        }
        journal.completed.bundle = true;
        journal.inFlight = null;
        await persistJournal(atomicWrite, plan, journal);
      } else {
        journal.inFlight = { type: "bundle" };
        await persistJournal(atomicWrite, plan, journal);
        await atomicWrite({ type: "bundle", writes: plan.writes.map(clone), exclusive: true });
        const writtenHashes = await Promise.all(plan.writes.map((write) => hash(write.path)));
        if (writtenHashes.some((value, index) => value !== plan.writes[index].sha256)) throw new Error("版本 6 文档写入后 SHA-256 哈希不一致。");
        journal.completed.bundle = true;
        journal.inFlight = null;
        await persistJournal(atomicWrite, plan, journal);
      }
    }

    for (const [index, operation] of plan.moves.entries()) {
      if (journal.completed.moves.includes(index)) {
        const sourceHash = await missingAsNull(hash, operation.from);
        const backupHash = await missingAsNull(hash, operation.to);
        if (sourceHash !== null || backupHash !== operation.sha256) throw failClosed(`已记录的备份移动状态不一致：${operation.from}`);
        continue;
      }
      const replaying = journal.inFlight?.type === "move" && journal.inFlight.index === index;
      const sourceHash = await missingAsNull(hash, operation.from);
      const backupHash = await missingAsNull(hash, operation.to);
      if (replaying && sourceHash === null && backupHash === operation.sha256) {
        journal.completed.moves.push(index);
        journal.inFlight = null;
        await persistJournal(atomicWrite, plan, journal);
        continue;
      }
      if (sourceHash !== operation.sha256 || backupHash !== null) throw failClosed(`旧文件或备份状态已变化，拒绝移动：${operation.from}`);
      journal.inFlight = { type: "move", index };
      await persistJournal(atomicWrite, plan, journal);
      await move(operation.from, operation.to, { exclusive: true });
      if (await missingAsNull(hash, operation.from) !== null || await hash(operation.to) !== operation.sha256) {
        throw new Error(`旧文件移动到备份后校验失败：${operation.from}`);
      }
      journal.completed.moves.push(index);
      journal.inFlight = null;
      await persistJournal(atomicWrite, plan, journal);
    }
    journal.state = "completed";
    journal.inFlight = null;
    await persistJournal(atomicWrite, plan, journal);
    return journal;
  } catch (error) {
    journal.error = String(error?.message || error);
    if (error?.failClosed) {
      journal.state = "blocked";
      await persistJournal(atomicWrite, plan, journal);
      throw error;
    }
    journal.state = "rolling-back";
    await persistJournal(atomicWrite, plan, journal);
    try {
      await rollbackProjectMigration({ journal, plan, move, removeNew, hash });
      await persistJournal(atomicWrite, plan, journal);
    } catch (rollbackError) {
      journal.state = "rollback-failed";
      journal.rollbackError = String(rollbackError?.message || rollbackError);
      await persistJournal(atomicWrite, plan, journal);
      error.rollbackError = rollbackError;
      error.message = `${error.message}；迁移回滚失败：${journal.rollbackError}`;
    }
    throw error;
  }
}

module.exports = {
  createProjectMigrationJournal,
  executeProjectMigration,
  planLegacyProjectMigration,
  projectMigrationPlanId,
  projectMigrationSafetyReasons,
  rollbackProjectMigration,
};
