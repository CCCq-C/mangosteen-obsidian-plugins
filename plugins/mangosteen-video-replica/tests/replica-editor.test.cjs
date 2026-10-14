const assert = require("assert");
const { normalizeGenerationRequest } = require("../replica-core.cjs");
const {
  addTimelineSegment,
  isDraftLocked,
  moveShot,
  removeTimelineSegment,
  updateDraftField,
  validateDraft,
} = require("../replica-editor.cjs");

const draft = {
  version: 5,
  confirmed: false,
  visualStyle: { category: "真人写实", prompt: "真人电影质感，自然光影。" },
  character: { id: "hero", prompt: "原人物", voiceProfile: "原声音" },
  products: [],
  scenes: [{ id: "room", prompt: "原场景" }],
  settings: { imageModel: "gpt-image-2", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
  shots: [
    { id: "001", title: "第一镜", sceneId: "room", productIds: [], duration: 4, timeline: [{ start: 0, end: 4, action: "人物入场", dialogue: "", performance: "自然", camera: "远景", environment: "客厅" }] },
    { id: "002", title: "第二镜", sceneId: "room", productIds: [], duration: 4, timeline: [{ start: 0, end: 4, action: "人物坐下", dialogue: "", performance: "自然", camera: "中景", environment: "客厅" }] },
  ],
};

assert.strictEqual(isDraftLocked(draft, null), false);
assert.strictEqual(isDraftLocked({ ...draft, confirmed: true }, null), true);
assert.strictEqual(isDraftLocked(draft, { status: "processing" }), true);

const edited = updateDraftField(draft, { section: "timeline", shotIndex: 0, segmentIndex: 0, field: "dialogue" }, "新台词");
assert.strictEqual(edited.shots[0].timeline[0].dialogue, "新台词");
assert.strictEqual(draft.shots[0].timeline[0].dialogue, "");
assert.notStrictEqual(edited, draft);
assert.notStrictEqual(edited.shots[0].timeline[0], draft.shots[0].timeline[0]);

const editedSettings = updateDraftField(draft, { section: "settings", field: "videoModel" }, "seedance-2.5");
assert.strictEqual(editedSettings.settings.videoModel, "seedance-2.5");
assert.strictEqual(draft.settings.videoModel, "MiniMax-H3");

const draftWithProduct = { ...draft, products: [{ id: "phone", prompt: "原产品" }] };
const supportedEdits = [
  [{ section: "visualStyle", field: "category" }, "二次元写实", (value) => value.visualStyle.category],
  [{ section: "visualStyle", field: "prompt" }, "二次元写实角色，真实电影光影。", (value) => value.visualStyle.prompt],
  [{ section: "character", field: "prompt" }, "新人物", (value) => value.character.prompt],
  [{ section: "character", field: "voiceProfile" }, "年轻女声，四川口音", (value) => value.character.voiceProfile],
  [{ section: "product", index: 0, field: "prompt" }, "新产品", (value) => value.products[0].prompt],
  [{ section: "scene", index: 0, field: "prompt" }, "新场景", (value) => value.scenes[0].prompt],
  [{ section: "shot", index: 0, field: "title" }, "新标题", (value) => value.shots[0].title],
  [{ section: "shot", index: 0, field: "duration" }, 8, (value) => value.shots[0].duration],
  [{ section: "shot", index: 0, field: "sceneId" }, "room-2", (value) => value.shots[0].sceneId],
  [{ section: "shot", index: 0, field: "productIds" }, ["phone"], (value) => value.shots[0].productIds],
  [{ section: "shot", index: 0, field: "videoPromptOverride" }, "用户编辑后的完整提示词", (value) => value.shots[0].videoPromptOverride],
  [{ section: "timeline", shotIndex: 0, segmentIndex: 0, field: "start" }, 0, (value) => value.shots[0].timeline[0].start],
  [{ section: "timeline", shotIndex: 0, segmentIndex: 0, field: "end" }, 4, (value) => value.shots[0].timeline[0].end],
  [{ section: "timeline", shotIndex: 0, segmentIndex: 0, field: "action" }, "新剧情", (value) => value.shots[0].timeline[0].action],
  [{ section: "timeline", shotIndex: 0, segmentIndex: 0, field: "dialogue" }, "新台词", (value) => value.shots[0].timeline[0].dialogue],
  [{ section: "timeline", shotIndex: 0, segmentIndex: 0, field: "performance" }, "惊喜，语速略快", (value) => value.shots[0].timeline[0].performance],
  [{ section: "timeline", shotIndex: 0, segmentIndex: 0, field: "camera" }, "新镜头语言", (value) => value.shots[0].timeline[0].camera],
  [{ section: "timeline", shotIndex: 0, segmentIndex: 0, field: "environment" }, "新环境", (value) => value.shots[0].timeline[0].environment],
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

const versionSixDraft = { ...draft, schemaVersion: 6 };
const movedVersionSix = moveShot(versionSixDraft, 1, "up");
assert.deepStrictEqual(movedVersionSix.shots.map((shot) => shot.title), ["第二镜", "第一镜"]);
assert.deepStrictEqual(
  movedVersionSix.shots.map((shot) => shot.id),
  ["002", "001"],
  "v6 reordering must move stable shot IDs with their shots instead of renumbering them",
);

const split = addTimelineSegment(draft, 0, 0);
assert.deepStrictEqual(split.shots[0].timeline.map(({ start, end }) => [start, end]), [[0, 2], [2, 4]]);
assert.strictEqual(split.shots[0].timeline[1].action, "");
const removed = removeTimelineSegment(split, 0, 1);
assert.deepStrictEqual(removed.shots[0].timeline.map(({ start, end }) => [start, end]), [[0, 4]]);
assert.throws(() => removeTimelineSegment(draft, 0, 0), /至少保留一个时间段/);

assert.throws(() => updateDraftField(draft, { section: "shot", index: 0, field: "__proto__" }, "x"), /不支持编辑/);
assert.throws(() => updateDraftField(draft, { section: "__proto__", field: "polluted" }, "x"), /不支持编辑/);
assert.throws(() => updateDraftField(draft, { section: "timeline", shotIndex: 9, segmentIndex: 0, field: "dialogue" }, "x"), /不支持编辑/);

const valid = validateDraft(draft, normalizeGenerationRequest);
assert.strictEqual(valid.ok, true);
assert.strictEqual(valid.value.confirmed, false);
assert.deepStrictEqual(valid.errors, []);

const invalid = validateDraft({ ...draft, shots: [{ ...draft.shots[0], sceneId: "missing" }] }, normalizeGenerationRequest);
assert.deepStrictEqual(invalid, {
  ok: false,
  value: null,
  errors: [{ path: "shots.0.sceneId", message: "镜头 001 找不到场景 ID：missing" }],
});

const invalidTimeline = validateDraft({
  ...draft,
  shots: [{
    ...draft.shots[0],
    timeline: [
      { ...draft.shots[0].timeline[0], end: 2 },
      { ...draft.shots[0].timeline[0], start: 3, end: 4 },
    ],
  }],
}, normalizeGenerationRequest);
assert.strictEqual(invalidTimeline.ok, false);
assert.match(invalidTimeline.errors[0].message, /存在空档/);

const multiCharacterDraft = {
  ...draft,
  version: 6,
  castConfirmed: true,
  characters: [
    { id: "female-lead", role: "女主", prompt: "女主人物参考", voiceProfile: "年轻女声" },
    { id: "male-lead", role: "男主", prompt: "男主人物参考", voiceProfile: "年轻男声" },
  ],
  character: { id: "female-lead", role: "女主", prompt: "女主人物参考", voiceProfile: "年轻女声" },
  shots: draft.shots.map((shot) => ({ ...shot, characterIds: ["female-lead", "male-lead"] })),
};
const editedRole = updateDraftField(multiCharacterDraft, { section: "character", index: 1, field: "role" }, "哥哥");
assert.strictEqual(editedRole.characters[1].role, "哥哥");
assert.strictEqual(editedRole.castConfirmed, false, "editing a role must require cast confirmation again");
const editedCharacterIds = updateDraftField(multiCharacterDraft, { section: "shot", index: 0, field: "characterIds" }, ["male-lead"]);
assert.deepStrictEqual(editedCharacterIds.shots[0].characterIds, ["male-lead"]);
assert.deepStrictEqual(multiCharacterDraft.shots[0].characterIds, ["female-lead", "male-lead"]);

console.log("replica-editor: ok");
