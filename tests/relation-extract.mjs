/**
 * 关系记忆 Task 5：selfnote_extract 工具（propose / list / boost）的 extractHandler。
 * 造一个假会话目录让 fact 的 citation 能核回，验证三层抽取、出处护栏、boost 与 list。
 * 跑法：node tests/relation-extract.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'selfnote-extract-'))
const sessions = join(root, 'sessions')
process.env.DSH_SESSIONS_DIR = sessions
process.env.DSH_MEMORY_DIR = join(root, 'memory')
process.env.DSH_SELFNOTE_DIR = join(root, 'selfnote')

const relation = await import('../lib/relation.js')
const memory = await import('../lib/memory.js')
const { extractHandler } = await import('../lib/index.js')

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

test('propose 落三层：topic + episode + 带出处的 fact', async () => {
  const out = await extractHandler({
    action: 'propose',
    topics: [{ title: '知识库', summary: '在搭' }],
    episodes: [{ topicId: null, title: '架构', summary: '进行中' }],
    facts: [{ text: '教训：检索要先建索引', kind: 'fact', citation: { sessionId: 'session-aaaa', index: 1 }, episodeId: 'e-架构' }],
  })
  assert.equal(out.topics[0].ok, true, JSON.stringify(out.topics[0]))
  assert.equal(out.episodes[0].ok, true, JSON.stringify(out.episodes[0]))
  assert.equal(out.facts[0].ok, true, JSON.stringify(out.facts[0]))
  assert.equal(relation.readTopics().length, 1)
  assert.equal(relation.readEpisodes().length, 1)
  assert.equal(memory.readFacts().length, 1)
  assert.equal(memory.readFacts()[0].episodeId, 'e-架构', 'fact 带 episodeId 落库')
})

test('episode 传入合法 status 落库，非法值回退 open', async () => {
  const closed = await extractHandler({
    action: 'propose',
    episodes: [{ title: '已收尾议题', status: 'closed' }],
  })
  assert.equal(closed.episodes[0].ok, true, JSON.stringify(closed.episodes[0]))
  assert.equal(closed.episodes[0].episode.status, 'closed')
  const archived = await extractHandler({
    action: 'propose',
    episodes: [{ title: '已归档议题', status: 'archived' }],
  })
  assert.equal(archived.episodes[0].episode.status, 'archived')
  const weird = await extractHandler({
    action: 'propose',
    episodes: [{ title: '怪状态议题', status: 'weird' }],
  })
  assert.equal(weird.episodes[0].episode.status, 'open')
})

test('fact 无 citation：该项 ok:false 且不落库', async () => {
  const before = memory.readFacts().length
  const out = await extractHandler({
    action: 'propose',
    topics: [],
    episodes: [],
    facts: [{ text: '没有出处的事实', kind: 'fact' }],
  })
  assert.equal(out.facts[0].ok, false)
  assert.equal(memory.readFacts().length, before, 'fact 数量不变')
})

test('episode 的 topicId 不存在：报 error 但 topic 仍落库', async () => {
  const beforeTopics = relation.readTopics().length
  const out = await extractHandler({
    action: 'propose',
    topics: [{ title: '第二个话题', summary: '' }],
    episodes: [{ topicId: 't-nonexistent', title: '坏挂载', summary: '' }],
    facts: [],
  })
  assert.equal(out.topics[0].ok, true)
  assert.equal(out.episodes[0].ok, false)
  assert.match(out.episodes[0].error, /不存在/)
  assert.equal(relation.readTopics().length, beforeTopics + 1, 'topic 仍已落库')
})

test('boost：boost += delta 且不碰 useCount', async () => {
  const topicId = relation.readTopics().find((t) => t.title === '知识库').id
  const out = await extractHandler({ action: 'boost', topicId, delta: 5 })
  assert.equal(out.ok, true, JSON.stringify(out))
  const boosted = relation.readTopics().find((t) => t.title === '知识库')
  assert.equal(boosted.boost, 5)
  assert.equal(boosted.useCount, 0, 'boost 不碰 useCount')
})

test('list：返回 topics/episodes 两键', async () => {
  const out = await extractHandler({ action: 'list' })
  assert.ok(Array.isArray(out.topics))
  assert.ok(Array.isArray(out.episodes))
})
