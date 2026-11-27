/**
 * 防马太效应：采集侧自动打标签（新事实归位画像层）。
 * 跑法：node tests/capture-tags.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-capture-tags-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')

const capture = await import('../lib/capture.js')
const run = await import('../lib/capture-run.js')

/* 1. 纯函数：四类触发映射成中文标签，按 TRIGGERS 顺序，去重、过滤未知 */
assert.deepEqual(capture.tagsForTriggers(['standing']), ['长期约定'])
assert.deepEqual(capture.tagsForTriggers(['prohibit', 'prefer']), ['禁止事项', '偏好'])
assert.deepEqual(capture.tagsForTriggers([]), [])
assert.deepEqual(capture.tagsForTriggers(['standing', 'standing']), ['长期约定'])
assert.deepEqual(capture.tagsForTriggers(['unknown']), [])
assert.deepEqual(capture.tagsForTriggers(['prefer', 'standing', 'correct']), ['偏好', '长期约定', '纠正要求'])
assert.deepEqual(capture.tagsForTriggers(null), [], '非数组 null → 空')
assert.deepEqual(capture.tagsForTriggers(undefined), [], '非数组 undefined → 空')
assert.deepEqual(capture.tagsForTriggers({}), [], '非数组对象 → 空')
console.log('1. tagsForTriggers：分类映射 + 去重 + 顺序 + 过滤未知 + 非数组兜底')

/* 2. 集成：一条 standing 规则句 → 新 fact.tags[0] 为长期约定 */
const standing = run.planWrites(['以后回答都用中文']
  , { facts: [], sessionId: 's-tags', seq: 1, now: new Date('2026-11-27T00:00:00Z') })
assert.equal(standing.created.length, 1, '规则句应产出一条新 candidate')
const newFact = standing.nextFacts.find((f) => f.id === standing.created[0])
assert.deepEqual(newFact.tags, ['长期约定'], '新规则句应自动打长期约定标签')

/* 3. 非规则句 → 即使传进来也不打标签
   （scope 守卫归 candidatesOf 管、capture.mjs 已测；planWrites 信任调用方已筛过的 texts） */
const chitChat = run.planWrites(['今天天气不错'], { facts: [], sessionId: 's-tags', seq: 2 })
const chitFact = chitChat.nextFacts.find((f) => f.id === chitChat.created[0])
assert.deepEqual(chitFact.tags, [], '非规则句没有 triggers → tags 空')

/* 4. merge 指向 approved 目标：目标 tags 原样不动，只让新候选指过去 */
const approved = { id: 'f-approved', text: '以后回答尽量简洁一点', status: 'approved', tags: ['保留标签'], hitCount: 5 }
const merged = run.planWrites(['以后回答再简洁一些'],
  { facts: [approved], sessionId: 's-tags', seq: 3, now: new Date('2026-11-27T00:00:00Z') })
const target = merged.nextFacts.find((f) => f.id === 'f-approved')
assert.deepEqual(target.tags, ['保留标签'], 'merge 不得回写 approved 目标的 tags')
console.log('4. approved 目标 tags 不被 merge 改写')

/* 5. 冲突分支同样不回写目标 tags */
const approved2 = { id: 'f-approved-2', text: '以后回答尽量简洁', status: 'approved', tags: ['原标签'] }
const conflicted = run.planWrites(['以后回答尽量详细'],
  { facts: [approved2], sessionId: 's-tags', seq: 4, now: new Date('2026-11-27T00:00:00Z') })
const target2 = conflicted.nextFacts.find((f) => f.id === 'f-approved-2')
assert.deepEqual(target2.tags, ['原标签'], 'conflict 不得回写 approved 目标的 tags')
console.log('5. approved 目标 tags 不被 conflict 改写')

console.log('capture-tags 全部通过')
