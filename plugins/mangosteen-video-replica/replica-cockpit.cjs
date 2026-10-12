function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numericProgress(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function statusLabel(status) {
  return ({
    ready: "草案",
    pending: "已排队",
    queued: "已排队",
    processing: "生成中",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
    reserved: "已保留",
    "recovery-pending": "待恢复核对",
    idle: "等待开始",
    stopping: "正在停止",
  })[String(status)] || text(status, "草案");
}

function stageStatusLabel(status) {
  return ({
    done: "完成",
    active: "处理中",
    failed: "失败",
    skipped: "无需",
    waiting: "等待",
  })[String(status)] || text(status, "等待");
}

function taskIdStatusLabel(availability) {
  return ({
    available: "",
    "not-submitted": "尚未提交",
    "platform-pending": "平台未返回",
    "recovery-pending": "待恢复核对",
  })[String(availability)] || "尚未提交";
}

async function runAction(actions, action) {
  try {
    return await action();
  } catch (error) {
    if (typeof actions?.reportError === "function") return actions.reportError(error);
    throw error;
  }
}

function createButton(parent, label, action, options = {}, actions = {}) {
  const button = parent.createEl("button", {
    cls: text(options.className),
    text: label,
    attr: { type: "button", ...(plainObject(options.attr)) },
  });
  button.disabled = Boolean(options.disabled);
  if (options.busy) {
    button.addClass("is-loading");
    button.setAttr("aria-busy", "true");
  }
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    await runAction(actions, action);
  });
  if (options.register && typeof actions.registerButton === "function") {
    actions.registerButton(options.register, button, Boolean(options.guardDisabled));
  }
  return button;
}

function createField(parent, labelText, tagName, value, target, options = {}, actions = {}) {
  const label = parent.createEl("label", { cls: "mangosteen-replica-field" });
  if (options.className) label.addClass(options.className);
  label.createEl("span", { text: labelText });
  const control = label.createEl(tagName, { attr: { "aria-label": labelText } });
  control.dataset.section = target.section;
  control.dataset.field = target.field;
  if (target.index !== undefined) control.dataset.index = String(target.index);
  if (target.shotIndex !== undefined) control.dataset.shotIndex = String(target.shotIndex);
  if (target.segmentIndex !== undefined) control.dataset.segmentIndex = String(target.segmentIndex);
  if (tagName === "select") {
    for (const [optionValue, optionLabel] of list(options.options)) {
      control.createEl("option", { text: optionLabel, attr: { value: optionValue } });
    }
  }
  for (const attribute of ["type", "min", "max", "step", "readonly"]) {
    if (options[attribute] !== undefined && options[attribute] !== null) {
      control.setAttr(attribute, String(options[attribute]));
    }
  }
  control.value = value === undefined || value === null ? "" : String(value);
  control.disabled = Boolean(options.disabled);
  if (!options.readonly) {
    control.addEventListener(tagName === "select" ? "change" : "input", async () => {
      const nextValue = options.numeric ? Number(control.value) : control.value;
      await runAction(actions, () => actions.updateDraftField?.(target, nextValue, control));
    });
  }
  return control;
}

