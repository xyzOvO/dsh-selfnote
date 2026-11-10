/**
 * 温层（P3）测试：带指针的摘要 + 可吊销 + 检索能顺着指针回到原文
 * 跑法：node tests/warm.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-warm-'))
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = join(dir, 'sessions')

const { writeSummary, voidSummary, searchWarm, warmStats, warmPath, readWarm } = await import('../lib/warm.js')
const { factsPath } = await import('../lib/memory.js')

const pointer = { sessionId: 'session-abc', index: 12 }

/* 1. 没指针 → 拒绝。这是温层唯一的护栏：核不到原文的摘要等于自述 */
let r = writeSummary({ text: '索引只存词元不存正文', pointers: [] })
assert.equal(r.ok, false)
assert.match(r.error, /指针/)
r = writeSummary({ text: '索引只存词元不存正文' })
assert.equal(r.ok, false)

/* 2. 指针格式不对也算没有 */
r = writeSummary({ text: 'x', pointers: [{ sessionId: '', index: 1 }] })
assert.equal(r.ok, false)
r = writeSummary({ text: 'x', pointers: [{ sessionId: 's', index: -1 }] })
assert.equal(r.ok, false)
console.log('1-2. 没指针 / 指针不完整都写不进去')

/* 3. 正常写：落盘、带 status active、条数对 */
r = writeSummary({ text: '索引只存词元不存正文，发布前验了 65/65 召回', pointers: [pointer], tags: ['索引'] })
assert.equal(r.ok, true)
assert.equal(r.item.status, 'active')
assert.equal(r.total, 1)
assert.ok(existsSync(warmPath()))
assert.equal(readFileSync(warmPath(), 'utf8').trim().split('\n').length, 1)
console.log('3. 带指针的摘要能写进去')

/* 4. 超长摘要拒绝（300 字） */
r = writeSummary({ text: '长'.repeat(301), pointers: [pointer] })
assert.equal(r.ok, false)
assert.match(r.error, /300/)
console.log('4. 超长摘要被拒')

/* 5. 检索：摘要在、指针一起回来 */
let found = searchWarm('索引 词元')
assert.equal(found.mode, 'warm')
assert.ok(found.hits.length >= 1)
const hit = found.hits.find((item) => item.kind === 'summary')
assert.ok(hit, '摘要应当被搜到')
assert.deepEqual(hit.pointers, [pointer])
console.log('5. 检索命中摘要并带回指针')

/* 6. 事实也在温层里：环境事实连 detail 段落一起搜得到 */
writeFileSync(
  factsPath(),
  JSON.stringify({
    id: 'env1',
    text: '推 GitHub 要代理',
    detail: 'HTTPS_PROXY=http://proxy.invalid:7897，账号 demoUser，gh 在 /tmp/gh-cli',
    channel: 'env',
    status: 'approved',
    tags: ['环境'],
    created: '2026-11-03',
  }) + '\n',
)
found = searchWarm('demoUser 代理')
assert.ok(found.hits.some((item) => item.id === 'env1' && item.kind === 'fact'), '要能从 detail 里搜到环境事实')
const envHit = found.hits.find((item) => item.id === 'env1')
assert.match(envHit.detail, /demoUser/)
console.log('6. 环境事实的原文段落也能被搜到')

/* 7. 吊销：不删，标 void，检索不再返回 */
const id = readWarm()[0].id
r = voidSummary(id, '结论已过期')
assert.equal(r.ok, true)
assert.equal(readWarm().length, 1, '吊销不等于删除')
found = searchWarm('索引 词元')
assert.equal(found.hits.some((item) => item.kind === 'summary'), false, '吊销的摘要不该再被搜出来')
const stat = warmStats()
assert.equal(stat.total, 1)
assert.equal(stat.voided, 1)
assert.equal(stat.active, 0)
console.log('7. 吊销只是标 void，检索不返回、条目还在')

/* 8. 空查询不炸；不存在的 id 吊销给错误 */
assert.equal(searchWarm('   ').hits.length, 0)
r = voidSummary('nope')
assert.equal(r.ok, false)
console.log('8. 空查询与不存在的 id 都好好失败')

/* 9. 坏行跳过，不整层废掉 */
writeFileSync(warmPath(), readFileSync(warmPath(), 'utf8') + '{"broken":\n')
assert.equal(readWarm().length, 1, '一行坏掉不该让整层读不出来')
console.log('9. 坏行跳过，其余照常')

console.log('\n9 项全部通过')
