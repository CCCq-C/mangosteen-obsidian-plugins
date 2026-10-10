const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const core = require("./replica-core.cjs");

function executable(value) {
  if (!value) return "";
  try { fs.accessSync(value, fs.constants.X_OK); return value; } catch (_) { return ""; }
}

function which(name) {
  const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  return result.status === 0 ? executable(String(result.stdout || "").trim()) : "";
}

function firstExisting(values, check = (value) => fs.existsSync(value)) {
  return values.find((value) => value && check(value)) || "";
}

function resolveRuntime(pluginRoot, name, envName, standard = []) {
  const platform = `${process.platform}-${process.arch}`;
  return firstExisting([
    process.env[envName],
    path.join(pluginRoot, "runtimes", platform, name),
    ...standard,
    which(name),
  ], executable);
}

function resolveWhisperModel(pluginRoot) {
  return firstExisting([
    process.env.MANGOSTEEN_WHISPER_MODEL,
    path.join(pluginRoot, "models", "ggml-small.bin"),
    path.join(pluginRoot, "models", "ggml-base.bin"),
    path.join(os.homedir(), ".cache", "whisper-cpp", "ggml-small.bin"),
    path.join(os.homedir(), ".cache", "whisper-cpp", "ggml-base.bin"),
  ]);
}

function resolveRuntimes(pluginRoot = __dirname) {
  return {
    ffmpeg: resolveRuntime(pluginRoot, "ffmpeg", "MANGOSTEEN_FFMPEG", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]),
    ffprobe: resolveRuntime(pluginRoot, "ffprobe", "MANGOSTEEN_FFPROBE", ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]),
    whisper: resolveRuntime(pluginRoot, "whisper-cli", "MANGOSTEEN_WHISPER", ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]),
    whisperModel: resolveWhisperModel(pluginRoot),
  };
}

