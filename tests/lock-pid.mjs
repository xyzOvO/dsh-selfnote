/**
 * 锁文件的稳定性契约：锁内写的是持有者 pid，陈旧锁仍按 mtime 自愈。
 * 不启用「进程已死就立刻夺取」：pid 检查与 unlink 之间有 TOCTOU 竞态，
 * 实测会让并发写入互相覆盖（见最终报告）。
 *
 * 复审修正：原来第 1/3 项预置 fresh placeholder 后只断言 changed:false，
 * 回调根本没进临界区（acquireLock 夺不到 fresh 锁）——假阳性。
 * 现在让回调真的进临界区（observed=true、changed:true）再断言。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'selfnote-lockpid-'))
process.env.DSH_SELFNOTE_DIR = join(root, 'selfnote')
process.env.DSH_MEMORY_DIR = join(root, 'memory')
mkdirSync(process.env.DSH_SELFNOTE_DIR, { recursive: true })
mkdirSync(process.env.DSH_MEMORY_DIR, { recursive: true })

const memory = await import('../lib/memory.js')
const relation = await import('../lib/relation.js')

// 1. 正常拿锁时，锁文件内容是本进程 pid，且回调真的进了临界区
const facts = memory.factsPath() + '.lock'
try { unlinkSync(facts) } catch {}
let observed = false
const seen = memory.mutateFacts(() => {
  observed = true
  assert.equal(readFileSync(facts, 'utf8').trim(), String(process.pid), '锁内容必须是持有者 pid')
  return { changed: true }
}, 1, 20)
assert.equal(observed, true, '回调必须真的进了临界区')
assert.equal(seen.changed, true, '回调的 changed 必须传出来')
console.log('1. 回调进临界区 + 锁内记录持有者 pid')

// 2. 老式空锁仍需按 2 秒 mtime 自愈（保留旧测试契约）
writeFileSync(facts, '')
const before = Date.now() - 5000
utimesSync(facts, new Date(before), new Date(before))
const stale = memory.mutateFacts((items) => {
  items.push({ id: 'stale-lock', text: '陈旧锁自愈' })
  return { changed: true }
}, 1, 20)
assert.equal(stale.changed, true, '陈旧空锁必须能接管：' + JSON.stringify(stale))
console.log('2. 陈旧空锁按 mtime 自愈')

// 3. topic 锁同样：回调真的进临界区 + 锁内 pid
const topicLock = relation.topicPath() + '.lock'
try { unlinkSync(topicLock) } catch {}
let topicObserved = false
const topic = relation.mutateTopics(() => {
  topicObserved = true
  assert.equal(readFileSync(topicLock, 'utf8').trim(), String(process.pid))
  return { changed: false }
}, 1, 20)
assert.equal(topicObserved, true, 'topic 回调必须真的进临界区')
assert.equal(topic.changed, false)
console.log('3. topic 锁：回调进临界区 + 锁内 pid')

console.log('\n3 项全部通过')
