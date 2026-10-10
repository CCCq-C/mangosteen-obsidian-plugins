# 视频提示词队列：UI 接入说明

## 引入

```js
const { createReplicaLogicApi } = require("./replica-logic-api.cjs");
```

创建 API 时传入：

- `saveQueue(queue)`：原子写入当前项目 `.work/generation-queue.json`。
- `runShot(shot, context)`：复用现有参考资产、首尾帧和视频生成逻辑。
- `activeQueues`：插件启动时从项目目录恢复的未结束队列，防止重启后重复付费。

## 字段

- `shot.videoPrompt`：AI 生成的基础画面运动描述。
- `shot.videoPromptOverride`：用户编辑的完整视频提示词；清空后恢复自动拼接。
- `plan.shots[].effectiveVideoPrompt`：预览和实际提交给模型的最终提示词，只读。
- `queue.shots[].status`：`queued`、`processing`、`completed`、`failed`、`stopped`。

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
- 确认弹窗必须原样展示：`点击生成后，所选镜头的提示词将无法修改，请确认生成。`
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

1. 使用 `context.character`、`context.scenes`、`context.products` 确保参考资产存在。
2. 根据 `shot.imagePrompt` 和 `shot.lastImagePrompt` 生成或复用首尾帧。
3. 把 `shot.effectiveVideoPrompt` 原样提交给视频模型，不得再次拼接台词。
4. 成功返回 `{ videoPath, firstImagePath?, lastImagePath? }`；失败直接抛错。

停止时调用 `await api.stop(queue)`。当前已经提交的平台任务仍可能完成并产生费用，但队列不会再提交下一个镜头。

