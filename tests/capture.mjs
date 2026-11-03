/**
 * P1-A 测试：触发判定、候选抽取、相似但反向不合并、游标幂等。
 * 跑法：node tests/capture.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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
assert.equal(capture.alreadySeen('s1', 9), false, '9 落在空洞里 —— 从没处理过，迟到了也要处理')
assert.equal(capture.alreadySeen('s1', 11), false, '新的 seq 应当处理')
assert.equal(capture.alreadySeen('s2', 11), false, '不同会话互不影响')
console.log('9. 游标按 seq 幂等，不同会话互不干扰')

/* 10. 游标只前进，不回退 */
capture.markSeen('s1', 5)
assert.equal(capture.cursorSeq(capture.readCursor(), 's1'), 10, '旧 seq 不该把游标拉回去')
console.log('10. 游标只前进')

/* 11. 事件过滤：类型和 source.kind 两个都要满足 */
assert.equal(capture.isUserAuthored({ type: 'user/message', data: { source: { kind: 'user' } } }), true)
assert.equal(capture.isUserAuthored({ type: 'user/message', data: { source: { kind: 'system-prompt' } } }), false)
assert.equal(capture.isUserAuthored({ type: 'assistant/message', data: { source: { kind: 'user' } } }), false)
assert.equal(capture.isUserAuthored(null), false)
console.log('11. 只认 user/message + source.kind=user')

/* 12. 提交顺序：写候选失败时游标不许前进 */
let threw = false
try {
  await capture.commitObservation({ sessionId: 's3', seq: 7, text: 'x' }, () => {
    throw new Error('磁盘满了')
  })
} catch {
  threw = true
}
assert.equal(threw, true, '写入失败应当抛出来，交给调用方记日志')
assert.equal(capture.cursorSeq(capture.readCursor(), 's3'), -1, '写失败时游标不能动')
console.log('12. 候选写失败 → 游标不前进')

/* 13. 提交成功 → 游标前进，第二次同样 seq 直接跳过 */
const okOne = await capture.commitObservation({ sessionId: 's3', seq: 7, text: 'x' }, () => 'written')
assert.equal(okOne.skipped, null, '正常提交 skipped 为 null')
assert.equal(capture.cursorSeq(capture.readCursor(), 's3'), 7)
const again = await capture.commitObservation({ sessionId: 's3', seq: 7, text: 'x' }, () => 'written')
assert.equal(again.skipped, 'cursor', '重放同一条应当按游标跳过')
console.log('13. 提交成功推进游标，重复提交跳过')

/* 14. 写成功但游标丢了 → 靠来源去重兜底 */
const facts = [{ id: 'a', source: 's3#7', status: 'candidate' }]
assert.equal(capture.alreadyCaptured(facts, 's3#7'), true)
assert.equal(capture.alreadyCaptured(facts, 's3#8'), false)
console.log('14. 重放时按 source 兜底去重')

/* 14b. 合并过的条目：source 还停在第一次，靠 evidence 认出来 */
const mergedFact = [{ id: 'b', source: 's4#1', evidence: ['s4#1', 's4#9'], occurrences: 2, status: 'candidate' }]
assert.equal(capture.alreadyCaptured(mergedFact, 's4#9'), true, '合并追加的那次也要算已采集')
assert.equal(capture.alreadyCaptured(mergedFact, 's4#10'), false)
console.log('14b. 合并只追加 evidence 时，重放不会再涨 occurrences')

/* 15. 采集门槛：有时间持续但不是给我的要求 → 不采 */
assert.deepEqual(capture.candidatesOf('我以后再也不熬夜了。'), [])
assert.deepEqual(capture.candidatesOf('我以后都不吃辣了。'), [])
assert.equal(capture.hasScope('我以后再也不熬夜了'), false)
console.log('15. 「以后」但不涉及交互要求 → 不采')

/* 16. 同一个触发，涉及回答方式 → 采 */
assert.deepEqual(capture.candidatesOf('以后回答都用中文。'), ['以后回答都用中文。'])
assert.equal(capture.candidatesOf('我希望以后回答更简洁。').length, 1)
assert.equal(capture.candidatesOf('以后提醒我不要熬夜。').length, 1)
console.log('16. 涉及回答/提醒的长期要求 → 采')

/* 17. 方向是集合：一句话里同时有长短与快慢，两个都要抓到 */
const dirs = capture.directionsOf('回答简短点、速度慢一点')
assert.equal(dirs.has('简短'), true)
assert.equal(dirs.has('慢'), true)
assert.equal(dirs.size, 2)
assert.equal(capture.compareCandidate('回答简短点、慢一点', '回答简短点、快一点').action, 'conflict')
console.log('17. 多维度方向集合，能发现第二组冲突')

