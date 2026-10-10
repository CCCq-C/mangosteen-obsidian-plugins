const assert = require("assert");
const {
  CONFIRMATION_WARNING,
  confirmGenerationPlan,
  createGenerationQueue,
  lockedShotIds,
  prepareGenerationPlan,
  requestQueueStop,
  runGenerationQueue,
} = require("../generation-queue.cjs");

function draft() {
  return {
    version: 3,
    confirmed: false,
    character: {
      id: "hero",
      prompt: "固定人物三视图，短黑发、白色夹克，保持五官和服装一致。",
      voiceProfile: "年轻清亮的中文女声，普通话，声音有亲和力。",
    },
    products: [{ id: "headphones", prompt: "白色头戴式耳机与包装盒，外形、比例和标识固定。" }],
    scenes: [
      { id: "room", prompt: "温暖客厅，米白色沙发和木质茶几，傍晚自然光。" },
      { id: "harbor", prompt: "海边集装箱码头，左侧蓝色集装箱，右侧海面。" },
    ],
    settings: { imageModel: "gpt-image-2-w", videoModel: "MiniMax-H3", ratio: "9:16", resolution: "768p" },
    shots: [
      {
        id: "001", title: "开场", sceneId: "room", productIds: ["headphones"], duration: 4,
        dialogue: "你们看这是什么？", voiceDirection: "惊喜，句尾上扬。",
        plot: "女主举起耳机盒", environment: "客厅", camera: "中近景推进",
        imagePrompt: "女主在客厅举起白色耳机盒。", lastImagePrompt: "", videoPrompt: "女主举起耳机盒，镜头推进。",
      },
      {
        id: "002", title: "过场", sceneId: "room", productIds: [], duration: 4,
        dialogue: "", voiceDirection: "", plot: "客厅空镜", environment: "客厅", camera: "固定镜头",
        imagePrompt: "傍晚客厅空镜。", lastImagePrompt: "", videoPrompt: "窗帘轻轻摆动。",
      },
      {
        id: "003", title: "海边", sceneId: "harbor", productIds: [], duration: 5,
        dialogue: "自动台词不应出现", voiceDirection: "自动语气",
        plot: "女主走向海边", environment: "码头", camera: "跟拍",
        imagePrompt: "女主站在集装箱前。", lastImagePrompt: "女主走到海边。", videoPrompt: "自动视觉描述。",
        videoPromptOverride: "用户编辑后的完整海边镜头提示词。",
      },
    ],
  };
}

assert.throws(() => prepareGenerationPlan(draft(), []), /至少选择一个镜头/);
assert.throws(() => prepareGenerationPlan(draft(), ["999"]), /找不到镜头.*999/);
assert.throws(() => prepareGenerationPlan(draft(), ["001", "001"]), /重复选择镜头.*001/);

const request = draft();
const plan = prepareGenerationPlan(request, ["003", "001"]);
assert.strictEqual(plan.warning, CONFIRMATION_WARNING);
assert.strictEqual(CONFIRMATION_WARNING, "点击生成后，所选镜头的提示词将无法修改，请确认生成。");
assert.match(plan.planId, /^sha256:[a-f0-9]{64}$/);
assert.deepStrictEqual(plan.selectedShotIds, ["001", "003"], "selected shots must follow draft order");
assert.deepStrictEqual(plan.shots.map((shot) => shot.id), ["001", "003"]);
assert.match(plan.shots[0].effectiveVideoPrompt, /你们看这是什么/);
assert.match(plan.shots[0].effectiveVideoPrompt, /年轻清亮的中文女声/);
assert.strictEqual(plan.shots[1].effectiveVideoPrompt, "用户编辑后的完整海边镜头提示词。");
assert.deepStrictEqual(plan.scenes.map((scene) => scene.id), ["room", "harbor"]);
assert.deepStrictEqual(plan.products.map((product) => product.id), ["headphones"]);
assert.strictEqual(Object.isFrozen(plan), true);
assert.strictEqual(Object.isFrozen(plan.shots), true);
assert.strictEqual(Object.isFrozen(plan.shots[0]), true);

request.shots[0].videoPrompt = "外部对象后来被修改";
assert.doesNotMatch(plan.shots[0].effectiveVideoPrompt, /外部对象后来被修改/);
assert.strictEqual(
  prepareGenerationPlan(draft(), ["001", "003"]).planId,
  prepareGenerationPlan(draft(), ["003", "001"]).planId,
  "selection click order must not change a draft-ordered plan",
);

