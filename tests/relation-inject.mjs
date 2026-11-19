/**
 * 关系记忆注入：assembleInjection 出 topic 段、返回 topicIds，且纯函数不写盘。
 * 跑法：node tests/relation-inject.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-relation-inject-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')

const relation = await import('../lib/relation.js')
const { assembleInjection, currentConfig } = await import('../lib/index.js')

test('assembleInjection 出 topic 段且纯函数不记账', () => {
  relation.upsertTopic({ title: '老话题', summary: '较早的讨论' })
  relation.upsertTopic({ title: '新话题', summary: '最近的讨论' })

  const built = assembleInjection(currentConfig())
  const seg = built.segments.find((s) => s.key === 'topic')
  assert.ok(seg, '注入里没有 topic 段')
  assert.equal(seg.limit, 160, 'topic 段预算应该是 160')
  assert.ok(Array.isArray(built.topicIds), 'assembleInjection 要返回 topicIds')
  const topics = relation.readTopics()
  const newId = topics.find((t) => t.title === '新话题').id
  assert.ok(built.topicIds.includes(newId), 'topicIds 应含新话题 id')
  assert.match(built.text, /新话题：最近的讨论/, '注入文本应含「标题：摘要」格式行')
  assert.ok(seg.chars <= 160, `topic 段 chars 不超过 160，实际 ${seg.chars}`)
  assert.ok(seg.kept.length <= 4, 'topic 段最多保留 4 个话题')
  // 纯函数不写盘：useCount 保持 0（Review Focus 5）
  for (const t of topics) {
    assert.equal(t.useCount, 0, 'assembleInjection 不该记 useCount')
  }
})

test('rankTopics 新 topic（lastTouched 近）排老 topic 前', () => {
  const now = Date.now()
  const topics = [
    { id: 'old', title: '老话题', summary: '', lastTouched: new Date(now - 86400000).toISOString(), useCount: 0, readCount: 0, boost: 0 },
    { id: 'new', title: '新话题', summary: '', lastTouched: new Date(now).toISOString(), useCount: 0, readCount: 0, boost: 0 },
  ]
  const ranked = relation.rankTopics(topics, now)
  assert.equal(ranked[0].id, 'new', 'lastTouched 近的排前面')
})

test('空库时话题段给一句抽取引导（算进话题段 chars）', () => {
  relation.writeTopics([])
  const built = assembleInjection(currentConfig())
  assert.match(built.text, /暂无/, '空库时注入应含「暂无」引导')
  assert.match(built.text, /selfnote_extract/, '引导句应提示用 selfnote_extract 抽取')
  const seg = built.segments.find((s) => s.key === 'topic')
  assert.ok(seg.chars > 0, '引导句算进话题段 chars（不是 0）')
  assert.ok(seg.chars <= 160, `引导句不超话题段预算，实际 ${seg.chars}`)
  assert.equal(seg.kept.length, 0, '空库没有真实话题，kept 为空')
})
