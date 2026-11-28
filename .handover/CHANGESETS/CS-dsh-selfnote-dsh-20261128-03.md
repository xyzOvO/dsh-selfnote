---
id: CS-dsh-selfnote-dsh-20261128-03
project_id: dsh-selfnote
agent: dsh
status: awaiting-review
risk: L1
created: 2026-11-28T12:08Z
---

# 变更集

## 基本信息
- 关联任务：T3（本仓库冷启动复述测试 + 交接卡准确性修复）
- 目的：让跨会话交接「更快更准确」——补上冷启动复述的机器可判定验收，修掉 review.sh 改动文件提取 bug，PROTOCOL 启动序列补读 JOURNAL 避免新会话漏掉最近事件/排障经验。
- 改动文件：
  - `tests/handover-coldstart.mjs`（新增）：7 组断言把冷启动复述要素变成可跑测试（核心文件齐备 / CONTEXT frontmatter / STATE 三小节 / PROTOCOL 启动序列含 JOURNAL+复述 6 要素 / REVIEW 改动文件列真实 / awaiting 计数一致 / CLAIMS 无冲突）。
  - `.handover/scripts/review.sh`：改动文件提取从只抓冒号后空串的 sed，换成纯 ASCII awk 状态机，抓第一组 `  - \`file\`` 子列表（不同 locale 下 awk 匹配中文不可靠，故不用中文正则）。
  - `.handover/PROTOCOL.md`：启动序列插入「读 JOURNAL 最近 3 条状态行」一步（原 7 步 → 8 步），后续步骤顺延。
  - `package.json`：test 链追加 `node tests/handover-coldstart.mjs`；版本 0.16.7 → 0.16.8（+0.0.1）。
  - `README.md`：版本徽章 0.16.7 → 0.16.8（与 package.json 同步，version.mjs 钉住三处一致）。
  - 交接卡自身（`.handover/` 下 TASKS / STATE / JOURNAL / REVIEW 重生成）：按结束序列更新。
- 关键 diff（核心 30–50 行）：见本变更集改动文件；核心是 tests/handover-coldstart.mjs（68 行）与 review.sh 的 awk 块。

## 验证
- 命令：（下面这个围栏必须是**本文件的第一个** ``` 块，review.sh 就靠它取验证命令）
  ```bash
  npm test && npm run test:accept && bash .handover/scripts/review.sh && node tests/handover-coldstart.mjs
  # 预期：npm test 全绿（含 handover-coldstart 7 项）；test:accept 12/12；review.sh 生成的变更集与待审数一致；冷启动测试 7/7
  ```
- 改动-测试映射：review.sh 提取 bug ↔ handover-coldstart 第 5 项（REVIEW 改动文件列含 lib/index.js）；PROTOCOL 漏 JOURNAL ↔ 第 4 项（启动序列含 JOURNAL）；冷启动复述无验收 ↔ 整个 handover-coldstart.mjs。
- 自检：编号合规 / 未写 verified / 改动与 CLAIMS 一致 / JOURNAL 已追加

## 文档影响
- README 版本徽章随版本号同步（version.mjs 要求徽章与 package.json 一致）。
- 交接卡 PROTOCOL 启动序列变更（ Agent 读卡行为改变，属用户可感知的小变动，但 README 只写用户视角大变动——本次不写 README 正文，仅在变更集记录）。

## 回滚
- 方式：本变更集改动尚未 commit；如需回退，逐文件还原（删除 tests/handover-coldstart.mjs、review.sh 与 PROTOCOL.md 改回原文、package.json/README.md 版本号回 0.16.7、交接卡正文回退）。commit 后用 `git revert <hash>`。

## 关联发布
- REL-0.16.8（版本号已 +0.0.1，是否单独发版由 OW 定；未发布）

## 未知 / 风险
- [ ] 到期：
- 「指针首回合没生效」的根因之一属部署态：config.json 的 handoverRoot 是新版字段，DSH 进程未重启则仍加载旧代码；本次未重启 DSH，需 OW 实机点验首回合指针。
- buildInjection 对 delegated 会话直接 return ''、handoverShown Set 无上限、sessionId 缺失退化为共享 `nosession` marker、首回合装配失败永久丢失——这些是代码层根因，但不在本次 T3/交接卡准确性修复范围内，留待后续任务。
- PROTOCOL 新增读 JOURNAL 一步，但契约仍未规定 STATE 时间戳过期判断（此前评估的问题⑤），留待后续。

## 审核结果（仅人可写）
- 结论：
- 验证输出：
- execution：
- commit / push：