function renderCockpitHeader(parent, model, actions) {
  const header = plainObject(model.header);
  const controls = plainObject(model.controls);
  const section = parent.createDiv({ cls: "mangosteen-replica-cockpit-header" });
  const heading = section.createDiv({ cls: "mangosteen-replica-cockpit-heading" });
  heading.createEl("span", { cls: "mangosteen-replica-eyebrow", text: "制作驾驶舱" });
  heading.createEl("h2", { text: text(header.title, "未命名项目") });
  heading.createEl("p", { text: text(header.currentText, "选择镜头开始制作") });

  const progress = section.createDiv({ cls: "mangosteen-replica-cockpit-progress" });
  const progressHead = progress.createDiv({ cls: "mangosteen-replica-cockpit-progress-head" });
  progressHead.createEl("span", { text: `${Number(header.completed) || 0} / ${Number(header.total) || 0} 完成` });
  const percent = numericProgress(header.percent);
  const monitorStatus = text(model?.monitor?.status, "idle");
  const isActive = ["processing", "reserved", "recovery-pending", "stopping"].includes(monitorStatus);
  progressHead.createEl("strong", { text: percent === null ? statusLabel(monitorStatus) : `${percent}%` });
  const track = progress.createDiv({ cls: "mangosteen-replica-progress-track" });
  const bar = track.createDiv({ cls: `mangosteen-replica-progress-bar${percent === null && isActive ? " is-indeterminate" : ""}` });
  if (percent !== null) bar.style.width = `${percent}%`;
  else if (!isActive) bar.style.width = "0%";

  const actionRow = section.createDiv({ cls: "mangosteen-replica-cockpit-actions" });
  const saveStatus = actionRow.createEl("span", {
    cls: "mangosteen-replica-save-status",
    text: controls.editingLocked ? "草案已锁定" : controls.dirty ? "有未保存修改" : "草案已保存",
  });
  actions.registerSaveStatus?.(saveStatus);
  createButton(actionRow, "保存草案", () => actions.saveDraft?.(), {
    className: "mod-cta",
    disabled: controls.editingLocked || !controls.dirty,
    register: "save",
  }, actions);
  const selected = list(controls.selectedShotIds).map(String);
  createButton(actionRow, `生成所选（${selected.length}）`, () => actions.generateSelected?.(selected), {
    className: "mod-cta",
    disabled: controls.confirmPending || !controls.canGenerate || selected.length === 0,
    busy: controls.confirmPending,
    register: "confirm",
    guardDisabled: selected.length === 0,
  }, actions);
  createButton(actionRow, "停止后续生成", () => actions.stopGeneration?.(), {
    className: "mod-warning",
    disabled: controls.stopPending || !controls.canStop,
    busy: controls.stopPending,
    register: "stop",
  }, actions);
  return section;
}

function renderShotRail(parent, model, actions = {}) {
  const rail = parent.createEl("aside", { cls: "shot-rail mangosteen-replica-shot-rail" });
  const items = list(model?.rail?.items);
  const controls = plainObject(model?.controls);
  const selectedIds = new Set(list(controls.selectedShotIds).map(String));
  const head = rail.createDiv({ cls: "mangosteen-replica-pane-head" });
  head.createEl("h3", { text: "分镜队列" });
  head.createEl("p", { text: "点击镜头编辑或查看真实任务状态" });

  const picker = rail.createEl("select", {
    cls: "mangosteen-replica-shot-picker",
    attr: { "aria-label": "选择要编辑的镜头" },
  });
  for (const item of items) {
    picker.createEl("option", {
      text: `${text(item?.id, "-")} · ${text(item?.title, "未命名镜头")} · ${statusLabel(item?.status)}`,
      attr: { value: text(item?.id) },
    });
    if (item?.selected) picker.value = text(item.id);
  }
  picker.disabled = items.length === 0;
  picker.addEventListener("change", async () => runAction(actions, () => actions.selectShot?.(picker.value)));

  const shotList = rail.createDiv({ cls: "mangosteen-replica-shot-list" });
  for (const item of items) {
    const id = text(item?.id);
    const row = shotList.createDiv({
      cls: [
        "mangosteen-replica-shot-item",
        item?.selected ? "is-active" : "",
        item?.status === "failed" ? "is-failed" : "",
        item?.locked ? "is-locked" : "",
      ].filter(Boolean),
    });
    const checkbox = row.createEl("input", {
      attr: { type: "checkbox", "aria-label": `选择镜头 ${id} 加入生成` },
    });
    checkbox.dataset.shotId = id;
    checkbox.checked = selectedIds.has(id);
    checkbox.disabled = Boolean(item?.locked) || !controls.canGenerate || controls.confirmPending;
    checkbox.addEventListener("change", async () => runAction(actions, () => actions.toggleShotSelected?.(id, checkbox.checked)));

    const select = row.createEl("button", {
      cls: "mangosteen-replica-shot-select",
      attr: { type: "button", "aria-current": item?.selected ? "true" : "false" },
    });
    select.dataset.selectShotId = id;
    select.createEl("strong", { cls: "mangosteen-replica-shot-number", text: id });
    const copy = select.createEl("span", { cls: "mangosteen-replica-shot-copy" });
    copy.createEl("strong", { text: text(item?.title, "未命名镜头") });
    copy.createEl("small", { text: `${statusLabel(item?.status)}${item?.locked && item?.lockReason ? ` · ${item.lockReason}` : ""}` });
    select.addEventListener("click", async () => runAction(actions, () => actions.selectShot?.(id)));
    row.createEl("i", { cls: `mangosteen-replica-status-dot is-${text(item?.status, "ready")}` });
  }
  if (!items.length) shotList.createDiv({ cls: "mangosteen-replica-empty-inline", text: "当前草案没有分镜。" });

  const selectable = items.filter((item) => !item?.locked).map((item) => text(item.id));
  const footer = rail.createDiv({ cls: "mangosteen-replica-shot-rail-footer" });
  const selectAllLabel = footer.createEl("label", { cls: "mangosteen-replica-shot-select-all" });
  const selectAll = selectAllLabel.createEl("input", { attr: { type: "checkbox", "aria-label": "选择全部分镜" } });
  selectAll.checked = selectable.length > 0 && selectable.every((id) => selectedIds.has(id));
  selectAll.disabled = !controls.canGenerate || controls.confirmPending || !selectable.length;
  selectAll.addEventListener("change", async () => runAction(actions, () => actions.toggleAllShots?.(selectable, selectAll.checked)));
  selectAllLabel.createEl("span", { text: "选择全部可编辑镜头" });
  return rail;
}

