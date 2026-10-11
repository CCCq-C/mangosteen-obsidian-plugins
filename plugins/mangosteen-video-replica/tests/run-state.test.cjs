const assert = require("assert");
const crypto = require("crypto");

const {
  archiveRun,
  createActiveRun,
  isRunActive,
  mergeRunState,
  normalizeGenerationError,
  requestRunStop,
  selectCurrentRun,
  updateShotState,
} = require("../run-state.cjs");

const plan = {
  confirmed: true,
  planId: "sha256:confirmed-plan",
  requestVersion: 6,
  selectedShotIds: ["008", "009"],
  shots: [
    { id: "008", title: "第一镜", effectiveVideoPrompt: "已确认提示词 008" },
    { id: "009", title: "第二镜", effectiveVideoPrompt: "已确认提示词 009" },
  ],
  character: { id: "hero" },
  products: [],
  scenes: [{ id: "room" }],
  settings: { videoModel: "MiniMax-H3" },
};

const run = createActiveRun({ runId: "run-1", plan, now: "2026-10-11T15:00:00.000Z" });
assert.strictEqual(run.status, "queued");
assert.deepStrictEqual(run.queue, ["008", "009"]);
assert.strictEqual(run.planId, plan.planId);
assert.strictEqual(run.shots["008"].confirmedPayload.title, "第一镜");
assert.strictEqual(run.shots["008"].progress, null);
assert.strictEqual(run.shots["008"].paidTaskSubmitted, false);
assert.strictEqual(isRunActive(run), true);

plan.shots[0].title = "外部对象被修改";
assert.strictEqual(run.shots["008"].confirmedPayload.title, "第一镜", "the confirmed snapshot must be immutable from caller mutations");

const processing = updateShotState(run, "008", {
  status: "video-processing",
  stage: "provider-generation",
  taskId: "task-1",
  progress: 68,
  elapsedMs: 402000,
});
assert.strictEqual(processing.activeShotId, "008");
assert.strictEqual(processing.status, "processing");
assert.strictEqual(processing.shots["008"].paidTaskSubmitted, true);
assert.strictEqual(processing.shots["008"].taskId, "task-1");
assert.strictEqual(processing.shots["008"].progress, 68);
assert.strictEqual(run.shots["008"].taskId, null, "state updates must not mutate the previous snapshot");

const unknownProgress = updateShotState(processing, "008", { progress: undefined, elapsedMs: 410000 });
assert.strictEqual(unknownProgress.shots["008"].progress, null, "unknown provider progress must remain null");

const paidWithoutTaskId = updateShotState(run, "008", {
  status: "video-submitted",
  stage: "provider-submission",
  paidTaskSubmitted: true,
});
assert.strictEqual(paidWithoutTaskId.shots["008"].paidTaskSubmitted, true, "provider acceptance alone marks the paid task as submitted");

const taskIdInResult = updateShotState(run, "008", {
  status: "completed",
  result: { taskId: "task-from-result", videoPath: "008.mp4" },
});
assert.strictEqual(taskIdInResult.shots["008"].taskId, "task-from-result");
assert.strictEqual(taskIdInResult.shots["008"].paidTaskSubmitted, true, "a recorded provider task ID must always mark paid submission");

const structuredError = normalizeGenerationError(new Error("平台查询失败"), {
  code: "PROVIDER_QUERY_FAILED",
  source: "video-plugin",
  stage: "provider-generation",
  action: "稍后继续查询原任务",
  retryable: true,
  taskId: "task-1",
  now: "2026-10-11T15:07:00.000Z",
});
assert.deepStrictEqual(structuredError, {
  code: "PROVIDER_QUERY_FAILED",
  source: "video-plugin",
  stage: "provider-generation",
  message: "平台查询失败",
  action: "稍后继续查询原任务",
  retryable: true,
  paidTaskSubmitted: true,
  at: "2026-10-11T15:07:00.000Z",
});

const failed = updateShotState(processing, "008", {
  status: "failed",
  error: structuredError,
});
assert.deepStrictEqual(failed.shots["008"].error, structuredError);
assert.strictEqual(failed.shots["008"].taskId, "task-1", "a failure must retain accepted provider recovery data");
assert.strictEqual(failed.shots["008"].paidTaskSubmitted, true);

const stopping = { ...processing, status: "stopping", stopRequested: true };
const stoppedShot = updateShotState(stopping, "008", { status: "stopped", stage: "stopped" });
assert.strictEqual(stoppedShot.shots["008"].taskId, "task-1", "stop must not erase an accepted provider task ID");
assert.strictEqual(stoppedShot.shots["008"].paidTaskSubmitted, true);

