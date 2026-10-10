const COLLECTIONS = {
  product: { key: "products", fields: new Set(["prompt"]) },
  scene: { key: "scenes", fields: new Set(["prompt"]) },
  shot: {
    key: "shots",
    fields: new Set([
      "title",
      "duration",
      "sceneId",
      "productIds",
      "dialogue",
      "voiceDirection",
      "plot",
      "environment",
      "camera",
      "imagePrompt",
      "lastImagePrompt",
      "videoPrompt",
    ]),
  },
};

const DIRECT_FIELDS = {
  character: new Set(["prompt", "voiceProfile"]),
  settings: new Set(["imageModel", "videoModel", "ratio", "resolution"]),
};

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  const output = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  for (const key of Object.keys(value)) {
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: clone(value[key]),
      writable: true,
    });
  }
  return output;
}

function unsupportedEdit() {
  throw new Error("不支持编辑此草案字段。");
}

function isDraftLocked(request, generationState) {
  return request?.confirmed === true || generationState?.status === "processing";
}

function updateDraftField(request, target, value) {
  if (!request || typeof request !== "object" || Array.isArray(request)
      || !target || typeof target !== "object" || Array.isArray(target)) unsupportedEdit();

  const next = clone(request);
  const directFields = Object.prototype.hasOwnProperty.call(DIRECT_FIELDS, target.section)
    ? DIRECT_FIELDS[target.section]
    : null;
  if (directFields) {
    if (target.index !== undefined || !directFields.has(target.field)
        || !next[target.section] || typeof next[target.section] !== "object") unsupportedEdit();
    next[target.section][target.field] = clone(value);
    return next;
  }

  const collection = Object.prototype.hasOwnProperty.call(COLLECTIONS, target.section)
    ? COLLECTIONS[target.section]
    : null;
  if (!collection || !collection.fields.has(target.field)
      || !Number.isInteger(target.index) || target.index < 0
      || !Array.isArray(next[collection.key]) || target.index >= next[collection.key].length
      || !next[collection.key][target.index] || typeof next[collection.key][target.index] !== "object") {
    unsupportedEdit();
  }
  next[collection.key][target.index][target.field] = clone(value);
  return next;
}

function moveShot(request, shotIndex, direction) {
  const next = clone(request);
  if (!next || typeof next !== "object" || !Array.isArray(next.shots)) return next;
  if (direction !== "up" && direction !== "down") throw new Error("不支持移动分镜。");
  const targetIndex = shotIndex + (direction === "up" ? -1 : 1);
  if (!Number.isInteger(shotIndex) || shotIndex < 0 || shotIndex >= next.shots.length
      || targetIndex < 0 || targetIndex >= next.shots.length) return next;
  [next.shots[shotIndex], next.shots[targetIndex]] = [next.shots[targetIndex], next.shots[shotIndex]];
  next.shots = next.shots.map((shot, index) => ({ ...shot, id: String(index + 1).padStart(3, "0") }));
  return next;
}

function validateDraft(request, normalizeGenerationRequest) {
  try {
    const value = normalizeGenerationRequest({ ...clone(request), confirmed: true });
    return { ok: true, value: { ...value, confirmed: false }, errors: [] };
  } catch (error) {
    return {
      ok: false,
      value: null,
      errors: [{ path: String(error?.path || "request"), message: String(error?.message || error) }],
    };
  }
}

module.exports = {
  isDraftLocked,
  moveShot,
  updateDraftField,
  validateDraft,
};
