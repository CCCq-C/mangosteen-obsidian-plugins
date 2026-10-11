const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const storage = require("../project-storage.cjs");

const projectFolder = "山竹视频复刻/project-1";

assert.deepStrictEqual(storage.projectRelativePaths(projectFolder), {
  overview: "山竹视频复刻/project-1/00-项目总览.md",
  sourceRoot: "山竹视频复刻/project-1/01-原始素材",
  referenceIndex: "山竹视频复刻/project-1/02-参考资产/参考资产.md",
  shotRoot: "山竹视频复刻/project-1/03-分镜",
  finalRoot: "山竹视频复刻/project-1/04-最终成片",
  metadataRoot: "山竹视频复刻/project-1/.mangosteen",
  project: "山竹视频复刻/project-1/.mangosteen/project.json",
  draft: "山竹视频复刻/project-1/.mangosteen/draft.json",
  activeRun: "山竹视频复刻/project-1/.mangosteen/active-run.json",
  runs: "山竹视频复刻/project-1/.mangosteen/runs",
  history: "山竹视频复刻/project-1/.mangosteen/history",
});

assert.deepStrictEqual(storage.shotArtifactPaths(projectFolder, "008"), {
  folder: "山竹视频复刻/project-1/03-分镜/008",
  firstFrame: "山竹视频复刻/project-1/03-分镜/008/首帧.png",
  lastFrame: "山竹视频复刻/project-1/03-分镜/008/尾帧.png",
  video: "山竹视频复刻/project-1/03-分镜/008/视频.mp4",
});

assert.deepStrictEqual(
  storage.shotArtifactPaths(projectFolder, 8),
  storage.shotArtifactPaths(projectFolder, "008"),
  "numeric shot IDs must normalize to the stable three-digit folder",
);

const renamedShot = { id: "008", title: "标题已经改变" };
assert.deepStrictEqual(
  storage.shotArtifactPaths(projectFolder, renamedShot.id),
  storage.shotArtifactPaths(projectFolder, "008"),
  "a title change must not affect artifact paths",
);

for (const shotId of ["", "000", "1000", "../008", "008/title", "镜头-008", "8.5", null]) {
  assert.throws(
    () => storage.shotArtifactPaths(projectFolder, shotId),
    /镜头 ID/,
    `unsafe shot ID must be rejected: ${String(shotId)}`,
  );
}

for (const folder of ["", "山竹视频复刻", "../project-1", "/山竹视频复刻/project-1", "山竹视频复刻//project-1", "其他/project-1", "山竹视频复刻\\project-1"]) {
  assert.throws(() => storage.projectRelativePaths(folder), /项目目录/);
}

function createSafeResolver(vaultRoot) {
  const root = path.resolve(vaultRoot);
  return (relativePath) => {
    const raw = String(relativePath ?? "");
    if (!raw || raw.includes("\0") || raw.includes("\\") || path.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
      throw new Error("测试解析器拒绝不安全路径。");
    }
    const segments = raw.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("测试解析器拒绝不安全路径。");
    }
    const absolute = path.resolve(root, ...segments);
    const relative = path.relative(root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("测试解析器拒绝知识库范围外路径。");
    }
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error("项目路径包含符号链接，已拒绝访问。");
      if (stat && current !== absolute && !stat.isDirectory()) throw new Error("项目路径的父级不是目录。");
      if (!stat) break;
    }
    return absolute;
  };
}

const temporaryRoots = [];
function createVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-project-storage-"));
  temporaryRoots.push(root);
  const vault = path.join(root, "vault");
  fs.mkdirSync(path.join(vault, "山竹视频复刻", "project-1"), { recursive: true });
  return { root, vault, resolveSafe: createSafeResolver(vault) };
}