const confirmed = confirmGenerationPlan(plan, draft());
assert.strictEqual(confirmed.confirmed, true);
assert.strictEqual(confirmed.planId, plan.planId);
assert.strictEqual(Object.isFrozen(confirmed), true);

const unselectedChanged = draft();
unselectedChanged.shots[1].videoPrompt = "未选镜头仍可编辑";
assert.strictEqual(confirmGenerationPlan(plan, unselectedChanged).confirmed, true);

for (const changed of [
  (() => { const value = draft(); value.shots[0].dialogue = "修改后的选中镜头台词"; return value; })(),
  (() => { const value = draft(); value.character.voiceProfile = "修改后的声音设定"; return value; })(),
  (() => { const value = draft(); value.settings.videoModel = "seedance-2.5"; return value; })(),
  (() => { const value = draft(); value.scenes[0].prompt = "修改后的客厅"; return value; })(),
]) {
  assert.throws(() => confirmGenerationPlan(plan, changed), /草案已变化.*重新确认/);
}

(async () => {
  const confirmedBatch = confirmGenerationPlan(prepareGenerationPlan(draft(), ["001", "003"]), draft());
  const queue = createGenerationQueue(confirmedBatch, { now: "2026-10-11T00:00:00.000Z" });
  assert.strictEqual(queue.status, "idle");
  assert.deepStrictEqual(queue.shots.map((shot) => shot.status), ["queued", "queued"]);
  assert.deepStrictEqual(lockedShotIds(queue), ["001", "003"]);
  assert.strictEqual(lockedShotIds(queue).includes("002"), false, "unselected shots must remain editable");
  assert.throws(
    () => createGenerationQueue(
      confirmGenerationPlan(prepareGenerationPlan(draft(), ["001"]), draft()),
      { activeQueues: [queue] },
    ),
    /镜头 001.*已经在生成队列/,
  );

  const callOrder = [];
  const finished = await runGenerationQueue(queue, async (shot, context) => {
    callOrder.push(shot.id);
    assert.strictEqual(context.planId, confirmedBatch.planId);
    assert.strictEqual(shot.effectiveVideoPrompt, confirmedBatch.shots.find((item) => item.id === shot.id).effectiveVideoPrompt);
    return { videoPath: `03-视频片段/${shot.id}.mp4` };
  });
  assert.deepStrictEqual(callOrder, ["001", "003"]);
  assert.strictEqual(finished.status, "completed");
  assert.deepStrictEqual(finished.shots.map((shot) => shot.status), ["completed", "completed"]);
  assert.deepStrictEqual(finished.shots.map((shot) => shot.result.videoPath), ["03-视频片段/001.mp4", "03-视频片段/003.mp4"]);
  assert.deepStrictEqual(lockedShotIds(finished), [], "terminal shots must become editable again");

  const failureQueue = createGenerationQueue(confirmedBatch);
  const failureOrder = [];
  await runGenerationQueue(failureQueue, async (shot) => {
    failureOrder.push(shot.id);
    if (shot.id === "001") throw new Error("供应商任务失败");
    return { videoPath: `${shot.id}.mp4` };
  });
  assert.deepStrictEqual(failureOrder, ["001", "003"], "one shot failure must not block later selected shots");
  assert.strictEqual(failureQueue.status, "completed_with_errors");
  assert.strictEqual(failureQueue.shots[0].status, "failed");
  assert.match(failureQueue.shots[0].error, /供应商任务失败/);
  assert.strictEqual(failureQueue.shots[1].status, "completed");
  assert.deepStrictEqual(lockedShotIds(failureQueue), []);

  const stopQueue = createGenerationQueue(confirmedBatch);
  const stopOrder = [];
  await runGenerationQueue(stopQueue, async (shot) => {
    stopOrder.push(shot.id);
    requestQueueStop(stopQueue);
    return { videoPath: `${shot.id}.mp4` };
  });
  assert.deepStrictEqual(stopOrder, ["001"], "stop request must prevent the next paid task from being submitted");
  assert.strictEqual(stopQueue.shots[0].status, "completed", "already submitted current shot may complete");
  assert.strictEqual(stopQueue.shots[1].status, "stopped");
  assert.strictEqual(stopQueue.status, "stopped");
  assert.deepStrictEqual(lockedShotIds(stopQueue), []);

  console.log("generation-queue: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
