const assert = require("assert");
const {
  CONFIRMATION_WARNING,
  appendGenerationPlan,
  confirmGenerationPlan,
  createGenerationQueue,
  lockedShotIds,
  prepareGenerationPlan,
  requestQueueStop,
  runGenerationQueue,
} = require("../generation-queue.cjs");
const { updateShotState } = require("../run-state.cjs");

assert.strictEqual(typeof appendGenerationPlan, "function", "an active queue must support appending later shot plans");

function runShots(run) {
  return run.queue.map((id) => run.shots[id]);
}

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

function timelineDraft() {
  const value = draft();
  value.version = 5;
  value.visualStyle = { category: "真人写实", prompt: "真人电影质感，自然皮肤纹理，暖色电影光影。" };
  value.shots = [{
    id: "001",
    title: "时间轴开场",
    sceneId: "room",
    productIds: ["headphones"],
    duration: 6,
    timeline: [
      { start: 0, end: 2.5, action: "女主走进客厅", dialogue: "", performance: "自然", camera: "远景跟拍", environment: "暖色客厅" },
      { start: 2.5, end: 6, action: "女主举起耳机", dialogue: "就是这款。", performance: "惊喜，句尾上扬", camera: "中景推进到特写", environment: "同一客厅" },
    ],
  }];
  return value;
}

assert.throws(() => prepareGenerationPlan(draft(), []), /至少选择一个镜头/);
assert.throws(() => prepareGenerationPlan(draft(), ["999"]), /找不到镜头.*999/);
assert.throws(() => prepareGenerationPlan(draft(), ["001", "001"]), /重复选择镜头.*001/);

const request = draft();
const plan = prepareGenerationPlan(request, ["003", "001"]);
assert.strictEqual(plan.requestVersion, 3, "the immutable plan must retain the source request schema version");
assert.strictEqual(plan.warning, CONFIRMATION_WARNING);
assert.strictEqual(CONFIRMATION_WARNING, "确认后，所选分镜在本次生成期间将无法更改。");
assert.match(plan.planId, /^sha256:[a-f0-9]{64}$/);
assert.deepStrictEqual(plan.selectedShotIds, ["001", "003"], "selected shots must follow draft order");
assert.deepStrictEqual(plan.shots.map((shot) => shot.id), ["001", "003"]);
assert.match(plan.shots[0].effectiveVideoPrompt, /你们看这是什么/);
assert.match(plan.shots[0].effectiveVideoPrompt, /年轻清亮的中文女声/);
assert.match(plan.shots[1].effectiveVideoPrompt, /用户编辑后的完整海边镜头提示词。/);
assert.match(plan.shots[1].effectiveVideoPrompt, /【项目视觉风格】/);
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

const timelinePlan = prepareGenerationPlan(timelineDraft(), ["001"]);
assert.strictEqual(timelinePlan.requestVersion, 5);
assert.deepStrictEqual(timelinePlan.visualStyle, timelineDraft().visualStyle);
assert.match(timelinePlan.shots[0].effectiveVideoPrompt, /【项目视觉风格】/);
assert.match(timelinePlan.shots[0].effectiveVideoPrompt, /【0～2\.5 秒】/);
assert.match(timelinePlan.shots[0].effectiveVideoPrompt, /人物台词：就是这款。/);
assert.strictEqual((timelinePlan.shots[0].effectiveVideoPrompt.match(/年轻清亮的中文女声/g) || []).length, 1);
const editedTimelineRequest = timelineDraft();
editedTimelineRequest.shots[0].timeline[1].action = "女主放下耳机";
assert.throws(() => confirmGenerationPlan(timelinePlan, editedTimelineRequest), /草案已变化.*重新确认/);
const editedStyleRequest = timelineDraft();
editedStyleRequest.visualStyle.prompt = "改成日系二维动画。";
assert.throws(() => confirmGenerationPlan(timelinePlan, editedStyleRequest), /草案已变化.*重新确认/);

