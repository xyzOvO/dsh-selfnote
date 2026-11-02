/**
 * facts.jsonl 的写事务：拿锁 → 读 → 改 → 写，跨进程互斥，放弃时不留半份。
 * 跑法：node tests/facts-tx.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-tx-'))
process.env.DSH_MEMORY_DIR = join(dir, 'memory')

const { mutateFacts, readFacts, writeFacts, touchFacts, setFactStatus } = await import('../lib/memory.js')

const factsFile = join(process.env.DSH_MEMORY_DIR, 'facts.jsonl')
const lockFile = factsFile + '.lock'
const seed = (facts) => writeFacts(facts)

/* 1. 基本形状：changed:false 不写盘 */
seed([{ id: 'a', text: '以后回答先给结论', status: 'approved', hitCount: 0 }])
const before = readFileSync(factsFile, 'utf8')
const noop = mutateFacts(() => ({ changed: false }))
assert.equal(noop.changed, false)
assert.equal(readFileSync(factsFile, 'utf8'), before, '没改动就不该落盘')
console.log('1. changed:false 不写文件，也不留锁')

/* 2. 注入记热度不能把已有候选抹掉 */
seed([
  { id: 'a', text: '以后回答先给结论', status: 'approved', hitCount: 0 },
  { id: 'b', text: '以后别用表情', status: 'candidate' },
])
touchFacts(['a'])
let facts = readFacts()
assert.equal(facts.find((f) => f.id === 'a').hitCount, 1)
assert.ok(facts.find((f) => f.id === 'b'), '候选不该被热度的整份写回覆盖')
console.log('2. 记热度不覆盖已有候选')

/* 3. 锁被别的进程占着：重试后放弃，绝不写半份 */
seed([{ id: 'a', text: '以后回答先给结论', status: 'approved', hitCount: 0 }])
writeFileSync(lockFile, '')
const blocked = mutateFacts((current) => {
  current.push({ id: 'mine', text: '我的改动', status: 'candidate' })
  return { changed: true }
}, 2)
assert.equal(blocked.changed, false)
assert.match(blocked.error, /一直被别的进程占着/)
facts = readFacts()
assert.equal(facts.some((fact) => fact.id === 'mine'), false, '放弃时不能留下半份写入')

/* 4. 崩溃遗留的锁（超过 2 秒）可以被接管 */
const stale = new Date(Date.now() - 5000)
utimesSync(lockFile, stale, stale)
const tookOver = mutateFacts((current) => {
  current.push({ id: 'after-stale', text: '接管之后写的', status: 'candidate' })
  return { changed: true }
})
assert.equal(tookOver.changed, true, '陈旧锁必须能接管，否则一次崩溃就永久写不进去')
facts = readFacts()
assert.ok(facts.some((fact) => fact.id === 'after-stale'))
console.log('3. 锁被占 → 放弃不写半份；陈旧锁 → 能接管')

/* 5. 正常写完不留锁文件 */
assert.equal(readFileSync(factsFile, 'utf8').length > 0, true)
assert.throws(() => readFileSync(lockFile, 'utf8'), /ENOENT/, '写完必须把锁放掉')
console.log('4. 写完放锁，不留锁文件')

/* 6. 审核改状态也走同一个事务：找不到 id 时不写盘 */
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
