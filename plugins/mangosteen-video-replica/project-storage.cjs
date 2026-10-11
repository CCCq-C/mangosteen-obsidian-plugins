const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = "山竹视频复刻";

function normalizeProjectFolder(folder) {
  const raw = String(folder ?? "").trim();
  if (!raw || raw.includes("\0") || raw.includes("\\") || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new Error("项目目录不安全。");
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")
      || raw === PROJECT_ROOT || !raw.startsWith(`${PROJECT_ROOT}/`)) {
    throw new Error(`项目目录必须位于 ${PROJECT_ROOT}/ 下。`);
  }
  return raw;
}

function normalizeShotId(shotId) {
  const raw = String(shotId ?? "").trim();
  if (!/^\d{1,3}$/.test(raw)) throw new Error("镜头 ID 必须是 1 到 999 的数字。");
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 999) {
    throw new Error("镜头 ID 必须是 1 到 999 的数字。");
  }
  return String(numeric).padStart(3, "0");
}

function projectRelativePaths(folder) {
  const root = normalizeProjectFolder(folder);
  const metadataRoot = `${root}/.mangosteen`;
  return {
    overview: `${root}/00-项目总览.md`,
    sourceRoot: `${root}/01-原始素材`,
    referenceIndex: `${root}/02-参考资产/参考资产.md`,
    shotRoot: `${root}/03-分镜`,
    finalRoot: `${root}/04-最终成片`,
    metadataRoot,
    project: `${metadataRoot}/project.json`,
    draft: `${metadataRoot}/draft.json`,
    activeRun: `${metadataRoot}/active-run.json`,
    runs: `${metadataRoot}/runs`,
    history: `${metadataRoot}/history`,
  };
}

function shotArtifactPaths(folder, shotId) {
  const shotRoot = `${projectRelativePaths(folder).shotRoot}/${normalizeShotId(shotId)}`;
  return {
    folder: shotRoot,
    firstFrame: `${shotRoot}/首帧.png`,
    lastFrame: `${shotRoot}/尾帧.png`,
    video: `${shotRoot}/视频.mp4`,
  };
}

function absoluteFrom(resolveSafe, relativePath, options = {}) {
  if (typeof resolveSafe !== "function") throw new Error("缺少项目安全路径解析器。");
  const absolute = resolveSafe(relativePath, options);
  if (typeof absolute !== "string" || !path.isAbsolute(absolute)) {
    throw new Error("项目安全路径解析器必须返回绝对路径。");
  }
  return absolute;
}

function ensureDirectory(resolveSafe, relativePath) {
  const absolute = absoluteFrom(resolveSafe, relativePath, { createParents: true, directory: true });
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("项目目录不安全，已拒绝访问。");
  return absolute;
}

function createProjectLayout({ resolveSafe, folder } = {}) {
  const paths = projectRelativePaths(folder);
  for (const relativePath of [
    paths.sourceRoot,
    `${paths.sourceRoot}/抽帧`,
    path.posix.dirname(paths.referenceIndex),
    paths.shotRoot,
    paths.finalRoot,
    paths.metadataRoot,
    paths.runs,
    paths.history,
  ]) {
    ensureDirectory(resolveSafe, relativePath);
  }
  return paths;
}

