/**
 * 索引（P5b）的测试：建索引、倒排命中、按 id 取正文、过期判定。
 * 跑法：node tests/index.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'selfnote-index-'))
process.env.DSH_SESSIONS_DIR = join(root, 'sessions')
process.env.DSH_MEMORY_DIR = join(root, 'memory')

const store = await import('../lib/index-store.js')
const memory = await import('../lib/memory.js')

function writeSession(project, id, records) {
  const dir = join(process.env.DSH_SESSIONS_DIR, project, id)
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

writeSession('proj', 'session-aaa', [
  userMessage(1, 1762000000000, '插件安装失败的时候先看日志，不要瞎猜。'),
  userMessage(2, 1762000100000, '晕字，你写得太多字了。'),
])
writeSession('proj', 'session-bbb', [
  userMessage(1, 1762100000000, '记忆插件要能带出处，不然没法验证。'),
])

/* 1. 建索引 */
const t0 = Date.now()
const index = store.buildIndex()
const buildMs = Date.now() - t0
assert.equal(index.v, 3)
assert.equal(Object.keys(index.sessions).length, 2)
assert.equal(index.records.length, 3)
assert.ok(Object.keys(index.postings).length > 10)
console.log(`1. 建索引：2 会话 / 3 条记录 / ${Object.keys(index.postings).length} 个词元（${buildMs}ms）`)

/* 2. 中文 bigram 命中 */
const hit = store.queryIndex(index, store.indexTerms('插件安装'))
assert.ok(hit.ids.length >= 1, '「插件安装」应该命中第一条')
const keys = store.hitKeys(index, hit.ids)
assert.ok(keys.some((id) => id.startsWith('session-aaa#')), '命中的应该是 session-aaa')
console.log('2. 中文 bigram 能命中（' + keys.join(', ') + '）')

/* 3. 英文/数字词元 */
assert.ok(store.indexTerms('DSH 插件').includes('dsh'))
console.log('3. 英文词元会被小写收录')

/* 4. AND 优先 */
const strict = store.queryIndex(index, ['晕字', '出处'])
assert.equal(strict.degraded, true, '「晕字」只在 aaa、「出处」只在 bbb，AND 为空应退回并集')
assert.equal(strict.ids.length, 2, '退回并集后两条都该在')
assert.equal(strict.ids.length, 2)
console.log('4. AND 为空时退回并集并标 degraded')

/* 5. 按 id 取正文 + 打分 */
const result = memory.searchByIds(keys, '插件安装', { limit: 5 })
assert.equal(result.source, 'index')
assert.ok(result.hits.length >= 1)
assert.match(result.hits[0].snippet, /插件安装/)
assert.equal(result.hits[0].session, 'session-aaa')
assert.equal(result.complete, true)
console.log('5. searchByIds 拿到正文并能给出引文（' + result.hits[0].session + ' 第 ' + result.hits[0].index + ' 条）')

/* 5b. 索引路径也要认 since：早于 since 的记录不能借索引漏回来 */
const futureOnly = memory.searchByIds(keys, '插件安装', { limit: 5, since: '2999-01-01' })
assert.equal(futureOnly.hits.length, 0, 'since 在未来时索引路径不该返回任何命中')
const pastOnly = memory.searchByIds(keys, '插件安装', { limit: 5, since: '2000-01-01' })
assert.ok(pastOnly.hits.length >= 1, 'since 在过去时索引路径照常返回')
const viaRecall = memory.recall('插件安装', { mode: 'raw', ids: keys, since: '2999-01-01', limit: 5 })
assert.equal(viaRecall.raw.hits.length, 0, 'recall 走索引分支时 since 也必须生效')
console.log('5b. 索引路径遵守 since（未来 0 条 / 过去有命中 / recall 同样生效）')

/* 6. 新鲜度：刚建的索引算新鲜 */
assert.equal(store.isFresh(index), true)
console.log('6. 刚建的索引是新鲜的')

