const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../replica-core.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-replica-"));
const source = path.join(tmp, "测试:视频.mp4");
fs.writeFileSync(source, "video");

assert.strictEqual(core.safeSegment("测试:视频"), "测试-视频");
assert.strictEqual(core.safeSegment("测试#视频[1]^"), "测试-视频-1-");
assert.strictEqual(core.formatTime(65.25), "01:05.250");
assert.match(core.createProjectFolder(source, new Date(2026, 9, 10, 9, 8, 7)), /^山竹视频复刻\/测试-视频-2026-10-10-09-08-07$/);
assert.strictEqual(core.validateSourceVideo(source, { duration: 12 }).duration, 12);
assert.throws(() => core.validateSourceVideo(source, { duration: 181 }), /180 秒以内/);
assert.throws(() => core.normalizeVaultPath("../escape"), /不安全/);
assert.throws(() => core.normalizeGenerationRequest({ confirmed: false }), /尚未确认/);

const request = core.normalizeGenerationRequest({
  confirmed: true,
  character: { prompt: "同一人物正面、侧面、背面三视图" },
  shots: [{ title: "开场", prompt: "人物走进房间", duration: 4 }],
});
assert.strictEqual(request.version, 1);
assert.strictEqual(request.shots[0].id, "001");

const requestV2Input = {
  version: 2,
  confirmed: true,
  character: { id: "hero", prompt: "固定人物参考板" },
  scenes: [{ id: "harbor", prompt: "海边集装箱场景" }],
  settings: { videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
  shots: [{
    title: "人物走向集装箱",
    sceneId: "harbor",
    imagePrompt: "人物全身中景",
    lastImagePrompt: "人物停在集装箱前",
    videoPrompt: "人物向前走，镜头缓慢推进",
    duration: 4,
  }],
};
const requestV2 = core.normalizeGenerationRequest(requestV2Input);
assert.strictEqual(requestV2.version, 2);
assert.deepStrictEqual(requestV2.character, { id: "hero", prompt: "固定人物参考板" });
assert.deepStrictEqual(requestV2.scenes, [{ id: "harbor", prompt: "海边集装箱场景" }]);
assert.strictEqual(requestV2.shots[0].sceneId, "harbor");
assert.strictEqual(requestV2.shots[0].lastImagePrompt, "人物停在集装箱前");

assert.throws(
  () => core.normalizeGenerationRequest({ ...requestV2Input, shots: [{ ...requestV2Input.shots[0], sceneId: "missing" }] }),
  /找不到场景 ID.*missing/,
);
assert.throws(
  () => core.normalizeGenerationRequest({ ...requestV2Input, character: { ...requestV2Input.character, id: "../hero" } }),
  /资产 ID 不安全/,
);
assert.throws(
  () => core.normalizeGenerationRequest({ ...requestV2Input, settings: { ...requestV2Input.settings, videoModel: "KlingO3" } }),
  /不支持模型/,
);
assert.throws(
  () => core.normalizeGenerationRequest({ ...requestV2Input, shots: Array.from({ length: 13 }, () => requestV2Input.shots[0]) }),
  /最多只能包含 12 个分镜/,
);

const markdown = core.dashboardMarkdown({
  folder: "山竹视频复刻/测试项目",
  title: "测试项目",
  sourcePath: source,
  duration: 12,
  createdAt: "2026-10-10T00:00:00.000Z",
  status: "prepared",
  transcriptPath: "山竹视频复刻/测试项目/02-分镜脚本/台词转写.md",
  frames: [{ index: 1, timestamp: 0, path: "山竹视频复刻/测试项目/02-分镜脚本/原片画面-001.jpg" }],
  shots: [],
});
assert.match(markdown, /!\[\[山竹视频复刻\/测试项目\/02-分镜脚本\/原片画面-001.jpg\]\]/);
assert.match(markdown, /!\[\[山竹视频复刻\/测试项目\/02-分镜脚本\/台词转写.md\]\]/);
assert.match(markdown, /当前状态/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("replica-core: ok");
