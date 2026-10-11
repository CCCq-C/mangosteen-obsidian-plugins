const assert = require("assert");

const {
  normalizeVideoOutputTarget,
  standaloneVideoPath,
} = require("../output-storage.cjs");

assert.deepStrictEqual(normalizeVideoOutputTarget({
  owner: "video-replica",
  projectId: "project-1",
  shotId: "008",
  assetType: "shot-video",
  destinationPath: "山竹视频复刻/project-1/03-分镜/008/视频.mp4",
}), {
  owner: "video-replica",
  projectId: "project-1",
  shotId: "008",
  assetType: "shot-video",
  destinationPath: "山竹视频复刻/project-1/03-分镜/008/视频.mp4",
  overwrite: "replace-current",
});

assert.strictEqual(
  standaloneVideoPath({ now: new Date("2026-10-11T07:13:02Z"), taskId: "task_efgh" }),
  "山竹创作记录/视频/2026-10/20261011-151302-task_efgh.mp4",
);

assert.strictEqual(
  standaloneVideoPath({ now: new Date("2026-10-11T07:13:02Z"), taskId: "task:abc/123!?" }),
  "山竹创作记录/视频/2026-10/20261011-151302-taskabc123.mp4",
);

assert.throws(() => normalizeVideoOutputTarget({ destinationPath: "/tmp/out.mp4" }), /输出路径不安全/);
assert.throws(() => normalizeVideoOutputTarget({ destinationPath: "项目/视频.mov" }), /\.mp4/);

for (const destinationPath of [
  "项目\\视频.mp4",
  "C:/项目/视频.mp4",
  "项目//视频.mp4",
  "项目/./视频.mp4",
  "项目/../视频.mp4",
  "项目/视\0频.mp4",
]) {
  assert.throws(
    () => normalizeVideoOutputTarget({ destinationPath }),
    /输出路径不安全/,
    `must reject unsafe path: ${JSON.stringify(destinationPath)}`,
  );
}

for (const destinationPath of ["项目/视频.MOV", "项目/视频.webm", "项目/视频"]) {
  assert.throws(
    () => normalizeVideoOutputTarget({ destinationPath }),
    /\.mp4/,
    `must reject non-mp4 extension: ${JSON.stringify(destinationPath)}`,
  );
}

console.log("output-storage: ok");
