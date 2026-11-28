# TASKS

状态机：`todo → doing → awaiting-review → verified`；`awaiting-review → blocked / abandoned`；
`verified` 且 `execution: hold` 时可回 `doing`；已 commit/push 后回滚 = 新开 revert 变更集，原变更集标 `rolled-back`。

| ID | 任务 | 状态 | Agent | 风险 | 变更集 | 验证命令 | execution |
|---|---|---|---|---|---|---|---|
| T0 | 交接卡骨架就位 | todo | dsh | L0 | — | `bash .handover/scripts/review.sh` | — |
