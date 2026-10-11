const crypto = require("crypto");
const path = require("path");

const ACTIVE_RUN_STATUSES = new Set(["queued", "processing", "stopping"]);
const PROVIDER_SAVING_STATUSES = new Set(["saving", "provider-saving"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "completed_with_errors", "partial-failure", "failed", "stopped"]);
const MIGRATION_TYPE = "legacy-project-migration";
const MIGRATION_VERSION = 3;
const MIGRATION_SCHEMA_VERSION = 1;

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
    type: plan.type,
    version: plan.version,
    schemaVersion: plan.schemaVersion,
    projectFolder: plan.projectFolder,
    journalPath: plan.journalPath,
    destination: plan.destination,
    backupPath: plan.backupPath,
    sourceDisposition: plan.sourceDisposition,
    cleanupPending: plan.cleanupPending,
    stageRoot: plan.stageRoot,
    operations: plan.operations,
    writes: plan.writes,
    moves: plan.moves,
    backupManifest: plan.backupManifest,
    project: plan.project,
    request: plan.request,
  }));
}

function projectMaintenanceLockPath(projectFolder) {
  return `${normalizeProjectFolder(projectFolder)}/.mangosteen/maintenance.lock`;
}

function derivedProjectJournalPath(projectFolder, plannedAt) {
  return `${normalizeProjectFolder(projectFolder)}/.mangosteen/history/.migration-journal-${migrationTimestamp(plannedAt)}.json`;
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
  const journalPath = derivedProjectJournalPath(projectFolder, plannedAt);
  const stageRoot = `${destination}/history/.migration-stage-${stamp}`;
  const maintenanceLockPath = projectMaintenanceLockPath(projectFolder);
  if ([...files.keys()].some((filePath) => (filePath === destination || filePath.startsWith(`${destination}/`)) && filePath !== maintenanceLockPath)) {
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
    // draft is exposed first; project.json is the activation member used by
    // workbenchProjectPaths to recognize v6, so a crash cannot expose a
    // project.json without its matching draft.json.
    { type: "write", path: `${destination}/draft.json`, content: `${JSON.stringify(migratedRequest, null, 2)}\n`, activation: false },
    { type: "write", path: `${destination}/project.json`, content: `${JSON.stringify(migratedProject, null, 2)}\n`, activation: true },
  ].map((item) => ({
    ...item,
    stagePath: `${stageRoot}/${path.posix.basename(item.path)}`,
    size: Buffer.byteLength(item.content),
    sha256: sha256(item.content),
  }));
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
      type: "copy-backup-retain-source",
      from,
      to: `${backupPath}/${from.slice(projectFolder.length + 1)}`,
      size: source?.size ?? 0,
      sha256: source?.sha256 || "",
    };
  });
  const backupManifest = moves.map((operation) => ({
    relativePath: operation.from.slice(projectFolder.length + 1),
    size: operation.size,
    sha256: operation.sha256,
    type: "file",
  }));
  for (const move of moves) if (files.has(move.to)) reasons.push(`迁移备份目标已存在，已拒绝覆盖：${move.to}`);

  const uniqueReasons = [...new Set(reasons)];
  const blocked = uniqueReasons.length > 0;
  const effectiveOperations = blocked ? [] : operations;
  const effectiveWrites = blocked ? [] : writes;
  const effectiveMoves = blocked ? [] : moves;
  const plan = {
    version: MIGRATION_VERSION,
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    type: MIGRATION_TYPE,
    planId: "",
    plannedAt,
    projectFolder,
    destination,
    backupPath,
    journalPath,
    stageRoot,
    maintenanceLockPath,
    sourceDisposition: "retained",
    cleanupPending: [
      ...effectiveMoves.map((operation) => ({ type: "legacy-source-file", path: operation.from, reason: "portable no-follow move is unavailable; source retained for separate cleanup" })),
      ...effectiveWrites.map((operation) => ({ type: "verified-stage-file", path: operation.stagePath, reason: "path unlink is intentionally deferred to separate cleanup" })),
    ],
    blocked,
    reasons: uniqueReasons,
    operations: effectiveOperations,
    writes: effectiveWrites,
    moves: effectiveMoves,
    backupManifest: blocked ? [] : backupManifest,
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
    version: MIGRATION_VERSION,
    type: `${MIGRATION_TYPE}-journal`,
    planId: plan.planId,
    journalPath: plan.journalPath,
    projectFolder: plan.projectFolder,
    state: "planned",
    inFlight: null,
    completed: { copies: [], staged: [], exposed: [], backups: [] },
    rollback: { backups: [], exposed: [], copies: [], stages: [] },
    cleanupPending: [],
    error: "",
    rollbackError: "",
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

function validateProjectPlan(plan) {
  if (!plan || plan.blocked) throw new Error(`迁移计划已阻止：${plan?.reasons?.join("；") || "计划不可用"}`);
  if (plan.type !== MIGRATION_TYPE || plan.version !== MIGRATION_VERSION || plan.schemaVersion !== MIGRATION_SCHEMA_VERSION) {
    throw failClosed("迁移计划类型或版本无效。");
  }
  if (plan.journalPath !== derivedProjectJournalPath(plan.projectFolder, plan.plannedAt)) {
    throw failClosed("迁移 journal 路径不属于固定项目迁移目录。");
  }
  if (plan.maintenanceLockPath !== projectMaintenanceLockPath(plan.projectFolder)) {
    throw failClosed("项目维护锁路径不属于固定目录。");
  }
  if (projectMigrationPlanId(plan) !== plan.planId) throw failClosed("迁移计划内容已变更，与 planId 不一致，已拒绝执行。");
}

async function persistJournal(atomicWrite, plan, journal) {
  await atomicWrite({ type: "journal", path: plan.journalPath, value: clone(journal) });
}

async function assertOwned(context, phase) {
  await context.assertMaintenanceOwned(phase);
}

async function checkedHash(context, filePath, phase) {
  await assertOwned(context, phase);
  return missingAsNull(context.hash, filePath);
}

function recordCleanupPending(journal, item) {
  if (!Array.isArray(journal.cleanupPending)) journal.cleanupPending = [];
  if (!journal.cleanupPending.some((entry) => entry.type === item.type && entry.path === item.path)) {
    journal.cleanupPending.push(clone(item));
  }
}

async function verifyProjectBackup(context, operation, phase) {
  const sourceHash = await checkedHash(context, operation.from, `${phase}:source`);
  const backupHash = await checkedHash(context, operation.to, `${phase}:backup`);
  return sourceHash === operation.sha256 && backupHash === operation.sha256;
}

async function verifyProjectFinal(context) {
  const { plan } = context;
  for (const operation of plan.operations) {
    if (await checkedHash(context, operation.to, `completed:copy:${operation.to}`) !== operation.sha256) throw failClosed(`迁移目标哈希不一致：${operation.to}`);
  }
  for (const write of plan.writes) {
    if (await checkedHash(context, write.path, `completed:bundle:${write.path}`) !== write.sha256) throw failClosed(`版本 6 文档哈希不一致：${write.path}`);
    if (await checkedHash(context, write.stagePath, `completed:stage:${write.stagePath}`) !== write.sha256) throw failClosed(`版本 6 暂存文件哈希不一致：${write.stagePath}`);
  }
  for (const operation of plan.moves) {
    if (!await verifyProjectBackup(context, operation, `completed:backup:${operation.from}`)) throw failClosed(`迁移备份状态不一致：${operation.from}`);
  }
}

function projectCompletedIndexes(journal, key, length, label) {
  const values = journal?.completed?.[key];
  if (!Array.isArray(values) || values.some((index) => !Number.isInteger(index) || index < 0 || index >= length)
      || new Set(values).size !== values.length) throw failClosed(`迁移 journal 的${label}记录无效。`);
  return values;
}

async function verifyProjectForwardProgress(context) {
  const { plan, journal } = context;
  for (const index of projectCompletedIndexes(journal, "copies", plan.operations.length, "复制完成")) {
    const operation = plan.operations[index];
    if (await checkedHash(context, operation.to, `replay:copy:${index}`) !== operation.sha256) throw failClosed(`已记录的迁移目标哈希不一致：${operation.to}`);
  }
  const staged = projectCompletedIndexes(journal, "staged", plan.writes.length, "暂存完成");
  const exposed = projectCompletedIndexes(journal, "exposed", plan.writes.length, "bundle 暴露完成");
  for (const index of staged) {
    const write = plan.writes[index];
    if (await checkedHash(context, write.stagePath, `replay:stage:${index}`) !== write.sha256) throw failClosed(`已记录的暂存文件哈希不一致：${write.stagePath}`);
  }
  for (const index of exposed) {
    const write = plan.writes[index];
    if (await checkedHash(context, write.path, `replay:bundle:${index}`) !== write.sha256) throw failClosed(`已记录的版本 6 文档哈希不一致：${write.path}`);
  }
  for (const index of projectCompletedIndexes(journal, "backups", plan.moves.length, "备份复制完成")) {
    const operation = plan.moves[index];
    if (!await verifyProjectBackup(context, operation, `replay:backup:${index}`)) throw failClosed(`已记录的备份复制状态不一致：${operation.from}`);
  }
}

async function rollbackProjectMigration(context) {
  const { journal, plan, atomicWrite } = context;
  journal.state = "rolling-back";
  await persistJournal(atomicWrite, plan, journal);
  try {
    const backups = new Set(journal.completed.backups);
    if (journal.inFlight?.type === "backup-copy") backups.add(journal.inFlight.index);
    for (const index of [...backups].sort((left, right) => right - left)) {
      const operation = plan.moves[index];
      await assertOwned(context, `rollback:backup:${index}`);
      if (journal.rollback.backups.includes(index)) {
        if (!await verifyProjectBackup(context, operation, `rollback:verify-backup:${index}`)) throw failClosed(`已记录的备份保留状态不一致：${operation.from}`);
        continue;
      }
      if (!await verifyProjectBackup(context, operation, `rollback:backup-state:${index}`)) throw failClosed(`回滚备份状态不一致：${operation.from}`);
      recordCleanupPending(journal, { type: "verified-backup-file", path: operation.to, reason: "safe migration never unlinks backup files during rollback" });
      journal.rollback.backups.push(index);
      await persistJournal(atomicWrite, plan, journal);
    }

    const exposed = new Set(journal.completed.exposed);
    if (journal.inFlight?.type === "bundle-expose") exposed.add(journal.inFlight.index);
    for (const index of [...exposed].sort((left, right) => right - left)) {
      const write = plan.writes[index];
      await assertOwned(context, `rollback:bundle:${index}`);
      if (journal.rollback.exposed.includes(index)) {
        if (await checkedHash(context, write.path, `rollback:verify-bundle:${index}`) !== write.sha256) throw failClosed(`已记录的版本 6 文档保留状态不一致：${write.path}`);
        continue;
      }
      const targetHash = await checkedHash(context, write.path, `rollback:bundle-state:${index}`);
      if (targetHash !== null && targetHash !== write.sha256) throw failClosed(`版本 6 文档回滚目标不一致：${write.path}`);
      if (targetHash === write.sha256) recordCleanupPending(journal, {
        type: "verified-v6-file",
        path: write.path,
        visible: write.activation === true,
        reason: "portable no-follow unlink is unavailable; manual recovery required",
      });
      journal.rollback.exposed.push(index);
      await persistJournal(atomicWrite, plan, journal);
    }

    const copied = new Set(journal.completed.copies);
    if (journal.inFlight?.type === "copy") copied.add(journal.inFlight.index);
    for (const index of [...copied].sort((left, right) => right - left)) {
      const operation = plan.operations[index];
      await assertOwned(context, `rollback:copy:${index}`);
      if (journal.rollback.copies.includes(index)) {
        if (await checkedHash(context, operation.to, `rollback:verify-copy:${index}`) !== operation.sha256) throw failClosed(`已记录的复制保留状态不一致：${operation.to}`);
        continue;
      }
      const targetHash = await checkedHash(context, operation.to, `rollback:copy-state:${index}`);
      if (targetHash !== null && targetHash !== operation.sha256) throw failClosed(`复制回滚目标不一致：${operation.to}`);
      if (targetHash === operation.sha256) recordCleanupPending(journal, { type: "verified-generated-copy", path: operation.to, reason: "portable no-follow unlink is unavailable; cleanup deferred" });
      journal.rollback.copies.push(index);
      await persistJournal(atomicWrite, plan, journal);
    }

    const staged = new Set(journal.completed.staged);
    if (journal.inFlight?.type === "bundle-stage") staged.add(journal.inFlight.index);
    for (const index of [...staged].sort((left, right) => right - left)) {
      const write = plan.writes[index];
      await assertOwned(context, `rollback:stage:${index}`);
      if (journal.rollback.stages.includes(index)) {
        if (await checkedHash(context, write.stagePath, `rollback:verify-stage:${index}`) !== write.sha256) throw failClosed(`已记录的暂存保留状态不一致：${write.stagePath}`);
        continue;
      }
      const stageHash = await checkedHash(context, write.stagePath, `rollback:stage-state:${index}`);
      if (stageHash !== null && stageHash !== write.sha256) throw failClosed(`暂存回滚目标不一致：${write.stagePath}`);
      if (stageHash === write.sha256) recordCleanupPending(journal, { type: "verified-stage-file", path: write.stagePath, reason: "portable no-follow unlink is unavailable; cleanup deferred" });
      journal.rollback.stages.push(index);
      await persistJournal(atomicWrite, plan, journal);
    }

    journal.inFlight = null;
    if (journal.cleanupPending.some((item) => item.type === "verified-v6-file" && item.visible === true)) {
      throw failClosed("版本 6 激活成员已暴露；安全运行时不能无竞态删除，需保留维护锁并人工恢复。");
    }
    journal.state = "rolled-back";
    await persistJournal(atomicWrite, plan, journal);
    return journal;
  } catch (error) {
    journal.state = "rollback-failed";
    journal.rollbackError = String(error?.message || error);
    await persistJournal(atomicWrite, plan, journal);
    throw error;
  }
}

async function executeProjectMigration(context) {
  const { plan, copy, backupCopy, hash, atomicWrite, assertMaintenanceOwned } = context;
  for (const [name, callback] of Object.entries({ copy, backupCopy, hash, atomicWrite, assertMaintenanceOwned })) {
    if (typeof callback !== "function") throw new Error(`迁移执行器缺少 ${name}。`);
  }
  validateProjectPlan(plan);
  const journal = plan.journal ? clone(plan.journal) : createProjectMigrationJournal(plan);
  if (journal.planId !== plan.planId || journal.journalPath !== plan.journalPath || journal.type !== `${MIGRATION_TYPE}-journal`) {
    throw failClosed("迁移 journal 与计划不一致，已 fail-closed。");
  }
  if (["rolling-back", "rollback-failed"].includes(journal.state)) {
    await rollbackProjectMigration({ ...context, journal });
    throw new Error("项目迁移回滚完成；未恢复正向迁移。");
  }
  if (journal.state === "rolled-back") throw new Error("项目迁移已回滚，需重新生成计划。");
  if (journal.state === "completed") { await verifyProjectFinal({ ...context, journal }); await assertOwned(context, "completed:replay"); return journal; }
  if (!["planned", "forward"].includes(journal.state)) throw failClosed(`迁移 journal 状态无效：${journal.state}`);

  journal.state = "forward";
  await persistJournal(atomicWrite, plan, journal);
  try {
    await verifyProjectForwardProgress({ ...context, journal });
    for (const [index, operation] of plan.operations.entries()) {
      if (journal.completed.copies.includes(index)) {
        if (await checkedHash(context, operation.to, `copy:verify-completed:${index}`) !== operation.sha256) throw failClosed(`已记录的迁移目标哈希不一致：${operation.to}`);
        continue;
      }
      const existingHash = await checkedHash(context, operation.to, `copy:destination:${index}`);
      if (existingHash !== null) {
        if (journal.inFlight?.type !== "copy" || journal.inFlight.index !== index || existingHash !== operation.sha256) {
          throw failClosed(`迁移目标存在且内容不一致：${operation.to}`);
        }
      } else {
        journal.inFlight = { type: "copy", index, created: false };
        await persistJournal(atomicWrite, plan, journal);
        await assertOwned(context, `copy:${index}`);
        await copy(operation.from, operation.to, operation);
        journal.inFlight.created = true;
        await persistJournal(atomicWrite, plan, journal);
      }
      if (await checkedHash(context, operation.to, `copy:hash:${index}`) !== operation.sha256) throw new Error(`复制后 SHA-256 哈希不一致：${operation.to}`);
      journal.completed.copies.push(index);
      journal.inFlight = null;
      await persistJournal(atomicWrite, plan, journal);
    }

    for (const [index, write] of plan.writes.entries()) {
      if (journal.completed.staged.includes(index)) {
        if (await checkedHash(context, write.stagePath, `bundle-stage:verify-completed:${index}`) !== write.sha256) throw new Error(`已记录的暂存文件哈希不一致：${write.stagePath}`);
        continue;
      }
      const stageHash = await checkedHash(context, write.stagePath, `bundle-stage:destination:${index}`);
      if (stageHash !== null) {
        if (journal.inFlight?.type !== "bundle-stage" || journal.inFlight.index !== index || stageHash !== write.sha256) {
          throw failClosed(`迁移暂存文件存在且内容不一致：${write.stagePath}`);
        }
      } else {
        journal.inFlight = { type: "bundle-stage", index, created: false };
        await persistJournal(atomicWrite, plan, journal);
        await assertOwned(context, `bundle-stage:${index}`);
        await atomicWrite({ type: "stage", write: clone(write), exclusive: true });
        journal.inFlight.created = true;
        await persistJournal(atomicWrite, plan, journal);
      }
      if (await checkedHash(context, write.stagePath, `bundle-stage:hash:${index}`) !== write.sha256) throw new Error(`版本 6 暂存文件 SHA-256 不一致：${write.stagePath}`);
      journal.completed.staged.push(index);
      journal.inFlight = null;
      await persistJournal(atomicWrite, plan, journal);
    }

    for (const [index, write] of plan.writes.entries()) {
      if (journal.completed.exposed.includes(index)) {
        if (await checkedHash(context, write.path, `bundle-expose:verify-completed:${index}`) !== write.sha256) throw failClosed(`已记录的版本 6 文档哈希不一致：${write.path}`);
        continue;
      }
      if (await checkedHash(context, write.stagePath, `bundle-expose:stage:${index}`) !== write.sha256) throw new Error(`暴露前暂存文件缺失或不一致：${write.stagePath}`);
      const targetHash = await checkedHash(context, write.path, `bundle-expose:destination:${index}`);
      if (targetHash !== null) {
        if (journal.inFlight?.type !== "bundle-expose" || journal.inFlight.index !== index || targetHash !== write.sha256) {
          throw failClosed(`版本 6 文档存在且内容不一致：${write.path}`);
        }
      } else {
        journal.inFlight = { type: "bundle-expose", index, created: false };
        await persistJournal(atomicWrite, plan, journal);
        await assertOwned(context, `bundle-expose:${index}`);
        await atomicWrite({ type: "expose", write: clone(write), exclusive: true });
        journal.inFlight.created = true;
        await persistJournal(atomicWrite, plan, journal);
      }
      if (await checkedHash(context, write.path, `bundle-expose:hash:${index}`) !== write.sha256) throw new Error(`版本 6 文档暴露后 SHA-256 不一致：${write.path}`);
      journal.completed.exposed.push(index);
      journal.inFlight = null;
      await persistJournal(atomicWrite, plan, journal);
    }

    for (const [index, operation] of plan.moves.entries()) {
      if (journal.completed.backups.includes(index)) {
        if (!await verifyProjectBackup(context, operation, `backup:verify-completed:${index}`)) throw failClosed(`已记录的备份复制状态不一致：${operation.from}`);
        continue;
      }
      const sourceHash = await checkedHash(context, operation.from, `backup:source:${index}`);
      const backupHash = await checkedHash(context, operation.to, `backup:destination:${index}`);
      if (journal.inFlight?.type === "backup-copy" && journal.inFlight.index === index && sourceHash === operation.sha256 && backupHash === operation.sha256) {
        journal.completed.backups.push(index);
        journal.inFlight = null;
        await persistJournal(atomicWrite, plan, journal);
        continue;
      }
      if (sourceHash !== operation.sha256 || backupHash !== null) throw failClosed(`旧文件或备份状态已变化：${operation.from}`);
      journal.inFlight = { type: "backup-copy", index, created: false };
      await persistJournal(atomicWrite, plan, journal);
      await assertOwned(context, `backup-copy:${index}`);
      await backupCopy(operation.from, operation.to, operation);
      journal.inFlight.created = true;
      await persistJournal(atomicWrite, plan, journal);
      if (!await verifyProjectBackup(context, operation, `backup-copy:hash:${index}`)) throw new Error(`旧文件复制到备份后校验失败：${operation.from}`);
      journal.completed.backups.push(index);
      journal.inFlight = null;
      await persistJournal(atomicWrite, plan, journal);
    }

    await verifyProjectFinal({ ...context, journal });
    await assertOwned(context, "completed");
    journal.cleanupPending = clone(plan.cleanupPending);
    journal.state = "completed";
    journal.inFlight = null;
    await persistJournal(atomicWrite, plan, journal);
    return journal;
  } catch (error) {
    journal.error = String(error?.message || error);
    try { await rollbackProjectMigration({ ...context, journal }); }
    catch (rollbackError) {
      error.message = `${error.message}；迁移回滚失败：${String(rollbackError?.message || rollbackError)}`;
      throw error;
    }
    throw error;
  }
}

module.exports = {
  createProjectMigrationJournal,
  derivedProjectJournalPath,
  executeProjectMigration,
  planLegacyProjectMigration,
  projectMaintenanceLockPath,
  projectMigrationPlanId,
  projectMigrationSafetyReasons,
  rollbackProjectMigration,
};
