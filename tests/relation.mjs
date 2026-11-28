import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 别碰真实的记忆目录：topic.jsonl / episode.jsonl 落到临时目录。
const dir = mkdtempSync(join(tmpdir(), 'selfnote-relation-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SELFNOTE_NO_OPEN = '1'

const rel = await import('../lib/relation.js')
const {
  topicPath,
  episodePath,
  readTopics,
  readEpisodes,
  writeTopics,
  writeEpisodes,
  upsertTopic,
  upsertEpisode,
  rankTopics,
  renameTopic,
  archiveTopic,
  touchTopics,
  seenTopics,
} = rel

const reset = () => {
  for (const p of [topicPath(), episodePath()]) {
    if (existsSync(p)) rmSync(p)
    if (existsSync(p + '.lock')) rmSync(p + '.lock')
  }
}
beforeEach(reset)

test('空文件读回空数组', () => {
  assert.deepEqual(readTopics(), [])
  assert.deepEqual(readEpisodes(), [])
})

test('writeTopics 后 readTopics 逐条还原且坏行被跳过', () => {
  writeTopics([
    { id: 't1', title: '骑行', useCount: 0, readCount: 0, boost: 0, created: '2026-11-19', updated: '2026-11-19' },
    { id: 't2', title: '知识库', useCount: 1, readCount: 0, boost: 0, created: '2026-11-19', updated: '2026-11-19' },
  ])
  const p = topicPath()
  writeFileSync(p, readFileSync(p, 'utf8') + '这不是一行 JSON\n{"id":"t3","title":"坏行之后的好行"}\n')
  const topics = readTopics()
  assert.equal(topics.length, 3)
  assert.equal(topics[0].title, '骑行')
  assert.equal(topics[1].title, '知识库')
  assert.equal(topics[2].title, '坏行之后的好行')
})

test('upsertTopic 新建返回 ok 且带 t 前缀 id', () => {
  const r = upsertTopic({ title: '骑行装备', summary: '年假' })
  assert.equal(r.ok, true)
  assert.equal(r.topic.id.startsWith('t'), true)
  assert.equal(r.topic.title, '骑行装备')
  assert.equal(r.topic.useCount, 0)
  assert.equal(r.topic.readCount, 0)
  assert.equal(r.topic.boost, 0)
  assert.equal(readTopics().length, 1)
})

test('upsertTopic 判重只认归一化 title（trim + 空白折叠）', () => {
  const a = upsertTopic({ title: ' 骑行  备考 ', summary: '年假' })
  const b = upsertTopic({ title: '骑行 备考', summary: '年假' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(b.merged, true)
  assert.equal(readTopics().length, 1)
})

test('upsertTopic 仅大小写不同不判重（新建）', () => {
  const a = upsertTopic({ title: 'Dsh' })
  const b = upsertTopic({ title: 'dsh' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(b.merged, undefined)
  assert.equal(readTopics().length, 2)
})

test('upsertEpisode 挂 topicId、默认 open、判重', () => {
  const e1 = upsertEpisode({ topicId: 't1', title: '出处核回修复' })
  const e2 = upsertEpisode({ topicId: 't1', title: ' 出处核回修复 ' })
  assert.equal(e1.ok, true)
  assert.equal(e1.episode.id.startsWith('e'), true)
  assert.equal(e1.episode.topicId, 't1')
  assert.equal(e1.episode.status, 'open')
  assert.equal(e2.merged, true)
  assert.equal(readEpisodes().length, 1)
})

test('upsertEpisode 不同 topicId 不判重', () => {
  const e1 = upsertEpisode({ topicId: 't1', title: '出处核回修复' })
  const e2 = upsertEpisode({ topicId: 't2', title: '出处核回修复' })
  assert.equal(e1.ok, true)
  assert.equal(e2.ok, true)
  assert.equal(e2.merged, undefined)
  assert.equal(readEpisodes().length, 2)
})

test('rankTopics 最近活跃在前、归档被过滤', () => {
  const now = Date.now()
  const recent = new Date(now - 1000).toISOString()
  const old = new Date(now - 30 * 86400000).toISOString()
  const topics = [
    { id: 't1', title: '老话题', lastTouched: old, useCount: 100, readCount: 0, boost: 0 },
    { id: 't2', title: '新话题', lastTouched: recent, useCount: 1, readCount: 0, boost: 0 },
    { id: 't3', title: '归档', lastTouched: recent, useCount: 5, readCount: 0, boost: 0, archivedAt: '2026-01-01T00:00:00.000Z' },
  ]
  const ranked = rankTopics(topics, now)
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].id, 't2')
  assert.equal(ranked[1].id, 't1')
})

test('rankTopics 同活跃时用量高在前', () => {
  const now = Date.now()
  const same = new Date(now - 1000).toISOString()
  const topics = [
    { id: 'a', title: '低用量', lastTouched: same, useCount: 0, readCount: 0, boost: 0 },
    { id: 'b', title: '高用量', lastTouched: same, useCount: 10, readCount: 0, boost: 0 },
  ]
  const ranked = rankTopics(topics, now)
  assert.equal(ranked[0].id, 'b')
})

test('renameTopic 改 title 后同 title 再 upsert 判重命中', () => {
  const a = upsertTopic({ title: '骑行' })
  const r = renameTopic(a.topic.id, '骑行装备')
  assert.equal(r.ok, true)
  assert.equal(r.topic.title, '骑行装备')
  const b = upsertTopic({ title: '骑行装备' })
  assert.equal(b.merged, true)
  assert.equal(readTopics().length, 1)
})

test('renameTopic 撞已有 title 报错', () => {
  const a = upsertTopic({ title: '骑行' })
  upsertTopic({ title: '知识库' })
  const r = renameTopic(a.topic.id, '知识库')
  assert.equal(r.ok, false)
  assert.match(r.error, /已存在/)
})

test('archiveTopic 软删：rankTopics 不再返回、readTopics 仍在', () => {
  const a = upsertTopic({ title: '骑行' })
  const r = archiveTopic(a.topic.id)
  assert.equal(r.ok, true)
  assert.ok(r.topic.archivedAt)
  const all = readTopics()
  assert.equal(all.length, 1)
  assert.ok(all[0].archivedAt)
  assert.equal(rankTopics(all).length, 0)
})

test('touchTopics 首次 +1、一小时内去重', () => {
  const a = upsertTopic({ title: '骑行' })
  assert.equal(touchTopics([a.topic.id]), 1)
  assert.equal(readTopics().find((t) => t.id === a.topic.id).useCount, 1)
  assert.equal(touchTopics([a.topic.id]), 0)
  assert.equal(readTopics().find((t) => t.id === a.topic.id).useCount, 1)
})

test('touchTopics 超过一小时可再 +1', () => {
  const a = upsertTopic({ title: '骑行' })
  const base = Date.now()
  assert.equal(touchTopics([a.topic.id], base), 1)
  assert.equal(touchTopics([a.topic.id], base + 3600001), 1)
  assert.equal(readTopics().find((t) => t.id === a.topic.id).useCount, 2)
})

test('seenTopics 首次 +1、10 分钟内去重', () => {
  const a = upsertTopic({ title: '骑行' })
  assert.equal(seenTopics([a.topic.id]), 1)
  assert.equal(readTopics().find((t) => t.id === a.topic.id).readCount, 1)
  assert.equal(seenTopics([a.topic.id]), 0)
  assert.equal(readTopics().find((t) => t.id === a.topic.id).readCount, 1)
})

test('seenTopics 超过 10 分钟可再 +1', () => {
  const a = upsertTopic({ title: '骑行' })
  const base = Date.now()
  assert.equal(seenTopics([a.topic.id], base), 1)
  assert.equal(seenTopics([a.topic.id], base + 600001), 1)
  assert.equal(readTopics().find((t) => t.id === a.topic.id).readCount, 2)
})

test('touchTopics / seenTopics 空 id 数组返回 0', () => {
  assert.equal(touchTopics([]), 0)
  assert.equal(seenTopics([]), 0)
})
