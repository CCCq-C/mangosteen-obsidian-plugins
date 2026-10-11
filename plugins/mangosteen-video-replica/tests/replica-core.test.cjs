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
  character: { id: "hero", prompt: "固定人物参考板", voiceProfile: "年轻清亮的中文女声，轻微四川口音。" },
  scenes: [{ id: "harbor", prompt: "海边集装箱场景" }],
  settings: { videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
  shots: [{
    title: "人物走向集装箱",
    sceneId: "harbor",
    imagePrompt: "人物全身中景",
    lastImagePrompt: "人物停在集装箱前",
    videoPrompt: "人物向前走，镜头缓慢推进",
    dialogue: "今天带大家看看这款耳机。",
    voiceDirection: "自然介绍，语速中等，句尾轻微上扬。",
    duration: 4,
  }],
};
const requestV2 = core.normalizeGenerationRequest(requestV2Input);
assert.strictEqual(requestV2.version, 2);
assert.deepStrictEqual(requestV2.character, { id: "hero", prompt: "固定人物参考板", voiceProfile: "年轻清亮的中文女声，轻微四川口音。" });
assert.strictEqual(requestV2.character.voiceProfile, "年轻清亮的中文女声，轻微四川口音。");
assert.deepStrictEqual(requestV2.scenes, [{ id: "harbor", prompt: "海边集装箱场景" }]);
assert.strictEqual(requestV2.shots[0].sceneId, "harbor");
assert.strictEqual(requestV2.shots[0].lastImagePrompt, "人物停在集装箱前");
assert.strictEqual(requestV2.shots[0].voiceDirection, "自然介绍，语速中等，句尾轻微上扬。");
const fractionalRequest = core.normalizeGenerationRequest({
  ...requestV2Input,
  shots: [{ ...requestV2Input.shots[0], duration: 13.5 }],
});
assert.strictEqual(fractionalRequest.shots[0].duration, 14, "fractional provider durations must round up to an accepted integer");

assert.throws(
  () => core.normalizeGenerationRequest({ ...requestV2Input, shots: [{ ...requestV2Input.shots[0], sceneId: "missing" }] }),
  /找不到场景 ID.*missing/,
);
let missingSceneError;
try {
  core.normalizeGenerationRequest({ ...requestV2Input, shots: [{ ...requestV2Input.shots[0], sceneId: "missing" }] });
} catch (error) {
  missingSceneError = error;
}
assert.strictEqual(missingSceneError.path, "shots.0.sceneId");
assert.strictEqual(missingSceneError.message, "镜头 001 找不到场景 ID：missing");
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

const requestV3Input = {
  ...requestV2Input,
  version: 3,
  products: [{ id: "headphones", prompt: "白色头戴式耳机与白色包装盒，外观、比例、材质和品牌位置固定。" }],
  shots: [{
    ...requestV2Input.shots[0],
    productIds: ["headphones"],
    videoPromptOverride: "用户确认后的完整视频生成提示词。",
  }],
};
const requestV3 = core.normalizeGenerationRequest(requestV3Input);
assert.strictEqual(requestV3.version, 3);
assert.deepStrictEqual(requestV3.products, requestV3Input.products);
assert.deepStrictEqual(requestV3.shots[0].productIds, ["headphones"]);
assert.strictEqual(requestV3.shots[0].videoPromptOverride, "用户确认后的完整视频生成提示词。");
assert.deepStrictEqual(requestV3.shots[0].timeline, [{
  start: 0,
  end: 4,
  action: "人物向前走，镜头缓慢推进",
  dialogue: "今天带大家看看这款耳机。",
  performance: "自然介绍，语速中等，句尾轻微上扬。",
  camera: "",
  environment: "",
}]);
assert.throws(
  () => core.normalizeGenerationRequest({ ...requestV3Input, shots: [{ ...requestV3Input.shots[0], productIds: ["missing"] }] }),
  /找不到产品 ID.*missing/,
);
assert.throws(
  () => core.normalizeGenerationRequest({
    ...requestV3Input,
    products: [
      requestV3Input.products[0],
      { id: "phone", prompt: "黑色手机固定产品参考板" },
      { id: "cup", prompt: "白色咖啡杯固定产品参考板" },
    ],
    shots: [{ ...requestV3Input.shots[0], productIds: ["headphones", "phone", "cup"] }],
  }),
  /最多引用 2 个产品/,
);

