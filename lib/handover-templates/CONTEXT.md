---
project_id: __PROJECT_ID__
project_name: __PROJECT_NAME__
format: handover-v3
related_projects: []
---

# CONTEXT

## 硬边界（每次启动必读，不可违反）
- 不直接改生产配置
- 不写 verified 和执行授权字段
- 不读 .env / *.key / *secret*
- 发布必须人在场

## 任务路由

| 任务 | 必读 | 选读 | 禁止 |
|---|---|---|---|
| 理解项目 | CONTEXT | project-map | 读全部模块卡 |
| 跑起来 | CONTEXT | runbook/start-deploy | 猜命令 |
| 改模块 | CONTEXT + 模块卡 | runbook | 改未声明文件 |
| 排障 | CONTEXT + runbook | known-issues | 直接重启生产 |
| 审核 | CHANGESETS 当前条 | 相关模块卡 | 代填 verified |

## 外部 Agent 接入模板（人复制使用）

```text
交接卡在 <项目根>/.handover/。
先读 CONTEXT.md，按「外部 Agent 接入」执行。
快速接入（改小东西）：读 CONTEXT + CLAIMS，收工追加 JOURNAL 一条。
完整接手：按 PROTOCOL 启动序列执行。
本次任务：<一句话>。
```

### 快速接入
读：CONTEXT + CLAIMS。不读 STATE / TASKS / CHANGESETS 全文。
开工前检查 CLAIMS 冲突和 TASKS 待审数；收工追加 JOURNAL 一条，注明改了哪些文件。

### 完整接手
按 PROTOCOL 启动序列执行，走 awaiting-review。

## 格式契约

- `format: handover-v3`，字段名与状态枚举以本文件与 `CHANGESETS/TEMPLATE.md` 为准。
- 任务状态：`todo / doing / awaiting-review / verified / blocked / abandoned`（外加 `rolled-back` 标变更集）。
- 变更集状态：`todo / awaiting-review / verified / rolled-back / abandoned`；**Agent 最多写到 `awaiting-review`**。
- CLAIMS 状态：`占用 / 已释放 / 冲突`。
- 变更集编号：`CS-<project_id>-<agent>-<YYYYMMDD>-<seq>`。
- frontmatter 必填：变更集 `id / project_id / agent / status / risk / created`；STATE 的 `project_verified_against / last_verification / truth_source` 仅人写。
