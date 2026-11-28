# JOURNAL

每次收工至少一条状态行；有事件（决策、阻塞、异常、外部修改）额外追加。
每条带唯一前缀：时间戳 | Agent | session_id | 任务 ID | 状态。

## 2026-11-28T10:20Z | dsh | - | T0 | todo
- 一句话：交接卡骨架装进本仓库，CONTEXT / STATE / TASKS / HISTORY 已按本仓库实情填好。
- 验证命令：`bash .handover/scripts/review.sh`（预期：0 条变更集，生成 REVIEW.md）

## 2026-11-28T10:45Z | dsh | - | T1 | awaiting-review
- 一句话：交接卡指针注入落地（lib/index.js + tests/handover.mjs），会话首个回合注入一段指路牌，不占八段预算。
- 验证命令：`npm test && npm run test:accept`（实测：无失败标记、验收 12/12）
- 变更集：CS-dsh-selfnote-dsh-20261128-01

## 2026-11-28T11:05Z | dsh | - | T4 | awaiting-review
- 一句话：交接卡可导出成单份 markdown、也可导入还原；设置页给了按钮和粘贴框。
- 验证命令：`npm test && npm run test:accept`（实测：全绿）
- 变更集：CS-dsh-selfnote-dsh-20261128-02

## 2026-11-28T11:15Z | dsh | - | T1,T4 | awaiting-review
- 一句话：v0.16.7 已发版（commit `107a7dc`，另 `a31df1a` 为文档措辞），交接卡初始化 / 导出 / 导入与首回合指针注入随包发布；T1、T4 两张变更集仍待人审。
- 验证命令：`npm test && npm run test:accept`（实测：57 个测试文件全绿、验收 12/12）
- 变更集：CS-dsh-selfnote-dsh-20261128-01、CS-dsh-selfnote-dsh-20261128-02
- 事件：npm registry 版本端点轮询 6 次仍 404（传播延迟），重发报 `E409 Cannot publish over previously staged version "0.16.7"` 反证已落库；设置页按钮与 `/handover/*` 路由未实机点验（需重启 DSH 加载新代码）。

## 2026-11-28T12:09Z | dsh | - | T3 | awaiting-review
- 一句话：交接卡准确性修复落地——冷启动复述测试 7/7、review.sh 改动文件提取 bug 修复、PROTOCOL 启动序列补读 JOURNAL，版本 +0.0.1 到 0.16.8。
- 验证命令：`npm test && npm run test:accept && bash .handover/scripts/review.sh && node tests/handover-coldstart.mjs`（实测：npm test 全绿含新增 7 项冷启动、test:accept 12/12、review.sh 3 条变更集 3 条待审、冷启动 7/7）
- 变更集：CS-dsh-selfnote-dsh-20261128-03
- 事件：TDD RED→GREEN，RED 的 2 项失败正是两个根因（PROTOCOL 漏 JOURNAL、review.sh 改动文件列全是 `-`）；review.sh 首版用中文正则匹配在 awk 下失效（不同 locale 不可靠），改纯 ASCII 状态机后转绿。CLAIMS 无占用条目，无需释放/hash 比对。指针首回合未生效的部署态根因仍需重启 DSH 实机点验。

## 2026-11-28T12:52Z | dsh | - | T5 | awaiting-review
- 一句话：审查发现的问题全修——F1 README tests 徽章加一致性断言（52→59）、F2 冷启动复述断言从全文改限定启动序列片段、F3 lib/index.js 代码层四处（委派只注入指针不注入记忆 / nosession 不共享 / Set 换 256 上限 LRU Map / marker 提交推迟到注入成功并补缓存命中记账），新增 tests/handover-delegated.mjs 4/4，版本 +0.0.1 到 0.16.9。
- 验证命令：`npm test && npm run test:accept && bash .handover/scripts/review.sh && node tests/handover-coldstart.mjs && node tests/handover-delegated.mjs`（实测：npm test 59 文件全绿、test:accept 12/12、delegated 4/4、coldstart 7/7、version 徽章三处一致）
- 变更集：CS-dsh-selfnote-dsh-20261128-04
- 事件：TDD RED→GREEN——F1 RED（徽章 52≠58）、F3 RED（委派指针空串）；GREEN 时踩坑：marker 记账原在 assembleInjection 前、改到注入成功后仍漏缓存命中分支（同一会话第二回合永远命中含指针缓存），补缓存命中记账才 4/4。tests/api.mjs 委派断言未冲突（其场景未配 handoverRoot，pointer 本就空）。CLAIMS 无占用条目，无需释放/hash 比对。F3 改变了委派会话注入行为，需 OW 在 GUI 新开子代理实机复验。

## 2026-11-28T13:10Z | dsh | - | T5 | awaiting-review
- 一句话：CS-04 实机复验通过——OW 重启 DSH 后，干净上下文子代理 `pointer-probe-2` 禁工具复述首回合，完整贴出四行 `[交接卡]` 指针（项目名/必读顺序/待审/禁止），对比重启前 `pointer-probe` 一个字都没有；root 会话首回合也收到指针，部署态旧代码问题随重启解决。
- 验证命令：`subagent` 起干净上下文探针，禁工具只准复述首回合所见（已实测，四行齐全）
- 变更集：CS-dsh-selfnote-dsh-20261128-04
- 事件：实机复验坐实 F3① 生效，委派 Agent 能接到指针；Web GUI 端口随重启变为 58356。人审状态仍为 awaiting-review（实机通过 ≠ 人审通过），待 OW 审 CS-01/-02/-03/-04。

## 2026-11-28T13:17Z | dsh | - | T5 | awaiting-review
- 一句话：OW 授权「提交推送发版」后，commit `64f76a5` 已 push origin/main、tag `v0.16.9` 已 push、GitHub Release 已建、npm `dsh-selfnote@0.16.9` 已发布到 registry.npmjs.org。
- 验证命令：`git log -1 --oneline` / `git tag --points-at HEAD` / `gh release list` / `npm publish --registry=https://registry.npmjs.org/`（E409 反证）
- 变更集：CS-dsh-selfnote-dsh-20261128-04（关联发布段已回填）
- 事件：npm 默认 registry 是 npmmirror（未登录），OW 登录的是 npmjs.org（账号 xyz66），故 publish 显式加 `--registry=https://registry.npmjs.org/`。发后 registry 读取端点短暂 404、dist-tags 停在 0.16.7，用重发 E409「Cannot publish over previously staged version 0.16.9」反证已落库——与 v0.16.7 那次的传播延迟排障经验一致。docs/superpowers/** 与 docs/待办.md 仍未跟踪、未进 commit/npm 包。人审队列 4 条仍待人审。
