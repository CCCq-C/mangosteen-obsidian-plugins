const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = "山竹视频资产库";
const SCENE_GENERATION_POLICY_VERSION = 3;
const PRODUCT_GENERATION_POLICY_VERSION = 1;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;
const HUMAN_CLAUSE = /(女主|男主|人物|两人|二人|女孩|男孩|女子|男子|女生|男生|哥哥|妹妹|情侣|行人|人群|模特|角色)/;
const PRODUCT_CLAUSE = /(关键物件|关键产品|核心产品|产品(?:展示|特写|信息)|(?:包装盒|耳机盒|品牌商品).*(?:清晰可见|特写|关键|展示))/;
const KIND_CONFIG = {
  character: { folder: "人物", image: "人物参考板.png", metadata: "character.json", label: "人物" },
  product: { folder: "产品", image: "产品参考板.png", metadata: "product.json", label: "产品" },
  scene: { folder: "场景", image: "场景参考图.png", metadata: "scene.json", label: "场景" },
};

function assertAssetId(value) {
  const id = String(value ?? "").trim().normalize("NFKC");
  if (!SAFE_ID.test(id) || WINDOWS_RESERVED_NAME.test(id)) {
    throw new Error(`资产 ID 不安全：${id || "未填写"}。请只使用文字、数字、短横线或下划线。`);
  }
  return id;
}

function cleanPrompt(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function environmentOnlyDescription(value) {
  const source = cleanPrompt(value);
  const clauses = source
    .split(/(?<=[。！？；;])|[，,]/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !HUMAN_CLAUSE.test(part) && !PRODUCT_CLAUSE.test(part));
  return clauses.join("，").replace(/，([。！？；;])/gu, "$1").trim();
}

function createGenerationSpec(asset, prompt) {
  const sourcePrompt = cleanPrompt(prompt);
  const kind = KIND_CONFIG[asset?.kind] ? asset.kind : "character";
  if (!sourcePrompt) throw new Error(`${KIND_CONFIG[kind].label}资产缺少生成提示词。`);
  if (kind === "character") {
    return { sourcePrompt, generationPrompt: sourcePrompt, policyVersion: 1 };
  }
  if (kind === "product") {
    return {
      sourcePrompt,
      policyVersion: PRODUCT_GENERATION_POLICY_VERSION,
      generationPrompt: [
        "纯产品参考板。使用简洁中性背景，禁止出现人物、手、身体、生活场景或无关道具。",
        "在同一张图中清楚展示产品正面、侧面、背面和关键细节，固定外形、颜色、材质、比例、包装与明确写出的品牌标识位置。",
        sourcePrompt,
        "这是后续镜头复用的产品身份板，不要改变产品型号，不要添加原描述没有的配件、文字或装饰。",
      ].join("\n"),
    };
  }
  const environment = environmentOnlyDescription(sourcePrompt) || "保留原描述中的建筑、陈设、自然环境、光线、道具与空间关系。";
  return {
    sourcePrompt,
    policyVersion: SCENE_GENERATION_POLICY_VERSION,
    generationPrompt: [
      "纯环境空镜参考图。画面中禁止出现任何人、人体、脸、手、剪影、倒影或人物照片。",
      "只生成建筑、自然环境、固定陈设、光线、天气与空间布局；忽略人物以及可单独引用的核心产品、品牌包装和产品位置。",
      environment,
      "这是后续合成人物使用的干净场景板，保持写实、空间清楚、光线统一。",
    ].join("\n"),
  };
}

function assetMatchesGenerationSpec(asset, spec) {
  if (!asset?.exists || !asset.metadata || !spec) return false;
  const storedSource = cleanPrompt(asset.metadata.sourcePrompt || asset.metadata.prompt);
  if (storedSource !== spec.sourcePrompt) return false;
  if (asset.kind === "scene" || asset.kind === "product") {
    return Number(asset.metadata.generationPolicyVersion) === Number(spec.policyVersion);
  }
  return true;
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
  const config = KIND_CONFIG[kind];
  if (!config) throw new Error(`不支持的资产类型：${String(kind || "未填写")}`);
  const id = assertAssetId(value);
  const folderPath = `${ROOT}/${config.folder}/${id}`;
  const imagePath = `${folderPath}/${config.image}`;
  const canonicalMetadataPath = `${folderPath}/${config.metadata}`;
  const legacyMetadataPath = `${folderPath}/metadata.json`;
  const imageAbsolutePath = checkedAssetPath(vaultRoot, imagePath);
  const canonicalMetadataAbsolutePath = checkedAssetPath(vaultRoot, canonicalMetadataPath);
  const legacyMetadataAbsolutePath = checkedAssetPath(vaultRoot, legacyMetadataPath);
  const exists = Boolean(fs.statSync(imageAbsolutePath, { throwIfNoEntry: false })?.isFile());
  let metadata = null;
  let metadataPath = canonicalMetadataPath;
  let metadataAbsolutePath = canonicalMetadataAbsolutePath;
  if (!fs.statSync(metadataAbsolutePath, { throwIfNoEntry: false })?.isFile()
      && fs.statSync(legacyMetadataAbsolutePath, { throwIfNoEntry: false })?.isFile()) {
    metadataPath = legacyMetadataPath;
    metadataAbsolutePath = legacyMetadataAbsolutePath;
  }
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

function resolveProductAsset(vaultRoot, id) {
  return resolveAsset(vaultRoot, "product", id);
}

function resolveReferenceAsset(vaultRoot, kind, id) {
  return resolveAsset(vaultRoot, kind, id);
}

function writeAssetMetadata(vaultRoot, asset, metadata = {}) {
  const canonical = resolveReferenceAsset(vaultRoot, asset?.kind, asset?.id);
  const payload = {
    ...metadata,
    version: 1,
    kind: canonical.kind,
    id: canonical.id,
    imagePath: canonical.imagePath,
  };
  const canonicalMetadataPath = `${canonical.folderPath}/${KIND_CONFIG[canonical.kind].metadata}`;
  let metadataPath = checkedAssetPath(vaultRoot, canonicalMetadataPath);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  metadataPath = checkedAssetPath(vaultRoot, canonicalMetadataPath);
  const temporaryVaultPath = `${canonicalMetadataPath}.tmp-${process.pid}`;
  const temporary = checkedAssetPath(vaultRoot, temporaryVaultPath);
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  metadataPath = checkedAssetPath(vaultRoot, canonicalMetadataPath);
  fs.renameSync(temporary, metadataPath);
  return payload;
}

function hashAssetImage(vaultRoot, asset) {
  const resolved = resolveReferenceAsset(vaultRoot, asset?.kind, asset?.id);
  const absolutePath = checkedAssetPath(vaultRoot, resolved.imagePath);
  if (!fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`资产图片不存在：${resolved.imagePath}`);
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")}`;
}

module.exports = {
  assetMatchesGenerationSpec,
  assertAssetId,
  checkedAssetPath,
  createGenerationSpec,
  hashAssetImage,
  resolveCharacterAsset,
  resolveProductAsset,
  resolveReferenceAsset,
  resolveSceneAsset,
  writeAssetMetadata,
};
