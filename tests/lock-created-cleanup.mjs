/**
 * 批4 复审 Minor #4 回归：三处锁创建（memory 事实锁 / memory 习惯锁 / relation 锁）
 * 在 openSync(file,'wx') 成功后若写 pid 抛错，必须只删自己刚创建的锁文件，
 * 绝不能在 EEXIST 分支删掉别人持有的锁。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const memSource = readFileSync(fileURLToPath(new URL('../lib/memory.js', import.meta.url)), 'utf8')
const relSource = readFileSync(fileURLToPath(new URL('../lib/relation.js', import.meta.url)), 'utf8')

// memory.js 有两把锁：facts/episodes(acquireLock) 与 habits(acquireHabitLock)
const memLocks = memSource.split(/function acquire(?:Habit)?Lock\(/).slice(1)
assert.equal(memLocks.length, 2, 'memory.js 应有两处 acquire*Lock')
for (const [i, body] of memLocks.entries()) {
  assert.match(body, /let\s+created\s*=\s*false/, `memory lock#${i}: 需 created 标志`)
  assert.match(
    body,
    /openSync\(file,\s*['"]wx['"]\)[\s\S]*?created\s*=\s*true[\s\S]*?if\s*\(\s*created\s*\)\s*\{[\s\S]*?unlinkSync\(file\)/,
    `memory lock#${i}: 建锁后异常必须只删自己创建的锁`,
  )
}
assert.match(
  relSource,
  /function acquireLock\([\s\S]*?let\s+created\s*=\s*false[\s\S]*?openSync\(file,\s*['"]wx['"]\)[\s\S]*?created\s*=\s*true[\s\S]*?if\s*\(\s*created\s*\)\s*\{[\s\S]*?unlinkSync\(file\)/,
  'relation lock: 建锁后异常必须只删自己创建的锁',
)
console.log('三处锁创建失败清理只删自己创建的锁')
