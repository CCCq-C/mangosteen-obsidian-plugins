const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const core = require("./replica-core.cjs");
const projectStorage = require("./project-storage.cjs");
const { DEFAULT_VISUAL_STYLE } = require("./visual-style.cjs");

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

function reportPreparationProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try { onProgress({ ...event }); } catch (_) { /* progress UI must never stop local preparation */ }
}

function uniqueProjectFolder(vaultPath, preferred) {
  let folder = preferred;
  let suffix = 2;
  while (fs.existsSync(path.join(vaultPath, folder))) folder = `${preferred}-${suffix++}`;
  return folder;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function createProjectResolver(vaultPath, projectFolder) {
  const vault = path.resolve(String(vaultPath || ""));
  const vaultStat = fs.lstatSync(vault, { throwIfNoEntry: false });
  if (!vaultStat?.isDirectory() || vaultStat.isSymbolicLink()) throw new Error("知识库目录不安全，已拒绝创建项目。");
  const folder = projectStorage.projectRelativePaths(projectFolder).overview.split("/00-项目总览.md")[0];
  const projectRoot = path.resolve(vault, ...folder.split("/"));
  if (!isInside(vault, projectRoot)) throw new Error("项目目录超出知识库范围，已拒绝创建。");

  return (relativePath, { createParents = false, directory = false } = {}) => {
    const normalized = core.normalizeVaultPath(relativePath);
    if (normalized !== folder && !normalized.startsWith(`${folder}/`)) {
      throw new Error("项目文件超出当前项目范围，已拒绝访问。");
    }
    const target = path.resolve(vault, ...normalized.split("/"));
    if (!isInside(projectRoot, target)) throw new Error("项目文件路径不安全，已拒绝访问。");
    const targetDirectory = directory ? target : path.dirname(target);
    const relativeDirectory = path.relative(vault, targetDirectory);
    let current = vault;
    for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat && createParents) {
        fs.mkdirSync(current);
        stat = fs.lstatSync(current, { throwIfNoEntry: false });
      }
      if (!stat) break;
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("项目路径包含符号链接或非目录节点，已拒绝访问。");
    }
    const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (targetStat?.isSymbolicLink()) throw new Error("项目文件不能是符号链接，已拒绝访问。");
    if (directory && targetStat && !targetStat.isDirectory()) throw new Error("项目目录无效，已拒绝访问。");
    return target;
  };
}