/* 18. seq 必须是安全的非负整数 */
assert.equal((await capture.commitObservation({ sessionId: 's9', seq: null }, () => 'x')).ok, false)
assert.equal((await capture.commitObservation({ sessionId: 's9', seq: '10' }, () => 'x')).ok, true)
assert.equal((await capture.commitObservation({ sessionId: 's9', seq: -1 }, () => 'x')).ok, false)
assert.equal((await capture.commitObservation({ sessionId: 's9', seq: 1.5 }, () => 'x')).ok, false)
console.log('18. seq 校验：只收非负整数')

/* 19. 游标文件损坏：备份后抛错，不静默从头来 */
const broken = capture.cursorPath()
writeFileSync(broken, '{ this is not json')
let corrupt = null
try {
  capture.readCursor()
} catch (error) {
  corrupt = error
}
assert.equal(corrupt?.name, 'CursorCorruptError')
assert.ok(corrupt.backup.includes('.corrupt-'))
assert.equal(existsSync(broken), false, '坏文件应当被移走')
assert.equal(existsSync(corrupt.backup), true)
console.log('19. 游标损坏：先备份再抛错')

/* 20. commitObservation 传 facts 现读函数时，按 source 跳过且推进游标 */
const beforeSeq = capture.cursorSeq(capture.readCursor(), 's8')
const res = await capture.commitObservation({ sessionId: 's8', seq: beforeSeq + 5 }, () => 'should-not-run', {
  facts: () => [{ id: 'x', source: `s8#${beforeSeq + 5}`, status: 'candidate' }],
})
assert.equal(res.skipped, 'source')
assert.equal(capture.cursorSeq(capture.readCursor(), 's8'), beforeSeq + 5)
console.log('20. 写入路径自己接 source 去重')

/* 21. 会话头判委派：实测据是 origin='subagent' / delegationDepth>0 */
assert.equal(capture.isDelegatedSession({ origin: 'subagent', delegationDepth: 1 }), true, '子代理会话')
assert.equal(capture.isDelegatedSession({ delegationDepth: 2 }), true, '嵌套委派也算')
assert.equal(capture.isDelegatedSession({ delegationDepth: 0 }), false, '真人会话')
assert.equal(capture.isDelegatedSession(undefined), false, '没有会话头不拦')
assert.equal(capture.isDelegatedSession({ parentSession: 'x', delegationDepth: 0 }), false, '分叉会话仍然算本人的')
console.log('21. 委派会话按会话头识别，不看正文标记')

/* 22. 迟到的消息不再被吞：seq 跳号会把中间的记成空洞，迟到时照样处理 */
capture.markSeen('h1', 50)
capture.markSeen('h1', 100)
assert.equal(capture.alreadySeen('h1', 100), true, '刚处理的那条算处理过')
assert.equal(capture.alreadySeen('h1', 99), false, '99 夹在 50 与 100 之间，从没到过，是空洞，要处理')
assert.equal(capture.alreadySeen('h1', 5), false, '第一次见到这个会话时，之前的 seq 都算没处理过')
capture.markSeen('h1', 99)
assert.equal(capture.alreadySeen('h1', 99), true, '补上之后就算处理过')
assert.equal(capture.cursorSeq(capture.readCursor(), 'h1'), 100, '补空洞不拉低高水位')
console.log('22. 迟到的事件落在空洞里 → 照样处理，补完才划掉')

/* 23. 旧格式（只有一个整数）仍然认，语义按老规矩：≤ 高水位的都算处理过 */
assert.equal(capture.alreadySeen('h2', 12, { h2: 12 }), true)
assert.equal(capture.alreadySeen('h2', 11, { h2: 12 }), true, '旧格式没法知道空洞，只能保守跳过')
assert.equal(capture.alreadySeen('h2', 13, { h2: 12 }), false)
console.log('23. 旧游标文件不用迁移也能读')

/* 24. 空洞有上限：跳 8000 个号也不会把游标记爆，超出的当作没处理过 */
capture.markSeen('h3', 8000)
const holes = capture.cursorHoles(capture.readCursor(), 'h3')
assert.equal(holes <= capture.HOLE_WINDOW, true, '空洞数必须被窗口夹住：' + holes)
assert.equal(capture.alreadySeen('h3', 7999), false, '最近的空洞留着')
console.log('24. 空洞最多留 ' + capture.HOLE_WINDOW + ' 个，实际 ' + holes + ' 个')

console.log('\n25 项全部通过')
process.exit(0)
