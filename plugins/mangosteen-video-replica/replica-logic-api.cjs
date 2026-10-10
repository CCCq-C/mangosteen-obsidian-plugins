const {
  confirmGenerationPlan,
  createGenerationQueue,
  lockedShotIds,
  prepareGenerationPlan,
  requestQueueStop,
  runGenerationQueue,
} = require("./generation-queue.cjs");

function createReplicaLogicApi({ saveQueue = async () => {}, runShot = null } = {}) {
  if (typeof saveQueue !== "function") throw new Error("saveQueue 必须是函数。");

  return {
    preview(request, selectedShotIds) {
      return prepareGenerationPlan(request, selectedShotIds);
    },

    confirm(plan, currentRequest) {
      return confirmGenerationPlan(plan, currentRequest);
    },

    async enqueue(confirmedPlan, options = {}) {
      const queue = createGenerationQueue(confirmedPlan, options);
      await saveQueue(queue);
      return queue;
    },

    lockedShotIds(queue) {
      return lockedShotIds(queue);
    },

    isLocked(queue, shotId) {
      return lockedShotIds(queue).includes(String(shotId));
    },

    async stop(queue) {
      requestQueueStop(queue);
      await saveQueue(queue);
      return queue;
    },

    async run(queue, runner = runShot) {
      if (typeof runner !== "function") throw new Error("缺少单镜头运行器。");
      return runGenerationQueue(queue, runner, { onUpdate: saveQueue });
    },
  };
}

module.exports = { createReplicaLogicApi };
