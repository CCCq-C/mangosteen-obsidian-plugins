const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  analyzeProject,
  concatProjectVideos,
  hasFrameCoverage,
  parseAnalysisOutput,
  sampleFrames,
  transcriptSegments,
} = require("../replica-cli.cjs");

assert.deepStrictEqual(transcriptSegments({
  transcription: [{ timestamps: { from: "00:00:00,000", to: "00:00:07,000" }, text: "(字幕製作:貝爾)" }],
}), []);

assert.deepStrictEqual(transcriptSegments({
  transcription: [{ offsets: { from: 1500, to: 3200 }, text: "今天我们来看这款产品。" }],
}), [{ start: 1.5, end: 3.2, text: "今天我们来看这款产品。" }]);

assert.strictEqual(hasFrameCoverage([0, 2, 22, 74, 105], 133), false);
assert.strictEqual(hasFrameCoverage([0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132], 133), true);

const sampled = sampleFrames(Array.from({ length: 30 }, (_, index) => ({ index: index + 1 })), 12);
assert.strictEqual(sampled.length, 12);
assert.strictEqual(sampled[0].index, 1);
assert.strictEqual(sampled.at(-1).index, 30);
assert.deepStrictEqual(sampleFrames([], 12), []);
assert.deepStrictEqual(parseAnalysisOutput('```json\n{"character":{"id":"hero"}}\n```'), { character: { id: "hero" } });

(async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-replica-cli-"));
  const projectFolder = "山竹视频复刻/AI分析";
  const projectRoot = path.join(vault, ...projectFolder.split("/"));
  const storyboardRoot = path.join(projectRoot, "02-分镜脚本");
  fs.mkdirSync(storyboardRoot, { recursive: true });
  const frames = [1, 2].map((index) => {
    const vaultPath = `${projectFolder}/02-分镜脚本/原片画面-${String(index).padStart(3, "0")}.jpg`;
    fs.writeFileSync(path.join(vault, ...vaultPath.split("/")), `frame-${index}`);
    return { index, timestamp: index - 1, path: vaultPath };
  });
  fs.writeFileSync(path.join(storyboardRoot, "台词转写.md"), "# 台词转写\n\n- 00:00 你好\n");
  fs.writeFileSync(path.join(projectRoot, "project.json"), JSON.stringify({
    folder: projectFolder,
    title: "AI分析",
    duration: 8,
    width: 1080,
    height: 1920,
    frames,
    shots: [],
    transcriptPath: `${projectFolder}/02-分镜脚本/台词转写.md`,
    storyboardPath: `${projectFolder}/02-分镜脚本/分镜脚本.md`,
  }));

  const fakeCodex = path.join(vault, "fake-codex");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(output, JSON.stringify({
  character: { id: "hero", prompt: "短黑发人物三视图，固定五官和服装。" },
  scenes: [{ id: "studio", prompt: "明亮摄影棚，固定白色背景和柔光灯。" }],
  shots: [{
    title: "打招呼", sceneId: "studio", startTime: 0, endTime: 4,
    dialogue: "你好", plot: "人物抬手打招呼", environment: "摄影棚", camera: "中景固定",
    imagePrompt: "人物面对镜头抬手。", lastImagePrompt: "人物放下手。", videoPrompt: "人物自然挥手后放下。"
  }]
}));
`);
  fs.chmodSync(fakeCodex, 0o755);

  const fakeFfmpeg = path.join(vault, "fake-ffmpeg");
  fs.writeFileSync(fakeFfmpeg, `#!/usr/bin/env node
const fs = require("fs");
const output = process.argv.at(-1);
fs.writeFileSync(output, "joined-video");
`);
  fs.chmodSync(fakeFfmpeg, 0o755);

  const oldCodex = process.env.MANGOSTEEN_CODEX_CLI;
  const oldFfmpeg = process.env.MANGOSTEEN_FFMPEG;
  process.env.MANGOSTEEN_CODEX_CLI = fakeCodex;
  process.env.MANGOSTEEN_FFMPEG = fakeFfmpeg;
  try {
    const analyzed = await analyzeProject({ projectFolder, vaultPath: vault, pluginRoot: path.resolve(__dirname, "..") });
    assert.strictEqual(analyzed.request.confirmed, false);
    assert.strictEqual(analyzed.project.status, "analysis_ready");
    assert.strictEqual(analyzed.project.shots[0].status, "等待确认");
    assert.match(fs.readFileSync(path.join(storyboardRoot, "分镜脚本.md"), "utf8"), /人物自然挥手后放下/);

    const clipOne = `${projectFolder}/03-视频片段/镜头-001.mp4`;
    const clipTwo = `${projectFolder}/03-视频片段/镜头-002.mp4`;
    for (const clip of [clipOne, clipTwo]) {
      fs.mkdirSync(path.dirname(path.join(vault, ...clip.split("/"))), { recursive: true });
      fs.writeFileSync(path.join(vault, ...clip.split("/")), clip);
    }
    const finalVideoPath = await concatProjectVideos({
      project: { folder: projectFolder, shots: [{ videoPath: clipOne }, { videoPath: clipTwo }] },
      vaultPath: vault,
      pluginRoot: path.resolve(__dirname, ".."),
    });
    assert.strictEqual(finalVideoPath, `${projectFolder}/04-最终成片/最终成片.mp4`);
    assert.strictEqual(fs.readFileSync(path.join(vault, ...finalVideoPath.split("/")), "utf8"), "joined-video");
  } finally {
    if (oldCodex === undefined) delete process.env.MANGOSTEEN_CODEX_CLI; else process.env.MANGOSTEEN_CODEX_CLI = oldCodex;
    if (oldFfmpeg === undefined) delete process.env.MANGOSTEEN_FFMPEG; else process.env.MANGOSTEEN_FFMPEG = oldFfmpeg;
    fs.rmSync(vault, { recursive: true, force: true });
  }
  console.log("replica-cli: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
