# PROTOCOL

## 硬边界

- 不得写 `verified`、`execution`、执行授权字段。
- 不得改 JOURNAL 历史条目。
- 不得读取 `.env` / `*.key` / `*secret*` / 生产配置。
- 不得执行发布；发布由人备料后在场执行。
- 改动文件必须先在 CLAIMS 声明。

## 启动序列

1. 读 CONTEXT，确认 `project_id` 与硬边界。
2. 读 STATE 的「当前工作 / 阻塞 / 上次交接」。
3. 读 PROTOCOL（本文件）。
4. 读 CLAIMS，检查冲突；冲突则标 blocked，不写文件。
5. 读最近 3 条变更集 + TASKS 的 doing / awaiting；若 `decisions.md` 存在，读最近 3 条。
6. 新会话 / 换 Agent：执行冷启动复述检查（说出目标、下一步、阻塞、待审变更集、验证命令、硬边界）。
7. 只加载当前任务相关模块卡 / runbook。

## 结束序列

1. 写变更集到 `awaiting-review`（编号、模板、自检、验证命令块、改动-测试映射、回滚方式）。
2. 更新 TASKS 状态。
3. 覆盖 STATE 正文三个小节，保留 frontmatter 人写字段。
4. 追加 JOURNAL 至少一条状态行（有事件则额外追加）。
5. 重算 `current_hash`，与 `last_written_hash` 对比；不等则标冲突，不释放。
6. 若本阶段关闭，追加 HISTORY 一行。
7. 产出漂移检查命令块。

## 收工自检清单（所有 Agent 通用）

- [ ] 编号符合 `CS-<project>-<agent>-<date>-<seq>`
- [ ] 未写 verified / execution / 执行授权
- [ ] 改动文件与 CLAIMS 一致
- [ ] JOURNAL 至少一条状态行已追加
- [ ] 验证命令可复制执行
- [ ] 关键 diff ≤50 行

## 验证规则

- 首次出现的验证命令，人看一眼实际测什么；复用免审。
- 禁止 `|| true`、`--passWithNoTests`、只跑 lint 冒充测试。
- L3 变更人必须复跑验证命令；L1/L2 信任 Agent 输出，但扫一眼是否覆盖改动。
- 造假一次：该 Agent 一周内所有变更集人全跑验证。

## 授权规则

- 审核即授权：人填 `verified` 时同时填 `execution: commit-only / commit+push / hold`。
- 不设独立授权状态和时效；会话结束未执行的，下次审核重新给。
- 发布不由 Agent 执行；Agent 在 `RELEASES/REL-<version>.md` 产出发布清单，人按 runbook 执行后回填。

## 执行失败处理

- commit/push 执行失败（远端冲突、权限、网络）：
  1. 状态回 `verified`，`execution` 改 `hold`
  2. JOURNAL 记失败原因 + 命令输出
  3. Agent 不自行 retry、不 force push
  4. 人重新审核后重新授权

## 回滚规则

- Agent 可标「回滚请求」，不可执行 reset/revert。
- 回滚需人授权；`git revert` 优先于 `reset`；必须 reset 时人在场。
- `execution: hold` 时回滚 = `verified → doing`，清空 execution。
- 已执行 commit/push 后回滚 = 新开 revert 变更集，原变更集标 `rolled-back`，不退回 doing。
- 回滚后 `project_verified_against` 回退到回滚前 commit。
