/**
 * 关系记忆检索召回：recall 纯读返回 topics（不记账），recallAndTouch 命中后 readCount +1。
 * 跑法：node tests/relation-recall.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-relation-recall-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')

const relation = await import('../lib/relation.js')
const { recall } = await import('../lib/memory.js')
const { recallAndTouch } = await import('../lib/index.js')

const topicUp = relation.upsertTopic({ title: '知识库搭建', summary: '正在搭本地知识库' })
assert.equal(topicUp.ok, true)
const topicId = topicUp.topic.id
const epUp = relation.upsertEpisode({ topicId, title: '检索架构', summary: '知识库的检索怎么做' })
assert.equal(epUp.ok, true)

test('recall 召回 topic 与 episode（纯读，不记账）', () => {
  const r = recall('知识库', { mode: 'all' })
  const topics = r.topics ?? []
  assert.ok(topics.some((t) => t.title.includes('知识库')), 'topic 按 title 召回')
  assert.ok(topics.some((t) => t.status === 'open'), 'episode 附 status 召回')
  const stored = relation.readTopics().find((t) => t.title.includes('知识库'))
  assert.equal(stored.readCount ?? 0, 0, 'recall 纯读不记 readCount')
})

test('recallAndTouch 命中后 readCount +1 且 10 分钟内去重', () => {
  const topic = () => relation.readTopics().find((t) => t.title.includes('知识库'))
  const before = topic().readCount ?? 0
  recallAndTouch('知识库', { mode: 'all' })
  assert.equal(topic().readCount, before + 1, '命中后 readCount +1')
  recallAndTouch('知识库', { mode: 'all' })
  assert.equal(topic().readCount, before + 1, '10 分钟内去重不涨')
})
