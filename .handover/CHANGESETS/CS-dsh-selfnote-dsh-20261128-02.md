---
id: CS-dsh-selfnote-dsh-20261128-02
project_id: dsh-selfnote
agent: dsh
status: awaiting-review
risk: L2
created: 2026-11-28T11:05Z
---

# 变更集

## 基本信息
- 关联任务：T4（交接卡导入导出）
- 目的：把 `.handover/` 打成一份 markdown，任何人或任何 AI 拿到这一份就能接手；反向也能导入还原。
- 改动文件：
  - `lib/handover-bundle.js`（新增）：`bundleMarkdown` / `parseBundle` / `importBundle` / `bundleFileName`。
  - `lib/index.js`：`GET /handover/export`、`POST /handover/import`、辅助函数 `handoverBase()`。
  - `lib/client.js`：设置页「项目交接卡」卡片（导出按钮 / 粘贴框 / 导入按钮 / 样式）。
  - `tests/handover-bundle.mjs`（新增）、`tests/ux-regressions.mjs`（卡片结构断言）、`package.json`（测试接线）。
- 关键 diff（核心 30–50 行）：见 `git show 544d574`。

## 验证
  ```bash
  npm test && npm run test:accept
  # 预期：全部通过；handover-bundle 6 组、运行时验收 12 项
  ```
- 改动-测试映射：打包/解析/往返/备份/拒绝空内容/文件名 ↔ handover-bundle 六组；卡片结构 ↔ ux-regressions。
- 自检：编号合规 / 未写 verified / 改动与 CLAIMS 一致 / JOURNAL 已追加

## 文档影响
- 脚手架 README 增加「导入 / 导出」一节。

## 回滚
- 方式：`git revert 544d574`

## 关联发布
- REL-0.16.7（与 T1 一起发）

## 未知 / 风险
- [ ] 到期：
- HTTP 路由未在运行中的实例验过（需重启 DSH）。
- 设置页导出依赖 `cfg.handoverRoot` 或进程 cwd 能找到项目；桌面端 cwd 通常不是项目目录，需在设置里填路径。

## 审核结果（仅人可写）
- 结论：
- 验证输出：
- execution：
- commit / push：
