---
id: CS-dsh-selfnote-dsh-20261128-04
project_id: dsh-selfnote
agent: dsh
status: awaiting-review
risk: L1
created: 2026-11-28T12:52Z
---

# 变更集

## 基本信息
- 关联任务：T5（审查发现问题的修复）
- 目的：修复 differential review 报告指出的三项 MEDIUM（F1/F2/F3）与技术债——让跨会话交接在代码层也准确：委派子代理能拿到交接卡指针、无 id 会话不再共享 marker、marker 记账不再因装配失败永久丢失；徽章与测试数不再各写各的。
- 改动文件：
  - `lib/index.js`：`nextHandoverPointer` 改为返回 `{ pointer, marker }` 只算不标记；无会话 id 用递增 anon token（不再共享 `nosession`）；`handoverShown` 从无上限 Set 换成 256 上限的 LRU Map；marker 提交（`markHandoverShown`）推迟到注入真贴出去后，并补缓存命中分支记账；委派分支由 `return ''` 改为只注入指针不注入记忆。
  - `tests/handover-delegated.mjs`（新增）：4 组断言把 F3 四处修复变成可跑测试（委派收到指针 / 委派不注入记忆 / 无 id 不共享 marker / 同一会话第二回合去重）。
  - `tests/handover-coldstart.mjs`：F2——复述 6 要素断言从全文 `p.includes` 改为启动序列片段 `start.includes`，防止删掉复述那步测试仍绿。
  - `tests/version.mjs`：F1——新增第 5 节，断言 README tests 徽章数字 == package.json test 链实际文件数。
  - `package.json`：版本 0.16.8 → 0.16.9（+0.0.1）；test 链追加 `node tests/handover-delegated.mjs`（58 → 59 个文件）。
  - `README.md`：version 徽章 → 0.16.9、tests 徽章 52 → 59（与 test 链一致）。
  - `.handover/TASKS.md`：T3 验证命令补 `bash .handover/scripts/review.sh`（技术债）；新增 T5 行。
- 关键 diff（核心 30–50 行）：lib/index.js 的 `nextHandoverPointer`、`markHandoverShown`、`composeInjection` 缓存命中分支、`buildInjection` 委派分支，均以 byte-level 保 CRLF 修改，`node --check` 通过（crlf=4269 loneLF=0）。

## 验证
- 命令：（下面这个围栏必须是**本文件的第一个** ``` 块，review.sh 就靠它取验证命令）
  ```bash
  npm test && npm run test:accept && bash .handover/scripts/review.sh && node tests/handover-coldstart.mjs && node tests/handover-delegated.mjs
  # 预期：npm test 全绿（59 个测试文件）；test:accept 12/12；review.sh 生成变更集与待审数一致；冷启动 7/7；delegated 4/4
  ```
- 改动-测试映射：F3 委派指针 ↔ handover-delegated 第 1/2 项；F3 nosession 共享 ↔ 第 3 项；F3 marker 提交时机 ↔ 第 4 项（+ 缓存命中分支）；F1 徽章 ↔ version.mjs 第 5 节；F2 复述断言 ↔ handover-coldstart 第 4 项。
- 自检：编号合规 / 未写 verified / 改动与 CLAIMS 一致 / JOURNAL 已追加

## 文档影响
- README 两个徽章随版本与测试数同步（version.mjs 钉住 version 徽章、新增钉住 tests 徽章）。
- 交接卡 TASKS 新增 T5、T3 验证命令补齐；PROTOCOL 无变更。

## 回滚
- 方式：本变更集改动尚未 commit；如需回退，逐文件还原（lib/index.js 用 git checkout 回 107a7dc 版本、删除 tests/handover-delegated.mjs、撤回 tests/handover-coldstart.mjs 与 tests/version.mjs 的 F1/F2 改动、package.json/README.md 版本回 0.16.8、交接卡正文回退）。commit 后用 `git revert <hash>`。

## 关联发布
- REL-0.16.9（版本号已 +0.0.1，是否单独发版由 OW 定；未发布）

## 未知 / 风险
- [ ] 到期：
- [x] 实机复验已通过（2026-11-28T21:08+08:00）：OW 重启 DSH 后，干净上下文子代理 `pointer-probe-2` 禁工具复述首回合，一字不改贴出完整四行 `[交接卡]` 指针（项目名 / 必读顺序 / 待审 / 禁止）；对比重启前 `pointer-probe` 一个字都没有。root 会话首回合也收到指针。Web GUI 端口随重启变为 58356。
- F3 修复改变了委派会话的注入行为（从完全不注入变为注入交接卡指针），属用户可感知行为变化；tests/api.mjs 的旧断言未冲突（其委派场景未配 handoverRoot，pointer 本就为空），但真实宿主委派链路需实机回归。
- `handoverShown` 的 256 上限与 anon 递增 token 是进程内状态，DSH 重启会清空——重启后每个会话首回合会重新提醒一次，属预期行为。
- STATE 时间戳过期判断契约仍未规定（此前评估的问题⑤），留待后续。

## 审核结果（仅人可写）
- 结论：
- 验证输出：
- execution：
- commit / push：