const recoverableProcessing = updateShotState(processing, "008", {
  progress: 71,
  error: structuredError,
  recoveryContext: { pollAttempt: 4, lastProviderStatus: "unknown" },
});
const monotonicStop = requestRunStop(recoverableProcessing, "2026-10-11T15:08:00.000Z");
assert.strictEqual(monotonicStop.status, "stopping");
assert.strictEqual(monotonicStop.stopRequested, true);
assert.strictEqual(monotonicStop.shots["008"].taskId, "task-1");
assert.strictEqual(monotonicStop.shots["008"].paidTaskSubmitted, true);
assert.strictEqual(monotonicStop.shots["008"].progress, 71);
assert.deepStrictEqual(monotonicStop.shots["008"].error, structuredError);
assert.deepStrictEqual(monotonicStop.shots["008"].recoveryContext, { pollAttempt: 4, lastProviderStatus: "unknown" });
assert.strictEqual(recoverableProcessing.stopRequested, false, "the monotonic stop transition must not mutate its authoritative input");
const lateProviderState = updateShotState(recoverableProcessing, "008", { now: "2026-10-11T15:18:00.000Z", progress: 72 });
const earlierPendingStop = requestRunStop(lateProviderState, "2026-10-11T15:17:00.000Z");
assert.strictEqual(earlierPendingStop.updatedAt, "2026-10-11T15:18:00.000Z", "merging an older pending stop must not regress authoritative timestamps");

const authoritativeStopped = requestRunStop(updateShotState(recoverableProcessing, "008", {
  taskId: "task-linearized",
  paidTaskSubmitted: true,
  progress: 73,
  recoveryContext: { pollAttempt: 5, lastProviderStatus: "processing" },
}), "2026-10-11T15:09:00.000Z");
authoritativeStopped.revision = 9;
const staleRunner = JSON.parse(JSON.stringify(run));
staleRunner.status = "processing";
staleRunner.shots["008"].status = "processing";
staleRunner.revision = 7;
const monotonicMerge = mergeRunState(authoritativeStopped, staleRunner, "2026-10-11T15:10:00.000Z");
assert.strictEqual(monotonicMerge.stopRequested, true, "a stale runner save must not clear a persisted stop");
assert.strictEqual(monotonicMerge.status, "stopping");
assert.strictEqual(monotonicMerge.shots["008"].taskId, "task-linearized");
assert.strictEqual(monotonicMerge.shots["008"].paidTaskSubmitted, true);
assert.strictEqual(monotonicMerge.shots["008"].progress, 73);
assert.deepStrictEqual(monotonicMerge.shots["008"].recoveryContext, { pollAttempt: 5, lastProviderStatus: "processing" });
assert.strictEqual(monotonicMerge.revision, 10, "each persisted merge must advance the authoritative revision");

const authoritativeProcessing = updateShotState(run, "008", {
  status: "video-processing",
  stage: "provider-generation",
  progress: 41,
  recoveryContext: { pollAttempt: 2 },
});
authoritativeProcessing.revision = 5;
authoritativeProcessing.activeShotId = "008";
const staleQueued = JSON.parse(JSON.stringify(run));
staleQueued.revision = 4;
staleQueued.updatedAt = "2026-10-11T14:00:00.000Z";
const mergedStaleQueued = mergeRunState(authoritativeProcessing, staleQueued, "2026-10-11T15:11:00.000Z");
assert.strictEqual(mergedStaleQueued.shots["008"].status, "video-processing", "stale queued state must not regress authoritative processing");
assert.strictEqual(mergedStaleQueued.shots["008"].progress, 41);
assert.deepStrictEqual(mergedStaleQueued.shots["008"].recoveryContext, { pollAttempt: 2 });
assert.strictEqual(mergedStaleQueued.activeShotId, "008");

const authoritativeRecovery = updateShotState(authoritativeProcessing, "008", {
  status: "recovery-pending",
  error: normalizeGenerationError(new Error("查询结果未知"), {
    code: "PROVIDER_QUERY_UNKNOWN",
    retryable: true,
    taskId: "task-recovery",
    now: "2026-10-11T15:12:00.000Z",
  }),
  taskId: "task-recovery",
  paidTaskSubmitted: true,
  progress: 44,
  recoveryContext: { pollAttempt: 3, lastProviderStatus: "unknown" },
});
authoritativeRecovery.revision = 8;
const staleTerminalFailure = updateShotState(processing, "008", {
  status: "failed",
  error: new Error("旧窗口误判失败"),
});
staleTerminalFailure.revision = 7;
const mergedStaleFailure = mergeRunState(authoritativeRecovery, staleTerminalFailure, "2026-10-11T15:13:00.000Z");
assert.strictEqual(mergedStaleFailure.shots["008"].status, "recovery-pending", "stale terminal failure must not unlock newer recovery-pending state");
assert.strictEqual(mergedStaleFailure.shots["008"].error.code, "PROVIDER_QUERY_UNKNOWN");
assert.strictEqual(mergedStaleFailure.shots["008"].progress, 44);
assert.deepStrictEqual(mergedStaleFailure.shots["008"].recoveryContext, { pollAttempt: 3, lastProviderStatus: "unknown" });

