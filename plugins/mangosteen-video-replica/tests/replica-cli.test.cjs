const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  analysisPrompt,
  applyAnalysis,
  concatProjectVideos,
  hasFrameCoverage,
  resolveRuntimes,
  sampleFrames,
  transcriptSegments,
} = require("../replica-cli.cjs");

const promptForVoiceAnalysis = analysisPrompt({
  folder: "山竹视频复刻/测试",
  duration: 8,
  width: 1080,
  height: 1920,
  transcriptPath: "山竹视频复刻/测试/02-分镜脚本/台词转写.md",
}, "四川话：你莫急嘛。");
assert.match(promptForVoiceAnalysis, /voiceProfile/);
assert.match(promptForVoiceAnalysis, /voiceDirection/);
assert.match(promptForVoiceAnalysis, /无法实际听到原声音频/);
assert.match(promptForVoiceAnalysis, /口音/);

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
assert.strictEqual(Object.hasOwn(resolveRuntimes(path.resolve(__dirname, "..")), "codex"), false, "video replica must not launch Codex CLI as an analysis fallback");

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

  const analysis = {
  character: { id: "hero", prompt: "短黑发人物三视图，固定五官和服装。", voiceProfile: "年轻清亮的中文女声，普通话。" },
  scenes: [{ id: "studio", prompt: "明亮摄影棚，固定白色背景和柔光灯。" }],
  shots: [{
    title: "打招呼", sceneId: "studio", startTime: 0, endTime: 4,
    dialogue: "你好", voiceDirection: "亲切，语速中等，句尾上扬。", plot: "人物抬手打招呼", environment: "摄影棚", camera: "中景固定",
    imagePrompt: "人物面对镜头抬手。", lastImagePrompt: "人物放下手。", videoPrompt: "人物自然挥手后放下。"
  }],
  };

  const fakeFfmpeg = path.join(vault, "fake-ffmpeg");
  fs.writeFileSync(fakeFfmpeg, `#!/usr/bin/env node
const fs = require("fs");
const output = process.argv.at(-1);
fs.writeFileSync(output, "joined-video");
`);
  fs.chmodSync(fakeFfmpeg, 0o755);

  const oldFfmpeg = process.env.MANGOSTEEN_FFMPEG;
  process.env.MANGOSTEEN_FFMPEG = fakeFfmpeg;
  try {
    const analyzed = applyAnalysis({ projectFolder, vaultPath: vault, analysis, settings: { videoModel: "MiniMax-H3", resolution: "768p" } });
    assert.strictEqual(analyzed.request.confirmed, false);
    assert.strictEqual(analyzed.project.status, "analysis_ready");
    assert.strictEqual(analyzed.project.shots[0].status, "等待确认");
    assert.strictEqual(analyzed.request.character.voiceProfile, "年轻清亮的中文女声，普通话。");
    assert.strictEqual(analyzed.request.shots[0].voiceDirection, "亲切，语速中等，句尾上扬。");
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
    if (oldFfmpeg === undefined) delete process.env.MANGOSTEEN_FFMPEG; else process.env.MANGOSTEEN_FFMPEG = oldFfmpeg;
    fs.rmSync(vault, { recursive: true, force: true });
  }
  console.log("replica-cli: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