function renderShotEditor(parent, model, actions = {}) {
  const editor = plainObject(model?.editor);
  const controls = plainObject(model?.controls);
  const shot = plainObject(editor.shot);
  const index = Number.isInteger(editor.shotIndex) ? editor.shotIndex : 0;
  const panel = parent.createEl("main", { cls: "shot-editor mangosteen-replica-shot-editor" });
  if (!text(shot.id)) {
    panel.createDiv({ cls: "mangosteen-replica-empty-inline", text: "请选择一个镜头。" });
    return panel;
  }

  const locked = Boolean(controls.editingLocked || editor.locked);
  const head = panel.createDiv({ cls: "mangosteen-replica-editor-head" });
  const heading = head.createDiv();
  heading.createEl("h3", { text: `${text(shot.id)} · ${text(shot.title, "未命名镜头")}` });
  const settings = plainObject(controls.settings);
  heading.createEl("p", {
    cls: "mangosteen-replica-mono",
    text: [shot.duration ? `${shot.duration} 秒` : "时长未定", text(settings.videoModel, "模型未选择"), text(settings.resolution), text(settings.ratio)]
      .filter(Boolean).join(" · "),
  });
  head.createEl("span", {
    cls: `mangosteen-replica-lock-chip${locked ? " is-locked" : ""}`,
    text: locked ? text(editor.lockReason, "本镜头已锁定") : "可编辑",
  });

  const body = panel.createDiv({ cls: "mangosteen-replica-editor-body" });
  const references = body.createDiv({ cls: "mangosteen-replica-reference-grid" });
  const referenceGroups = list(editor.referenceGroups);
  for (const reference of referenceGroups.length ? referenceGroups : list(editor.references).map((value, referenceIndex) => ({
    id: String(referenceIndex), label: `参考资产 ${referenceIndex + 1}`, value, state: "已绑定",
  }))) {
    const card = references.createDiv({ cls: "mangosteen-replica-reference-card" });
    card.createEl("span", { text: text(reference?.label, "参考资产") });
    card.createEl("strong", { text: text(reference?.value, "尚未绑定") });
    card.createEl("small", { text: text(reference?.state, "未绑定") });
  }
  if (!references.children.length) references.createDiv({ cls: "mangosteen-replica-empty-inline", text: "本镜头没有绑定参考资产。" });

  const metadata = body.createDiv({ cls: "mangosteen-replica-editor-fields" });
  createField(metadata, "镜头标题", "input", shot.title, { section: "shot", index, shotIndex: index, field: "title" }, { disabled: locked, className: "is-title" }, actions);
  const range = plainObject(controls.durationRange);
  createField(metadata, "时长（秒）", "input", shot.duration, { section: "shot", index, shotIndex: index, field: "duration" }, {
    disabled: locked,
    className: "is-duration",
    type: "number",
    min: range.min,
    max: range.max,
    step: range.step,
    numeric: true,
  }, actions);
  createField(metadata, "场景", "select", shot.sceneId, { section: "shot", index, shotIndex: index, field: "sceneId" }, {
    disabled: locked,
    className: "is-scene",
    options: controls.sceneOptions,
  }, actions);

  const timeline = list(editor.timeline);
  const timelineList = body.createDiv({ cls: "mangosteen-replica-timeline-list" });
  timeline.forEach((segment, segmentIndex) => {
    const row = timelineList.createDiv({ cls: "mangosteen-replica-timeline-row" });
    const rowHead = row.createDiv({ cls: "mangosteen-replica-timeline-header" });
    const title = rowHead.createDiv();
    title.createEl("strong", { text: `剧情段落 ${String(segmentIndex + 1).padStart(2, "0")}` });
    title.createEl("span", {
      cls: "mangosteen-replica-timecode",
      text: `${Number(segment?.start || 0).toFixed(1)}s — ${Number(segment?.end || 0).toFixed(1)}s`,
    });
    const rowActions = rowHead.createDiv({ cls: "mangosteen-replica-timeline-actions" });
    createButton(rowActions, "在后面添加", () => actions.addTimelineSegment?.(index, segmentIndex), { disabled: locked }, actions);
    createButton(rowActions, "删除此段", () => actions.removeTimelineSegment?.(index, segmentIndex), {
      disabled: locked || timeline.length <= 1,
    }, actions);

    const timeFields = row.createDiv({ cls: "mangosteen-replica-timeline-time" });
    createField(timeFields, "开始（秒）", "input", segment?.start, {
      section: "timeline", shotIndex: index, segmentIndex, field: "start",
    }, { disabled: locked, type: "number", min: 0, max: shot.duration, step: 0.1, numeric: true }, actions);
    createField(timeFields, "结束（秒）", "input", segment?.end, {
      section: "timeline", shotIndex: index, segmentIndex, field: "end",
    }, { disabled: locked, type: "number", min: 0, max: shot.duration, step: 0.1, numeric: true }, actions);

    const content = row.createDiv({ cls: "mangosteen-replica-timeline-fields" });
    for (const [field, label, className] of [
      ["action", "画面动作", "is-wide"],
      ["dialogue", "人物台词", ""],
      ["performance", "情绪与声音", ""],
      ["camera", "景别与运镜", ""],
      ["environment", "环境", "is-wide"],
    ]) {
      createField(content, label, "textarea", segment?.[field], {
        section: "timeline", shotIndex: index, segmentIndex, field,
      }, { disabled: locked, className }, actions);
    }
  });
  if (!timeline.length) timelineList.createDiv({ cls: "mangosteen-replica-empty-inline", text: "这个镜头还没有剧情段落。" });

  const disclosure = body.createEl("details", { cls: "mangosteen-replica-prompt-disclosure" });
  disclosure.open = false;
  actions.registerDisclosure?.(`prompt:${text(shot.id)}`, disclosure);
  disclosure.createEl("summary", { text: "查看完整视频提示词" });
  const prompt = disclosure.createEl("textarea", {
    attr: { readonly: "true", "aria-label": "最终视频提示词预览" },
  });
  prompt.value = text(editor.effectivePrompt, "提示词将在时间轴完整后生成。");
  actions.registerPromptPreview?.(index, prompt);

  const footer = body.createDiv({ cls: "mangosteen-replica-editor-footer" });
  const footerCopy = footer.createDiv();
  footerCopy.createEl("strong", { text: locked ? "当前镜头不可修改" : "修改只保存到草案" });
  footerCopy.createEl("small", { text: locked ? text(editor.lockReason, "任务结束后自动解锁") : "生成前会再次确认，不会自动提交付费任务。" });
  const footerActions = footer.createDiv({ cls: "mangosteen-replica-inline-actions" });
  createButton(footerActions, "保存草案", () => actions.saveDraft?.(), {
    disabled: controls.editingLocked || !controls.dirty,
    register: "save",
  }, actions);
  createButton(footerActions, "生成此镜头", () => actions.generateSelected?.([text(shot.id)]), {
    className: "mod-cta",
    disabled: controls.confirmPending || !controls.canGenerate || Boolean(editor.locked),
    busy: controls.confirmPending,
    register: "confirm",
    guardDisabled: Boolean(editor.locked),
  }, actions);
  const artifactPath = text(shot.videoPath, text(controls.selectedArtifactPath));
  if (artifactPath) createButton(footerActions, "打开产物", () => actions.openArtifact?.(artifactPath), {}, actions);
  return panel;
}

