---
id: CS-dsh-selfnote-dsh-20261128-01
project_id: dsh-selfnote
agent: dsh
status: awaiting-review
risk: L2
created: 2026-11-28T10:40Z
---

# 变更集

## 基本信息
- 关联任务：T1（交接卡指针注入）
- 目的：会话开始时注入一段 ≤100 token 的指路牌，告诉 Agent「这个项目有交接卡、先读哪三份、禁止什么」，不把 STATE 正文塞进提示词。
- 改动文件：
  - `lib/index.js`：新增 `findHandoverRoot()` / `handoverPointerOf()` / `sessionCwdOf()` / `nextHandoverPointer()`；`assembleInjection` 支持 `options.pointer`（不进八段预算）；`composeInjection` 每会话只提醒一次并把 `|hv` 并入缓存键；`DEFAULT_CONFIG.handoverRoot` 可显式指定根目录。
  - `tests/handover.mjs`：7 组断言（指针内容、长度 ≤400 字符、无交接卡返回空串、向上查找、八段字数不变、overhead 增加、不传指针时文本不变）。
  - `package.json`：test 链追加 `tests/handover.mjs`。
- 关键 diff（核心 30–50 行）：见 `git show 9ef2f4b -- lib/index.js`。

## 验证
  ```bash
  npm test && npm run test:accept
  # 预期：npm test 无失败标记（57 个测试文件），运行时验收 12 项全过
  ```
- 改动-测试映射：`handoverPointerOf` ↔ 前 3 组断言；`findHandoverRoot` ↔ 第 4、5 组；`assembleInjection({pointer})` ↔ 第 6、7 组。
- 自检：编号合规 / 未写 verified / 改动与 CLAIMS 一致 / JOURNAL 已追加

## 文档影响
- README 暂未改：交接卡属新功能，等 T2、T3 完成一并写一行用户视角说明。

## 回滚
- 方式：`git revert 9ef2f4b`

## 关联发布
- REL-0.16.7（待 T2/T3 完成后一起发）

## 未知 / 风险
- [ ] 到期：
- 探测只认会话 cwd（`ctx.agents.currentInitiator().session.meta.cwd`），拿不到会话 cwd 时不注入——需真人重启一次确认桌面端确实能取到。
- 指针每会话只出现一次；若首回合装配失败，该会话不会再补提醒。

## 审核结果（仅人可写）
- 结论：
- 验证输出：
- execution：
- commit / push：
