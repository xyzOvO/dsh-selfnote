/**
 * 记忆层（P1）的测试：造一个假的会话目录，验证解压、检索、出处校验、缓存。
 * 跑法：node tests/memory.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'selfnote-mem-'))
const sessions = join(root, 'sessions')
const cache = join(root, 'memory')

process.env.DSH_SESSIONS_DIR = sessions
process.env.DSH_MEMORY_DIR = cache

const memory = await import('../lib/memory.js')

/* ---------- 造两个会话 ---------- */

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

const assistantMessage = (seq, time, text, reasoning) => ({
  type: 'assistant/message',
  seq,
  time,
  data: {
    message: {
      role: 'assistant',
      content: [{ type: 'reasoning', text: reasoning ?? '想一下' }, { type: 'text', text }],
    },
  },
})

writeSession('proj-a', 'session-aaaa', [
  { type: 'session', version: 4, id: 'session-aaaa' },
  userMessage(0, Date.parse('2026-11-01T10:00:00Z'), '帮我做个插件，要能检索笔记'),
  assistantMessage(1, Date.parse('2026-11-01T10:00:10Z'), '好，先写一个 wiki_recall 的骨架。'),
  userMessage(2, Date.parse('2026-11-01T10:01:00Z'), '回答要短一点，我晕字'),
  // 运行时注入的内容：带「插件」这个词，但它不是他说的
  userMessage(3, Date.parse('2026-11-01T10:02:00Z'), 'MNEMON RUNTIME MEMORY SNAPSHOT ... 插件 插件 插件', 'dsh-mnemon'),
])

writeSession('proj-b', 'session-bbbb', [
  { type: 'session', version: 4, id: 'session-bbbb' },
  userMessage(0, Date.parse('2026-11-02T09:00:00Z'), '插件装好了，加个设置页'),
  assistantMessage(1, Date.parse('2026-11-02T09:00:20Z'), '设置页走 /api/selfnote 同源接口。'),
])

/* ---------- 1. 列出会话 ---------- */

const list = memory.listSessions()
assert.equal(list.length, 2)
assert.ok(list[0].id === 'session-bbbb', '最新会话要排前面')
console.log('1. listSessions 找到 2 个会话，按时间倒序')

/* ---------- 2. 解压 + 只取正文 ---------- */

const parsed = memory.readSession(list[0])
assert.equal(parsed.records.length, 2, 'reasoning 不该被当成一轮')
assert.equal(parsed.records[0].role, 'user')
assert.match(parsed.records[1].text, /同源接口/)
assert.ok(!JSON.stringify(parsed.records).includes('想一下'), 'reasoning 不该进记忆')
console.log('2. 解压正常，reasoning/tool-call 被剔除')

/* ---------- 3. 缓存 ---------- */

assert.ok(existsSync(join(cache, 'cache', 'session-bbbb.json')), '应该写了缓存文件')
const before = readdirSync(join(cache, 'cache')).length
memory.readSession(list[0])
assert.equal(readdirSync(join(cache, 'cache')).length, before, '第二次读不该再写新文件')
console.log('3. 缓存命中，不重复解压')

/* ---------- 4. 检索：AND 命中 ---------- */

const hit = memory.searchRaw('插件 设置页')
assert.ok(hit.total >= 1)
assert.equal(hit.degraded, false)
assert.equal(hit.hits[0].session, 'session-bbbb')
assert.equal(hit.hits[0].role, 'user')
assert.match(hit.hits[0].snippet, /插件装好了/)
assert.equal(hit.hits[0].index, 1, 'citation 要指向真实行号')
console.log('4. AND 检索命中，带会话 id / 行号 / 日期')

/* ---------- 5. 检索：放宽 ---------- */

const loose = memory.searchRaw('插件 从来没提过的词')
assert.equal(loose.degraded, true, '没有一条同时含所有词时要标记放宽')
assert.ok(loose.total >= 1)
console.log('5. 多词没全中时降级为放宽，并标记 degraded')

/* ---------- 6. 用户话权重大于我的话 ---------- */

const weighted = memory.searchRaw('插件')
assert.equal(weighted.hits[0].role, 'user', '同样命中时用户原话要排前面')
console.log('6. role=user 权重更高')

/* ---------- 7. since 过滤 ---------- */

const since = memory.searchRaw('插件', { since: '2099-01-01' })
assert.equal(since.total, 0)
console.log('7. since 过滤生效')

/* ---------- 8. 行号钳制 ---------- */

assert.ok(memory.searchRaw('插件', { limit: 999 }).hits.length <= 20)
assert.ok(memory.searchRaw('插件', { limit: 0 }).hits.length >= 1, 'limit=0 不合法时退回默认')
console.log('8. limit 被夹到 1–20')

/* ---------- 9. 出处校验 ---------- */

assert.equal(memory.checkCitation({ sessionId: 'session-bbbb', index: 1 }).ok, true)
assert.equal(memory.checkCitation({ sessionId: 'session-bbbb', index: 99 }).ok, false)
assert.equal(memory.checkCitation({ sessionId: 'session-不存在', index: 0 }).ok, false)
assert.equal(memory.checkCitation(null).ok, false)
console.log('9. citation 校验：真实行号通过，其余拒绝')