function renderGenerationMonitor(parent, model, actions = {}) {
  const monitor = plainObject(model?.monitor);
  const controls = plainObject(model?.controls);
  const panel = parent.createEl("aside", { cls: "generation-monitor mangosteen-replica-generation-monitor" });
  const head = panel.createDiv({ cls: "mangosteen-replica-pane-head" });
  head.createEl("h3", { text: "生成监控" });
  head.createEl("p", { text: "读取真实任务状态，不猜百分比" });

  const body = panel.createDiv({ cls: "mangosteen-replica-monitor-body" });
  const task = body.createDiv({ cls: `mangosteen-replica-task-card is-${text(monitor.status, "idle")}` });
  const taskTop = task.createDiv({ cls: "mangosteen-replica-task-top" });
  taskTop.createEl("strong", { text: text(monitor.shotId) ? `镜头 ${monitor.shotId}` : "尚无活动镜头" });
  taskTop.createEl("span", { text: statusLabel(monitor.status) });

  const taskId = task.createDiv({ cls: "mangosteen-replica-task-id" });
  taskId.createEl("span", { text: "TASK ID" });
  taskId.createEl("code", { text: text(monitor.taskId, taskIdStatusLabel(monitor.taskIdAvailability)) });

  const progress = numericProgress(monitor.progress);
  const progressBlock = task.createDiv({ cls: "mangosteen-replica-task-progress" });
  const progressText = progressBlock.createDiv({ cls: "mangosteen-replica-task-progress-head" });
  progressText.createEl("span", { text: progress === null ? "平台未提供百分比" : "平台真实进度" });
  progressText.createEl("strong", { text: progress === null ? statusLabel(monitor.status) : `${progress}%` });
  const track = progressBlock.createDiv({ cls: "mangosteen-replica-progress-track" });
  const monitorActive = ["processing", "reserved", "recovery-pending", "stopping"].includes(text(monitor.status));
  const bar = track.createDiv({ cls: `mangosteen-replica-progress-bar${progress === null && monitorActive ? " is-indeterminate" : ""}` });
  if (progress !== null) bar.style.width = `${progress}%`;
  else if (!monitorActive) bar.style.width = "0%";

  const meta = task.createDiv({ cls: "mangosteen-replica-task-meta" });
  meta.createEl("span", { text: text(monitor.model, "模型未记录") });
  meta.createEl("span", { cls: "mangosteen-replica-mono", text: `已等待 ${formatElapsed(monitor.elapsedMs)}` });

  const stages = task.createDiv({ cls: "mangosteen-replica-monitor-stages" });
  for (const stage of list(monitor.stages)) {
    const row = stages.createDiv({ cls: `mangosteen-replica-monitor-stage is-${text(stage?.status, "waiting")}` });
    row.createEl("i");
    row.createEl("span", { text: text(stage?.label, "未知阶段") });
    row.createEl("em", { text: stageStatusLabel(stage?.status) });
  }

  if (monitor.error) {
    const error = plainObject(monitor.error);
    const currentStage = list(monitor.stages).find((stage) => ["active", "failed"].includes(stage?.status));
    const errorBox = body.createDiv({ cls: "mangosteen-replica-monitor-error" });
    errorBox.createEl("strong", { text: text(error.message, "任务发生错误") });
    errorBox.createEl("p", { text: `阶段：${text(currentStage?.label, "状态核对")} · ${monitor.paidTaskSubmitted ? "已提交付费任务" : "尚未提交付费任务"}` });
    errorBox.createEl("p", { cls: "mangosteen-replica-next-action", text: `下一步：${text(error.nextAction, "检查任务记录后再操作")}` });
  }

  const actionRow = body.createDiv({ cls: "mangosteen-replica-monitor-actions" });
  createButton(actionRow, controls.modelCatalogLoading ? "正在读取模型…" : "重新读取模型", () => actions.refreshModels?.(), {
    disabled: controls.modelCatalogLoading,
    busy: controls.modelCatalogLoading,
  }, actions);
  const artifactPath = text(plainObject(model?.editor).shot?.videoPath, text(controls.selectedArtifactPath, text(controls.outputPath)));
  createButton(actionRow, "打开产物", () => actions.openArtifact?.(artifactPath), { disabled: !artifactPath }, actions);
  createButton(actionRow, "整理当前项目", () => actions.organizeProject?.(), { disabled: controls.organizeDisabled }, actions);
  return panel;
}

function renderCockpit(parent, model, actions = {}) {
  const root = parent.createEl("section", { cls: "mangosteen-replica-cockpit" });
  renderCockpitHeader(root, model, actions);
  const grid = root.createDiv({ cls: "mangosteen-replica-cockpit-grid" });
  renderShotRail(grid, model, actions);
  renderShotEditor(grid, model, actions);
  renderGenerationMonitor(grid, model, actions);
  return root;
}

module.exports = {
  renderShotRail,
  renderShotEditor,
  renderGenerationMonitor,
  renderCockpit,
};
