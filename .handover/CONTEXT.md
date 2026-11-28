---
project_id: dsh-selfnote
project_name: dsh-selfnote 插件
format: handover-v3
related_projects: []
---

# CONTEXT

## 硬边界（每次启动必读，不可违反）

- `lib/index.js` 与 `tests/client-state.mjs` 是纯 CRLF 文件；其余纯 LF。改 CRLF 文件走 byte-level（`split('\r\n')` / `join('\r\n')`），改完 `node --check`。
- 不写 `verified`、`execution`、审核段——那三个位置只由人填。
- 不读 `.env` / `*.key` / `*secret*`。
- 本地 commit 可自主；`git push` / 打 tag / 建 Release / `npm publish` 必须先得到 OW 一句同意。
- 不改 OW 的运行时数据（`~/.dsh/selfnote/notes.md`、`persona.md`、`presets.json`），除非他明确要求。
- `docs/superpowers/**` 与 `docs/待办.md` 刻意未跟踪，不进 commit / npm 包。
- 版本号改动一律 +0.0.1。

## 任务路由

| 任务 | 必读 | 选读 | 禁止 |
|---|---|---|---|
| 改注入装配 | CONTEXT + `lib/index.js` 段构建区 | `tests/api.mjs` | 改八段预算常量 |
| 改设置页 UI | CONTEXT + `lib/client.js` | `tests/client.mjs`、`tests/client-state.mjs` | 新增 useState（hook 序号被测试钉住） |
| 改记忆数据层 | CONTEXT + `lib/memory.js` | `tests/memory.mjs` | 迁移 schema |
| 发版 | CONTEXT + README 发版段 | `package.json` | 未获同意就 push |
| 审核 | `CHANGESETS` 当前条 | 相关测试 | 代填 verified |

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
- 任务状态：`todo / doing / awaiting-review / verified / blocked / abandoned`；变更集另有 `rolled-back`。
- **Agent 最多把变更集写到 `awaiting-review`**。
- CLAIMS 状态：`占用 / 已释放 / 冲突`。
- 变更集编号：`CS-dsh-selfnote-<agent>-<YYYYMMDD>-<seq>`。
- frontmatter 必填：`id / project_id / agent / status / risk / created`；STATE 的 `project_verified_against / last_verification / truth_source` 仅人写。