const analysisDraft = core.buildGenerationDraft({ width: 1080, height: 1920 }, {
  character: {
    id: "main-hero",
    prompt: "固定人物三视图，短黑发、米白夹克、深蓝工装裤，保持五官和服装一致。",
    voiceProfile: "年轻清亮的中文女声，普通话，声音有亲和力。",
  },
  products: [{ id: "headphones", prompt: "白色头戴式耳机与白色包装盒，外观、比例、材质和品牌位置固定。" }],
  scenes: [{ id: "harbor", prompt: "傍晚海边集装箱码头，左侧蓝色集装箱，右侧海面，远处白色灯塔。" }],
  shots: [{
    title: "走向集装箱", sceneId: "harbor", startTime: 0, endTime: 4,
    productIds: ["headphones"],
    timeline: [{ start: 0, end: 4, action: "人物向前走两步", dialogue: "你好呀", performance: "轻松打招呼，语速中等，尾音自然上扬。", camera: "中景缓慢推进", environment: "海边码头" }],
  }],
}, { videoModel: "MiniMax-H3", resolution: "768p" });
assert.strictEqual(analysisDraft.confirmed, false);
assert.strictEqual(analysisDraft.version, 4);
assert.strictEqual(analysisDraft.settings.ratio, "9:16");
assert.strictEqual(analysisDraft.shots[0].duration, 4);
assert.deepStrictEqual(analysisDraft.shots[0].productIds, ["headphones"]);
assert.strictEqual(analysisDraft.character.voiceProfile, "年轻清亮的中文女声，普通话，声音有亲和力。");
assert.strictEqual(analysisDraft.shots[0].timeline[0].performance, "轻松打招呼，语速中等，尾音自然上扬。");
const fractionalAnalysisDraft = core.buildGenerationDraft({ width: 1080, height: 1920 }, {
  character: analysisDraft.character,
  products: analysisDraft.products,
  scenes: analysisDraft.scenes,
  shots: [{ ...analysisDraft.shots[0], startTime: 0, endTime: 13.5, timeline: [{ ...analysisDraft.shots[0].timeline[0], end: 13.5 }] }],
}, { videoModel: "MiniMax-H3", resolution: "768p" });
assert.strictEqual(fractionalAnalysisDraft.shots[0].duration, 14);
assert.strictEqual(fractionalAnalysisDraft.shots[0].timeline.at(-1).end, 14);
const storyboard = core.analysisStoryboardMarkdown({ title: "测试" }, analysisDraft);
assert.match(storyboard, /原片截图只用于分析/);
assert.match(storyboard, /产品参考提示词/);
assert.match(storyboard, /headphones/);
assert.match(storyboard, /人物声音设定/);
assert.match(storyboard, /轻松打招呼/);

const markdown = core.dashboardMarkdown({
  folder: "山竹视频复刻/测试项目",
  title: "测试项目",
  sourcePath: source,
  duration: 12,
  createdAt: "2026-10-10T00:00:00.000Z",
  status: "prepared",
  transcriptPath: "山竹视频复刻/测试项目/02-分镜脚本/台词转写.md",
  productAssets: [{ id: "headphones", imagePath: "山竹视频资产库/产品/headphones/产品参考板.png" }],
  frames: [{ index: 1, timestamp: 0, path: "山竹视频复刻/测试项目/02-分镜脚本/原片画面-001.jpg" }],
  shots: [],
});
assert.match(markdown, /!\[\[山竹视频复刻\/测试项目\/02-分镜脚本\/原片画面-001.jpg\]\]/);
assert.match(markdown, /!\[\[山竹视频复刻\/测试项目\/02-分镜脚本\/台词转写.md\]\]/);
assert.match(markdown, /当前状态/);
assert.match(markdown, /山竹视频资产库\/产品\/headphones\/产品参考板\.png/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("replica-core: ok");
