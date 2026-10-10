const assert = require("assert");
const { normalizeGenerationRequest } = require("../replica-core.cjs");
const {
  isDraftLocked,
  moveShot,
  updateDraftField,
  validateDraft,
} = require("../replica-editor.cjs");

const draft = {
  version: 3,
  confirmed: false,
  character: { id: "hero", prompt: "原人物", voiceProfile: "原声音" },
  products: [],
  scenes: [{ id: "room", prompt: "原场景" }],
  settings: { imageModel: "gpt-image-2", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
  shots: [
    { id: "001", title: "第一镜", sceneId: "room", productIds: [], imagePrompt: "首帧1", videoPrompt: "视频1" },
    { id: "002", title: "第二镜", sceneId: "room", productIds: [], imagePrompt: "首帧2", videoPrompt: "视频2" },
  ],
};

assert.strictEqual(isDraftLocked(draft, null), false);
assert.strictEqual(isDraftLocked({ ...draft, confirmed: true }, null), true);
assert.strictEqual(isDraftLocked(draft, { status: "processing" }), true);

const edited = updateDraftField(draft, { section: "shot", index: 0, field: "dialogue" }, "新台词");
assert.strictEqual(edited.shots[0].dialogue, "新台词");
assert.strictEqual(draft.shots[0].dialogue, undefined);
assert.notStrictEqual(edited, draft);
assert.notStrictEqual(edited.shots, draft.shots);
assert.notStrictEqual(edited.shots[0], draft.shots[0]);

const editedSettings = updateDraftField(draft, { section: "settings", field: "videoModel" }, "seedance-2.5");
assert.strictEqual(editedSettings.settings.videoModel, "seedance-2.5");
assert.strictEqual(draft.settings.videoModel, "MiniMax-H3");

const draftWithProduct = { ...draft, products: [{ id: "phone", prompt: "原产品" }] };
const supportedEdits = [
  [{ section: "character", field: "prompt" }, "新人物", (value) => value.character.prompt],
  [{ section: "character", field: "voiceProfile" }, "年轻女声，四川口音", (value) => value.character.voiceProfile],
  [{ section: "product", index: 0, field: "prompt" }, "新产品", (value) => value.products[0].prompt],
  [{ section: "scene", index: 0, field: "prompt" }, "新场景", (value) => value.scenes[0].prompt],
  [{ section: "shot", index: 0, field: "title" }, "新标题", (value) => value.shots[0].title],
  [{ section: "shot", index: 0, field: "duration" }, 8, (value) => value.shots[0].duration],
  [{ section: "shot", index: 0, field: "sceneId" }, "room-2", (value) => value.shots[0].sceneId],
  [{ section: "shot", index: 0, field: "productIds" }, ["phone"], (value) => value.shots[0].productIds],
  [{ section: "shot", index: 0, field: "plot" }, "新剧情", (value) => value.shots[0].plot],
  [{ section: "shot", index: 0, field: "voiceDirection" }, "惊喜，语速略快", (value) => value.shots[0].voiceDirection],
  [{ section: "shot", index: 0, field: "environment" }, "新环境", (value) => value.shots[0].environment],
  [{ section: "shot", index: 0, field: "camera" }, "新镜头语言", (value) => value.shots[0].camera],
  [{ section: "shot", index: 0, field: "imagePrompt" }, "新首帧", (value) => value.shots[0].imagePrompt],
  [{ section: "shot", index: 0, field: "lastImagePrompt" }, "新尾帧", (value) => value.shots[0].lastImagePrompt],
  [{ section: "shot", index: 0, field: "videoPrompt" }, "新视频", (value) => value.shots[0].videoPrompt],
  [{ section: "shot", index: 0, field: "videoPromptOverride" }, "用户编辑后的完整提示词", (value) => value.shots[0].videoPromptOverride],
  [{ section: "settings", field: "imageModel" }, "gpt-image-3", (value) => value.settings.imageModel],
  [{ section: "settings", field: "ratio" }, "16:9", (value) => value.settings.ratio],
  [{ section: "settings", field: "resolution" }, "1080p", (value) => value.settings.resolution],
];
for (const [target, value, read] of supportedEdits) {
  const result = updateDraftField(draftWithProduct, target, value);
  assert.deepStrictEqual(read(result), value);
}

const moved = moveShot(draft, 1, "up");
assert.deepStrictEqual(moved.shots.map((shot) => shot.title), ["第二镜", "第一镜"]);
assert.deepStrictEqual(moved.shots.map((shot) => shot.id), ["001", "002"]);
assert.deepStrictEqual(draft.shots.map((shot) => shot.title), ["第一镜", "第二镜"]);
assert.notStrictEqual(moved, draft);

const unchanged = moveShot(draft, 0, "up");
assert.deepStrictEqual(unchanged, draft);
assert.notStrictEqual(unchanged, draft);

assert.throws(
  () => updateDraftField(draft, { section: "shot", index: 0, field: "__proto__" }, "x"),
  /不支持编辑/,
);
assert.throws(
  () => updateDraftField(draft, { section: "__proto__", field: "polluted" }, "x"),
  /不支持编辑/,
);
assert.throws(
  () => updateDraftField(draft, { section: "shot", index: 9, field: "dialogue" }, "x"),
  /不支持编辑/,
);

const valid = validateDraft(draft, normalizeGenerationRequest);
assert.strictEqual(valid.ok, true);
assert.strictEqual(valid.value.confirmed, false);
assert.strictEqual(draft.confirmed, false);
assert.deepStrictEqual(valid.errors, []);

const invalid = validateDraft({
  ...draft,
  shots: [{ ...draft.shots[0], sceneId: "missing" }],
}, normalizeGenerationRequest);
assert.deepStrictEqual(invalid, {
  ok: false,
  value: null,
  errors: [{ path: "shots.0.sceneId", message: "镜头 001 找不到场景 ID：missing" }],
});

console.log("replica-editor: ok");
