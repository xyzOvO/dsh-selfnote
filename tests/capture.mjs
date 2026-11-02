/**
 * P1-A 测试：触发判定、候选抽取、相似但反向不合并、游标幂等。
 * 跑法：node tests/capture.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-capture-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')

const capture = await import('../lib/capture.js')

/* 1. 普通聊天不触发 */
assert.deepEqual(capture.triggersOf('今天天气不错'), [])
assert.deepEqual(capture.triggersOf('帮我看看这个报错'), [])
assert.deepEqual(capture.triggersOf(''), [])
console.log('1. 普通聊天不触发')

/* 2. 四类触发认得出来 */
assert.ok(capture.triggersOf('以后都用中文回复').includes('standing'))
assert.ok(capture.triggersOf('不要再用 emoji 了').includes('prohibit'))
assert.ok(capture.triggersOf('我更喜欢先给结论').includes('prefer'))
assert.ok(capture.triggersOf('你刚才说得不对，应该先问清楚').includes('correct'))
console.log('2. 四类触发都认得（长期 / 禁止 / 偏好 / 纠正）')

/* 3. 一条消息里只挑命中触发的句子 */
const mixed = '这个报错我看过了。以后回答别超过三句话。另外今天有点热。'
const picked = capture.candidatesOf(mixed)
assert.equal(picked.length, 1)
assert.ok(picked[0].includes('以后回答别超过三句话'))
console.log('3. 只挑出相关的句子：' + picked[0])

/* 4. 相似但相反的不能合并 */
const concise = '以后回答尽量简洁'
const verbose = '以后回答尽量详细'
assert.ok(capture.similarity(concise, verbose) > 0.5, '词面确实很像：' + capture.similarity(concise, verbose))
assert.equal(capture.compareCandidate(verbose, concise).action, 'conflict')
console.log('4. 简洁 / 详细 判冲突，不合并（相似度 ' + capture.similarity(concise, verbose).toFixed(2) + '）')

/* 5. 否定方向不同也不合并 */
const like = '我更喜欢用表格'
const noLike = '我不喜欢用表格'
assert.equal(capture.compareCandidate(noLike, like).action, 'conflict')
console.log('5. 喜欢 / 不喜欢 判冲突')

/* 6. 同义重复 → 合并（只合并证据） */
const a = '以后回答尽量简洁一点'
const b = '以后回答再简洁一些'
const merged = capture.compareCandidate(b, a)
assert.equal(merged.action, 'merge', '相似度 ' + merged.score.toFixed(2))
console.log('6. 同义重复合并（相似度 ' + merged.score.toFixed(2) + '）')

/* 7. 不相似 → 新候选 */
assert.equal(capture.compareCandidate('不要再给 emoji', '以后用中文').action, 'new')
console.log('7. 不相干的是新候选')

/* 8. 候选抽取有长度上限，短句和长段都不收 */
assert.deepEqual(capture.candidatesOf('哦'), [])
assert.deepEqual(capture.candidatesOf('以后' + '很'.repeat(300)), [])
console.log('8. 过短过长都不收')

/* 9. 游标幂等：同一条 seq 不会处理两次 */
assert.equal(capture.alreadySeen('s1', 10), false)
capture.markSeen('s1', 10)
assert.equal(capture.alreadySeen('s1', 10), true, '同一 seq 应当视为已处理')
assert.equal(capture.alreadySeen('s1', 9), true, '更小的 seq 也是旧的')
assert.equal(capture.alreadySeen('s1', 11), false, '新的 seq 应当处理')
assert.equal(capture.alreadySeen('s2', 11), false, '不同会话互不影响')
console.log('9. 游标按 seq 幂等，不同会话互不干扰')

/* 10. 游标只前进，不回退 */
capture.markSeen('s1', 5)
assert.equal(Number(capture.readCursor().s1), 10, '旧 seq 不该把游标拉回去')
console.log('10. 游标只前进')

console.log('\n10 项全部通过')
process.exit(0)
