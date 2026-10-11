const assert = require("assert");
const {
  compileTimelinePrompt,
  fitTimelineDuration,
  firstFramePrompt,
  legacyTimeline,
  normalizeTimeline,
} = require("../shot-timeline.cjs");

const timeline = [
  {
    start: 0,
    end: 2.5,
    action: "人物走进客厅",
    dialogue: "",
    performance: "放松自然",
    camera: "远景跟拍",
    environment: "傍晚客厅，暖色灯光",
  },
  {
    start: 2.5,
    end: 8,
    action: "人物拿起耳机盒并展示",
    dialogue: "你们看这个。",
    performance: "惊喜，语速稍快，句尾上扬",
    camera: "中景推进到产品特写",
    environment: "同一客厅",
  },
  {
    start: 8,
    end: 14,
    action: "人物看向镜头并放下耳机盒",
    dialogue: "",
    performance: "自然微笑，停顿一秒",
    camera: "近景固定",
    environment: "同一客厅",
  },
];

assert.deepStrictEqual(normalizeTimeline(timeline, 14), timeline);
assert.deepStrictEqual(
  fitTimelineDuration([{ start: 0, end: 10 }, { start: 10, end: 20 }], 15),
  [{ start: 0, end: 7.5 }, { start: 7.5, end: 15 }],
);
assert.throws(
  () => normalizeTimeline([{ ...timeline[0], start: 1 }], 2.5),
  /必须从 0 秒开始/,
);
assert.throws(
  () => normalizeTimeline([{ ...timeline[0], end: 2 }, { ...timeline[1], start: 3, end: 14 }], 14),
  /存在空档/,
);
assert.throws(
  () => normalizeTimeline([{ ...timeline[0], end: 4 }, { ...timeline[1], start: 3, end: 14 }], 14),
  /存在重叠/,
);
assert.throws(
  () => normalizeTimeline([{ ...timeline[0], end: 12 }], 14),
  /必须结束于 14 秒/,
);
assert.throws(
  () => normalizeTimeline([{ ...timeline[0], end: 0 }], 14),
  /结束时间必须大于开始时间/,
);

const legacy = legacyTimeline({
  duration: 6,
  plot: "人物抬手打招呼",
  dialogue: "你好。",
  voiceDirection: "亲切自然",
  camera: "中景缓慢推进",
  environment: "明亮摄影棚",
});
assert.deepStrictEqual(legacy, [{
  start: 0,
  end: 6,
  action: "人物抬手打招呼",
  dialogue: "你好。",
  performance: "亲切自然",
  camera: "中景缓慢推进",
  environment: "明亮摄影棚",
}]);
assert.strictEqual(
  legacyTimeline({ duration: 4, plot: "剧情摘要", videoPrompt: "包含完整运镜细节的视频提示词" })[0].action,
  "包含完整运镜细节的视频提示词",
  "legacy conversion must not discard the richer video prompt",
);

const prompt = compileTimelinePrompt(timeline, {
  duration: 14,
  voiceProfile: "年轻清亮的中文女声，普通话。",
});
assert.match(prompt, /【固定声音】\n年轻清亮的中文女声/);
assert.match(prompt, /【0～2\.5 秒】/);
assert.match(prompt, /【2\.5～8 秒】/);
assert.match(prompt, /人物台词：你们看这个。/);
assert.match(prompt, /不得添加、删减或改写台词/);

const opening = firstFramePrompt(timeline);
assert.match(opening, /人物走进客厅/);
assert.match(opening, /远景跟拍/);
assert.match(opening, /傍晚客厅/);
assert.doesNotMatch(opening, /你们看这个/);

assert.deepStrictEqual(
  Object.keys(require("../shot-timeline.cjs")).sort(),
  ["compileTimelinePrompt", "firstFramePrompt", "fitTimelineDuration", "legacyTimeline", "normalizeTimeline"],
);

console.log("shot-timeline: ok");
