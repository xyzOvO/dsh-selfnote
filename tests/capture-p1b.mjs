/**
 * P1-B 验收：把评审列的 8 条逐条落成断言。
 * 跑法：node tests/capture-p1b.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-p1b-'))
process.env.DSH_SELFNOTE_DIR = dir

const capture = await import('../lib/capture.js')
const run = await import('../lib/capture-run.js')

const factsFile = join(dir, 'facts.jsonl')
let facts = []

function readFacts() {
  return JSON.parse(JSON.stringify(facts))
}

function writeFacts(next) {
  facts = next
  writeFileSync(factsFile, next.map((fact) => JSON.stringify(fact)).join('\n') + (next.length ? '\n' : ''))
}

function userEvent(text, seq, kind = 'user') {
  return { type: 'user/message', seq, data: { content: [{ type: 'text', text }], source: { kind } } }
}

/* 1. 同会话串行：后到的先完成，也不能插到前面 */
const order = []
await Promise.all([
  capture.enqueue('s1', async () => {
    await new Promise((r) => setTimeout(r, 30))
    order.push('first')
  }),
  capture.enqueue('s1', async () => {
    order.push('second')
  }),
  capture.enqueue('s1', async () => {
    order.push('third')
  }),
])
assert.deepEqual(order, ['first', 'second', 'third'], '同一会话必须按到达顺序串行')
console.log('1. 同会话串行：慢任务不会被打乱')

/* 2. 跨会话并发：两个会话同时推进游标，不能互相覆盖 */
await Promise.all([
  capture.markSeenLocked('a', 5),
  capture.markSeenLocked('b', 9),
  capture.markSeenLocked('c', 1),
])
const cursor = capture.readCursor()
assert.equal(Number(cursor.a), 5)
assert.equal(Number(cursor.b), 9)
assert.equal(Number(cursor.c), 1)
console.log('2. 跨会话并发写游标：三条都在')

/* 3. seq 从 0 开始：第一条不能被当成「已处理」 */
assert.equal(capture.alreadySeen('fresh', 0), false)
assert.equal(capture.alreadySeen('fresh', 0, { fresh: 0 }), true)
assert.equal(capture.alreadySeen('fresh', 1, { fresh: 0 }), false)
console.log('3. seq=0 的第一条会被处理')

/* 4. 普通合并：只加证据，不动状态 */
facts = [{ id: 'f1', text: '以后回答都用中文', status: 'candidate', occurrences: 1, evidence: ['old#1'] }]
let result = await run.handleEvent(userEvent('以后回答都用中文', 2), { sessionId: 's1', readFacts, writeFacts })
assert.equal(result.handled, true)
assert.equal(facts.length, 1, '合并不能新建一条')
assert.equal(facts[0].occurrences, 2)
assert.equal(facts[0].status, 'candidate', '合并不能改状态')
assert.equal(facts[0].evidence.length, 2)
console.log('4. 普通合并只加证据')

/* 5. 冲突：两条 candidate + 双向 similarTo */
facts = [{ id: 'f2', text: '以后回答要详细', status: 'candidate', evidence: ['x#1'] }]
result = await run.handleEvent(userEvent('以后回答要简洁', 3), { sessionId: 's2', readFacts, writeFacts })
assert.equal(result.plan.conflicts.length, 1)
const a = facts.find((fact) => fact.id === 'f2')
const b = facts.find((fact) => fact.conflictWith === 'f2')
assert.ok(b, '应当新建一条冲突候选')
assert.equal(a.conflictWith, b.id, '双向关联')
assert.equal(a.similarTo.includes(b.id), true)
assert.equal(b.similarTo.includes('f2'), true)
console.log('5. 冲突双写 + 双向 similarTo')

/* 6. 已采纳的事实：只被指向，不被改写 */
facts = [{ id: 'f3', text: '以后回答要详细', status: 'approved', occurrences: 7, evidence: ['y#1'], importance: 3 }]
const snapshot = JSON.parse(JSON.stringify(facts[0]))
result = await run.handleEvent(userEvent('以后回答要简洁', 4), { sessionId: 's3', readFacts, writeFacts })
const approved = facts.find((fact) => fact.id === 'f3')
assert.deepEqual(approved, snapshot, 'approved 一个字节都不能改')
const linked = facts.find((fact) => fact.similarTo?.includes('f3'))
assert.ok(linked, '新候选要指回已采纳事实')
assert.equal(linked.status, 'candidate')
console.log('6. 已采纳事实不被复制、不被改写')

/* 7. 批量写入失败：不落半条、游标不前进 */
facts = [{ id: 'f4', text: '以后回答要详细', status: 'candidate', evidence: ['z#1'] }]
const seqBefore = Number(capture.readCursor().s4 ?? -1)
let threw = false
try {
  await run.handleEvent(userEvent('以后回答要简洁', 8), {
    sessionId: 's4',
    readFacts,
    writeFacts: () => {
      throw new Error('磁盘满了')
    },
  })
} catch {
  threw = true
}
assert.equal(threw, true, '写失败要抛给上层记日志')
assert.equal(Number(capture.readCursor().s4 ?? -1), seqBefore, '写失败时游标不动')
assert.equal(facts.length, 1, '没有留下半条冲突')
console.log('7. 批量写失败：不留半条，游标不推进')

/* 8. 游标损坏的三种形态：语法错 / 数组 / 值不是整数 */
for (const [label, payload] of [
  ['语法错', '{not json'],
  ['数组', '[]'],
  ['值非整数', '{"s1":"oops"}'],
]) {
  writeFileSync(capture.cursorPath(), payload)
  let error = null
  try {
    capture.readCursor()
  } catch (caught) {
    error = caught
  }
  assert.equal(error?.name, 'CursorCorruptError', label + ' 应当报损坏')
  assert.equal(existsSync(error.backup), true, label + ' 应当留下备份')
}
console.log('8. 游标损坏：备份 + 报错，不静默重来')

/* 9. 重放：候选已写、游标丢失 → 按 source 跳过，不重复写 */
writeFileSync(capture.cursorPath(), '{}')
facts = []
const ev = userEvent('以后回答都用中文', 6)
await run.handleEvent(ev, { sessionId: 's5', readFacts, writeFacts })
const afterFirst = facts.length
writeFileSync(capture.cursorPath(), '{}') // 模拟游标丢失
const replay = await run.handleEvent(ev, { sessionId: 's5', readFacts, writeFacts })
assert.equal(facts.length, afterFirst, '重放不能重复写候选')
assert.equal(replay.handled, false)
assert.equal(replay.reason, 'source')
console.log('9. source 幂等：游标丢了也不会重复写')

/* 10. 非本人发言 / 没有候选：都不采 */
facts = []
const injected = await run.handleEvent(userEvent('以后回答都用中文', 7, 'system-prompt'), {
  sessionId: 's6', readFacts, writeFacts,
})
assert.equal(injected.handled, false)
const chat = await run.handleEvent(userEvent('今天天气不错', 8), { sessionId: 's6', readFacts, writeFacts })
assert.equal(chat.handled, false)
assert.equal(facts.length, 0)
assert.equal(Number(capture.readCursor().s6), 8, '没候选也要推进游标')
console.log('10. 注入内容与闲聊都不采，但游标照常前进')

console.log('\n10 组断言全部通过（data dir: ' + dir + '）')
process.exit(0)