function readProjectDocument({ readJson, paths, legacyPaths } = {}) {
  if (typeof readJson !== "function") throw new Error("缺少项目 JSON 读取器。");
  if (!paths?.project || !paths?.draft || !legacyPaths?.project || !legacyPaths?.draft) {
    throw new Error("项目文档路径不完整。");
  }
  try {
    return {
      project: readJson(paths.project),
      draft: readJson(paths.draft),
      legacy: false,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    project: readJson(legacyPaths.project),
    draft: readJson(legacyPaths.draft),
    legacy: true,
  };
}

function atomicWriteJson({ resolveSafe, relativePath, value } = {}) {
  const content = JSON.stringify(value, null, 2);
  if (content === undefined) throw new Error("项目 JSON 内容无法序列化。");

  const parentRelativePath = path.posix.dirname(String(relativePath ?? ""));
  if (!parentRelativePath || parentRelativePath === ".") throw new Error("项目 JSON 路径不完整。");
  const parentAbsolutePath = ensureDirectory(resolveSafe, parentRelativePath);
  const absolutePath = absoluteFrom(resolveSafe, relativePath, { createParents: true });
  if (path.resolve(path.dirname(absolutePath)) !== path.resolve(parentAbsolutePath)) {
    throw new Error("项目 JSON 路径解析结果不一致，已拒绝写入。");
  }

  const temporaryRelativePath = `${relativePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const temporaryAbsolutePath = absoluteFrom(resolveSafe, temporaryRelativePath, { createParents: true });
  if (path.resolve(path.dirname(temporaryAbsolutePath)) !== path.resolve(parentAbsolutePath)) {
    throw new Error("项目 JSON 临时路径不安全，已拒绝写入。");
  }

  let temporaryOwned = false;
  try {
    const descriptor = fs.openSync(temporaryAbsolutePath, "wx");
    temporaryOwned = true;
    try {
      fs.writeFileSync(descriptor, `${content}\n`);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryAbsolutePath, absolutePath);
  } finally {
    if (temporaryOwned) fs.rmSync(temporaryAbsolutePath, { force: true });
  }
  return relativePath;
}

const ARTIFACT_KINDS = Object.freeze({
  firstFrame: "firstFrame",
  "first-frame": "firstFrame",
  lastFrame: "lastFrame",
  "last-frame": "lastFrame",
  video: "video",
  "shot-video": "video",
});

function historyTimestamp(now) {
  const date = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error("归档时间无效。");
  const digits = date.toISOString().replace(/\D/g, "");
  return `${digits.slice(0, 8)}-${digits.slice(8, 14)}-${digits.slice(14, 17)}`;
}

function archiveCurrentArtifact({ resolveSafe, projectFolder, shotId, kind, now } = {}) {
  const artifactKey = ARTIFACT_KINDS[kind];
  if (!artifactKey) throw new Error(`不支持归档的镜头文件类型：${String(kind)}`);
  const artifacts = shotArtifactPaths(projectFolder, shotId);
  const currentRelativePath = artifacts[artifactKey];
  const currentAbsolutePath = absoluteFrom(resolveSafe, currentRelativePath);
  const currentStat = fs.lstatSync(currentAbsolutePath, { throwIfNoEntry: false });
  if (!currentStat) return null;
  if (currentStat.isSymbolicLink() || !currentStat.isFile()) throw new Error("当前镜头文件不安全，已拒绝归档。");

  const paths = projectRelativePaths(projectFolder);
  const normalizedShotId = path.posix.basename(artifacts.folder);
  const historyFolder = `${paths.history}/${historyTimestamp(now)}/${normalizedShotId}`;
  const historyAbsoluteFolder = ensureDirectory(resolveSafe, historyFolder);
  const archivedRelativePath = `${historyFolder}/${path.posix.basename(currentRelativePath)}`;
  const archivedAbsolutePath = absoluteFrom(resolveSafe, archivedRelativePath, { createParents: true });
  if (path.resolve(path.dirname(archivedAbsolutePath)) !== path.resolve(historyAbsoluteFolder)) {
    throw new Error("镜头历史路径解析结果不一致，已拒绝归档。");
  }
  if (fs.lstatSync(archivedAbsolutePath, { throwIfNoEntry: false })) {
    throw new Error("镜头历史文件已存在，已拒绝覆盖。");
  }
  fs.linkSync(currentAbsolutePath, archivedAbsolutePath);
  fs.unlinkSync(currentAbsolutePath);
  return archivedRelativePath;
}

function restoreArchivedArtifact({ resolveSafe, projectFolder, shotId, kind, archivedPath } = {}) {
  const artifactKey = ARTIFACT_KINDS[kind];
  if (!artifactKey) throw new Error(`不支持恢复的镜头文件类型：${String(kind)}`);
  const artifacts = shotArtifactPaths(projectFolder, shotId);
  const currentRelativePath = artifacts[artifactKey];
  const paths = projectRelativePaths(projectFolder);
  const normalizedArchivedPath = String(archivedPath ?? "").trim();
  const expectedPrefix = `${paths.history}/`;
  const historySegments = normalizedArchivedPath.startsWith(expectedPrefix)
    ? normalizedArchivedPath.slice(expectedPrefix.length).split("/")
    : [];
  const normalizedShotId = path.posix.basename(artifacts.folder);
  if (historySegments.length !== 3
      || !/^\d{8}-\d{6}-\d{3}$/.test(historySegments[0])
      || historySegments[1] !== normalizedShotId
      || historySegments[2] !== path.posix.basename(currentRelativePath)) {
    throw new Error("镜头历史路径不安全，已拒绝恢复。");
  }

  const archivedAbsolutePath = absoluteFrom(resolveSafe, normalizedArchivedPath);
  const archivedStat = fs.lstatSync(archivedAbsolutePath, { throwIfNoEntry: false });
  if (!archivedStat || archivedStat.isSymbolicLink() || !archivedStat.isFile()) {
    throw new Error("镜头历史文件不存在或不安全，无法恢复。");
  }
  ensureDirectory(resolveSafe, path.posix.dirname(currentRelativePath));
  const currentAbsolutePath = absoluteFrom(resolveSafe, currentRelativePath, { createParents: true });
  if (fs.lstatSync(currentAbsolutePath, { throwIfNoEntry: false })) {
    throw new Error("当前镜头文件已存在，已拒绝用历史文件覆盖。");
  }
  fs.linkSync(archivedAbsolutePath, currentAbsolutePath);
  fs.unlinkSync(archivedAbsolutePath);
  return currentRelativePath;
}

module.exports = {
  archiveCurrentArtifact,
  atomicWriteJson,
  createProjectLayout,
  projectRelativePaths,
  readProjectDocument,
  restoreArchivedArtifact,
  shotArtifactPaths,
};
