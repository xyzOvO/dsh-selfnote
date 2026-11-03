/**
 * 增量解析的真实收益：拿最大的一个真会话，量「全量解一遍」和「只解新追加的那一帧」。
 * 只读真会话目录，副本和缓存放临时目录，不动真实记忆。
 * 跑法：node tests/perf-incremental.mjs
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const realSessions = join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', 'sessions')
const root = mkdtempSync(join(tmpdir(), 'selfnote-perf-incr-'))
process.env.DSH_MEMORY_DIR = join(root, 'memory')
process.env.DSH_SESSIONS_DIR = join(root, 'sessions')

const memory = await import('../lib/memory.js')

// 找最大的会话
let best = null
for (const project of readdirSync(realSessions, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  const pdir = join(realSessions, project.name)
  for (const session of readdirSync(pdir, { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const file = join(pdir, session.name, 'session.v4.jsonl.zstd')
    try {
      const size = statSync(file).size
      if (!best || size > best.size) best = { file, size, id: session.name, project: project.name }
    } catch {}
  }
}
if (!best) {
  console.log('没有找到真会话，跳过')
  process.exit(0)
}

const dir = join(root, 'sessions', best.project, best.id)
mkdirSync(dir, { recursive: true })
const copy = join(dir, 'session.v4.jsonl.zstd')
copyFileSync(best.file, copy)

const session = () => ({ id: best.id, project: best.project, file: copy, mtime: statSync(copy).mtimeMs })

function ms(fn) {
  const at = process.hrtime.bigint()
  const out = fn()
  return { ms: Number(process.hrtime.bigint() - at) / 1e6, out }
}

const full = ms(() => memory.readSession(session()))
// 追加一帧（相当于又聊了一轮）
const frame = zstdCompressSync(
  Buffer.from(
    JSON.stringify({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '又聊一句' }] }, time: Date.now() }) + '\n',
    'utf8',
  ),
)
appendFileSync(copy, frame)
const incr = ms(() => memory.readSession(session()))
appendFileSync(copy, frame)
const incr2 = ms(() => memory.readSession(session()))

console.log('会话：' + best.id + '（' + (best.size / 1024 / 1024).toFixed(1) + ' MB，记录 ' + full.out.records.length + ' 条）')
console.log('全量解析：' + full.ms.toFixed(0) + ' ms')
console.log('追加一帧后（增量）：' + incr.ms.toFixed(0) + ' ms，记录 ' + incr.out.records.length + ' 条')
console.log('再追加一帧（增量）：' + incr2.ms.toFixed(0) + ' ms，记录 ' + incr2.out.records.length + ' 条')
console.log('省下：' + (100 - (incr.ms / full.ms) * 100).toFixed(0) + '%')
