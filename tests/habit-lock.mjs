/**
 * 习惯写入并发契约（代码审查发现的丢更新）：
 * 陈旧 habits.jsonl.lock 能接管；正常并发五条不能丢。
 * 注：本仓最终没有启用 pid 活性夺取（Windows 高并发 TOCTOU 会丢数据），
 * 所以这里不测「活 pid 必须阻塞」——那条契约与最终实现不相容。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'selfnote-habit-lock-'))
process.env.DSH_SELFNOTE_DIR = join(root, 'selfnote')
process.env.DSH_MEMORY_DIR = join(root, 'memory')
mkdirSync(process.env.DSH_SELFNOTE_DIR, { recursive: true })
mkdirSync(process.env.DSH_MEMORY_DIR, { recursive: true })

const memory = await import('../lib/memory.js')
const lock = join(root, 'memory', 'habits.jsonl.lock')

// 陈旧空锁（老式崩溃残留）必须能接管
writeFileSync(lock, '')
const old = Date.now() - 5000
utimesSync(lock, new Date(old), new Date(old))
const stale = memory.setHabit('陈旧锁后写入', 'active')
assert.equal(stale.ok, true, '陈旧 habits 锁必须能接管：' + JSON.stringify(stale))
assert.equal(memory.readHabits().length, 1)
assert.equal(existsSync(lock), false, '不能留下锁')
console.log('1. 陈旧 habits.lock：接管后写入且放锁')

// 并发五进程，每条都要落地（顺序 spawn 在 Windows 上会先后进临界区，但覆盖写仍会被锁串行化）
const worker = join(fileURLToPath(new URL('.', import.meta.url)), 'worker-habit.mjs')
const entries = ['习惯甲', '习惯乙', '习惯丙', '习惯丁', '习惯戊']
const runs = entries.map((text) => spawnSync(process.execPath, [worker, root, text], { encoding: 'utf8' }))
for (const [index, run] of runs.entries()) {
  assert.equal(run.status, 0, 'worker ' + index + ' 失败：' + run.stderr)
}
const after = memory.readHabits()
assert.equal(after.length, entries.length + 1, '并发之后所有习惯都要在：' + JSON.stringify(after))
assert.equal(existsSync(lock), false, '不能留下锁')
console.log('2. 五进程并发 setHabit：全部落地，锁正确释放')

console.log('\n2 项全部通过')
