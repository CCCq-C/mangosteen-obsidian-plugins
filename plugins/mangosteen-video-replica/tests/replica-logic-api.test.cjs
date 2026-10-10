const assert = require("assert");
const { createReplicaLogicApi } = require("../replica-logic-api.cjs");

const request = {
  version: 3,
  confirmed: false,
  character: { id: "hero", prompt: "固定人物三视图和服装，保持脸部与发型一致。", voiceProfile: "年轻清亮中文女声。" },
  products: [],
  scenes: [{ id: "room", prompt: "暖色客厅，米白沙发和木质茶几，傍晚自然光。" }],
  settings: { imageModel: "gpt-image-2-w", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
  shots: [
    { id: "001", title: "第一镜", sceneId: "room", productIds: [], duration: 4, dialogue: "第一句", voiceDirection: "自然", imagePrompt: "人物站在客厅。", videoPrompt: "人物抬手。" },
    { id: "002", title: "第二镜", sceneId: "room", productIds: [], duration: 4, dialogue: "第二句", voiceDirection: "开心", imagePrompt: "人物坐在沙发。", videoPrompt: "人物坐下。" },
  ],
};

(async () => {
  const persisted = [];
  const submitted = [];
  const api = createReplicaLogicApi({
    saveQueue: async (queue) => { persisted.push(JSON.parse(JSON.stringify(queue))); },
    runShot: async (shot) => {
      submitted.push({ id: shot.id, prompt: shot.effectiveVideoPrompt });
      return { videoPath: `${shot.id}.mp4` };
    },
  });

  assert.deepStrictEqual(
    Object.keys(api).sort(),
    ["confirm", "enqueue", "isLocked", "lockedShotIds", "preview", "run", "stop"],
  );
  const plan = api.preview(request, ["002"]);
  assert.deepStrictEqual(plan.selectedShotIds, ["002"]);
  assert.match(plan.shots[0].effectiveVideoPrompt, /第二句/);
  const confirmed = api.confirm(plan, request);
  const queue = await api.enqueue(confirmed);
  assert.strictEqual(api.isLocked(queue, "002"), true);
  assert.strictEqual(api.isLocked(queue, "001"), false);
  assert.deepStrictEqual(api.lockedShotIds(queue), ["002"]);
  assert.strictEqual(persisted.length, 1, "enqueue must be persisted before paid work can start");

  await api.run(queue);
  assert.deepStrictEqual(submitted.map((item) => item.id), ["002"]);
  assert.match(submitted[0].prompt, /第二句/);
  assert.strictEqual(queue.status, "completed");
  assert.strictEqual(api.isLocked(queue, "002"), false);
  assert(persisted.some((item) => item.shots[0].status === "processing"));
  assert.strictEqual(persisted.at(-1).status, "completed");

  const stoppedQueue = await api.enqueue(api.confirm(api.preview(request, ["001"]), request));
  await api.stop(stoppedQueue);
  assert.strictEqual(stoppedQueue.status, "stopped");
  assert.strictEqual(api.isLocked(stoppedQueue, "001"), false);
  assert.strictEqual(persisted.at(-1).status, "stopped");

  console.log("replica-logic-api: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
