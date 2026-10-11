const {
  appendGenerationPlan,
  confirmGenerationPlan,
  createGenerationQueue,
  lockedShotIds,
  prepareGenerationPlan,
  requestQueueStop,
  runGenerationQueue,
} = require("./generation-queue.cjs");

function createReplicaLogicApi({ activeQueues = [], saveQueue = async () => {}, saveStop = null, runShot = null, isStopRequested = null } = {}) {
  if (typeof saveQueue !== "function") throw new Error("saveQueue 必须是函数。");
  if (!Array.isArray(activeQueues)) throw new Error("activeQueues 必须是数组。");
  const knownQueues = [...activeQueues];

  return {
    preview(request, selectedShotIds) {
      return prepareGenerationPlan(request, selectedShotIds);
    },

    confirm(plan, currentRequest) {
      return confirmGenerationPlan(plan, currentRequest);
    },

    async enqueue(confirmedPlan, options = {}) {
      const suppliedQueues = Array.isArray(options.activeQueues) ? options.activeQueues : [];
      const queue = createGenerationQueue(confirmedPlan, {
        ...options,
        activeQueues: [...knownQueues, ...suppliedQueues],
      });
      knownQueues.push(queue);
      try {
        await saveQueue(queue);
      } catch (error) {
        const index = knownQueues.indexOf(queue);
        if (index >= 0) knownQueues.splice(index, 1);
        throw error;
      }
      return queue;
    },

    async append(queue, confirmedPlan) {
      const snapshot = JSON.parse(JSON.stringify(queue));
      appendGenerationPlan(queue, confirmedPlan);
      try {
        await saveQueue(queue);
      } catch (error) {
        for (const key of Object.keys(queue)) delete queue[key];
        Object.assign(queue, snapshot);
        throw error;
      }
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
      const saved = typeof saveStop === "function"
        ? await saveStop(queue)
        : await saveQueue(queue);
      if (saved && saved !== queue && typeof saved === "object") {
        for (const key of Object.keys(queue)) delete queue[key];
        Object.assign(queue, saved);
      }
      return queue;
    },

    async run(queue, runner = runShot) {
      if (typeof runner !== "function") throw new Error("缺少单镜头运行器。");
      return runGenerationQueue(queue, runner, { onUpdate: saveQueue, isStopRequested });
    },
  };
}

module.exports = { createReplicaLogicApi };
