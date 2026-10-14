const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  analysisPrompt,
  applyAnalysis,
  concatProjectVideos,
  hasFrameCoverage,
  prepareProject,
  prepareResult,
  resolveRuntimes,
  sampleFrames,
  transcriptSegments,
  whisperArguments,
} = require("../replica-cli.cjs");

const promptForVoiceAnalysis = analysisPrompt({
  folder: "山竹视频复刻/测试",
  duration: 8,
  width: 1080,
  height: 1920,
  transcriptPath: "山竹视频复刻/测试/02-分镜脚本/台词转写.md",
}, "四川话：你莫急嘛。");
assert.match(promptForVoiceAnalysis, /voiceProfile/);
assert.match(promptForVoiceAnalysis, /performance/);
assert.match(promptForVoiceAnalysis, /无法实际听到原声音频/);
assert.match(promptForVoiceAnalysis, /口音/);
assert.match(promptForVoiceAnalysis, /背景歌曲歌词不得当成人物对白/);
assert.match(promptForVoiceAnalysis, /画外背景歌曲/);
assert.match(promptForVoiceAnalysis, /根据剧情节点动态划分/);
assert.match(promptForVoiceAnalysis, /时间段必须连续/);
assert.match(promptForVoiceAnalysis, /visualStyle/);
assert.match(promptForVoiceAnalysis, /全项目统一视觉风格/);
const analysisSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../video-analysis-schema.json"), "utf8"));
assert(analysisSchema.required.includes("visualStyle"));
assert(analysisSchema.required.includes("characters"));
assert(!analysisSchema.required.includes("character"));
assert.deepStrictEqual(analysisSchema.properties.visualStyle.required, ["category", "prompt"]);
const shotSchema = analysisSchema.properties.shots.items;
assert(shotSchema.required.includes("timeline"));
assert(shotSchema.required.includes("characterIds"));
assert(!shotSchema.required.includes("imagePrompt"));

const whisperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-whisper-priority-"));
fs.mkdirSync(path.join(whisperRoot, "models"), { recursive: true });
fs.writeFileSync(path.join(whisperRoot, "models/ggml-base.bin"), "base");
fs.writeFileSync(path.join(whisperRoot, "models/ggml-small.bin"), "small");
assert.strictEqual(resolveRuntimes(whisperRoot).whisperModel, path.join(whisperRoot, "models/ggml-small.bin"));
assert.deepStrictEqual(
  whisperArguments(
    { whisperModel: "/models/small.bin" },
    "/work/audio.wav",
    "/work/whisper-result",
    "  品牌   名称  ",
    4,
  ).slice(0, 10),
  ["-m", "/models/small.bin", "-f", "/work/audio.wav", "-l", "zh", "--prompt", "品牌 名称", "--carry-initial-prompt", "-oj"],
  "Whisper must receive the source-name prompt and carry it across segments",
);
fs.rmSync(whisperRoot, { recursive: true, force: true });

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
  const creationVault = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-replica-create-v6-"));
  const sourceVideo = path.join(creationVault, "CLI 输入视频.MOV");
  const fakeFfprobe = path.join(creationVault, "fake-ffprobe");
  const fakePrepareFfmpeg = path.join(creationVault, "fake-prepare-ffmpeg");
  fs.writeFileSync(sourceVideo, "source-video");
  fs.writeFileSync(fakeFfprobe, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  format: { duration: "8", size: "12" },
  streams: [{ index: 0, codec_type: "video", width: 720, height: 1280, r_frame_rate: "30/1" }],
}));
`);
  fs.writeFileSync(fakePrepareFfmpeg, `#!/usr/bin/env node
