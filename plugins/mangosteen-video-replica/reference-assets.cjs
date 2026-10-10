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

function absoluteVaultPath(vaultRoot, vaultPath) {
  const root = path.resolve(String(vaultRoot || ""));
  const target = path.resolve(root, ...String(vaultPath).split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("资产路径超出知识库范围。");
  return target;
}

function resolveAsset(vaultRoot, kind, value) {
  const id = assertAssetId(value);
  const typeFolder = kind === "character" ? "人物" : "场景";
  const imageName = kind === "character" ? "人物参考板.png" : "场景参考图.png";
  const folderPath = `${ROOT}/${typeFolder}/${id}`;
  const imagePath = `${folderPath}/${imageName}`;
  const metadataPath = `${folderPath}/metadata.json`;
  const imageAbsolutePath = absoluteVaultPath(vaultRoot, imagePath);
  const metadataAbsolutePath = absoluteVaultPath(vaultRoot, metadataPath);
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
  const metadataPath = absoluteVaultPath(vaultRoot, canonical.metadataPath);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  const temporary = `${metadataPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(temporary, metadataPath);
  return payload;
}

module.exports = {
  assertAssetId,
  resolveCharacterAsset,
  resolveSceneAsset,
  writeAssetMetadata,
};
