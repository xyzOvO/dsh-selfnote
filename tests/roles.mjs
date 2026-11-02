/**
 * 角色归属的边界测试：工具输出回声不能被当成「他本人说的」。
 *
 * 判据只看结构，不看文本：
 *   - 会话里出现 subagent/descriptor → 这个会话是子代理会话，里面的 user/message 是委派方写的任务书；
 *   - 真正的工具输出是 tool/result 记录，本来就不进检索。
 *
 * 跑法：node tests/roles.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'selfnote-roles-'))
process.env.DSH_SESSIONS_DIR = join(root, 'sessions')
process.env.DSH_MEMORY_DIR = join(root, 'memory')

const memory = await import('../lib/memory.js')
const store = await import('../lib/index-store.js')

const SESSIONS = process.env.DSH_SESSIONS_DIR

function writeSession(id, records) {
  const dir = join(SESSIONS, 'proj', id)
  mkdirSync(dir, { recursive: true })
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(body, 'utf8')))
  return file
}

const userMsg = (seq, text, source = { kind: 'user' }) => ({
  type: 'user/message',
  seq,
  time: 1762300000000 + seq,
  data: { content: [{ type: 'text', text }], role: 'user', ...(source === null ? {} : { source }) },
})

const PHRASE = '工具输出回声会污染检索结果'

/* 1. 真人会话：他说了一句，正好是这个句子 */
const humanFile = writeSession('session-human', [
  { type: 'session', seq: 0, data: { id: 'session-human' } },
  userMsg(1, PHRASE + '，这句是我自己打的。'),
])

/* 2. 子代理会话：同样的句子出现在委派任务书里（模拟回声） */
const subFile = writeSession('session-sub', [
  { type: 'session', seq: 0, data: { id: 'session-sub' } },
  { type: 'subagent/descriptor', seq: 1, data: { agent: 'reviewer', task: 'review' } },
  userMsg(2, '[dsh-mnemon:delegated review]\n' + PHRASE + '：请复核这段结论。'),
  userMsg(3, '这是另一个子代理提示，也含同样的字。'),
])

/* 3. 会话里只有真正的 tool/result（带 <content> 结构） */
writeSession('session-tool', [
  { type: 'session', seq: 0, data: { id: 'session-tool' } },
  {
    type: 'tool/result',
    seq: 1,
    time: 1762300500000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'call_1' },
        toolCallId: 'call_1',
        content: [{ type: 'text', text: '<content> Created file ' + PHRASE + ' </content>' }],
      },
    },
  },
])

/* 4. 缺 source 字段的 user 消息：不能因为「缺元数据」被丢掉 */
const noSourceFile = writeSession('session-nosource', [
  { type: 'session', seq: 0, data: { id: 'session-nosource' } },
  userMsg(1, '用户主动讨论 tool/result 的时候，别把我这句过滤掉。', null),
])

/* ---------- 原始文件指纹，后面用来证明没被改过 ---------- */
const fingerprint = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const files = { humanFile, subFile, noSourceFile }
const before = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fingerprint(file)]))

/* 1. 子代理会话被标成 delegated */
const sub = memory.readSession(memory.listSessions().find((s) => s.id === 'session-sub'))
assert.equal(sub.delegated, true)
assert.equal(sub.records[0].role, 'delegated', '委派任务书不该算成他的原话')
assert.equal(sub.records[1].role, 'delegated')
console.log('1. 子代理会话里的 user 消息被标成 delegated（' + sub.records.length + ' 条）')

/* 2. 真人会话还是 user */
const human = memory.readSession(memory.listSessions().find((s) => s.id === 'session-human'))
assert.equal(human.delegated, false)
assert.equal(human.records[0].role, 'user')
console.log('2. 真人会话保持 role=user')

/* 3. 缺 source 的消息不被丢 */
const noSource = memory.readSession(memory.listSessions().find((s) => s.id === 'session-nosource'))
assert.equal(noSource.records.length, 1, '缺 source 字段不能当噪音删掉')
assert.equal(noSource.records[0].role, 'user')
console.log('3. 缺 source 元数据的用户消息仍在')

/* 4. tool/result 不进检索记录 */
const toolSession = memory.readSession(memory.listSessions().find((s) => s.id === 'session-tool'))
assert.equal(toolSession.records.length, 0, 'tool/result 本来就不该被当成对话记录')
console.log('4. tool/result 不进入检索记录')

/* 5. 同一句话：他本人的排第一，委派提示在后 */
const result = memory.searchRaw(PHRASE, { limit: 5 })
assert.ok(result.hits.length >= 2, '应该同时命中两个会话')
assert.equal(result.hits[0].session, 'session-human', '他本人说的话必须排第一')
assert.equal(result.hits[0].role, 'user')
const delegatedHit = result.hits.find((hit) => hit.session === 'session-sub')
assert.equal(delegatedHit.role, 'delegated')
assert.ok(result.hits[0].score > delegatedHit.score, '原话权重必须高于委派提示')
console.log('5. 原话排第一，委派提示权重降级（' + result.hits[0].score + ' vs ' + delegatedHit.score + '）')

/* 6. 索引里角色也分得开 */
const index = store.buildIndex()
const roles = index.records.filter((record) => record.s === 'session-sub').map((record) => record.r)
assert.ok(roles.every((role) => role === 'd'), '索引里子代理会话应记为 d')
const humanRoles = index.records.filter((record) => record.s === 'session-human').map((record) => record.r)
assert.ok(humanRoles.every((role) => role === 'u'))
console.log('6. 索引记录区分 u / d')

/* 7. 走索引查同一句话，排名顺序不变 */
const found = store.queryIndex(index, store.indexTerms(PHRASE))
const viaIndex = memory.searchByIds(store.hitKeys(index, found.ids), PHRASE, { limit: 5 })
assert.equal(viaIndex.hits[0].session, 'session-human', '索引这条路也要把原话排前面')
console.log('7. 索引检索的排名与原话一致')

/* 8. 原始会话文件一字节没动 */
for (const [key, file] of Object.entries(files)) {
  assert.equal(fingerprint(file), before[key], key + ' 被改动了')
}
console.log('8. 原始会话文件指纹未变（只读）')

/* 9. 重建索引后仍能看到委派会话（不是被删掉，只是降权） */
assert.ok(index.records.some((record) => record.s === 'session-sub'), '降权不等于丢弃')
console.log('9. 委派会话仍在索引里，只是标成 d')

console.log('\n9 项全部通过')
process.exit(0)
