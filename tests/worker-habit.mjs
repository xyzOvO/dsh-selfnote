/**
 * habit-lock.mjs 的子进程：另一个窗口同时 setHabit。
 */
import { join } from 'node:path'

const [dir, text] = process.argv.slice(2)
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
const memory = await import('../lib/memory.js')
const result = memory.setHabit(text, 'active', '并发')
if (!result.ok) throw new Error('setHabit 失败：' + JSON.stringify(result))