try {
  const layoutVault = createVault();
  const layoutPaths = storage.createProjectLayout({ resolveSafe: layoutVault.resolveSafe, folder: projectFolder });
  assert.deepStrictEqual(layoutPaths, storage.projectRelativePaths(projectFolder));
  for (const relativePath of [
    layoutPaths.sourceRoot,
    `${layoutPaths.sourceRoot}/抽帧`,
    path.posix.dirname(layoutPaths.referenceIndex),
    layoutPaths.shotRoot,
    layoutPaths.finalRoot,
    layoutPaths.metadataRoot,
    layoutPaths.runs,
    layoutPaths.history,
  ]) {
    assert.strictEqual(fs.statSync(layoutVault.resolveSafe(relativePath)).isDirectory(), true, `${relativePath} must be created`);
  }

  const v6Project = { schemaVersion: 6, projectId: "project-1" };
  const v6Draft = { schemaVersion: 6, shots: [{ id: "008" }] };
  storage.atomicWriteJson({ resolveSafe: layoutVault.resolveSafe, relativePath: layoutPaths.project, value: v6Project });
  storage.atomicWriteJson({ resolveSafe: layoutVault.resolveSafe, relativePath: layoutPaths.draft, value: v6Draft });
  const legacyPaths = {
    project: `${projectFolder}/project.json`,
    draft: `${projectFolder}/generation-request.json`,
  };
  fs.writeFileSync(layoutVault.resolveSafe(legacyPaths.project), JSON.stringify({ schemaVersion: 5, projectId: "legacy" }));
  fs.writeFileSync(layoutVault.resolveSafe(legacyPaths.draft), JSON.stringify({ version: 5, shots: [] }));
  const readJson = (relativePath) => JSON.parse(fs.readFileSync(layoutVault.resolveSafe(relativePath), "utf8"));
  assert.deepStrictEqual(
    storage.readProjectDocument({ readJson, paths: layoutPaths, legacyPaths }),
    { project: v6Project, draft: v6Draft, legacy: false },
    "version 6 documents must take priority over legacy files",
  );
  fs.rmSync(layoutVault.resolveSafe(layoutPaths.project));
  fs.rmSync(layoutVault.resolveSafe(layoutPaths.draft));
  assert.deepStrictEqual(
    storage.readProjectDocument({ readJson, paths: layoutPaths, legacyPaths }),
    { project: { schemaVersion: 5, projectId: "legacy" }, draft: { version: 5, shots: [] }, legacy: true },
    "legacy files must remain readable without migration",
  );
  assert.throws(
    () => storage.readProjectDocument({
      readJson: () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
      paths: layoutPaths,
      legacyPaths,
    }),
    /permission denied/,
  );

  const atomicPath = `${projectFolder}/.mangosteen/atomic.json`;
  storage.atomicWriteJson({ resolveSafe: layoutVault.resolveSafe, relativePath: atomicPath, value: { version: 1 } });
  assert.strictEqual(fs.readFileSync(layoutVault.resolveSafe(atomicPath), "utf8"), '{\n  "version": 1\n}\n');
  storage.atomicWriteJson({ resolveSafe: layoutVault.resolveSafe, relativePath: atomicPath, value: { version: 2 } });
  const originalBytes = fs.readFileSync(layoutVault.resolveSafe(atomicPath), "utf8");
  assert.strictEqual(originalBytes, '{\n  "version": 2\n}\n');
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function rejectAtomicReplace(source, destination) {
    if (destination === layoutVault.resolveSafe(atomicPath)) throw new Error("injected rename failure");
    return originalRenameSync.call(this, source, destination);
  };
  try {
    assert.throws(
      () => storage.atomicWriteJson({ resolveSafe: layoutVault.resolveSafe, relativePath: atomicPath, value: { version: 3 } }),
      /injected rename failure/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.strictEqual(fs.readFileSync(layoutVault.resolveSafe(atomicPath), "utf8"), originalBytes, "failed replacement must preserve the original JSON");
  assert.strictEqual(
    fs.readdirSync(path.dirname(layoutVault.resolveSafe(atomicPath))).some((name) => name.startsWith("atomic.json.tmp-")),
    false,
    "failed atomic writes must clean up their temporary file",
  );

  const collisionPath = `${projectFolder}/.mangosteen/collision.json`;
  storage.atomicWriteJson({ resolveSafe: layoutVault.resolveSafe, relativePath: collisionPath, value: { version: "original" } });
  const collisionOriginalBytes = fs.readFileSync(layoutVault.resolveSafe(collisionPath), "utf8");
  const collidingUuid = "00000000-0000-4000-8000-000000000000";
  const collidingTemporaryPath = `${collisionPath}.tmp-${process.pid}-${collidingUuid}`;
  fs.writeFileSync(layoutVault.resolveSafe(collidingTemporaryPath), "temporary-file-owned-by-another-writer");
  const originalRandomUuid = crypto.randomUUID;
  crypto.randomUUID = () => collidingUuid;
  let collisionError;
  try {
    storage.atomicWriteJson({ resolveSafe: layoutVault.resolveSafe, relativePath: collisionPath, value: { version: "new" } });
  } catch (error) {
    collisionError = error;
  } finally {
    crypto.randomUUID = originalRandomUuid;
  }
  assert.strictEqual(collisionError?.code, "EEXIST", "a claimed temp name must fail without claiming ownership");
  assert.strictEqual(
    fs.readFileSync(layoutVault.resolveSafe(collidingTemporaryPath), "utf8"),
    "temporary-file-owned-by-another-writer",
    "a temp collision must not delete another writer's file",
  );
  assert.strictEqual(
    fs.readFileSync(layoutVault.resolveSafe(collisionPath), "utf8"),
    collisionOriginalBytes,
    "a temp collision must leave the original JSON intact",
  );

  const artifact = storage.shotArtifactPaths(projectFolder, "008");
  fs.mkdirSync(path.dirname(layoutVault.resolveSafe(artifact.firstFrame)), { recursive: true });
  fs.writeFileSync(layoutVault.resolveSafe(artifact.firstFrame), "current-frame");
  const archived = storage.archiveCurrentArtifact({
    resolveSafe: layoutVault.resolveSafe,
    projectFolder,
    shotId: "008",
    kind: "firstFrame",
    now: new Date("2026-10-11T07:00:51.000Z"),
  });
  assert.strictEqual(archived, `${projectFolder}/.mangosteen/history/20261011-070051-000/008/首帧.png`);
  assert.strictEqual(fs.existsSync(layoutVault.resolveSafe(artifact.firstFrame)), false);
  assert.strictEqual(fs.readFileSync(layoutVault.resolveSafe(archived), "utf8"), "current-frame");

  assert.strictEqual(storage.restoreArchivedArtifact({
    resolveSafe: layoutVault.resolveSafe,
    projectFolder,
    shotId: "008",
    kind: "firstFrame",
    archivedPath: archived,
  }), artifact.firstFrame);
  assert.strictEqual(fs.readFileSync(layoutVault.resolveSafe(artifact.firstFrame), "utf8"), "current-frame");
  assert.strictEqual(fs.existsSync(layoutVault.resolveSafe(archived)), false, "a successful rollback must consume only its own history link");

  fs.writeFileSync(layoutVault.resolveSafe(archived), "history-must-not-overwrite-current");
  assert.throws(
    () => storage.restoreArchivedArtifact({
      resolveSafe: layoutVault.resolveSafe,
      projectFolder,
      shotId: "008",
      kind: "firstFrame",
      archivedPath: archived,
    }),
    /当前镜头文件已存在/,
  );
  assert.strictEqual(fs.readFileSync(layoutVault.resolveSafe(artifact.firstFrame), "utf8"), "current-frame");
  assert.strictEqual(fs.readFileSync(layoutVault.resolveSafe(archived), "utf8"), "history-must-not-overwrite-current");

  const restoreScopeVault = createVault();
  const wrongShotArchive = `${projectFolder}/.mangosteen/history/20261011-070051-000/009/首帧.png`;
  fs.mkdirSync(path.dirname(restoreScopeVault.resolveSafe(wrongShotArchive)), { recursive: true });
  fs.writeFileSync(restoreScopeVault.resolveSafe(wrongShotArchive), "another-shot-history");
  assert.throws(
    () => storage.restoreArchivedArtifact({
      resolveSafe: restoreScopeVault.resolveSafe,
      projectFolder,
      shotId: "008",
      kind: "firstFrame",
      archivedPath: wrongShotArchive,
    }),
    /历史路径不安全/,
    "rollback must never restore a different shot's history file",
  );
  assert.strictEqual(fs.existsSync(restoreScopeVault.resolveSafe(artifact.firstFrame)), false);
  assert.strictEqual(fs.readFileSync(restoreScopeVault.resolveSafe(wrongShotArchive), "utf8"), "another-shot-history");

  const archiveRaceVault = createVault();
  const archiveRaceArtifact = storage.shotArtifactPaths(projectFolder, "008");
  fs.mkdirSync(path.dirname(archiveRaceVault.resolveSafe(archiveRaceArtifact.video)), { recursive: true });
  fs.writeFileSync(archiveRaceVault.resolveSafe(archiveRaceArtifact.video), "current-video-must-survive");
  const archiveRaceDestination = `${projectFolder}/.mangosteen/history/20261011-070051-000/008/视频.mp4`;
  const archiveRaceDestinationAbsolute = path.join(archiveRaceVault.vault, ...archiveRaceDestination.split("/"));
  const originalLstatSync = fs.lstatSync;
  let destinationChecks = 0;
  fs.lstatSync = function createHistoryCollisionAfterCheck(target, options) {
    if (path.resolve(String(target)) === path.resolve(archiveRaceDestinationAbsolute)) {
      destinationChecks += 1;
      const existing = originalLstatSync.call(this, target, options);
      if (destinationChecks === 2 && !existing) {
        fs.writeFileSync(archiveRaceDestinationAbsolute, "history-created-by-racing-writer");
      }
      return existing;
    }
    return originalLstatSync.call(this, target, options);
  };
  let archiveRaceError;
  try {
    storage.archiveCurrentArtifact({
      resolveSafe: archiveRaceVault.resolveSafe,
      projectFolder,
      shotId: "008",
      kind: "video",
      now: new Date("2026-10-11T07:00:51.000Z"),
    });
  } catch (error) {
    archiveRaceError = error;
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.strictEqual(archiveRaceError?.code, "EEXIST", "a racing history destination must be rejected without replacement");
  assert.strictEqual(
    fs.readFileSync(archiveRaceVault.resolveSafe(archiveRaceArtifact.video), "utf8"),
    "current-video-must-survive",
    "the current artifact must remain when history reservation collides",
  );
  assert.strictEqual(
    fs.readFileSync(archiveRaceVault.resolveSafe(archiveRaceDestination), "utf8"),
    "history-created-by-racing-writer",
    "the racing historical file must not be overwritten",
  );

  const failedArtifactVault = createVault();
  const failedArtifact = storage.shotArtifactPaths(projectFolder, "008");
  fs.mkdirSync(path.dirname(failedArtifactVault.resolveSafe(failedArtifact.video)), { recursive: true });
  fs.writeFileSync(failedArtifactVault.resolveSafe(failedArtifact.video), "failed-new-video");
  const failedArchive = storage.archiveFailedArtifact({
    resolveSafe: failedArtifactVault.resolveSafe,
    projectFolder,
    shotId: "008",
    kind: "video",
    now: new Date("2026-10-11T07:00:51.000Z"),
    failureId: "failure-1",
  });
  assert.strictEqual(failedArchive, `${projectFolder}/.mangosteen/history/failed/20261011-070051-000/008/failure-1-视频.mp4`);
  assert.strictEqual(fs.existsSync(failedArtifactVault.resolveSafe(failedArtifact.video)), false);
  assert.strictEqual(fs.readFileSync(failedArtifactVault.resolveSafe(failedArchive), "utf8"), "failed-new-video");
  fs.writeFileSync(failedArtifactVault.resolveSafe(failedArtifact.video), "second-failed-new-video");
  assert.throws(
    () => storage.archiveFailedArtifact({
      resolveSafe: failedArtifactVault.resolveSafe,
      projectFolder,
      shotId: "008",
      kind: "video",
      now: new Date("2026-10-11T07:00:51.000Z"),
      failureId: "failure-1",
    }),
    /已存在|EEXIST/,
    "failed history must use no-clobber semantics",
  );
  assert.strictEqual(fs.readFileSync(failedArtifactVault.resolveSafe(failedArtifact.video), "utf8"), "second-failed-new-video");
  assert.strictEqual(fs.readFileSync(failedArtifactVault.resolveSafe(failedArchive), "utf8"), "failed-new-video");

  const missingVault = createVault();
  assert.strictEqual(storage.archiveCurrentArtifact({
    resolveSafe: missingVault.resolveSafe,
    projectFolder,
    shotId: "008",
    kind: "video",
    now: new Date("2026-10-11T07:00:51.000Z"),
  }), null);
  assert.strictEqual(
    fs.existsSync(path.join(missingVault.vault, "山竹视频复刻", "project-1", ".mangosteen")),
    false,
    "missing current artifacts must not create history",
  );

  const layoutSymlinkVault = createVault();
  const layoutOutside = path.join(layoutSymlinkVault.root, "outside-layout");
  fs.mkdirSync(layoutOutside);
  fs.symlinkSync(layoutOutside, path.join(layoutSymlinkVault.vault, "山竹视频复刻", "project-1", "03-分镜"), "dir");
  assert.throws(
    () => storage.createProjectLayout({ resolveSafe: layoutSymlinkVault.resolveSafe, folder: projectFolder }),
    /符号链接/,
    "layout creation must use the injected real-path and symlink guard",
  );

  const jsonSymlinkVault = createVault();
  const outsideJson = path.join(jsonSymlinkVault.root, "outside.json");
  fs.writeFileSync(outsideJson, "outside-unchanged");
  fs.mkdirSync(path.join(jsonSymlinkVault.vault, "山竹视频复刻", "project-1", ".mangosteen"));
  fs.symlinkSync(outsideJson, path.join(jsonSymlinkVault.vault, "山竹视频复刻", "project-1", ".mangosteen", "project.json"));
  assert.throws(
    () => storage.atomicWriteJson({ resolveSafe: jsonSymlinkVault.resolveSafe, relativePath: `${projectFolder}/.mangosteen/project.json`, value: { changed: true } }),
    /符号链接/,
  );
  assert.strictEqual(fs.readFileSync(outsideJson, "utf8"), "outside-unchanged");
} finally {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
}

console.log("project-storage: ok");