function run(command, args, { allowFailure = false, maxOutput = 12 * 1024 * 1024, cwd, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs) : null;
    timer?.unref?.();
    const append = (current, chunk) => {
      if (current.length >= maxOutput) return current;
      return Buffer.concat([current, Buffer.from(chunk).subarray(0, maxOutput - current.length)]);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result = { code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
      if (timedOut) return reject(new Error(`${path.basename(command)} 执行超过 ${Math.ceil(timeoutMs / 60000)} 分钟，已停止本次分析。`));
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${path.basename(command)} 执行失败：${result.stderr.trim().split("\n").slice(-4).join(" ") || `退出码 ${code}`}`));
    });
  });
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filePath);
}

function writeJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function uniqueProjectFolder(vaultPath, preferred) {
  let folder = preferred;
  let suffix = 2;
  while (fs.existsSync(path.join(vaultPath, folder))) folder = `${preferred}-${suffix++}`;
  return folder;
}

async function probeVideo(ffprobe, sourcePath) {
  const result = await run(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=index,codec_type,width,height,r_frame_rate",
    "-of", "json",
    sourcePath,
  ]);
  let json;
  try { json = JSON.parse(result.stdout); } catch (_) { throw new Error("无法读取视频信息，请确认视频文件没有损坏。"); }
  const duration = Number(json?.format?.duration);
  const videoStream = (json?.streams || []).find((stream) => stream.codec_type === "video");
  if (!videoStream) throw new Error("源文件中没有可读取的视频画面。");
  return {
    duration,
    width: Number(videoStream.width) || 0,
    height: Number(videoStream.height) || 0,
    hasAudio: (json?.streams || []).some((stream) => stream.codec_type === "audio"),
  };
}

function parseShowInfo(stderr) {
  const values = [];
  const pattern = /showinfo[^\n]*?pts_time:\s*([0-9.]+)/g;
  let match;
  while ((match = pattern.exec(stderr))) values.push(Number(match[1]) || 0);
  return values;
}

function hasFrameCoverage(timestamps, duration) {
  if (!(duration > 3)) return true;
  const points = timestamps.filter(Number.isFinite).filter((value) => value >= 0 && value <= duration).sort((a, b) => a - b);
  if (points.length < 2) return false;
  const edges = [0, ...points, duration];
  const largestGap = Math.max(...edges.slice(1).map((value, index) => value - edges[index]));
  return largestGap <= Math.max(10, duration / 10);
}

async function extractFrames(ffmpeg, sourcePath, outputFolder, duration) {
  fs.mkdirSync(outputFolder, { recursive: true });
  const target = path.join(outputFolder, "原片画面-%03d.jpg");
  const scene = await run(ffmpeg, [
    "-hide_banner", "-loglevel", "info", "-i", sourcePath,
    "-vf", "select=eq(n\\,0)+gt(scene\\,0.22),showinfo,scale=1280:-2:force_original_aspect_ratio=decrease",
    "-fps_mode", "vfr", "-frames:v", "30", "-q:v", "2", "-y", target,
  ]);
  let files = fs.readdirSync(outputFolder).filter((name) => /^原片画面-\d+\.jpg$/i.test(name)).sort();
  let timestamps = parseShowInfo(scene.stderr);
  if (duration > 3 && (files.length < 2 || !hasFrameCoverage(timestamps.slice(0, files.length), duration))) {
    for (const name of files) fs.rmSync(path.join(outputFolder, name), { force: true });
    const interval = Math.max(2, duration / 30);
    await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", sourcePath,
      "-vf", `fps=1/${interval},scale=1280:-2:force_original_aspect_ratio=decrease`,
      "-frames:v", "30", "-q:v", "2", "-y", target,
    ]);
    files = fs.readdirSync(outputFolder).filter((name) => /^原片画面-\d+\.jpg$/i.test(name)).sort();
    timestamps = files.map((_, index) => index * interval);
  }
  if (!files.length) throw new Error("没有提取到视频画面，请确认视频可以正常播放。");
  return files.map((name, index) => ({ name, timestamp: Math.min(duration, timestamps[index] ?? index * 3) }));
}

async function extractAudio(ffmpeg, sourcePath, outputPath) {
  const result = await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", sourcePath,
    "-map", "0:a:0?", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", outputPath,
  ], { allowFailure: true });
  return result.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 44;
}

function segmentTime(value) {
  if (typeof value === "number") return value / (value > 1000 ? 1000 : 1);
  const text = String(value || "");
  const match = text.match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

function transcriptSegments(json) {
  const entries = json?.transcription || json?.segments || json?.result?.segments || [];
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    start: segmentTime(entry?.timestamps?.from ?? entry?.start ?? entry?.offsets?.from),
    end: segmentTime(entry?.timestamps?.to ?? entry?.end ?? entry?.offsets?.to),
    text: String(entry?.text || entry?.sentence || "").trim(),
  })).filter((entry) => entry.text && !/^[(\[（【].*(字幕|翻译|翻譯|制作|製作|music|音乐|音樂).*[)\]）】]$/i.test(entry.text));
}

function transcriptMarkdown(segments, sourceName) {
  const lines = [`# 台词转写｜${core.safeSegment(sourceName)}`, "", "> 本地 Whisper.cpp 自动转写，建议生成前快速校对人名和专有词。", ""];
  if (!segments.length) lines.push("未检测到可识别的语音。", "");
  for (const segment of segments) lines.push(`- **${core.formatTime(segment.start)} → ${core.formatTime(segment.end)}**　${segment.text}`);
  lines.push("");
  return lines.join("\n");
}

async function transcribeAudio(runtime, audioPath, workFolder, sourceName) {
  if (!fs.existsSync(audioPath)) return { segments: [], jsonPath: "", markdown: transcriptMarkdown([], sourceName) };
  if (!runtime.whisper) throw new Error("缺少 Whisper.cpp。请重新安装山竹视频复刻组件。");
  if (!runtime.whisperModel) throw new Error("缺少 Whisper 中文模型。请重新安装山竹视频复刻组件。");
  const outputPrefix = path.join(workFolder, "whisper-result");
  const initialPrompt = String(sourceName || "").replace(/\s+/g, " ").trim().slice(0, 320);
  await run(runtime.whisper, [
    "-m", runtime.whisperModel, "-f", audioPath, "-l", "zh",
    ...(initialPrompt ? ["--prompt", initialPrompt, "--carry-initial-prompt"] : []),
    "-oj", "-of", outputPrefix, "-np", "-t", String(Math.max(2, Math.min(8, os.cpus().length - 1))),
  ]);
  const jsonPath = `${outputPrefix}.json`;
  if (!fs.existsSync(jsonPath)) throw new Error("Whisper 已运行，但没有输出转写文件。");
  const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const segments = transcriptSegments(json);
  return { segments, jsonPath, markdown: transcriptMarkdown(segments, sourceName) };
}

function initialStoryboard(project) {
  const lines = [
    `# 分镜脚本｜${core.safeSegment(project.title)}`,
    "",
    "> 等待山竹根据原片画面和台词转写完成剧情、台词、环境、镜头和生成提示词分析。",
    "",
    "| 镜头 | 时间 | 原片画面 | 剧情/动作 | 台词 | 环境 | 镜头语言 |",
    "|---|---:|---|---|---|---|---|",
  ];
  for (const frame of project.frames) lines.push(`| ${String(frame.index).padStart(3, "0")} | ${core.formatTime(frame.timestamp)} | ![[${frame.path}]] | 待分析 | 待分析 | 待分析 | 待分析 |`);
  lines.push("");
  return lines.join("\n");
}

async function prepareProject({ sourcePath, vaultPath, projectFolder = "", pluginRoot = __dirname } = {}) {
  const vault = path.resolve(String(vaultPath || ""));
  if (!fs.statSync(vault, { throwIfNoEntry: false })?.isDirectory()) throw new Error("找不到 Obsidian 知识库目录。");
  const source = core.validateSourceVideo(sourcePath);
  const runtime = resolveRuntimes(pluginRoot);
  if (!runtime.ffmpeg || !runtime.ffprobe) throw new Error("缺少 FFmpeg/ffprobe。请重新安装山竹视频复刻组件。");
  const metadata = await probeVideo(runtime.ffprobe, source.absolute);
  core.validateSourceVideo(source.absolute, { duration: metadata.duration });
  const preferred = projectFolder ? core.normalizeVaultPath(projectFolder) : core.createProjectFolder(source.absolute);
  const folder = uniqueProjectFolder(vault, preferred);
  const absoluteFolder = path.join(vault, ...folder.split("/"));
  const peopleFolder = path.join(absoluteFolder, "01-人物参考");
  const storyboardFolder = path.join(absoluteFolder, "02-分镜脚本");
  const clipsFolder = path.join(absoluteFolder, "03-视频片段");
  const workFolder = path.join(absoluteFolder, ".work");
  for (const directory of [peopleFolder, storyboardFolder, clipsFolder, workFolder]) fs.mkdirSync(directory, { recursive: true });

  const project = {
    version: 1,
    id: path.basename(folder),
    folder,
    title: path.basename(source.absolute, path.extname(source.absolute)),
    sourcePath: source.absolute,
    sourceName: path.basename(source.absolute),
    createdAt: new Date().toISOString(),
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    status: "preparing",
    statusText: "正在提取画面和台词",
    frames: [],
    shots: [],
    transcriptPath: `${folder}/02-分镜脚本/台词转写.md`,
    storyboardPath: `${folder}/02-分镜脚本/分镜脚本.md`,
    characterImagePath: "",
    runtime: {
      ffmpeg: runtime.ffmpeg,
      ffprobe: runtime.ffprobe,
      whisper: runtime.whisper,
      whisperModel: runtime.whisperModel,
    },
  };
  const saveProject = () => {
    writeJson(path.join(absoluteFolder, "project.json"), project);
    atomicWrite(path.join(absoluteFolder, "00-项目总览.md"), core.dashboardMarkdown(project));
  };
  saveProject();

  try {
    const extracted = await extractFrames(runtime.ffmpeg, source.absolute, storyboardFolder, metadata.duration);
    project.frames = extracted.map((frame, index) => ({ index: index + 1, timestamp: frame.timestamp, path: `${folder}/02-分镜脚本/${frame.name}` }));
    const audioPath = path.join(workFolder, "原片音频.wav");
    const hasAudio = metadata.hasAudio && await extractAudio(runtime.ffmpeg, source.absolute, audioPath);
    const transcript = hasAudio ? await transcribeAudio(runtime, audioPath, workFolder, project.title) : { segments: [], markdown: transcriptMarkdown([], project.title) };
    project.transcriptSegments = transcript.segments;
    atomicWrite(path.join(storyboardFolder, "台词转写.md"), transcript.markdown);
    atomicWrite(path.join(storyboardFolder, "分镜脚本.md"), initialStoryboard(project));
    project.status = "prepared";
    project.statusText = "本地拆解完成，等待山竹分析分镜";
    saveProject();
    return project;
  } catch (error) {
    project.status = "failed";
    project.statusText = `本地拆解失败：${String(error?.message || error)}`;
    saveProject();
    throw error;
  }
}

function sampleFrames(frames, limit = 12) {
  const values = Array.isArray(frames) ? frames : [];
  const count = Math.max(1, Math.min(Number(limit) || 12, values.length));
  if (values.length <= count) return values.slice();
  return Array.from({ length: count }, (_, index) => values[Math.round(index * (values.length - 1) / (count - 1))]);
}

function analysisPrompt(project, transcriptText = "") {
  const transcript = project.transcriptPath || `${project.folder}/02-分镜脚本/台词转写.md`;
  return [
    "你是视频复刻分镜分析器。只分析本次提供的项目资料，不搜索网络，不修改任何文件。",
    `项目：${project.folder}`,
    `时长：${Number(project.duration || 0).toFixed(1)} 秒；尺寸：${Number(project.width || 0)}x${Number(project.height || 0)}`,
    `台词转写来源：${transcript}`,
    String(transcriptText || "").trim() ? `以下是完整台词转写：\n${String(transcriptText).trim()}` : "原片没有识别到可用台词。",
    "再结合附带的按时间顺序截图完成分析。",
    "输出最多 12 个连续分镜，覆盖主要剧情。每个分镜写清人物动作、台词、环境、镜头语言、首帧提示词、可选尾帧提示词和视频提示词。",
    "人物提示词必须描述稳定的五官、发型、年龄、服装和正面/侧面/背面三视图。",
    "声音采用两层设定：character.voiceProfile 写全片固定的语言、口音、年龄感、音色和说话习惯；每个有台词的镜头用 voiceDirection 写本镜头的情绪、语调、语速、重音和停顿。全片没有台词时 voiceProfile 为空；单个镜头没有台词时 voiceDirection 为空。",
    "严格区分人物对白、旁白和背景歌曲歌词。只有画面中角色实际开口说出的内容写入 dialogue；背景歌曲歌词不得当成人物对白或要求角色对口型，应写进 videoPrompt，明确为画外背景歌曲。",
    "优先保留台词转写中明确出现的语言或方言线索。当前分析只收到台词文本与截图，无法实际听到原声音频；没有明确证据时只能根据人物、画面和剧情给出可编辑的声音建议，不得声称已经克隆或精确识别原声。",
    "把需要固定外观的商品、品牌包装或核心道具单独写入 products；产品提示词要写清型号、形状、颜色、材质、比例、包装和可见标识。没有核心产品时 products 输出空数组。",
    "场景只描述纯环境：地标、空间布局、建筑、固定陈设、光线、天气、时间和环境质感，不得写人物、商品、品牌包装或产品摆放。环境细节要足以在多个镜头中保持空间连续。",
    "每个镜头用 productIds 指定本镜头真正出现的产品，最多 2 个；普通桌椅、树木、灯具等环境陈设不算产品。",
    "所有镜头复用同一人物资产；同一地点复用同一 sceneId。ID 只用英文、数字、下划线或短横线。",
    "原片截图只用于理解，不要要求把原片截图作为生成参考图。严格按给定 JSON Schema 输出。",
  ].join("\n");
}

function applyAnalysis({ projectFolder, vaultPath, analysis, settings = {}, analysisProvider = "mangosteen-agent", analysisGroup = "", analysisModel = "" } = {}) {
  const vault = path.resolve(String(vaultPath || ""));
  if (!fs.statSync(vault, { throwIfNoEntry: false })?.isDirectory()) throw new Error("找不到 Obsidian 知识库目录。");
  const folder = core.normalizeVaultPath(projectFolder);
  const absoluteFolder = path.join(vault, ...folder.split("/"));
  const projectPath = path.join(absoluteFolder, "project.json");
  if (!fs.statSync(projectPath, { throwIfNoEntry: false })?.isFile()) throw new Error("找不到视频复刻项目的 project.json。");
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const workFolder = path.join(absoluteFolder, ".work");
  const outputPath = path.join(workFolder, "ai-analysis.json");
  fs.mkdirSync(workFolder, { recursive: true });
  const request = core.buildGenerationDraft(project, analysis, settings);
  project.status = "analysis_ready";
  project.statusText = "山竹智能体分析完成，等待确认生成";
  project.imageModel = request.settings.imageModel;
  project.videoModel = request.settings.videoModel;
  project.analysisProvider = analysisProvider;
  project.analysisGroup = String(analysisGroup || "");
  project.analysisModel = String(analysisModel || "");
  delete project.analysisErrorCode;
  delete project.analysisErrorStatus;
  delete project.analysisErrorAt;
  project.shots = request.shots.map((shot) => ({ ...shot, status: "等待确认", imagePath: "", videoPath: "", error: "" }));
  writeJson(outputPath, analysis);
  writeJson(projectPath, project);
  writeJson(path.join(absoluteFolder, "generation-request.json"), request);
  atomicWrite(path.join(absoluteFolder, "02-分镜脚本", "分镜脚本.md"), core.analysisStoryboardMarkdown(project, request));
  atomicWrite(path.join(absoluteFolder, "00-项目总览.md"), core.dashboardMarkdown(project));
  return { project, request, outputPath };
}

function concatFileLine(filePath) {
  return `file '${String(filePath).replace(/'/g, "'\\''")}'`;
}

async function concatProjectVideos({ project, vaultPath, pluginRoot = __dirname } = {}) {
  const vault = path.resolve(String(vaultPath || ""));
  const folder = core.normalizeVaultPath(project?.folder);
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  if (!shots.length || shots.some((shot) => !shot.videoPath)) throw new Error("分镜视频尚未全部生成，暂时不能拼接。");
  const clips = shots.map((shot) => path.join(vault, ...core.normalizeVaultPath(shot.videoPath).split("/")));
  const missing = clips.find((filePath) => !fs.statSync(filePath, { throwIfNoEntry: false })?.isFile());
  if (missing) throw new Error(`找不到视频片段：${path.basename(missing)}`);
  const ffmpeg = resolveRuntimes(pluginRoot).ffmpeg;
  if (!ffmpeg) throw new Error("缺少 FFmpeg，无法拼接最终成片。请重新安装山竹视频复刻组件。");
  const absoluteFolder = path.join(vault, ...folder.split("/"));
  const workFolder = path.join(absoluteFolder, ".work");
  const outputFolder = path.join(absoluteFolder, "04-最终成片");
  const listPath = path.join(workFolder, "concat.txt");
  const outputPath = path.join(outputFolder, "最终成片.mp4");
  fs.mkdirSync(workFolder, { recursive: true });
  fs.mkdirSync(outputFolder, { recursive: true });
  atomicWrite(listPath, `${clips.map(concatFileLine).join("\n")}\n`);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-y", outputPath], { timeoutMs: 10 * 60 * 1000 });
  if (!fs.statSync(outputPath, { throwIfNoEntry: false })?.isFile()) throw new Error("FFmpeg 已结束，但没有生成最终成片。");
  return `${folder}/04-最终成片/最终成片.mp4`;
}

function parseArgs(argv) {
  const output = { command: argv[2] || "", json: false };
  for (let index = 3; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--json") output.json = true;
    else if (item.startsWith("--")) output[item.slice(2)] = argv[++index];
  }
  return output;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.command !== "prepare" || !args.source || !args.vault) {
    throw new Error('用法：node replica-cli.cjs prepare --source "/绝对路径/视频.mp4" --vault "/知识库路径" --json');
  }
  const project = await prepareProject({ sourcePath: args.source, vaultPath: args.vault, projectFolder: args.project });
  const result = { ok: true, projectFolder: project.folder, dashboard: `${project.folder}/00-项目总览.md`, frameCount: project.frames.length, transcriptCount: project.transcriptSegments?.length || 0 };
  process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `已创建：${result.dashboard}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${String(error?.message || error)}\n`); process.exitCode = 1; });

module.exports = {
  analysisPrompt,
  applyAnalysis,
  concatProjectVideos,
  hasFrameCoverage,
  prepareProject,
  resolveRuntimes,
  sampleFrames,
  transcriptSegments,
};