function copyFileAtomic(sourcePath, targetPath) {
  const temporary = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary, targetPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function initialVersionSixDraft() {
  return {
    schemaVersion: 6,
    version: 6,
    confirmed: false,
    castConfirmed: false,
    analysisStatus: "preparing",
    analysisStatusText: "正在提取画面和台词",
    transcriptSegments: [],
    visualStyle: { ...DEFAULT_VISUAL_STYLE },
    characters: [],
    character: { id: "main-character", prompt: "", voiceProfile: "" },
    products: [],
    scenes: [],
    settings: { imageModel: "", videoModel: "", ratio: "", resolution: "" },
    shots: [],
  };
}

function writeVersionSixDocuments({ resolveSafe, paths, project, draft }) {
  projectStorage.atomicWriteBundle({
    resolveSafe,
    entries: [
      { relativePath: paths.project, content: `${JSON.stringify(project, null, 2)}\n` },
      { relativePath: paths.draft, content: `${JSON.stringify(draft, null, 2)}\n` },
      { relativePath: paths.referenceIndex, content: core.referenceAssetsMarkdown(project, draft) },
      { relativePath: paths.overview, content: core.dashboardMarkdown(project, draft) },
    ],
  });
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

function whisperArguments(runtime, audioPath, outputPrefix, sourceName, cpuCount = os.cpus().length) {
  const initialPrompt = String(sourceName || "").replace(/\s+/g, " ").trim().slice(0, 320);
  return [
    "-m", runtime.whisperModel, "-f", audioPath, "-l", "zh",
    ...(initialPrompt ? ["--prompt", initialPrompt, "--carry-initial-prompt"] : []),
    "-oj", "-of", outputPrefix, "-np", "-t", String(Math.max(2, Math.min(8, cpuCount - 1))),
  ];
}

async function transcribeAudio(runtime, audioPath, workFolder, sourceName) {
  if (!fs.existsSync(audioPath)) return { segments: [], jsonPath: "", markdown: transcriptMarkdown([], sourceName) };
  if (!runtime.whisper) throw new Error("缺少 Whisper.cpp。请重新安装山竹视频复刻组件。");
  if (!runtime.whisperModel) throw new Error("缺少 Whisper 中文模型。请重新安装山竹视频复刻组件。");
  const outputPrefix = path.join(workFolder, "whisper-result");
  await run(runtime.whisper, whisperArguments(runtime, audioPath, outputPrefix, sourceName));
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

async function prepareProject({ sourcePath, vaultPath, projectFolder = "", pluginRoot = __dirname, onProgress = null } = {}) {
  const vault = path.resolve(String(vaultPath || ""));
  if (!fs.statSync(vault, { throwIfNoEntry: false })?.isDirectory()) throw new Error("找不到 Obsidian 知识库目录。");
  const source = core.validateSourceVideo(sourcePath);
  const runtime = resolveRuntimes(pluginRoot);
  if (!runtime.ffmpeg || !runtime.ffprobe) throw new Error("缺少 FFmpeg/ffprobe。请重新安装山竹视频复刻组件。");
  reportPreparationProgress(onProgress, { stage: "probe", percent: 5, step: 1, label: "正在读取视频信息", indeterminate: true });
  const metadata = await probeVideo(runtime.ffprobe, source.absolute);
  core.validateSourceVideo(source.absolute, { duration: metadata.duration });
  reportPreparationProgress(onProgress, { stage: "project", percent: 12, step: 2, label: "正在创建项目并复制源视频", indeterminate: true });
  const preferred = projectFolder ? core.normalizeVaultPath(projectFolder) : core.createProjectFolder(source.absolute);
  const folder = uniqueProjectFolder(vault, preferred);
  const resolveSafe = createProjectResolver(vault, folder);
  const paths = projectStorage.createProjectLayout({ resolveSafe, folder });
  const sourceVideoPath = `${paths.sourceRoot}/原视频${source.extension}`;
  const transcriptPath = `${paths.sourceRoot}/台词转写.md`;
  const frameFolderPath = `${paths.sourceRoot}/抽帧`;
  const sourceVideoAbsolute = resolveSafe(sourceVideoPath, { createParents: true });
  copyFileAtomic(source.absolute, sourceVideoAbsolute);
  const now = new Date().toISOString();

  const project = {
    schemaVersion: 6,
    layoutVersion: 6,
    projectId: path.basename(folder),
    id: path.basename(folder),
    folder,
    title: path.basename(source.absolute, path.extname(source.absolute)),
    source: {
      videoPath: sourceVideoPath,
      originalPath: source.absolute,
      originalName: path.basename(source.absolute),
      extension: source.extension,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
    },
    sourcePath: sourceVideoPath,
    sourceName: path.basename(source.absolute),
    createdAt: now,
    updatedAt: now,
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    frames: [],
    shots: [],
    transcriptPath,
    finalVideoPath: "",
  };
  const draft = initialVersionSixDraft();
  const saveProject = () => writeVersionSixDocuments({ resolveSafe, paths, project, draft });
  saveProject();
  const workFolder = fs.mkdtempSync(path.join(os.tmpdir(), "mangosteen-video-replica-"));

  try {
    reportPreparationProgress(onProgress, { stage: "frames", percent: 20, step: 3, label: "正在抽取关键画面", indeterminate: true });
    const extracted = await extractFrames(runtime.ffmpeg, sourceVideoAbsolute, resolveSafe(frameFolderPath, { directory: true }), metadata.duration);
    project.frames = extracted.map((frame, index) => ({ index: index + 1, timestamp: frame.timestamp, path: `${frameFolderPath}/${frame.name}` }));
    reportPreparationProgress(onProgress, { stage: "frames-complete", percent: 45, step: 3, label: `已抽取 ${project.frames.length} 张关键画面`, indeterminate: false });
    const audioPath = path.join(workFolder, "原片音频.wav");
    reportPreparationProgress(onProgress, { stage: "audio", percent: 52, step: 4, label: metadata.hasAudio ? "正在提取音频" : "原视频没有音轨，跳过音频提取", indeterminate: metadata.hasAudio });
    const hasAudio = metadata.hasAudio && await extractAudio(runtime.ffmpeg, sourceVideoAbsolute, audioPath);
    if (hasAudio) reportPreparationProgress(onProgress, { stage: "transcript", percent: 58, step: 4, label: "正在识别台词", indeterminate: true });
    const transcript = hasAudio ? await transcribeAudio(runtime, audioPath, workFolder, project.title) : { segments: [], markdown: transcriptMarkdown([], project.title) };
    draft.transcriptSegments = transcript.segments;
    draft.analysisStatus = "prepared";
    draft.analysisStatusText = "本地拆解完成，等待山竹分析分镜";
    atomicWrite(resolveSafe(transcriptPath, { createParents: true }), transcript.markdown);
    project.updatedAt = new Date().toISOString();
    saveProject();
    reportPreparationProgress(onProgress, { stage: "prepared", percent: 70, step: 4, label: "本地拆解完成", indeterminate: false });
    return project;
  } catch (error) {
    draft.analysisStatus = "failed";
    draft.analysisStatusText = `本地拆解失败：${String(error?.message || error)}`;
    draft.analysisError = String(error?.message || error);
    project.updatedAt = new Date().toISOString();
    saveProject();
    throw error;
  } finally {
    fs.rmSync(workFolder, { recursive: true, force: true });
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
    "先提取全项目统一视觉风格到 visualStyle：category 使用简短类别（如真人写实、二次元写实、二维动漫、3D 动画、插画）；prompt 写清媒介、写实度、材质、光线、色彩、镜头质感和明确禁止的风格漂移。",
    "visualStyle 是全项目统一视觉风格，不得为不同人物、场景或分镜分别改风格。",
    "输出最多 12 个连续分镜，覆盖主要剧情。每个分镜都用 timeline 根据剧情节点动态划分时间段，不得套用固定的 0～1 秒、1～4 秒模板。",
    "每个 timeline 时间段写清画面动作、人物台词、情绪与声音、景别与运镜、环境。时间段必须连续、不重叠、不漏秒，从 0 秒开始并结束于该分镜总时长。",
    "动态识别所有需要跨镜头保持一致的独立角色，写入 characters。多次出现、说台词、推动剧情或需要固定外观的人物应单独建角色；偶发路人、人群和不参与剧情的背景人物不要建角色。不得固定假设只有一个主角。",
    "每个人物提示词必须描述稳定的五官、发型、年龄、服装和正面/侧面/背面三视图；role 使用观众能理解的角色名，如女主、男主、店员。",
    "声音采用两层设定：characters[].voiceProfile 写该角色全片固定的语言、口音、年龄感、音色和说话习惯；每个有台词的时间段用 performance 写情绪、语调、语速、重音和停顿。全片没有台词时 voiceProfile 为空；单个时间段没有台词时 dialogue 为空。",
    "严格区分人物对白、旁白和背景歌曲歌词。只有画面中角色实际开口说出的内容写入 timeline[].dialogue；背景歌曲歌词不得当成人物对白或要求角色对口型，应在对应时间段的 action 中明确为画外背景歌曲。",
    "优先保留台词转写中明确出现的语言或方言线索。当前分析只收到台词文本与截图，无法实际听到原声音频；没有明确证据时只能根据人物、画面和剧情给出可编辑的声音建议，不得声称已经克隆或精确识别原声。",
    "把需要固定外观的商品、品牌包装或核心道具单独写入 products；产品提示词要写清型号、形状、颜色、材质、比例、包装和可见标识。没有核心产品时 products 输出空数组。",
    "场景只描述纯环境：地标、空间布局、建筑、固定陈设、光线、天气、时间和环境质感，不得写人物、商品、品牌包装或产品摆放。环境细节要足以在多个镜头中保持空间连续。",
    "每个镜头用 productIds 指定本镜头真正出现的产品，最多 2 个；普通桌椅、树木、灯具等环境陈设不算产品。",
    "每个镜头用 characterIds 指定本镜头真正出现且需要保持一致的角色，单镜头最多 3 个固定角色；超过时按剧情拆成多个镜头。纯空镜可为空数组。对话内容需写清说话角色。同一地点复用同一 sceneId。ID 只用英文、数字、下划线或短横线。",
    "原片截图只用于理解，不要要求把原片截图作为生成参考图。严格按给定 JSON Schema 输出。",
  ].join("\n");
}

function applyAnalysis({ projectFolder, vaultPath, analysis, settings = {}, analysisProvider = "mangosteen-agent", analysisGroup = "", analysisModel = "" } = {}) {
  const vault = path.resolve(String(vaultPath || ""));
  if (!fs.statSync(vault, { throwIfNoEntry: false })?.isDirectory()) throw new Error("找不到 Obsidian 知识库目录。");
  const folder = core.normalizeVaultPath(projectFolder);
  const resolveSafe = createProjectResolver(vault, folder);
  const paths = projectStorage.projectRelativePaths(folder);
  const legacyPaths = { project: `${folder}/project.json`, draft: `${folder}/generation-request.json` };
  let documents;
  try {
    documents = projectStorage.readProjectDocument({
      readJson: (relativePath) => JSON.parse(fs.readFileSync(resolveSafe(relativePath), "utf8")),
      paths,
      legacyPaths,
    });
  } catch (error) {
    if (error?.code === "ENOENT" && fs.statSync(resolveSafe(legacyPaths.project), { throwIfNoEntry: false })?.isFile()) {
      documents = {
        project: JSON.parse(fs.readFileSync(resolveSafe(legacyPaths.project), "utf8")),
        draft: fs.statSync(resolveSafe(legacyPaths.draft), { throwIfNoEntry: false })?.isFile()
          ? JSON.parse(fs.readFileSync(resolveSafe(legacyPaths.draft), "utf8"))
          : {},
        legacy: true,
      };
    } else if (error?.code === "ENOENT") throw new Error("找不到视频复刻项目的 project.json。");
    else throw error;
  }
  const project = documents.project;
  const request = core.buildGenerationDraft(project, analysis, settings);
  if (!documents.legacy) {
    const updatedAt = new Date().toISOString();
    const previousShots = new Map((Array.isArray(project.shots) ? project.shots : []).map((shot) => [String(shot.id), shot]));
    project.schemaVersion = 6;
    project.layoutVersion = 6;
    project.projectId ||= project.id || path.basename(folder);
    project.id ||= project.projectId;
    project.analysis = {
      provider: analysisProvider,
      group: String(analysisGroup || ""),
      model: String(analysisModel || ""),
      updatedAt,
    };
    project.shots = request.shots.map((shot) => {
      const previous = previousShots.get(String(shot.id)) || {};
      return {
        id: shot.id,
        currentArtifacts: previous.currentArtifacts && typeof previous.currentArtifacts === "object"
          ? previous.currentArtifacts
          : {},
      };
    });
    project.updatedAt = updatedAt;
    const draft = {
      ...request,
      schemaVersion: 6,
      analysisStatus: "analysis_ready",
      analysisStatusText: "山竹智能体分析完成，等待确认生成",
      analysis: { ...project.analysis },
      transcriptSegments: Array.isArray(documents.draft?.transcriptSegments) ? documents.draft.transcriptSegments : [],
    };
    for (const shot of request.shots) {
      const shotFolder = projectStorage.shotArtifactPaths(folder, shot.id).folder;
      fs.mkdirSync(resolveSafe(shotFolder, { createParents: true, directory: true }), { recursive: true });
    }
    writeVersionSixDocuments({ resolveSafe, paths, project, draft });
    return { project, request: draft, outputPath: resolveSafe(paths.draft) };
  }

  const absoluteFolder = resolveSafe(folder, { directory: true });
  const projectPath = resolveSafe(legacyPaths.project);
  const workFolder = resolveSafe(`${folder}/.work`, { createParents: true, directory: true });
  const outputPath = path.join(workFolder, "ai-analysis.json");
  fs.mkdirSync(workFolder, { recursive: true });
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
  const videoPaths = shots.map((shot) => shot?.videoPath || shot?.currentArtifacts?.video || "");
  if (!shots.length || videoPaths.some((videoPath) => !videoPath)) throw new Error("分镜视频尚未全部生成，暂时不能拼接。");
  const isVersionSix = Number(project?.schemaVersion) === 6;
  const resolveSafe = isVersionSix ? createProjectResolver(vault, folder) : null;
  const clips = videoPaths.map((videoPath) => {
    const normalized = core.normalizeVaultPath(videoPath);
    return resolveSafe ? resolveSafe(normalized) : path.join(vault, ...normalized.split("/"));
  });
  const missing = clips.find((filePath) => !fs.statSync(filePath, { throwIfNoEntry: false })?.isFile());
  if (missing) throw new Error(`找不到视频片段：${path.basename(missing)}`);
  const ffmpeg = resolveRuntimes(pluginRoot).ffmpeg;
  if (!ffmpeg) throw new Error("缺少 FFmpeg，无法拼接最终成片。请重新安装山竹视频复刻组件。");
  const absoluteFolder = resolveSafe ? resolveSafe(folder, { directory: true }) : path.join(vault, ...folder.split("/"));
  const outputFolder = resolveSafe
    ? resolveSafe(`${folder}/04-最终成片`, { createParents: true, directory: true })
    : path.join(absoluteFolder, "04-最终成片");
  const listPath = resolveSafe
    ? resolveSafe(`${folder}/.mangosteen/concat-${crypto.randomUUID()}.txt`, { createParents: true })
    : path.join(absoluteFolder, ".work", "concat.txt");
  const outputPath = resolveSafe
    ? resolveSafe(`${folder}/04-最终成片/最终成片.mp4`, { createParents: true })
    : path.join(outputFolder, "最终成片.mp4");
  if (!resolveSafe) fs.mkdirSync(path.dirname(listPath), { recursive: true });
  fs.mkdirSync(outputFolder, { recursive: true });
  try {
    atomicWrite(listPath, `${clips.map(concatFileLine).join("\n")}\n`);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-y", outputPath], { timeoutMs: 10 * 60 * 1000 });
    if (!fs.statSync(outputPath, { throwIfNoEntry: false })?.isFile()) throw new Error("FFmpeg 已结束，但没有生成最终成片。");
    return `${folder}/04-最终成片/最终成片.mp4`;
  } finally {
    if (isVersionSix) fs.rmSync(listPath, { force: true });
  }
}

function prepareResult(project, draft = {}) {
  const transcriptSource = Number(project?.schemaVersion) === 6 ? draft : project;
  return {
    ok: true,
    projectFolder: project.folder,
    dashboard: `${project.folder}/00-项目总览.md`,
    frameCount: Array.isArray(project.frames) ? project.frames.length : 0,
    transcriptCount: Array.isArray(transcriptSource?.transcriptSegments) ? transcriptSource.transcriptSegments.length : 0,
  };
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
  let draft = {};
  if (Number(project.schemaVersion) === 6) {
    const resolveSafe = createProjectResolver(args.vault, project.folder);
    draft = JSON.parse(fs.readFileSync(resolveSafe(projectStorage.projectRelativePaths(project.folder).draft), "utf8"));
  }
  const result = prepareResult(project, draft);
  process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `已创建：${result.dashboard}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${String(error?.message || error)}\n`); process.exitCode = 1; });

module.exports = {
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
};
