const EPSILON = 0.001;
const clean = (value) => String(value ?? "").trim();

function secondsLabel(value) {
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(3)));
}

function normalizeTimeline(timeline, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) throw new Error("镜头总时长无效。");
  if (!Array.isArray(timeline) || !timeline.length) throw new Error("镜头至少需要一个时间段。");

  const normalized = timeline.map((segment, index) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`时间段 ${index + 1} 的起止时间无效。`);
    if (end <= start + EPSILON) throw new Error(`时间段 ${index + 1} 的结束时间必须大于开始时间。`);
    return {
      start,
      end,
      action: clean(segment?.action),
      dialogue: clean(segment?.dialogue),
      performance: clean(segment?.performance),
      camera: clean(segment?.camera),
      environment: clean(segment?.environment),
    };
  });

  if (Math.abs(normalized[0].start) > EPSILON) throw new Error("时间轴必须从 0 秒开始。");
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.start > previous.end + EPSILON) throw new Error(`时间段 ${index} 和 ${index + 1} 之间存在空档。`);
    if (current.start < previous.end - EPSILON) throw new Error(`时间段 ${index} 和 ${index + 1} 之间存在重叠。`);
  }
  const end = normalized[normalized.length - 1].end;
  if (Math.abs(end - total) > EPSILON) throw new Error(`时间轴必须结束于 ${secondsLabel(total)} 秒。`);
  return normalized;
}

function legacyTimeline(shot = {}) {
  const duration = Number(shot.duration);
  return [{
    start: 0,
    end: Number.isFinite(duration) && duration > 0 ? duration : 4,
    action: clean(shot.videoPrompt || shot.plot),
    dialogue: clean(shot.dialogue),
    performance: clean(shot.voiceDirection),
    camera: clean(shot.camera),
    environment: clean(shot.environment),
  }];
}

function compileTimelinePrompt(timeline, { duration, voiceProfile = "" } = {}) {
  const segments = normalizeTimeline(timeline, duration);
  const lines = [
    "【人物一致性】",
    "严格按照人物参考图保持身份、五官、发型、发色、年龄、身材和服装完全一致，不得换人或改变造型。",
  ];
  if (clean(voiceProfile)) lines.push("", "【固定声音】", clean(voiceProfile));
  lines.push("", "【时间轴镜头指令】");
  for (const segment of segments) {
    lines.push(
      `【${secondsLabel(segment.start)}～${secondsLabel(segment.end)} 秒】`,
      `画面动作：${segment.action || "保持自然动作"}`,
      `人物台词：${segment.dialogue || "无"}`,
      `情绪与声音：${segment.performance || "自然表达"}`,
      `景别与运镜：${segment.camera || "保持镜头稳定"}`,
      `环境：${segment.environment || "延续当前场景"}`,
    );
  }
  lines.push("", "人物台词必须与口型同步、吐字清楚；不得添加、删减或改写台词；背景音乐和环境音不得盖过对白。");
  return lines.join("\n");
}

function firstFramePrompt(timeline) {
  const first = Array.isArray(timeline) ? timeline[0] : null;
  if (!first) throw new Error("缺少首段时间轴，无法生成首帧。");
  return [
    "生成这个视频镜头开始时的静态画面。",
    `画面动作起点：${clean(first.action) || "人物处于动作起点"}`,
    `人物状态：${clean(first.performance) || "神态自然"}`,
    `景别与构图：${clean(first.camera) || "镜头稳定"}`,
    `环境：${clean(first.environment) || "延续场景参考图"}`,
  ].join("\n");
}

module.exports = {
  compileTimelinePrompt,
  firstFramePrompt,
  legacyTimeline,
  normalizeTimeline,
};