/* 7. 正在写的会话算 hot，不算过期；冷下来的会话变了才算过期 */
writeFileSync(
  join(process.env.DSH_SESSIONS_DIR, 'proj', 'session-bbb', 'session.v4.jsonl.zstd'),
  zstdCompressSync(Buffer.from(JSON.stringify(userMessage(2, 1762100100000, '再加一条。')) + '\n', 'utf8')),
)
const hotness = store.freshness(index)
assert.equal(hotness.fresh, true, '刚改过的会话是热会话，不该把索引判死')
assert.equal(hotness.hot, 1, '应该记下 1 个热会话')
assert.equal(store.isFresh(index), true)
console.log('7. 热会话（5 分钟内还在写）不算过期，hot=1')

/* 7b. 冷会话变了才算过期 */
const dirOld = join(process.env.DSH_SESSIONS_DIR, 'proj', 'session-old')
mkdirSync(dirOld, { recursive: true })
const oldFile = join(dirOld, 'session.v4.jsonl.zstd')
writeFileSync(oldFile, zstdCompressSync(Buffer.from(JSON.stringify(userMessage(1, 1700000000000, '很久以前的会话。')) + '\n', 'utf8')))
const longAgo = new Date(Date.now() - 30 * 60 * 1000)
utimesSync(oldFile, longAgo, longAgo)
const stale = store.freshness(index)
assert.equal(stale.fresh, false, '多了个冷会话，索引就代表不了磁盘')
assert.equal(stale.missing, 1)
assert.equal(stale.absent, 1, '这个会话根本没进过索引')
assert.equal(stale.stale, 0, '不是「进去过又改了」，是「没进去」')
console.log('7b. 冷会话新增后索引被判过期（missing=1）')

/* 7c. 「没进去」和「进去过又改了」要分开报：两个数合成一个，就会跟页面上
   那组「已索引 / 磁盘」对不上 —— 看着像算错了，其实是在说两件事 */
const dirChanged = join(process.env.DSH_SESSIONS_DIR, 'proj', 'session-changed')
mkdirSync(dirChanged, { recursive: true })
const changedFile = join(dirChanged, 'session.v4.jsonl.zstd')
writeFileSync(changedFile, zstdCompressSync(Buffer.from(JSON.stringify(userMessage(1, 1700000000000, '一开始的内容。')) + '\n', 'utf8')))
const changedOld = new Date(Date.now() - 40 * 60 * 1000)
utimesSync(changedFile, changedOld, changedOld)
// 先把磁盘上现有的（含 session-old、session-changed）全收进索引
const beforeChange = store.buildIndex()
// 再让 session-changed 变成「建完之后又改过」（冷下来，靠 mtime 变新来暴露）
const changedLater = new Date(Date.now() - 20 * 60 * 1000)
utimesSync(changedFile, changedLater, changedLater)
// 再加一个从来没进过索引的冷会话
const dirFresh = join(process.env.DSH_SESSIONS_DIR, 'proj', 'session-fresh')
mkdirSync(dirFresh, { recursive: true })
const freshFile = join(dirFresh, 'session.v4.jsonl.zstd')
writeFileSync(freshFile, zstdCompressSync(Buffer.from(JSON.stringify(userMessage(1, 1700000000000, '索引建完之后才出现的会话。')) + '\n', 'utf8')))
const freshOld = new Date(Date.now() - 30 * 60 * 1000)
utimesSync(freshFile, freshOld, freshOld)
const mixed = store.freshness(beforeChange)
assert.equal(mixed.missing, 2, '一个没进去、一个又改过，合起来还是 2 个待同步')
assert.equal(mixed.absent, 1, 'absent 只数没进去的那个')
assert.equal(mixed.stale, 1, 'stale 只数建完之后又改过的那个')
assert.equal(mixed.absent + mixed.stale, mixed.missing, '分项加起来必须等于总数，不许漏')
console.log('7c. 待同步拆得开：「没进去 1 个、又改过 1 个」合计 2')

/* 8. stats 反映磁盘实况 */
const stats = store.indexStats()
assert.equal(stats.present, true)
assert.equal(stats.fresh, false)
assert.ok(stats.bytes > 0)
console.log('8. indexStats 报 present=true / fresh=false / ' + stats.bytes + ' 字节')

