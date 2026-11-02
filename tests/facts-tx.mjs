/**
 * facts.jsonl 的写事务：读 → 改 → 写 必须是一段同步代码，且不覆盖别人的改动。
 * 跑法：node tests/facts-tx.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-tx-'))
process.env.DSH_MEMORY_DIR = join(dir, 'memory')

const { mutateFacts, readFacts, writeFacts, touchFacts, setFactStatus } = await import('../lib/memory.js')

const factsFile = join(process.env.DSH_MEMORY_DIR, 'facts.jsonl')
const seed = (facts) => writeFacts(facts)

/* 1. 基本形状：changed:false 不写盘 */
seed([{ id: 'a', text: '以后回答先给结论', status: 'approved', hitCount: 0 }])
const before = readFileSync(factsFile, 'utf8')
const noop = mutateFacts(() => ({ changed: false }))
assert.equal(noop.changed, false)
assert.equal(readFileSync(factsFile, 'utf8'), before, '没改动就不该落盘')
console.log('1. changed:false 不写文件')

/* 2. 注入记热度不能把并发写进来的候选抹掉 */
seed([
  { id: 'a', text: '以后回答先给结论', status: 'approved', hitCount: 0 },
  { id: 'b', text: '以后别用表情', status: 'candidate' },
])
touchFacts(['a'])
let facts = readFacts()
assert.equal(facts.find((f) => f.id === 'a').hitCount, 1)
assert.ok(facts.find((f) => f.id === 'b'), '候选不该被热度的整份写回覆盖')
console.log('2. 记热度不覆盖已有候选')

/* 3. 跨进程：读到之后文件被别人改过，要重读重做而不是覆盖 */
seed([{ id: 'a', text: '以后回答先给结论', status: 'approved', hitCount: 0 }])
let injected = false
mutateFacts((current) => {
  const target = current.find((f) => f.id === 'a')
  target.hitCount = 1
  if (!injected) {
    injected = true
    // 模拟另一个窗口：在我们读完之后，它往里写了一条新候选
    const other = readFacts()
    other.push({ id: 'z', text: '以后多用例子', status: 'candidate' })
    writeFacts(other)
  }
  return { changed: true }
})
facts = readFacts()
assert.equal(facts.find((f) => f.id === 'a').hitCount, 1, '自己的改动要落下')
assert.ok(facts.find((f) => f.id === 'z'), '别人的改动不能被覆盖')
console.log('3. 别人先写过 → 重读重做，两边改动都在')

/* 4. 连续被改：宁可失败也不覆盖 */
let rounds = 0
const lost = mutateFacts((current) => {
  current.push({ id: 'mine-' + rounds, text: '我的改动', status: 'candidate' })
  rounds += 1
  const other = readFacts()
  other.push({ id: 'theirs-' + rounds, text: '别人的改动', status: 'candidate' })
  writeFacts(other)
  return { changed: true }
})
assert.equal(lost.changed, false)
assert.match(lost.error, /一直被别的进程改写/)
facts = readFacts()
assert.equal(facts.some((f) => f.id === 'mine-3'), false, '放弃时不能留下半份写入')
console.log('4. 一直被抢先就放弃，不写半份结果')

/* 5. 审核改状态也走同一个事务：找不到 id 时不写盘 */
seed([{ id: 'q', text: '以后回答先给结论', status: 'candidate' }])
const stamp = readFileSync(factsFile, 'utf8')
const miss = setFactStatus('nope', 'approved')
assert.equal(miss.ok, false)
assert.equal(readFileSync(factsFile, 'utf8'), stamp, '找不到 id 不该动文件')
const hit = setFactStatus('q', 'approved', { via: 'settings' })
assert.equal(hit.ok, true)
assert.equal(readFacts()[0].status, 'approved')
console.log('5. setFactStatus 走事务，找不到 id 不动文件')

console.log('\n5 项全部通过（data dir: ' + dir + '）')
process.exit(0)
