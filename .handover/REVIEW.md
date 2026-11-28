# REVIEW

> 由 scripts/review.sh 生成，Agent 只读。生成时间：2026-11-28 21:12

共 4 条变更集，其中 awaiting-review **4** 条。

**待审队列已满（超过 3 条），先清队列再接新任务。**

| 变更集 | Agent | 风险 | 状态 | 改动文件 | 验证命令 | 冲突 |
|---|---|---|---|---|---|---|
| CS-dsh-selfnote-dsh-20261128-01 | dsh | L2 | awaiting-review | lib/index.js, tests/handover.mjs, package.json | npm test && npm run test:accept | - |
| CS-dsh-selfnote-dsh-20261128-02 | dsh | L2 | awaiting-review | lib/handover-bundle.js, lib/index.js, lib/client.js, tests/handover-bundle.mjs | npm test && npm run test:accept | - |
| CS-dsh-selfnote-dsh-20261128-03 | dsh | L1 | awaiting-review | tests/handover-coldstart.mjs, .handover/scripts/review.sh, .handover/PROTOCOL.md, package.json, README.md | npm test && npm run test:accept && bash .handover/scripts/review.sh && node tests/handover-coldstart.mjs | - |
| CS-dsh-selfnote-dsh-20261128-04 | dsh | L1 | awaiting-review | lib/index.js, tests/handover-delegated.mjs, tests/handover-coldstart.mjs, tests/version.mjs, package.json, README.md, .handover/TASKS.md | npm test && npm run test:accept && bash .handover/scripts/review.sh && node tests/handover-coldstart.mjs && node tests/handover-delegated.mjs | - |
