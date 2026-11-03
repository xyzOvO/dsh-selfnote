/**
 * 量一下热路径上那些「每条消息都发生一次」的写盘到底多少钱：
 *   1. 采集游标（每条用户消息写一次，带 fsync）
 *   2. facts.jsonl 原子写
 * 只写临时目录，不碰真实记忆。
 * 跑法：node tests/perf-writes.mjs
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'selfnote-perf-writes-'))
process.env.DSH_MEMORY_DIR = join(root, 'memory')
mkdirSync(process.env.DSH_MEMORY_DIR, { recursive: true })

const { writeAtomic } = await import('../lib/atomic.js')

const target = join(process.env.DSH_MEMORY_DIR, 'cursor.json')
const payload = JSON.stringify({ sessions: { 'sess-1': 128, 'sess-2': 64, 'sess-3': 9 } })

const N = 200
const at = process.hrtime.bigint()
for (let i = 0; i < N; i += 1) writeAtomic(target, payload + i)
const total = Number(process.hrtime.bigint() - at) / 1e6
console.log('原子写（write+fsync+rename）：' + (total / N).toFixed(2) + ' ms/次，共 ' + N + ' 次')
console.log('每条用户消息一次的话：一分钟 10 句 ≈ ' + ((total / N) * 10).toFixed(0) + ' ms/分钟')
