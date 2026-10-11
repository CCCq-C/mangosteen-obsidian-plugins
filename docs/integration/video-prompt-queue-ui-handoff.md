# 视频提示词队列：UI 接入说明

## 引入

```js
const { createReplicaLogicApi } = require("./replica-logic-api.cjs");
```

创建 API 时传入：

- `saveQueue(queue)`：原子写入当前项目 `.work/generation-queue.json`。
- `runShot(shot, context)`：按所选视频模型复用参考资产，并执行必要的首帧和视频生成逻辑。
- `activeQueues`：插件启动时从项目目录恢复的未结束队列，防止重启后重复付费。

## 字段

- `shot.timeline[]`：v4 分镜的结构化剧情时间段，按顺序包含 `start`、`end`、`action`、`dialogue`、`performance`、`camera`、`environment`。
- `shot.duration`：镜头总时长；时间段必须从 0 秒开始、首尾连续、不重叠，并在该时长结束。
- `shot.videoPromptOverride`：兼容旧项目的完整视频提示词覆盖值；v4 工作台不再提供这个编辑入口。
- `plan.shots[].effectiveVideoPrompt`：根据时间段、固定人物和声音要求编译出的最终提示词。UI 只读预览，实际提交必须使用同一份内容。
- `queue.shots[].status`：`queued`、`processing`、`completed`、`failed`、`stopped`。
- `queue.shots[].confirmedPayloadSignature`：确认后生成的完整负载签名；缺失或不匹配时不得调用付费接口，用户需要重新预览确认。

v1-v3 项目仍可读取；进入编辑器后会在内存中补成时间段。旧首尾帧字段会随 `legacyFrameMode` 一起保留，保存后仍走原有首尾帧流程；新分析产生的 v4 草案才使用新版模型自适应参考图流程。

## 单镜头与批量流程

```js
const plan = api.preview(currentRequest, checkedShotIds);
// 在确认弹窗展示 plan.warning 和每个 plan.shots[].effectiveVideoPrompt
const confirmed = api.confirm(plan, currentRequest);
const queue = await api.enqueue(confirmed);
await api.run(queue);
```

- 单镜头运行：`checkedShotIds` 只传当前镜头 ID。
- 批量运行：传勾选镜头 ID；逻辑层自动按草案顺序排列。
- 确认弹窗只展示所选镜头编号、不可修改提示和每个镜头的 `effectiveVideoPrompt`，不要重新拼接提示词。
- 不要再通过旧的项目级 `confirmed=true` 触发整项目生成。

## 编辑锁定

```js
const locked = api.isLocked(queue, shot.id);
```

- 只禁用当前队列中 `queued` 或 `processing` 的镜头。
- 未勾选镜头继续允许编辑。
- `completed`、`failed`、`stopped` 镜头重新允许编辑；再次生成必须重新预览和确认。

## 运行适配器要求

`runShot(shot, context)` 必须：

1. 使用 `context.character`、`context.scenes`、`context.products` 检查人物三视图、场景图和产品图。
2. MiniMax H3：根据第一个时间段和固定参考资产自动生成一张首帧；默认不生成尾帧。
3. Seedance 2.5：人物三视图、场景图和产品图直接作为视频参考图；不生成镜头首帧或尾帧。
4. 把确认快照中的 `shot.effectiveVideoPrompt` 原样提交给视频模型，不得再次拼接、删改台词或调整时间段。
5. 成功返回 `{ videoPath, firstImagePath?, lastImagePath? }`；Seedance 正常情况下只返回 `videoPath`，失败直接抛错。

旧 v1-v3 队列继续使用旧首尾帧流程，避免升级时改变已经确认的付费任务。

停止时调用 `await api.stop(queue)`。当前已经提交的平台任务仍可能完成并产生费用，但队列不会再提交下一个镜头。