const fs = require("fs");
const output = process.argv.at(-1);
if (output.includes("%03d")) {
  fs.writeFileSync(output.replace("%03d", "001"), "frame-1");
  fs.writeFileSync(output.replace("%03d", "002"), "frame-2");
  process.stderr.write("showinfo pts_time:0\\nshowinfo pts_time:4\\n");
} else {
  fs.writeFileSync(output, "media");
}
`);
  fs.chmodSync(fakeFfprobe, 0o755);
  fs.chmodSync(fakePrepareFfmpeg, 0o755);

  const oldPrepareFfmpeg = process.env.MANGOSTEEN_FFMPEG;
  const oldPrepareFfprobe = process.env.MANGOSTEEN_FFPROBE;
  process.env.MANGOSTEEN_FFMPEG = fakePrepareFfmpeg;
  process.env.MANGOSTEEN_FFPROBE = fakeFfprobe;
  const prepareProgress = [];
  let created;
  try {
    created = await prepareProject({
      sourcePath: sourceVideo,
      vaultPath: creationVault,
      projectFolder: "山竹视频复刻/project-stable",
      pluginRoot: path.resolve(__dirname, ".."),
      onProgress: (event) => prepareProgress.push(event),
    });
  } finally {
    if (oldPrepareFfmpeg === undefined) delete process.env.MANGOSTEEN_FFMPEG; else process.env.MANGOSTEEN_FFMPEG = oldPrepareFfmpeg;
    if (oldPrepareFfprobe === undefined) delete process.env.MANGOSTEEN_FFPROBE; else process.env.MANGOSTEEN_FFPROBE = oldPrepareFfprobe;
  }

  const createdRoot = path.join(creationVault, "山竹视频复刻/project-stable");
  const createdProjectPath = path.join(createdRoot, ".mangosteen/project.json");
  const createdDraftPath = path.join(createdRoot, ".mangosteen/draft.json");
  assert.strictEqual(created.schemaVersion, 6);
  assert.strictEqual(created.layoutVersion, 6);
  assert.strictEqual(created.projectId, "project-stable");
  assert.strictEqual(created.id, "project-stable", "the compatibility ID must remain stable");
  assert.deepStrictEqual(
    prepareProgress.map((event) => event.stage),
    ["probe", "project", "frames", "frames-complete", "audio", "prepared"],
    "local preparation must report every visible stage in order",
  );
  assert.deepStrictEqual(
    prepareProgress.map((event) => event.percent),
    [5, 12, 20, 45, 52, 70],
    "local preparation progress must be monotonic and leave room for AI analysis",
  );
  assert.match(prepareProgress[3].label, /2 张/);
  assert.strictEqual(created.sourcePath, "山竹视频复刻/project-stable/01-原始素材/原视频.mov");
  assert.strictEqual(fs.readFileSync(path.join(createdRoot, "01-原始素材/原视频.mov"), "utf8"), "source-video");
  assert(fs.existsSync(path.join(createdRoot, "01-原始素材/台词转写.md")));
  assert(fs.existsSync(path.join(createdRoot, "01-原始素材/抽帧/原片画面-001.jpg")));
  assert(fs.existsSync(path.join(createdRoot, "02-参考资产/参考资产.md")));
  assert(fs.existsSync(path.join(createdRoot, "03-分镜")));
  assert(fs.existsSync(path.join(createdRoot, "04-最终成片")));
  assert(fs.existsSync(createdProjectPath));
  assert(fs.existsSync(createdDraftPath));
  assert.strictEqual(fs.existsSync(path.join(createdRoot, "02-分镜脚本")), false, "v6 must not recreate the mixed legacy storyboard folder");
  assert.strictEqual(fs.existsSync(path.join(createdRoot, "project.json")), false);
  assert.strictEqual(fs.existsSync(path.join(createdRoot, "generation-request.json")), false);

  const createdProject = JSON.parse(fs.readFileSync(createdProjectPath, "utf8"));
  const createdDraft = JSON.parse(fs.readFileSync(createdDraftPath, "utf8"));
  assert.strictEqual(createdProject.schemaVersion, 6);
  assert.strictEqual(createdDraft.schemaVersion, 6);
  assert.strictEqual(createdDraft.confirmed, false);
  assert.strictEqual(createdDraft.transcriptSegments.length, 0);
  assert.deepStrictEqual(
    createdDraft.visualStyle,
    {
      category: "继承参考资产",
      prompt: "保持现有人物、场景和产品参考图的既有视觉风格；媒介、写实度、材质、色彩、光线和镜头质感全片一致。",
    },
    "a locally prepared draft must remain valid when AI analysis fails before replacing the fallback style",
  );
  assert.strictEqual(
    prepareResult({ ...created, transcriptSegments: [{ text: "wrong project location" }] }, {
      ...createdDraft,
      transcriptSegments: [{ start: 0, end: 1, text: "draft transcript" }],
    }).transcriptCount,
    1,
    "v6 CLI summaries must count transcript segments from draft.json",
  );
  for (const volatileField of ["status", "statusText", "runtime", "generationQueue", "activeRun"]) {
    assert.strictEqual(Object.hasOwn(createdProject, volatileField), false, `project.json must not persist volatile ${volatileField}`);
  }
  assert.deepStrictEqual(
    createdProject.frames.map((frame) => frame.path),
    [
      "山竹视频复刻/project-stable/01-原始素材/抽帧/原片画面-001.jpg",
      "山竹视频复刻/project-stable/01-原始素材/抽帧/原片画面-002.jpg",
    ],
  );
  const createdOverview = fs.readFileSync(path.join(createdRoot, "00-项目总览.md"), "utf8");
  assert.match(createdOverview, /!\[\[山竹视频复刻\/project-stable\/01-原始素材\/原视频\.mov\]\]/);
  assert.match(createdOverview, /!\[\[山竹视频复刻\/project-stable\/01-原始素材\/台词转写\.md\]\]/);
  assert.match(createdOverview, /!\[\[山竹视频复刻\/project-stable\/02-参考资产\/参考资产\.md\]\]/);

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
  visualStyle: { category: "真人写实", prompt: "真人电影质感，自然皮肤纹理，暖色夕阳光，低饱和写实摄影。" },
  character: { id: "hero", prompt: "短黑发人物三视图，固定五官和服装。", voiceProfile: "年轻清亮的中文女声，普通话。" },
  scenes: [{ id: "studio", prompt: "明亮摄影棚，固定白色背景和柔光灯。" }],
  shots: [{
    title: "打招呼", sceneId: "studio", startTime: 0, endTime: 4,
    productIds: [],
    timeline: [{ start: 0, end: 4, action: "人物抬手打招呼", dialogue: "你好", performance: "亲切，语速中等，句尾上扬。", camera: "中景固定", environment: "摄影棚" }],
  }],
  };

  const analyzedV6 = applyAnalysis({
    projectFolder: created.folder,
    vaultPath: creationVault,
    analysis,
    settings: { imageModel: "gpt-image-2-w", videoModel: "MiniMax-H3", resolution: "768p" },
  });
  const analyzedV6Project = JSON.parse(fs.readFileSync(createdProjectPath, "utf8"));
  const analyzedV6Draft = JSON.parse(fs.readFileSync(createdDraftPath, "utf8"));
  assert.strictEqual(analyzedV6.request.schemaVersion, 6);
  assert.strictEqual(analyzedV6Project.schemaVersion, 6);
  assert.strictEqual(analyzedV6Draft.schemaVersion, 6);
  assert.strictEqual(analyzedV6Draft.version, 6);
  assert.strictEqual(analyzedV6Draft.castConfirmed, false);
  assert.strictEqual(analyzedV6Draft.shots[0].id, "001");
  assert.strictEqual(analyzedV6Draft.shots[0].timeline[0].performance, "亲切，语速中等，句尾上扬。");
  assert.deepStrictEqual(analyzedV6Project.shots, [{ id: "001", currentArtifacts: {} }]);
  assert.strictEqual(Object.hasOwn(analyzedV6Project, "status"), false);
  assert.strictEqual(fs.existsSync(path.join(createdRoot, "02-分镜脚本/分镜脚本.md")), false);
  const referenceIndex = fs.readFileSync(path.join(createdRoot, "02-参考资产/参考资产.md"), "utf8");
  assert.match(referenceIndex, /!\[\[山竹视频资产库\/人物\/hero\/人物参考板\.png\]\]/);
  assert.match(referenceIndex, /!\[\[山竹视频资产库\/场景\/studio\/场景参考图\.png\]\]/);
  assert.match(referenceIndex, /本项目没有需要固定外观的核心产品/);
  const analyzedOverview = fs.readFileSync(path.join(createdRoot, "00-项目总览.md"), "utf8");
  assert.match(analyzedOverview, /\[\[山竹视频复刻\/project-stable\/03-分镜\/001\/首帧\.png\|首帧\]\]/);
  assert.match(analyzedOverview, /\[\[山竹视频复刻\/project-stable\/03-分镜\/001\/视频\.mp4\|视频\]\]/);

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
    assert.strictEqual(analyzed.request.version, 6);
    assert.strictEqual(analyzed.request.visualStyle.category, "真人写实");
    assert.strictEqual(analyzed.project.status, "analysis_ready");
    assert.strictEqual(analyzed.project.shots[0].status, "等待确认");
    assert.strictEqual(analyzed.request.character.voiceProfile, "年轻清亮的中文女声，普通话。");
    assert.strictEqual(analyzed.request.shots[0].timeline[0].performance, "亲切，语速中等，句尾上扬。");
    assert.match(fs.readFileSync(path.join(storyboardRoot, "分镜脚本.md"), "utf8"), /人物抬手打招呼/);

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

    const versionSixClips = ["001", "002"].map((id) => `${created.folder}/03-分镜/${id}/视频.mp4`);
    for (const clip of versionSixClips) {
      fs.mkdirSync(path.dirname(path.join(creationVault, ...clip.split("/"))), { recursive: true });
      fs.writeFileSync(path.join(creationVault, ...clip.split("/")), clip);
    }
    const versionSixFinalVideoPath = await concatProjectVideos({
      project: { schemaVersion: 6, folder: created.folder, shots: versionSixClips.map((videoPath) => ({ videoPath })) },
      vaultPath: creationVault,
      pluginRoot: path.resolve(__dirname, ".."),
    });
    assert.strictEqual(versionSixFinalVideoPath, `${created.folder}/04-最终成片/最终成片.mp4`);
    assert.strictEqual(fs.existsSync(path.join(createdRoot, ".work")), false, "v6 concat must not create the legacy .work directory");
    assert.strictEqual(
      fs.readdirSync(path.join(createdRoot, ".mangosteen")).some((name) => name.startsWith("concat-") || name.includes(".tmp-")),
      false,
      "v6 concat must remove its temporary manifest after success",
    );

    const failingFfmpeg = path.join(creationVault, "fake-ffmpeg-failure");
    fs.writeFileSync(failingFfmpeg, "#!/usr/bin/env node\nprocess.stderr.write('injected concat failure'); process.exit(1);\n");
    fs.chmodSync(failingFfmpeg, 0o755);
    process.env.MANGOSTEEN_FFMPEG = failingFfmpeg;
    await assert.rejects(
      () => concatProjectVideos({
        project: { schemaVersion: 6, folder: created.folder, shots: versionSixClips.map((videoPath) => ({ videoPath })) },
        vaultPath: creationVault,
        pluginRoot: path.resolve(__dirname, ".."),
      }),
      /injected concat failure|命令执行失败|退出码/,
    );
    assert.strictEqual(fs.existsSync(path.join(createdRoot, ".work")), false);
    assert.strictEqual(
      fs.readdirSync(path.join(createdRoot, ".mangosteen")).some((name) => name.startsWith("concat-") || name.includes(".tmp-")),
      false,
      "v6 concat must remove its temporary manifest after failure",
    );
  } finally {
    if (oldFfmpeg === undefined) delete process.env.MANGOSTEEN_FFMPEG; else process.env.MANGOSTEEN_FFMPEG = oldFfmpeg;
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(creationVault, { recursive: true, force: true });
  }
  console.log("replica-cli: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
