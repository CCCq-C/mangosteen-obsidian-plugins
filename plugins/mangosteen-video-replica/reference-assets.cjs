const fs = require("fs");
const path = require("path");

const ROOT = "山竹视频资产库";
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;

function assertAssetId(value) {
  const id = String(value ?? "").trim().normalize("NFKC");
  if (!SAFE_ID.test(id) || WINDOWS_RESERVED_NAME.test(id)) {
    throw new Error(`资产 ID 不安全：${id || "未填写"}。请只使用文字、数字、短横线或下划线。`);
  }
  return id;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function checkedAssetPath(vaultRoot, vaultPath) {
  const root = path.resolve(String(vaultRoot || ""));
  const rootStat = fs.statSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) throw new Error("资产路径无法定位真实知识库范围。");
  const normalized = String(vaultPath || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts[0] !== ROOT || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("资产路径不安全，已拒绝访问知识库范围外的文件。");
  }
  const target = path.resolve(root, ...parts);
  if (!isInside(root, target)) throw new Error("资产路径不安全，已拒绝访问知识库范围外的文件。");

  const realRoot = fs.realpathSync(root);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.lstatSync(current, { throwIfNoEntry: false })) break;
    let realCurrent;
    try {
      realCurrent = fs.realpathSync(current);
    } catch (_) {
      throw new Error("资产路径包含无法解析的符号链接，已拒绝访问知识库范围外的文件。");
    }
    if (!isInside(realRoot, realCurrent)) {
      throw new Error("资产路径通过符号链接超出知识库范围，已拒绝访问。");
    }
  }
  return target;
}

function resolveAsset(vaultRoot, kind, value) {
  const id = assertAssetId(value);
  const typeFolder = kind === "character" ? "人物" : "场景";
  const imageName = kind === "character" ? "人物参考板.png" : "场景参考图.png";
  const folderPath = `${ROOT}/${typeFolder}/${id}`;
  const imagePath = `${folderPath}/${imageName}`;
  const metadataPath = `${folderPath}/metadata.json`;
  const imageAbsolutePath = checkedAssetPath(vaultRoot, imagePath);
  const metadataAbsolutePath = checkedAssetPath(vaultRoot, metadataPath);
  const exists = Boolean(fs.statSync(imageAbsolutePath, { throwIfNoEntry: false })?.isFile());
  let metadata = null;
  if (fs.statSync(metadataAbsolutePath, { throwIfNoEntry: false })?.isFile()) {
    metadata = JSON.parse(fs.readFileSync(metadataAbsolutePath, "utf8"));
  }
  return { kind, id, folderPath, imagePath, metadataPath, exists, metadata };
}

function resolveCharacterAsset(vaultRoot, id) {
  return resolveAsset(vaultRoot, "character", id);
}

function resolveSceneAsset(vaultRoot, id) {
  return resolveAsset(vaultRoot, "scene", id);
}

function writeAssetMetadata(vaultRoot, asset, metadata = {}) {
  const canonical = asset?.kind === "character"
    ? resolveCharacterAsset(vaultRoot, asset.id)
    : resolveSceneAsset(vaultRoot, asset?.id);
  const payload = {
    ...metadata,
    version: 1,
    kind: canonical.kind,
    id: canonical.id,
    imagePath: canonical.imagePath,
  };
  let metadataPath = checkedAssetPath(vaultRoot, canonical.metadataPath);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  metadataPath = checkedAssetPath(vaultRoot, canonical.metadataPath);
  const temporaryVaultPath = `${canonical.metadataPath}.tmp-${process.pid}`;
  const temporary = checkedAssetPath(vaultRoot, temporaryVaultPath);
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  metadataPath = checkedAssetPath(vaultRoot, canonical.metadataPath);
  fs.renameSync(temporary, metadataPath);
  return payload;
}

module.exports = {
  assertAssetId,
  checkedAssetPath,
  resolveCharacterAsset,
  resolveSceneAsset,
  writeAssetMetadata,
};
