# 视频完整提示词与分镜队列设计

## 目标

让每个分镜都能展示并编辑实际提交给视频模型的完整提示词；单镜头运行只锁定当前镜头，批量运行只锁定用户勾选的镜头，并按分镜顺序执行。

## 范围

- 本次只实现逻辑模块、数据结构、调用接口和自动化测试。
- 不修改 `replica-workbench.cjs`、`styles.css` 等 UI 文件。
- 保留现有参考资产、首尾帧、视频模型调用和项目输出流程。

## 提示词模型

分镜继续保留 `videoPrompt`、`dialogue`、`voiceDirection`，人物继续保留 `voiceProfile`。新增可选字段 `videoPromptOverride`：

- `videoPromptOverride` 为空时，通过现有 `composeVideoPrompt` 自动拼接完整提示词。
- `videoPromptOverride` 非空时，它就是提交给视频模型的最终提示词，不再二次拼接。
- 逻辑层返回 `effectiveVideoPrompt` 供 UI 展示，但不把派生值重复写回草案。
- 用户清空覆盖值即可恢复自动拼接。

## 确认与锁定

UI 先调用 `prepareGenerationPlan(request, selectedShotIds)`。逻辑层返回：

- `planId`：基于所选镜头不可变快照生成的哈希标识。
- `warning`：`点击生成后，所选镜头的提示词将无法修改，请确认生成。`
- `shots`：按草案顺序排列的镜头快照，包含 `effectiveVideoPrompt`。

用户确认后调用 `confirmGenerationPlan(plan, currentRequest)`。确认时重新计算草案签名；任何所选镜头、人物声音或模型设置发生变化，旧计划失效，必须重新预览确认。

锁定按镜头 ID 生效。`queued` 和 `processing` 状态不可编辑；未选中的镜头保持 `editable`。完成或失败后保留本次快照，草案重新允许编辑，重试必须重新确认。

## 队列状态

队列独立于 `generation-request.json`，建议由 UI/插件宿主持久化为 `.work/generation-queue.json`：

- 队列状态：`idle`、`processing`、`completed`、`completed_with_errors`、`stopped`。
- 镜头状态：`queued`、`processing`、`completed`、`failed`、`stopped`。
- 队列只保存被选中的镜头快照，并按其在草案中的顺序执行。
- 单镜头运行是只含一个镜头的普通队列，不单独维护另一套流程。
- 当前镜头失败后记录错误并继续下一镜头；模型不可用等全局错误可由宿主中止队列。

## 运行适配器

逻辑模块不直接依赖 Obsidian 或算力插件。宿主提供一个 `runShot(snapshot, context)` 回调，复用现有生成流程完成：

1. 确保人物、场景和产品参考资产存在。
2. 生成或复用当前镜头首帧和可选尾帧。
3. 使用快照里的 `effectiveVideoPrompt` 提交视频任务。
4. 保存视频路径并返回结果。

这样未来更换模型或 UI 时，只需替换适配器，不修改队列规则。

## 错误处理

- 未选择镜头：拒绝创建计划。
- 重复或不存在的镜头 ID：拒绝创建计划。
- 计划确认前草案已变化：拒绝入队并提示重新确认。
- 已锁镜头再次入队：拒绝，避免重复付费任务。
- 单镜头失败：记录错误，继续执行后续队列。
- 停止：不再提交新镜头；已经提交的平台任务仍可能完成并产生费用。

## 验收标准

1. 自动完整提示词和用户覆盖提示词均能正确解析。
2. 单镜头计划只锁一个镜头。
3. 批量计划只锁勾选镜头，并按草案顺序排队。
4. 未选镜头在队列运行时仍可编辑。
5. 确认后修改所选镜头会使旧计划失效。
6. 队列失败继续、停止不再提交、重试重新确认均有测试覆盖。

