const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assets = require("../reference-assets.cjs");

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-reference-assets-"));

const character = assets.resolveCharacterAsset(vault, "hero");
assert.deepStrictEqual(character, {
  kind: "character",
  id: "hero",
  folderPath: "山竹视频资产库/人物/hero",
  imagePath: "山竹视频资产库/人物/hero/人物参考板.png",
  metadataPath: "山竹视频资产库/人物/hero/character.json",
  exists: false,
  metadata: null,
});

const scene = assets.resolveSceneAsset(vault, "harbor");
assert.strictEqual(scene.folderPath, "山竹视频资产库/场景/harbor");
assert.strictEqual(scene.imagePath, "山竹视频资产库/场景/harbor/场景参考图.png");
assert.strictEqual(scene.metadataPath, "山竹视频资产库/场景/harbor/scene.json");
assert.strictEqual(scene.exists, false);

const emptySceneSpec = assets.createGenerationSpec(scene, "海边集装箱场景。女主在前景，男主坐在后方。关键物件为白色耳机盒。");
assert.strictEqual(emptySceneSpec.policyVersion, 2);
assert.match(emptySceneSpec.generationPrompt, /纯环境空镜/);
assert.match(emptySceneSpec.generationPrompt, /海边集装箱场景/);
assert.match(emptySceneSpec.generationPrompt, /关键物件为白色耳机盒/);
assert.doesNotMatch(emptySceneSpec.generationPrompt, /女主在前景|男主坐在后方/);
assert.strictEqual(assets.assetMatchesGenerationSpec(scene, emptySceneSpec), false);

fs.mkdirSync(path.dirname(path.join(vault, ...scene.imagePath.split("/"))), { recursive: true });
fs.writeFileSync(path.join(vault, ...scene.imagePath.split("/")), "scene");
assets.writeAssetMetadata(vault, scene, {
  prompt: "海边集装箱场景",
  createdAt: "2026-10-10T00:00:00.000Z",
});
const resolvedScene = assets.resolveSceneAsset(vault, "harbor");
assert.strictEqual(resolvedScene.exists, true);
assert.deepStrictEqual(resolvedScene.metadata, {
  version: 1,
  kind: "scene",
  id: "harbor",
  imagePath: "山竹视频资产库/场景/harbor/场景参考图.png",
  prompt: "海边集装箱场景",
  createdAt: "2026-10-10T00:00:00.000Z",
});
assert.strictEqual(resolvedScene.metadataPath, "山竹视频资产库/场景/harbor/scene.json");
assert.match(assets.hashAssetImage(vault, resolvedScene), /^sha256:[a-f0-9]{64}$/);
assert.strictEqual(
  assets.assetMatchesGenerationSpec(resolvedScene, emptySceneSpec),
  false,
  "legacy scene metadata must be regenerated under the empty-environment policy",
);
assets.writeAssetMetadata(vault, resolvedScene, {
  prompt: emptySceneSpec.sourcePrompt,
  sourcePrompt: emptySceneSpec.sourcePrompt,
  generationPrompt: emptySceneSpec.generationPrompt,
  generationPolicyVersion: emptySceneSpec.policyVersion,
  createdAt: "2026-10-10T00:00:00.000Z",
});
assert.strictEqual(
  assets.assetMatchesGenerationSpec(assets.resolveSceneAsset(vault, "harbor"), emptySceneSpec),
  true,
  "scene asset must be reused only when its source prompt and generation policy match",
);

const legacyFolder = path.join(vault, "山竹视频资产库", "人物", "legacy");
fs.mkdirSync(legacyFolder, { recursive: true });
fs.writeFileSync(path.join(legacyFolder, "人物参考板.png"), "legacy-image");
fs.writeFileSync(path.join(legacyFolder, "metadata.json"), JSON.stringify({ prompt: "legacy metadata" }));
const legacy = assets.resolveCharacterAsset(vault, "legacy");
assert.strictEqual(legacy.metadataPath, "山竹视频资产库/人物/legacy/metadata.json");
assert.strictEqual(legacy.metadata.prompt, "legacy metadata");
assets.writeAssetMetadata(vault, legacy, { prompt: "new metadata" });
assert.strictEqual(fs.existsSync(path.join(legacyFolder, "character.json")), true);
assert.strictEqual(fs.existsSync(path.join(legacyFolder, "metadata.json")), true, "legacy metadata must not be renamed or deleted");

for (const unsafeId of ["", ".", "..", "../hero", "hero/side", "hero\\side", "CON", "hero.png"]) {
  assert.throws(() => assets.resolveCharacterAsset(vault, unsafeId), /资产 ID 不安全/, unsafeId);
}

const escapedRootVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-escaped-root-vault-"));
const escapedRootOutside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-escaped-root-outside-"));
const escapedRootAsset = path.join(escapedRootOutside, "人物", "escaped-root");
fs.mkdirSync(escapedRootAsset, { recursive: true });
fs.writeFileSync(path.join(escapedRootAsset, "人物参考板.png"), "outside-image");
fs.writeFileSync(path.join(escapedRootAsset, "metadata.json"), JSON.stringify({ secret: "outside-metadata" }));
fs.symlinkSync(escapedRootOutside, path.join(escapedRootVault, "山竹视频资产库"), "dir");
assert.throws(
  () => assets.resolveCharacterAsset(escapedRootVault, "escaped-root"),
  /资产路径.*知识库范围/,
  "asset root symlink must not expose outside image or metadata",
);

const escapedParentVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-escaped-parent-vault-"));
const escapedParentOutside = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-escaped-parent-outside-"));
const escapedParent = path.join(escapedParentVault, "山竹视频资产库", "人物");
fs.mkdirSync(escapedParent, { recursive: true });
fs.symlinkSync(escapedParentOutside, path.join(escapedParent, "escaped-parent"), "dir");
assert.throws(
  () => assets.writeAssetMetadata(escapedParentVault, { kind: "character", id: "escaped-parent" }, { prompt: "must not escape" }),
  /资产路径.*知识库范围/,
  "existing parent symlink must not receive metadata writes",
);
assert.strictEqual(fs.existsSync(path.join(escapedParentOutside, "character.json")), false);

fs.rmSync(vault, { recursive: true, force: true });
fs.rmSync(escapedRootVault, { recursive: true, force: true });
fs.rmSync(escapedRootOutside, { recursive: true, force: true });
fs.rmSync(escapedParentVault, { recursive: true, force: true });
fs.rmSync(escapedParentOutside, { recursive: true, force: true });
console.log("reference-assets: ok");
