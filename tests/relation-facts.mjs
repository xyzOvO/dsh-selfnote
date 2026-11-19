/**
 * 关系记忆 Task 2：facts 加 episodeId/topicId 外键（二选一互斥）、version 版本号、attachFact 单挂点。
 * 造一个假会话目录让 stageFact 的 citation 能核回，验证三条链路。
 * 跑法：node tests/relation-facts.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'selfnote-relfacts-'))
const sessions = join(root, 'sessions')
const cache = join(root, 'memory')

process.env.DSH_SESSIONS_DIR = sessions
process.env.DSH_MEMORY_DIR = cache

const memory = await import('../lib/memory.js')

/* ---------- 造一个会话，让 citation 能核回 ---------- */

function writeSession(project, id, records) {
  const dir = join(sessions, project, id)
  mkdirSync(dir, { recursive: true })
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
}

const userMessage = (seq, time, text, kind = 'user') => ({
  type: 'user/message',
  seq,
  time,
  data: { content: [{ type: 'text', text }], role: 'user', source: { kind } },
})

writeSession('proj-a', 'session-aaaa', [
  { type: 'session', version: 4, id: 'session-aaaa' },
  userMessage(0, Date.parse('2026-11-01T10:00:00Z'), '帮我做个插件，要能检索笔记'),
])

/* ---------- 1. stageFact 外键互斥 ---------- */

test('stageFact 外键互斥：episodeId 和 topicId 同时给要拒绝', () => {
  const r = memory.stageFact({
    text: '外键互斥测试',
    citation: { sessionId: 'session-aaaa', index: 1 },
    episodeId: 'e1',
    topicId: 't1',
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /二选一/)
})

/* ---------- 2. stageFact 只挂 episodeId ---------- */

test('stageFact 只给 episodeId：落库带 episodeId + version=1，无 topicId 键', () => {
  const r = memory.stageFact({
    text: '挂 episodeId 的事实',
    citation: { sessionId: 'session-aaaa', index: 1 },
    episodeId: 'e1',
  })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.fact.episodeId, 'e1')
  assert.equal(r.fact.version, 1)
  assert.equal('topicId' in r.fact, false)
})

/* ---------- 3. stageFact 只挂 topicId ---------- */

test('stageFact 只给 topicId：落库带 topicId，无 episodeId 键', () => {
  const r = memory.stageFact({
    text: '挂 topicId 的事实',
    citation: { sessionId: 'session-aaaa', index: 1 },
    topicId: 't1',
  })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.fact.topicId, 't1')
  assert.equal('episodeId' in r.fact, false)
})

/* ---------- 4. setFactStatus 采纳一次 version 递增 ---------- */

test('setFactStatus 采纳：version 从 1 起，每次 approve +1', () => {
  const r = memory.stageFact({
    text: '要采纳的事实',
    citation: { sessionId: 'session-aaaa', index: 1 },
  })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.fact.version, 1)

  const a1 = memory.setFactStatus(r.fact.id, 'approved')
  assert.equal(a1.ok, true, a1.error)
  assert.equal(a1.fact.version, 2)

  const a2 = memory.setFactStatus(r.fact.id, 'approved')
  assert.equal(a2.ok, true, a2.error)
  assert.equal(a2.fact.version, 3)
})

/* ---------- 5. attachFact 单挂点：改挂 episodeId 清掉 topicId ---------- */

test('attachFact 单挂点：从 topicId 改挂 episodeId 后 topicId 被清掉', () => {
  const r = memory.stageFact({
    text: '先挂 topicId 再改挂 episodeId 的事实',
    citation: { sessionId: 'session-aaaa', index: 1 },
    topicId: 't1',
  })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.fact.topicId, 't1')

  const a = memory.attachFact(r.fact.id, { episodeId: 'e2' })
  assert.equal(a.ok, true, a.error)
  assert.equal(a.fact.episodeId, 'e2')
  assert.equal('topicId' in a.fact, false)
})

/* ---------- 6. attachFact 互斥 ---------- */

test('attachFact 互斥：episodeId 和 topicId 同时给要拒绝', () => {
  const r = memory.stageFact({
    text: 'attachFact 互斥测试',
    citation: { sessionId: 'session-aaaa', index: 1 },
  })
  assert.equal(r.ok, true, r.error)

  const a = memory.attachFact(r.fact.id, { episodeId: 'e1', topicId: 't1' })
  assert.equal(a.ok, false)
  assert.match(a.error, /二选一/)
})
