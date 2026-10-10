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
  metadataPath: "山竹视频资产库/人物/hero/metadata.json",
  exists: false,
  metadata: null,
});

const scene = assets.resolveSceneAsset(vault, "harbor");
assert.strictEqual(scene.folderPath, "山竹视频资产库/场景/harbor");
assert.strictEqual(scene.imagePath, "山竹视频资产库/场景/harbor/场景参考图.png");
assert.strictEqual(scene.metadataPath, "山竹视频资产库/场景/harbor/metadata.json");
assert.strictEqual(scene.exists, false);

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

for (const unsafeId of ["", ".", "..", "../hero", "hero/side", "hero\\side", "CON", "hero.png"]) {
  assert.throws(() => assets.resolveCharacterAsset(vault, unsafeId), /资产 ID 不安全/, unsafeId);
}

fs.rmSync(vault, { recursive: true, force: true });
console.log("reference-assets: ok");
