# TASKS

状态机：`todo → doing → awaiting-review → verified`；`awaiting-review → blocked / abandoned`；
`verified` 且 `execution: hold` 时可回 `doing`；已 commit/push 后回滚 = 新开 revert 变更集，原变更集标 `rolled-back`。

| ID | 任务 | 状态 | Agent | 风险 | 变更集 | 验证命令 | execution |
|---|---|---|---|---|---|---|---|
| T1 | 交接卡指针注入（≤100 token，独立段） | awaiting-review | dsh | L2 | CS-dsh-selfnote-dsh-20261128-01 | `npm test && npm run test:accept` | — |
| T2 | `handover_read` 只读工具 + 只读校验 | todo | dsh | L2 | — | `npm test` | — |
| T3 | 本仓库冷启动复述测试 + 交接卡准确性修复 | awaiting-review | dsh | L1 | CS-dsh-selfnote-dsh-20261128-03 | `npm test && npm run test:accept && bash .handover/scripts/review.sh && node tests/handover-coldstart.mjs && node tests/handover-delegated.mjs` | — |
| T4 | 交接卡导入导出（单文件 markdown + 设置页按钮） | awaiting-review | dsh | L2 | CS-dsh-selfnote-dsh-20261128-02 | `npm test && npm run test:accept` | — |
| T5 | 审查发现问题的修复（F1 徽章一致性 / F2 测试范围 / F3 代码层委派指针与 marker） | awaiting-review | dsh | L1 | CS-dsh-selfnote-dsh-20261128-04 | `npm test && npm run test:accept && bash .handover/scripts/review.sh && node tests/handover-coldstart.mjs && node tests/handover-delegated.mjs` | — |