const reservedAuthoritative = updateShotState(authoritativeRecovery, "008", {
  status: "submission-reserved",
  stage: "video-submission",
  submissionReservation: {
    runId: authoritativeRecovery.runId,
    shotId: "008",
    boundary: "video-submission",
    reservationId: "reservation-stale-resolution",
    createdAt: "2026-10-11T15:14:00.000Z",
    status: "submission-reserved",
  },
  submissionUncertain: true,
});
reservedAuthoritative.revision = 10;
const staleAcceptedResolution = updateShotState(reservedAuthoritative, "008", {
  status: "video-processing",
  stage: "provider-generation",
  taskId: "task-after-pending-stop",
  paidTaskSubmitted: true,
  progress: null,
  error: null,
  recoveryContext: { boundary: "video-submission", taskId: "task-after-pending-stop" },
  submissionReservation: null,
  submissionUncertain: false,
  lastSubmissionResult: {
    reservationId: "reservation-stale-resolution",
    boundary: "video-submission",
    status: "resolved",
  },
});
staleAcceptedResolution.revision = 9;
const mergedStaleResolution = mergeRunState(reservedAuthoritative, staleAcceptedResolution, "2026-10-11T15:15:00.000Z");
assert.strictEqual(mergedStaleResolution.shots["008"].submissionReservation, null);
assert.strictEqual(mergedStaleResolution.shots["008"].taskId, "task-recovery", "an existing accepted task ID remains authoritative");
assert.strictEqual(mergedStaleResolution.shots["008"].progress, 44, "stale reservation resolution must not erase newer progress");
assert.strictEqual(mergedStaleResolution.shots["008"].error.code, "PROVIDER_QUERY_UNKNOWN", "stale reservation resolution must not erase newer error context");
assert.deepStrictEqual(mergedStaleResolution.shots["008"].recoveryContext, {
  boundary: "video-submission",
  taskId: "task-after-pending-stop",
  pollAttempt: 3,
  lastProviderStatus: "unknown",
});

assert.strictEqual(
  selectCurrentRun({ activeRun: processing, legacyState: { status: "stopped" } }).status,
  "processing",
  "the authoritative active run must override stale legacy state",
);

const legacyQueueRun = selectCurrentRun({
  legacyQueue: {
    queueId: "legacy-queue",
    planId: "sha256:legacy",
    status: "processing",
    createdAt: "2026-10-11T14:00:00.000Z",
    shots: [{ id: "008", status: "processing", result: null, error: "" }],
  },
  legacyState: { status: "stopped", requestMtimeMs: 99 },
  requestMtimeMs: 99,
});
assert.strictEqual(legacyQueueRun.runId, "legacy-queue");
assert.strictEqual(legacyQueueRun.status, "processing", "an active selected-shot queue must beat stale project-wide state");
assert.deepStrictEqual(legacyQueueRun.queue, ["008"]);

const legacyPayload = { id: "008", title: "旧队列镜头", effectiveVideoPrompt: "旧版已确认提示词" };
const legacyContext = { planId: "sha256:legacy-signed", settings: { videoModel: "MiniMax-H3" } };
const legacySignature = `sha256:${crypto.createHash("sha256").update(JSON.stringify({ shot: legacyPayload, context: legacyContext })).digest("hex")}`;
const convertedSignedLegacy = selectCurrentRun({
  legacyQueue: {
    queueId: "legacy-signed-queue",
    planId: legacyContext.planId,
    status: "idle",
    shots: [{
      ...legacyPayload,
      generationContext: legacyContext,
      confirmedPayloadSignature: legacySignature,
      status: "queued",
      error: "",
      result: null,
    }],
  },
});
assert.deepStrictEqual(convertedSignedLegacy.shots["008"].confirmedPayload, legacyPayload, "legacy runtime metadata must stay outside the immutable payload");
assert.deepStrictEqual(convertedSignedLegacy.shots["008"].generationContext, legacyContext);
assert.strictEqual(convertedSignedLegacy.shots["008"].confirmedPayloadSignature, legacySignature);

const legacyStateRun = selectCurrentRun({
  legacyQueue: { queueId: "old-terminal", status: "completed", shots: [] },
  legacyState: { status: "processing", requestMtimeMs: 100, currentStep: "镜头 002" },
  requestMtimeMs: 100,
});
assert.strictEqual(legacyStateRun.status, "processing");
assert.strictEqual(legacyStateRun.stage, "镜头 002");

const completed = updateShotState(
  updateShotState(run, "008", { status: "completed", stage: "completed" }),
  "009",
  { status: "completed", stage: "completed" },
);
assert.strictEqual(completed.status, "completed");
assert.strictEqual(isRunActive(completed), false);
const archived = archiveRun(completed, "2026-10-11T15:20:00.000Z");
assert.strictEqual(archived.activeShotId, null);
assert.strictEqual(archived.archivedAt, "2026-10-11T15:20:00.000Z");
assert.strictEqual(isRunActive(archived), false, "a terminal archive must not keep an active lock");
assert.strictEqual(Object.isFrozen(archived), true);
assert.throws(() => archiveRun(processing), /活动运行不能归档/);

console.log("run-state: ok");
