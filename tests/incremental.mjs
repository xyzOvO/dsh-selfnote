/**
 * 增量解析的测试：只解新追加的帧，行号要接上，任何「不认识的形状」都要退回全量而不是读错。
 * 跑法：node tests/incremental.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'selfnote-incr-'))
process.env.DSH_SESSIONS_DIR = join(root, 'sessions')
process.env.DSH_MEMORY_DIR = join(root, 'memory')

const memory = await import('../lib/memory.js')

let passed = 0
function ok(label) {
  passed += 1
  console.log(passed + '. ' + label)
}

/** 一帧 = 一次写入；DSH 就是这么追写的。 */
function frame(lines) {
  return zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8'))
}

function userMsg(text) {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] }, time: Date.now() }
}
function botMsg(text) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } }, time: Date.now() }
}

const project = 'p1'
const id = 'sess-1'
const dir = join(process.env.DSH_SESSIONS_DIR, project, id)
mkdirSync(dir, { recursive: true })
const file = join(dir, 'session.v4.jsonl.zstd')

let bytes = Buffer.concat([
  frame([userMsg('第一句')]),
  frame([botMsg('第二句')]),
  frame([userMsg('第三句')]),
])
writeFileSync(file, bytes)

const sessionOf = () => ({ id, project, file, mtime: statSync(file).mtimeMs })
const read = () => memory.readSession(sessionOf())

/* 1. 全量首次解析 */
let out = read()
assert.equal(out.failed, false)
assert.deepEqual(out.records.map((r) => r.text), ['第一句', '第二句', '第三句'])
assert.equal(out.records[0].role, 'user')
assert.equal(out.records[1].role, 'assistant')
assert.equal(out.end, bytes.length, '解析完要记住停在哪（下次从这里接着解）')
ok('首次解析：三帧解出三条，记下了帧边界')

/* 2. 追加一帧：只解新增那帧，行号接着走 */
bytes = Buffer.concat([bytes, frame([botMsg('第四句')])])
writeFileSync(file, bytes)
out = read()
assert.deepEqual(out.records.map((r) => r.text), ['第一句', '第二句', '第三句', '第四句'])
assert.equal(out.end, bytes.length)
const indexes = out.records.map((r) => r.index)
assert.equal(new Set(indexes).size, indexes.length, '行号不能撞车，否则出处指错人')
assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), '行号要递增')
assert.equal(indexes[3], 3, '第四句在第 4 行（index 3），累计行号要接上、不能错开一格')
ok('追写一帧：只解新帧，行号从上次结尾接着数')

/* 3. 没变过：不重解，直接给缓存 */
const first = read()
assert.equal(first.end, bytes.length)
assert.deepEqual(first.records.map((r) => r.text), out.records.map((r) => r.text))
ok('文件没变：走缓存，不用再解一遍')

/* 4. 前缀被改写（不是追写）：必须退回全量解析，不能拿旧的拼 */
const rewritten = Buffer.concat([frame([userMsg('换了个开头')]), frame([botMsg('换了个结尾')])])
writeFileSync(file, rewritten)
out = read()
assert.deepEqual(out.records.map((r) => r.text), ['换了个开头', '换了个结尾'], '文件被重写完，旧记录必须丢掉')
ok('文件被改写：指纹对不上就全量重解，不拼旧数据')

/* 5. 尾巴写了一半：已解出的照给，不算失败 */
bytes = Buffer.concat([rewritten, frame([userMsg('第五句')])])
const half = frame([botMsg('第六句')])
writeFileSync(file, Buffer.concat([bytes, half.subarray(0, Math.floor(half.length / 2))]))
out = read()
assert.equal(out.failed, false, '尾巴半帧不该把整个会话判成解不开')
assert.deepEqual(out.records.map((r) => r.text), ['换了个开头', '换了个结尾', '第五句'])
assert.ok(out.end < statSync(file).size, '停在半帧之前，等它写完')
ok('尾巴半帧：先给已经解出来的，位置停在半帧前')

/* 6. 那半帧补齐：接着解出来，不漏 */
writeFileSync(file, Buffer.concat([bytes, half]))
out = read()
assert.deepEqual(out.records.map((r) => r.text), ['换了个开头', '换了个结尾', '第五句', '第六句'])
ok('半帧补完：从上次停的地方接着解，一条不漏')

/* 7. 委派会话：增量解析也要认得出 subagent/descriptor */
const ddir = join(process.env.DSH_SESSIONS_DIR, project, 'sess-2')
mkdirSync(ddir, { recursive: true })
const df = join(ddir, 'session.v4.jsonl.zstd')
let dbuf = Buffer.concat([
  frame([{ type: 'subagent/descriptor', data: {} }, userMsg('委派任务书')]),
])
writeFileSync(df, dbuf)
let dout = memory.readSession({ id: 'sess-2', project, file: df, mtime: statSync(df).mtimeMs })
assert.equal(dout.delegated, true)
assert.equal(dout.records[0].role, 'delegated')
dbuf = Buffer.concat([dbuf, frame([userMsg('委派方又说了句')])])
writeFileSync(df, dbuf)
dout = memory.readSession({ id: 'sess-2', project, file: df, mtime: statSync(df).mtimeMs })
assert.equal(dout.delegated, true, '增量批次里没有 descriptor，也要沿用上次的判断')
assert.deepEqual(dout.records.map((r) => r.role), ['delegated', 'delegated'])
ok('委派会话：增量批次沿用上次的委派判断，不会把任务书当成本人原话')

/* 8. 彻底坏掉的文件：如实报失败，不当成空会话 */
const bdir = join(process.env.DSH_SESSIONS_DIR, project, 'sess-3')
mkdirSync(bdir, { recursive: true })
const bf = join(bdir, 'session.v4.jsonl.zstd')
writeFileSync(bf, Buffer.from('这不是 zstd，是一段普通文本'.repeat(20), 'utf8'))
const bout = memory.readSession({ id: 'sess-3', project, file: bf, mtime: statSync(bf).mtimeMs })
assert.equal(bout.failed, true, '解不开就要说解不开')
ok('坏文件：一帧都没解出来就报 failed，不装成空会话')

console.log('\n' + passed + ' 项全部通过（data dir: ' + root + '）')
