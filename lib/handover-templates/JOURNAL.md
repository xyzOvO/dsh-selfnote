# JOURNAL

每次收工至少一条状态行；有事件（决策、阻塞、异常、外部修改）额外追加。
每条带唯一前缀：时间戳 | Agent | session_id | 任务 ID | 状态。

## __TODAY__T00:00Z | dsh | - | T0 | todo
- 一句话：交接卡骨架初始化完成，等待第一次实际任务。
- 验证命令：`bash .handover/scripts/review.sh`（预期生成 REVIEW.md，列出 0 条待审）