/* ---------- 10. 空查询 ---------- */

assert.equal(memory.searchRaw('   ').total, 0)
console.log('10. 空查询返回空而不是全量')

/* ---------- 11. 注入内容不算他说的话 ---------- */

const older = memory.readSession(list[1])
assert.ok(!older.records.some((record) => record.text.startsWith('MNEMON')), 'dsh-mnemon 注入不该进记忆')
const noisy = memory.searchRaw('插件')
assert.ok(noisy.hits.every((hit) => !hit.snippet.includes('MNEMON')), '检索也不该命中注入内容')
console.log('11. source.kind 不是 user 的注入内容被剔除')

/* ---------- 12. 候选事实：无出处不许进 ---------- */

const bad1 = memory.stageFact({ text: '没有出处', citation: null })
assert.equal(bad1.ok, false)
const bad2 = memory.stageFact({ text: '行号不对', citation: { sessionId: 'session-aaaa', index: 99 } })
assert.equal(bad2.ok, false)
const good = memory.stageFact({
  text: '他要求回答先给结论。',
  kind: 'preference',
  tags: ['沟通'],
  citation: { sessionId: 'session-aaaa', index: 1 },
})
assert.equal(good.ok, true, JSON.stringify(good))
assert.equal(good.fact.status, 'candidate')
assert.equal(good.fact.citation.date, '2026-11-01')
console.log('12. 出处校验挡住编造，真出处才进候选区')

/* ---------- 13. 采纳 / 退役 ---------- */

assert.equal(memory.setFactStatus(good.fact.id, 'approved').ok, true)
assert.equal(memory.listFacts('approved').length, 1)
assert.equal(memory.setFactStatus(good.fact.id, 'retired').ok, true)
assert.equal(memory.listFacts('approved').length, 0)
assert.equal(memory.setFactStatus(good.fact.id, '不存在的状态').ok, false)
console.log('13. 候选 → 采纳 → 退役，非法状态被拒')

/* 回归：退役后再恢复，retiredAt 必须被清掉，不能留下「approved 却带退役日期」的矛盾 */
assert.equal(memory.setFactStatus(good.fact.id, 'approved').ok, true)
const revived = memory.listFacts('approved').find((item) => item.id === good.fact.id)
assert.ok(revived !== undefined, '恢复后应回到 approved 列表')
assert.equal('retiredAt' in revived, false, '恢复采纳后不该残留 retiredAt')
assert.equal(memory.setFactStatus(good.fact.id, 'retired').ok, true, '复原到退役态，不影响后面的计数断言')
console.log('13b. 退役 → 恢复 → 再退役，retiredAt 被清除（回归）')

/* ---------- 14. 习惯由频次触发 ---------- */

for (const text of ['第二条', '第三条', '第四条']) {
  const fact = memory.stageFact({ text, kind: 'preference', tags: ['沟通'], citation: { sessionId: 'session-aaaa', index: 1 } })
  memory.setFactStatus(fact.fact.id, 'approved')
}
const suggestions = memory.habitSuggestions(3)
assert.ok(suggestions.some((item) => item.tag === '沟通' && item.count >= 3), JSON.stringify(suggestions))
assert.equal(memory.setHabit('回答先给结论', 'active', '沟通').ok, true)
const again = memory.habitSuggestions(3)
assert.equal(again.find((item) => item.tag === '沟通').active, true, '升成习惯后建议里要标已激活')
console.log('14. 同一标签出现 3 次才给建议，升成习惯后正确标记')

/* ---------- 15. 统计 ---------- */

const stats = memory.memoryStats()
assert.equal(stats.sessions, 2)
assert.equal(stats.approved, 3)
assert.ok(stats.cache >= 1)
console.log('15. memoryStats 数字对得上')

/* 16. 检索留痕：seenCount 与 hitCount 分开记 —— 搜到不等于用上 */
{
  writeFileSync(
    join(cache, 'facts.jsonl'),
    JSON.stringify({ id: 'f-seen', text: '一条会被搜到的事实', status: 'approved', hitCount: 0 }) + '\n',
  )
  assert.equal(memory.seenFacts(['f-seen']), 1, '第一次要记')
  let fact = memory.readFacts().find((item) => item.id === 'f-seen')
  assert.equal(fact.seenCount, 1)
  assert.equal(fact.hitCount ?? 0, 0, '热能是「进注入」才算，检索不许动它')
  assert.ok(Number.isFinite(Date.parse(fact.lastSeen)))

  assert.equal(memory.seenFacts(['f-seen']), 0, '十分钟内重复搜不算第二次')
  fact = memory.readFacts().find((item) => item.id === 'f-seen')
  assert.equal(fact.seenCount, 1)

  // 十分钟后再搜要能记上
  assert.equal(memory.seenFacts(['f-seen'], Date.now() + 11 * 60 * 1000), 1)
  fact = memory.readFacts().find((item) => item.id === 'f-seen')
  assert.equal(fact.seenCount, 2)

  assert.equal(memory.seenFacts([]), 0, '空列表不该写盘')
  console.log('16. 检索留痕：seenCount 单独记，不动热度，十分钟内去重')
}

console.log('\n16 项全部通过')
process.exit(0)