/* 9. 线性扫描如实报告覆盖范围（P5a） */
const raw = memory.searchRaw('插件安装', { limit: 5 })
assert.equal(raw.complete, true)
assert.equal(raw.sessions_total, raw.sessions_scanned)
assert.ok(raw.sessions_scanned >= 2)
assert.equal(raw.sessions_failed, 0)
assert.equal(raw.partial, false)
console.log('9. 线性扫描报出 complete / sessions_scanned / sessions_total')

/* 10. 预算掐断时 complete 为 false */
const cramped = memory.searchRaw('插件安装', { limit: 5, budgetMs: 200 })
assert.equal(typeof cramped.partial, 'boolean')
assert.equal(cramped.budget_ms, 200)
console.log('10. budgetMs 会被回显，便于判断这次结果可信度')

/* 11. 多 frame 的 zstd（DSH 真实写法）：只解第一帧的实现会在这里露馅 */
const dirMulti = join(process.env.DSH_SESSIONS_DIR, 'proj', 'session-multi')
mkdirSync(dirMulti, { recursive: true })
const frame1 = zstdCompressSync(Buffer.from(JSON.stringify(userMessage(1, 1762200000000, '第一帧里的话。')) + '\n', 'utf8'))
const frame2 = zstdCompressSync(Buffer.from(JSON.stringify(userMessage(2, 1762200100000, '第二帧里的话，多帧要能一起解出来。')) + '\n', 'utf8'))
const multiFile = join(dirMulti, 'session.v4.jsonl.zstd')
writeFileSync(multiFile, Buffer.concat([frame1, frame2]))
const multi = memory.readSession({
  id: 'session-multi',
  project: 'proj',
  file: multiFile,
  mtime: statSync(multiFile).mtimeMs,
})
assert.equal(multi.records.length, 2, '多 frame 文件应该解出 2 条')
assert.match(multi.records[1].text, /第二帧/)
console.log('11. 多 frame zstd 能整块解出来（' + multi.records.length + ' 条）')

// 12. 索引只落后一两个会话时，topUp 就地补上，不用整份重建
{
  const built = store.buildIndex()
  const target = memory.listSessions().find((session) => session.id === 'session-bbb')
  // 模拟「会话被追加过」：内容换一份、mtime 变新
  writeSession('proj', 'session-bbb', [
    userMessage(1, 1762100000000, '记忆插件要能带出处，不然没法验证。'),
    userMessage(2, 1762100100000, '后补的一句：出处要能点回去看原文。'),
  ])
  const bumped = memory.listSessions().find((session) => session.id === 'session-bbb')
  assert.notEqual(bumped.mtime, target.mtime, 'mtime 应该变了')
  // 5 分钟内写的会话算「热」，不参与过期判断 —— 要验证的是「冷下来之后」，所以把 mtime 拨回十分钟前
  const old = new Date(Date.now() - 10 * 60 * 1000)
  utimesSync(bumped.file, old, old)
  assert.equal(store.freshnessOfSessions(built.sessions, memory.listSessions()).fresh, false, '这时整份索引是过期的')

  const topped = store.topUpIndex(built, memory.listSessions())
  assert.notEqual(topped.index, null, '只落后一个会话，应该能就地补')
  assert.equal(topped.gaps, 1)
  const found = store.queryIndex(topped.index, store.indexTerms('点回去'))
  assert.ok(found.ids.length > 0, '补上之后新增的句子要能命中')
  assert.equal(memory.recall('点回去', { mode: 'raw', ids: store.hitKeys(topped.index, found.ids) }).raw.total, 1)

  // 落后超过阈值就不硬撑，交给线性扫描
  const many = memory.listSessions().concat(
    Array.from({ length: 25 }, (_, i) => ({ id: 'ghost-' + i, project: 'proj', file: 'x', mtime: 1 })),
  )
  assert.equal(store.topUpIndex(built, many, { maxMissing: 20 }).index, null, '落后太多要放弃')
}
console.log('12. 索引只落后几个会话时就地补上，落后太多就退回线性扫描')

console.log('\n14 项全部通过')
process.exit(0)