const multiCharacterRequest = timelineDraft();
multiCharacterRequest.version = 6;
multiCharacterRequest.castConfirmed = true;
multiCharacterRequest.characters = [
  { id: "female-lead", role: "女主", prompt: "固定女主人物三视图，长发白色针织衫。", voiceProfile: "年轻女声，普通话。" },
  { id: "male-lead", role: "男主", prompt: "固定男主人物三视图，短发深色夹克。", voiceProfile: "年轻男声，普通话。" },
];
multiCharacterRequest.character = { ...multiCharacterRequest.characters[0] };
multiCharacterRequest.shots[0].characterIds = ["female-lead", "male-lead"];
const multiCharacterPlan = prepareGenerationPlan(multiCharacterRequest, ["001"]);
assert.strictEqual(multiCharacterPlan.primaryCharacterId, "female-lead");
assert.deepStrictEqual(multiCharacterPlan.characters.map((item) => item.id), ["female-lead", "male-lead"]);
assert.deepStrictEqual(multiCharacterPlan.shots[0].characterIds, ["female-lead", "male-lead"]);
assert.match(multiCharacterPlan.shots[0].effectiveVideoPrompt, /女主.*年轻女声/);
assert.match(multiCharacterPlan.shots[0].effectiveVideoPrompt, /男主.*年轻男声/);
const unconfirmedCast = { ...multiCharacterRequest, castConfirmed: false };
assert.throws(() => prepareGenerationPlan(unconfirmedCast, ["001"]), /先确认角色列表/);
const fourCharacterRequest = JSON.parse(JSON.stringify(multiCharacterRequest));
fourCharacterRequest.characters.push(
  { id: "friend-a", role: "朋友甲", prompt: "朋友甲固定形象", voiceProfile: "年轻男声" },
  { id: "friend-b", role: "朋友乙", prompt: "朋友乙固定形象", voiceProfile: "年轻女声" },
);
fourCharacterRequest.shots[0].characterIds = ["female-lead", "male-lead", "friend-a", "friend-b"];
assert.throws(() => prepareGenerationPlan(fourCharacterRequest, ["001"]), /最多支持 3 个固定角色/);

