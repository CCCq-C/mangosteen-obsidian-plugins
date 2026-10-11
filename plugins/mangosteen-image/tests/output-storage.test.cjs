const assert = require("assert");

const {
  normalizeImageOutputTarget,
  standaloneImagePath,
} = require("../output-storage.cjs");

assert.deepStrictEqual(normalizeImageOutputTarget({
  owner: "video-replica",
  projectId: "project-1",
  shotId: "008",
  assetType: "first-frame",
  destinationPath: "山竹视频复刻/project-1/03-分镜/008/首帧.png",
}), {
  owner: "video-replica",
  projectId: "project-1",
  shotId: "008",
  assetType: "first-frame",
  destinationPath: "山竹视频复刻/project-1/03-分镜/008/首帧.png",
  overwrite: "replace-current",
});

assert.strictEqual(
  standaloneImagePath({ now: new Date("2026-10-11T07:00:51Z"), taskId: "task_abcd", index: 1, extension: "png" }),
  "山竹创作记录/图片/2026-10/20261011-150051-task_abcd-01.png",
);

assert.strictEqual(
  standaloneImagePath({ now: new Date("2026-10-11T07:00:51Z"), taskId: "task:abc/123!?", index: 2, extension: ".JPEG" }),
  "山竹创作记录/图片/2026-10/20261011-150051-taskabc123-02.jpeg",
);

assert.ok(
  standaloneImagePath({ now: new Date("2026-10-11T07:00:51Z"), taskId: "a".repeat(80), index: 1, extension: "png" })
    .includes(`${"a".repeat(64)}-01.png`),
  "task ID must be limited to 64 safe characters",
);

assert.throws(() => normalizeImageOutputTarget({ destinationPath: "../outside.png" }), /输出路径不安全/);
assert.throws(() => normalizeImageOutputTarget({ destinationPath: "项目/视频.mp4" }), /图片扩展名/);

for (const destinationPath of [
  "项目\\图片.png",
  "/项目/图片.png",
  "C:/项目/图片.png",
  "项目//图片.png",
  "项目/./图片.png",
  "项目/../图片.png",
  "项目/图\0片.png",
]) {
  assert.throws(
    () => normalizeImageOutputTarget({ destinationPath }),
    /输出路径不安全/,
    `must reject unsafe path: ${JSON.stringify(destinationPath)}`,
  );
}

for (const destinationPath of ["项目/图片.gif", "项目/图片.svg", "项目/图片"]) {
  assert.throws(
    () => normalizeImageOutputTarget({ destinationPath }),
    /图片扩展名/,
    `must reject non-image extension: ${JSON.stringify(destinationPath)}`,
  );
}

console.log("output-storage: ok");
