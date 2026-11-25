/**
 * 批4 复审 Minor 回归：POST /import 拿到习惯锁后，readNotes/listFacts/readHabits/
 * mergeBundle 这些同步读若抛错（EACCES/磁盘错），必须在异常路径 unlink 掉 habitLockFile，
 * 否则锁泄漏到 2s stale 才自愈——期间 import 全 409、setHabit 延迟。
 * 手法：源码结构断言（仓库既有 lock-created-cleanup / atomic-wx-cleanup 同风格），
 * 锁定"拿锁后的同步读被 try 包住且 catch 里 unlink 再抛"这个不变量。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

assert.match(
  src,
  /const habitLockFile = acquireHabitLock\([\s\S]*?\n[ \t]*let before[, ]+merged\b[\s\S]*?\n[ \t]*try \{[\s\S]*?\n[ \t]*before = \{[\s\S]*?\n[ \t]*merged = mergeBundle\([\s\S]*?\n[ \t]*\} catch \(error\) \{[\s\S]*?unlinkSync\(habitLockFile\)[\s\S]*?throw error/,
  '拿习惯锁后的同步读必须包在 try 内，异常时 unlink 锁再抛',
)
console.log('/import 拿锁后的同步读异常路径会释放习惯锁')
