/**
 * 关系对账的 nodes 一侧：nodes 只是缓存，权威是事实。
 * 覆盖 nodesFor / pendingNodeFixes / syncEpisodeNodes，以及「挂事实时自动补齐」这条维护路径。
 * 跑法：node tests/relation-nodes.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'selfnote-relation-nodes-'))
const sessions = join(root, 'sessions')
const sn = join(root, 'selfnote')
const memoryDir = join(root, 'memory')

process.env.DSH_SESSIONS_DIR = sessions
process.env.DSH_MEMORY_DIR = memoryDir
process.env.DSH_SELFNOTE_DIR = sn
mkdirSync(sn, { recursive: true })

const rel = await import('../lib/relation.js')
const memory = await import('../lib/memory.js')

const now = '2026-11-19T00:00:00.000Z'
const day = '2026-11-19'

const episode = (patch = {}) => ({
  id: 'e1',
  topicId: 't1',
  title: '议题',
  status: 'open',
  summary: '',
  lastTouched: now,
  nodes: [],
  created: day,
  updated: day,
  ...patch,
})

const writeEpisodes = (list) => writeFileSync(rel.episodePath(), list.map((item) => JSON.stringify(item) + '\n').join(''))
const readEpisode = (id) => rel.readEpisodes().find((item) => item.id === id)

function writeSession(project, id, records) {
  const dir = join(sessions, project, id)
  mkdirSync(dir, { recursive: true })
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
}

const userMessage = (seq, time, text) => ({
  type: 'user/message',
  seq,
  time,
  data: { content: [{ type: 'text', text }], role: 'user', source: { kind: 'user' } },
})

writeSession('proj-a', 'session-aaaa', [
  { type: 'session', version: 4, id: 'session-aaaa' },
  userMessage(0, Date.parse('2026-11-19T10:00:00Z'), '这轮先修关系对账'),
])

const cite = { sessionId: 'session-aaaa', index: 1 }

/* ---------- 1. nodesFor：只认 episodeId，顺序跟事实文件走 ---------- */

test('nodesFor 按 episodeId 反查，别的挂点一律不算', () => {
  const facts = [
    { id: 'f1', episodeId: 'e1' },
    { id: 'f2', topicId: 't1' },
    { id: 'f3', episodeId: 'e2' },
    { id: 'f4', episodeId: 'e1' },
    { id: '', episodeId: 'e1' },
  ]
  assert.deepEqual(rel.nodesFor('e1', facts), ['f1', 'f4'])
  assert.deepEqual(rel.nodesFor('e2', facts), ['f3'])
  assert.deepEqual(rel.nodesFor('e9', facts), [])
  assert.deepEqual(rel.nodesFor('', facts), [])
})

/* ---------- 2. pendingNodeFixes：缺、多、顺序都算不一致 ---------- */

test('pendingNodeFixes 只挑真正不一致的 episode', () => {
  const facts = [
    { id: 'f1', episodeId: 'e1' },
    { id: 'f2', episodeId: 'e1' },
    { id: 'f3', episodeId: 'e2' },
  ]
  const clean = [episode({ id: 'e2', nodes: ['f3'] })]
  assert.deepEqual(rel.pendingNodeFixes(clean, facts), [])

  const missing = rel.pendingNodeFixes([episode({ id: 'e1', nodes: [] })], facts)
  assert.equal(missing.length, 1)
  assert.deepEqual(missing[0], { id: 'e1', before: [], after: ['f1', 'f2'] })

  const extra = rel.pendingNodeFixes([episode({ id: 'e1', nodes: ['f1', 'f2', 'f9'] })], facts)
  assert.deepEqual(extra[0].after, ['f1', 'f2'])
  assert.deepEqual(extra[0].before, ['f1', 'f2', 'f9'])

  // 同一批 id、顺序反了也算不一致：nodes 按事实顺序写，不然每次读都像换了一版
  const reordered = rel.pendingNodeFixes([episode({ id: 'e1', nodes: ['f2', 'f1'] })], facts)
  assert.equal(reordered.length, 1)
})

/* ---------- 3. syncEpisodeNodes：写回磁盘、可重入 ---------- */

test('syncEpisodeNodes 把 nodes 重算写回文件，再跑一次就没有要修的', () => {
  writeEpisodes([episode({ id: 'e1', nodes: [] }), episode({ id: 'e2', topicId: '', nodes: ['f3'] })])
  const facts = [
    { id: 'f1', episodeId: 'e1' },
    { id: 'f2', episodeId: 'e1' },
    { id: 'f3', episodeId: 'e2' },
  ]

  const first = rel.syncEpisodeNodes(facts)
  assert.equal(first.error, undefined)
  assert.deepEqual(first.fixed.map((item) => item.id), ['e1'], '只改真的不一致的那一个')
  assert.deepEqual(readEpisode('e1').nodes, ['f1', 'f2'], '写回要落到文件里')
  assert.deepEqual(readEpisode('e2').nodes, ['f3'])

  const second = rel.syncEpisodeNodes(facts)
  assert.deepEqual(second.fixed, [], '幂等：修完再跑不动任何东西')
})

/* ---------- 4. 挂事实时自动补齐（以前这里断了，才有那条对账告警） ---------- */

test('stageFact 挂到 episode 上：nodes 立刻包含新的 fact id', () => {
  writeEpisodes([episode({ id: 'e1', nodes: [] })])
  const r = memory.stageFact({ text: '发版 minor 只升一位', citation: cite, episodeId: 'e1', kind: 'decision' })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(readEpisode('e1').nodes, [r.fact.id])
  assert.equal(r.nodesFixed?.[0]?.id, 'e1', '返回里要说清补了哪个 episode')
})

test('attachFact 改挂到 topic：旧 episode 的 nodes 相应清空', () => {
  const r = memory.stageFact({ text: '体检六组默认收起', citation: cite, episodeId: 'e1', kind: 'decision' })
  assert.equal(r.ok, true, r.error)
  assert.equal(readEpisode('e1').nodes.length, 2)

  const moved = memory.attachFact(r.fact.id, { topicId: 't1' })
  assert.equal(moved.ok, true, moved.error)
  assert.equal(readEpisode('e1').nodes.length, 1, '换挂点后旧 episode 不该还指着它')
  assert.ok(!readEpisode('e1').nodes.includes(r.fact.id))
})

/* ---------- 5. 不挂 episode 的事实不该动 nodes ---------- */

test('不挂 episode 时不动 nodes', () => {
  writeEpisodes([episode({ id: 'e1', nodes: [] })])
  const r = memory.stageFact({ text: '只挂话题的一条', citation: cite, topicId: 't1' })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(readEpisode('e1').nodes, [])
  assert.equal(r.nodesFixed, undefined)
})