const tamperedPlan = JSON.parse(JSON.stringify(plan));
tamperedPlan.shots[0].effectiveVideoPrompt = "没有经过用户确认的替换提示词";
assert.throws(
  () => confirmGenerationPlan(tamperedPlan, draft()),
  /生成计划内容已变化.*重新预览/,
  "a serialized plan must not be alterable after preview",
);

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
  const firstOnly = confirmGenerationPlan(prepareGenerationPlan(draft(), ["001"]), draft());
  const laterOnly = confirmGenerationPlan(prepareGenerationPlan(draft(), ["003"]), draft());
  const appendQueue = createGenerationQueue(firstOnly, { now: "2026-10-11T00:00:00.000Z" });
  const appendOrder = [];
  const appendContexts = [];
  let releaseFirstShot;
  let firstShotReached;
  const firstShotGate = new Promise((resolve) => { releaseFirstShot = resolve; });
  const firstShotStarted = new Promise((resolve) => { firstShotReached = resolve; });
  const appendRun = runGenerationQueue(appendQueue, async (shot, context) => {
    appendOrder.push(shot.id);
    appendContexts.push({ id: shot.id, planId: context.planId, requestVersion: context.requestVersion, scenes: context.scenes.map((scene) => scene.id) });
    if (shot.id === "001") {
      firstShotReached();
      await firstShotGate;
    }
    return { videoPath: `${shot.id}.mp4` };
  });
  await firstShotStarted;
  appendGenerationPlan(appendQueue, laterOnly);
  assert.deepStrictEqual(lockedShotIds(appendQueue), ["001", "003"], "the running and newly queued shots must both be locked");
  assert.throws(() => appendGenerationPlan(appendQueue, laterOnly), /镜头 003.*队列/);
  releaseFirstShot();
  await appendRun;
  assert.deepStrictEqual(appendOrder, ["001", "003"], "later submissions must run after the current shot in append order");
  assert.deepStrictEqual(appendContexts, [
    { id: "001", planId: firstOnly.planId, requestVersion: 3, scenes: ["room"] },
    { id: "003", planId: laterOnly.planId, requestVersion: 3, scenes: ["harbor"] },
  ], "each appended shot must keep the exact assets and plan snapshot confirmed for that submission");

  const confirmedBatch = confirmGenerationPlan(prepareGenerationPlan(draft(), ["001", "003"]), draft());
  const tamperedConfirmed = JSON.parse(JSON.stringify(confirmedBatch));
  tamperedConfirmed.shots[0].effectiveVideoPrompt = "确认后又被替换的提示词";
  assert.throws(
    () => createGenerationQueue(tamperedConfirmed),
    /生成计划内容已变化.*重新预览/,
    "enqueue must verify a serialized confirmed plan again",
  );
  const queue = createGenerationQueue(confirmedBatch, { now: "2026-10-11T00:00:00.000Z" });
  assert.strictEqual(queue.status, "queued");
  assert.deepStrictEqual(queue.queue, ["001", "003"]);
  assert.deepStrictEqual(runShots(queue).map((shot) => shot.status), ["queued", "queued"]);
  assert.strictEqual(queue.shots["001"].confirmedPayload.effectiveVideoPrompt, confirmedBatch.shots[0].effectiveVideoPrompt);
  assert.deepStrictEqual(lockedShotIds(queue), ["001", "003"]);
  assert.strictEqual(lockedShotIds(queue).includes("002"), false, "unselected shots must remain editable");
  assert.throws(
    () => createGenerationQueue(
      confirmGenerationPlan(prepareGenerationPlan(draft(), ["001"]), draft()),
      { activeQueues: [queue] },
    ),
    /镜头 001.*已经在生成队列/,
  );

  const tamperedQueue = createGenerationQueue(confirmedBatch, { now: "2026-10-11T00:00:01.000Z" });
  tamperedQueue.shots["001"].confirmedPayload.effectiveVideoPrompt = "持久化后被替换的未确认提示词";
  let tamperedPaidCalls = 0;
  await runGenerationQueue(tamperedQueue, async () => {
    tamperedPaidCalls += 1;
    return { videoPath: "should-not-run.mp4" };
  });
  assert.strictEqual(tamperedPaidCalls, 1, "only the untouched later shot may reach the paid runner");
  assert.strictEqual(tamperedQueue.shots["001"].status, "failed");
  assert.match(tamperedQueue.shots["001"].error.message, /队列内容已变化.*不会提交付费任务/);

  const unsignedQueue = createGenerationQueue(confirmedBatch, { now: "2026-10-11T00:00:02.000Z" });
  delete unsignedQueue.shots["001"].confirmedPayloadSignature;
  let unsignedPaidCalls = 0;
  await runGenerationQueue(unsignedQueue, async () => {
    unsignedPaidCalls += 1;
    return { videoPath: "should-not-run.mp4" };
  });
  assert.strictEqual(unsignedPaidCalls, 1, "an unsigned shot must fail before paid submission while later signed shots may continue");
  assert.strictEqual(unsignedQueue.shots["001"].status, "failed");
  assert.match(unsignedQueue.shots["001"].error.message, /缺少确认签名.*不会提交付费任务/);

  const callOrder = [];
  const finished = await runGenerationQueue(queue, async (shot, context) => {
    callOrder.push(shot.id);
    assert.strictEqual(context.planId, confirmedBatch.planId);
    assert.strictEqual(shot.effectiveVideoPrompt, confirmedBatch.shots.find((item) => item.id === shot.id).effectiveVideoPrompt);
    return { videoPath: `03-视频片段/${shot.id}.mp4` };
  });
  assert.deepStrictEqual(callOrder, ["001", "003"]);
  assert.strictEqual(finished.status, "completed");
  assert.deepStrictEqual(runShots(finished).map((shot) => shot.status), ["completed", "completed"]);
  assert.deepStrictEqual(runShots(finished).map((shot) => shot.result.videoPath), ["03-视频片段/001.mp4", "03-视频片段/003.mp4"]);
  assert.deepStrictEqual(lockedShotIds(finished), [], "terminal shots must become editable again");

  const failureQueue = createGenerationQueue(confirmedBatch);
  const failureOrder = [];
  await runGenerationQueue(failureQueue, async (shot) => {
    failureOrder.push(shot.id);
    if (shot.id === "001") throw new Error("供应商任务失败");
    return { videoPath: `${shot.id}.mp4` };
  });
  assert.deepStrictEqual(failureOrder, ["001", "003"], "one shot failure must not block later selected shots");
  assert.strictEqual(failureQueue.status, "partial-failure");
  assert.strictEqual(failureQueue.shots["001"].status, "failed");
  assert.match(failureQueue.shots["001"].error.message, /供应商任务失败/);
  assert.strictEqual(failureQueue.shots["003"].status, "completed");
  assert.deepStrictEqual(lockedShotIds(failureQueue), []);

  const stopQueue = createGenerationQueue(confirmedBatch);
  const stopOrder = [];
  await runGenerationQueue(stopQueue, async (shot) => {
    stopOrder.push(shot.id);
    requestQueueStop(stopQueue);
    return { videoPath: `${shot.id}.mp4` };
  });
  assert.deepStrictEqual(stopOrder, ["001"], "stop request must prevent the next paid task from being submitted");
  assert.strictEqual(stopQueue.shots["001"].status, "completed", "already submitted current shot may complete");
  assert.strictEqual(stopQueue.shots["003"].status, "stopped");
  assert.strictEqual(stopQueue.status, "stopped");
  assert.deepStrictEqual(lockedShotIds(stopQueue), []);

  const acceptedTaskQueue = createGenerationQueue(firstOnly, { now: "2026-10-11T00:00:03.000Z" });
  await assert.rejects(
    runGenerationQueue(acceptedTaskQueue, async (_shot, context) => {
      await context.updateState({
        status: "video-processing",
        stage: "provider-generation",
        taskId: "provider-task-1",
        progress: null,
        elapsedMs: 5000,
      });
      throw Object.assign(new Error("查询暂时失败"), { code: "PROVIDER_QUERY_FAILED", retryable: true });
    }),
    /查询暂时失败/,
    "an uncertain query error must leave the accepted task available for safe recovery",
  );
  assert.strictEqual(acceptedTaskQueue.shots["001"].taskId, "provider-task-1");
  assert.strictEqual(acceptedTaskQueue.shots["001"].paidTaskSubmitted, true);
  assert.strictEqual(acceptedTaskQueue.shots["001"].progress, null, "queue state must not fabricate provider progress");
  assert.strictEqual(acceptedTaskQueue.shots["001"].error.code, "PROVIDER_QUERY_FAILED");
  assert.strictEqual(acceptedTaskQueue.shots["001"].error.paidTaskSubmitted, true);
  assert.strictEqual(acceptedTaskQueue.shots["001"].status, "recovery-pending");
  assert.deepStrictEqual(lockedShotIds(acceptedTaskQueue), ["001"], "an accepted task with uncertain status must remain locked");
  assert.throws(
    () => createGenerationQueue(firstOnly, { activeQueues: [acceptedTaskQueue] }),
    /镜头 001.*已经在生成队列/,
    "an uncertain accepted task must reject a second paid queue",
  );

  const terminalTaskQueue = createGenerationQueue(firstOnly, { now: "2026-10-11T00:00:03.500Z" });
  await runGenerationQueue(terminalTaskQueue, async (_shot, context) => {
    await context.updateState({
      status: "video-processing",
      stage: "provider-generation",
      taskId: "provider-task-terminal",
    });
    throw Object.assign(new Error("平台已确认任务失败"), {
      code: "VIDEO_TASK_FAILED",
      terminalTaskFailure: true,
    });
  });
  assert.strictEqual(terminalTaskQueue.shots["001"].status, "failed");
  assert.deepStrictEqual(lockedShotIds(terminalTaskQueue), [], "only an explicit terminal provider failure may unlock the shot");

  const stoppedBeforePaidQueue = createGenerationQueue(firstOnly, { now: "2026-10-11T00:00:04.000Z" });
  let paidAfterStop = 0;
  await runGenerationQueue(stoppedBeforePaidQueue, async (_shot, context) => {
    requestQueueStop(stoppedBeforePaidQueue);
    await context.assertPaidSubmissionAllowed();
    paidAfterStop += 1;
    return { videoPath: "must-not-run.mp4" };
  });
  assert.strictEqual(paidAfterStop, 0, "stop must block a paid submission that has not been accepted yet");
  assert.strictEqual(stoppedBeforePaidQueue.shots["001"].status, "stopped");
  assert.strictEqual(stoppedBeforePaidQueue.shots["001"].paidTaskSubmitted, false);
  assert.strictEqual(stoppedBeforePaidQueue.status, "stopped");

  const persistedStopQueue = createGenerationQueue(firstOnly, { now: "2026-10-11T00:00:05.000Z" });
  const persistedState = { stopRequested: false };
  let paidAfterPersistedStop = 0;
  await runGenerationQueue(persistedStopQueue, async (_shot, context) => {
    await context.updateState({ status: "video-submitting", stage: "provider-submission" });
    persistedState.stopRequested = true;
    await context.assertPaidSubmissionAllowed();
    paidAfterPersistedStop += 1;
    return { videoPath: "must-not-run-after-persisted-stop.mp4" };
  }, {
    isStopRequested: async () => {
      await Promise.resolve();
      return persistedState.stopRequested;
    },
  });
  assert.strictEqual(paidAfterPersistedStop, 0, "the paid boundary must await the authoritative persisted stop check");
  assert.strictEqual(persistedStopQueue.stopRequested, true);
  assert.strictEqual(persistedStopQueue.shots["001"].status, "stopped");

  const sharedGateQueue = createGenerationQueue(firstOnly, { now: "2026-10-11T00:00:06.000Z" });
  sharedGateQueue.revision = 12;
  const gateIdentities = [];
  let gatedPaidCalls = 0;
  await runGenerationQueue(sharedGateQueue, async (_shot, context) => {
    return context.withPaidSubmissionGate({ kind: "video-submission" }, async () => {
      gatedPaidCalls += 1;
      return { videoPath: "shared-gate.mp4" };
    });
  }, {
    withPaidSubmissionGate: async (identity, operation) => {
      gateIdentities.push(identity);
      return operation();
    },
  });
  assert.strictEqual(gatedPaidCalls, 1);
  assert.deepStrictEqual(gateIdentities.map(({ runId, revision, shotId, boundary }) => ({ runId, revision, shotId, boundary })), [{
    runId: sharedGateQueue.runId,
    revision: 12,
    shotId: "001",
    boundary: "video-submission",
  }], "the queue must pass current run identity and revision into the shared paid-submission gate");

  const reservationQueue = createGenerationQueue(firstOnly, { now: "2026-10-12T00:00:07.000Z" });
  reservationQueue.revision = 20;
  const reservationStates = [];
  await runGenerationQueue(reservationQueue, async (_shot, context) => context.withPaidSubmissionGate(
    { kind: "video-submission" },
    async ({ reservation, accept, resolve }) => {
      assert.strictEqual(reservation.status, "submission-reserved");
      assert.strictEqual(reservation.boundary, "video-submission");
      assert.strictEqual(reservation.shotId, "001");
      assert.strictEqual(reservationQueue.shots["001"].submissionUncertain, true, "reservation must be visible before provider entry");
      await accept({
        status: "submission-reserved",
        stage: "video-submission",
        taskId: "reserved-task",
        paidTaskSubmitted: true,
      });
      assert.strictEqual(reservationQueue.shots["001"].submissionReservation.reservationId, "reservation-1");
      assert.strictEqual(reservationQueue.shots["001"].paidTaskSubmitted, true, "accepted provider work must be durable before result handoff");
      await resolve({
        status: "video-processing",
        stage: "provider-generation",
        taskId: "reserved-task",
        paidTaskSubmitted: true,
      });
      return { videoPath: "reserved.mp4", taskId: "reserved-task" };
    },
  ), {
    onUpdate: async (state) => { reservationStates.push(state); },
    withPaidSubmissionGate: async (identity, operation) => {
      const reservation = {
        runId: identity.runId,
        shotId: identity.shotId,
        boundary: identity.boundary,
        reservationId: "reservation-1",
        createdAt: "2026-10-12T00:00:08.000Z",
        status: "submission-reserved",
        previousStatus: reservationQueue.shots[identity.shotId].status,
        previousStage: reservationQueue.shots[identity.shotId].stage,
      };
      const reserved = updateShotState(reservationQueue, identity.shotId, {
        status: "submission-reserved",
        stage: identity.boundary,
        submissionReservation: reservation,
        submissionUncertain: true,
      });
      reserved.revision = identity.revision + 1;
      return operation(reserved, reservation);
    },
  });
  assert.strictEqual(reservationQueue.shots["001"].submissionReservation, null);
  assert.strictEqual(reservationQueue.shots["001"].lastSubmissionResult.reservationId, "reservation-1");
  assert.strictEqual(reservationQueue.shots["001"].paidTaskSubmitted, true);

  const crashedReservationQueue = createGenerationQueue(firstOnly, { now: "2026-10-12T00:00:09.000Z" });
  crashedReservationQueue.revision = 30;
  let crashedProviderCalls = 0;
  await assert.rejects(
    runGenerationQueue(crashedReservationQueue, async (_shot, context) => context.withPaidSubmissionGate(
      { kind: "first-frame" },
      async () => {
        crashedProviderCalls += 1;
        throw Object.assign(new Error("模拟 provider 已接受后进程中断"), { code: "PROVIDER_TIMEOUT" });
      },
    ), {
      withPaidSubmissionGate: async (identity, operation) => {
        const reservation = {
          runId: identity.runId,
          shotId: identity.shotId,
          boundary: identity.boundary,
          reservationId: "reservation-crash",
          createdAt: "2026-10-12T00:00:10.000Z",
          status: "submission-reserved",
          previousStatus: crashedReservationQueue.shots[identity.shotId].status,
          previousStage: crashedReservationQueue.shots[identity.shotId].stage,
        };
        const reserved = updateShotState(crashedReservationQueue, identity.shotId, {
          status: "submission-reserved",
          stage: identity.boundary,
          submissionReservation: reservation,
          submissionUncertain: true,
        });
        reserved.revision = identity.revision + 1;
        return operation(reserved, reservation);
      },
    }),
    /模拟 provider 已接受后进程中断/,
  );
  assert.strictEqual(crashedProviderCalls, 1);
  assert.strictEqual(crashedReservationQueue.shots["001"].status, "recovery-pending");
  assert.strictEqual(crashedReservationQueue.shots["001"].submissionReservation.reservationId, "reservation-crash");
  assert.strictEqual(crashedReservationQueue.shots["001"].error.code, "UNSAFE_PAID_SUBMISSION_RECOVERY");
  assert.deepStrictEqual(lockedShotIds(crashedReservationQueue), ["001"]);

  const gateStoppedQueue = createGenerationQueue(firstOnly, { now: "2026-10-12T00:00:11.000Z" });
  let stoppedGateCalls = 0;
  await runGenerationQueue(gateStoppedQueue, async (_shot, context) => context.withPaidSubmissionGate(
    { kind: "reference-asset" },
    async () => { stoppedGateCalls += 1; },
  ), {
    withPaidSubmissionGate: async () => {
      const stopped = new Error("另一个窗口已持久化停止");
      stopped.code = "GENERATION_STOPPED";
      throw stopped;
    },
  });
  assert.strictEqual(stoppedGateCalls, 0);
  assert.strictEqual(gateStoppedQueue.stopRequested, true, "gate stop must request the local monotonic stop transition");
  assert.strictEqual(gateStoppedQueue.shots["001"].status, "stopped", "stop-first must not be recorded as failed");

  console.log("generation-queue: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
