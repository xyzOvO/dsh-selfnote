# 自动采集 P1-A（设计与验证）

目标：把「采集」从依赖模型主动调 `memory_stage`，变成系统自己发现值得保存的话。
本阶段只做**发现**，不落库、不调模型、不动 approved。

## 三个前置问题的答案

### 1. 对话结束事件从哪里取

平台提供两个钩子：

| 钩子 | 模式 | 载荷 | 用途 |
|---|---|---|---|
| `agent/turn-stopping` | serial，**被 await** | `{ agent, turn, signal }` | 回合即将关闭；监听者必须快，慢的别放这里 |
| `session/event` | emit，fire-and-forget | `(session, event: SessionEvent)` | 每次日志追加后；`turn/end` 与 `user/message` 都在这里 |

**选 `session/event`。** 理由：

- 拿到的就是提交后的确切事件，不用去解压 `session.v4.jsonl.zstd`，也不用担心读到半截。
- 它是 emit 不是 await，慢一点不影响对话；`turn/end` 触发时同回合的 `user/message` 已经全部到齐。
- `agent/turn-stopping` 留给需要「当场介入」的场景（比如想拦下这一回合），采集不该占那个位置。

### 2. 能否区分用户原话和模型生成

能，两层都在类型里：

- 事件类型分开了：`user/message` / `assistant/message` / `tool/result` / `system/message`。
- 消息自带 `source.kind`：`user` / `model` / `tool` / `system-prompt`。

注入进来的内容（系统提示、mnemon 快照、工具回填）不会伪装成 `user/message`；即便落在 user 通道，`source.kind !== 'user'` 也能筛掉。这套判断 `memory_recall` 已经在用（`CACHE_VERSION=2` 那次修的），采集直接复用，不另写一套。

### 3. 会不会重复处理同一条消息

不会。每条 `SessionEvent` 带单调递增的 `seq`，游标按会话记「处理到哪一条」：

- `alreadySeen(sessionId, seq)`：`seq <= 游标` 直接跳过。
- 游标只前进，写完用临时文件 + rename 原子落盘。
- 重启后从磁盘恢复游标，历史消息不会重放；换会话互不干扰。

不用时间戳判断 —— 时间会回拨，seq 不会。

## 触发规则（P1-A 已实现，10 项测试）

| 类型 | 例子 | 判据 |
|---|---|---|
| 长期约定 | 「以后都用中文」 | 以后 / 今后 / 往后 / 每次都… |
| 明确禁止 | 「不要再给 emoji」 | 不要再 / 别用 / 不许 / 禁止 |
| 长期偏好 | 「我更喜欢吃表格」 | 我更喜欢 / 我习惯 / 请记住 |
| 主动纠正 | 「你刚才说错了，应该先问」 | 说错了 / 不是这样 / 应该先 |

只挑命中触发的**句子**（4–200 字），一条消息最多 3 条候选。没命中的消息零成本跳过，不调模型。

## 去重：只合并证据，不合并状态

- 第一层：bigram 重叠系数（不是 Jaccard —— 中文长句改几个字，Jaccard 掉太快）。阈值 0.5。
- 第二层：否定词 + 方向词校验。「简洁 / 详细」「喜欢 / 不喜欢」这类词面很像但方向相反的，判 `conflict`，**不合并**。
- 三层结论：`merge`（记 occurrences + lastObserved）/ `conflict`（两条都留，标 similarTo）/ `new`。
- 已 approved 的事实只作为比对对象，**永远不被自动采集改写或覆盖**。

## 候选数据（复用 facts.jsonl，不新建库）

| 字段 | 值 |
|---|---|
| `status` | 恒为 `candidate` |
| `captureSource` | `automatic` / `manual` |
| `source` | `会话 id#seq` |
| `occurrences` | 重复出现次数 |
| `lastObserved` | 最近一次观察时间 |
| `similarTo` | 相似候选的 id |

## 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1-A | 触发 + 候选抽取 + 去重判定 + 游标（**本阶段，纯函数 + 10 项测试**） | 不触发时不做事；相反表达不合并；seq 幂等 |
| P1-B | 接 `session/event`，把候选写进 facts.jsonl | 自动采集永远进不了 approved；写入走唯一入口 |
| P1-C | 设置页给候选标「自动 / 手动」，冲突可对照看两句原文 | 人能一眼分辨来源 |
| P1-D | 线上观察噪声率、重复率、漏采率 | — |

## 边界

- 采集器与注入器解耦：采集失败不影响对话（同 `buildInjection` 的 try/catch 策略）。
- 提取器不碰画像：画像只读 approved。
- 去重不改已采纳事实；候选写入仍走 `stageFact` 那条唯一入口。
