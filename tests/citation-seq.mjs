/**
 * 出处核回：seq 与物理行号是两套编号。
 * 跑法：node tests/citation-seq.mjs
 *
 * 现场：会话文件第 0 行是 session 头（不带 seq），第一条事件 seq=0 落在第 1 行，
 * 所以「物理行号 = seq + 1」。纠偏事件里存的是 seq，checkCitation 却按行号找 ——
 * 于是永远差一行，四轮复盘 26 条证据全被打回。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-citation-seq-'))
const sessionsDir = join(dir, 'sessions')
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = sessionsDir
process.env.DSH_SELFNOTE_NO_OPEN = '1'
mkdirSync(process.env.DSH_MEMORY_DIR, { recursive: true })
mkdirSync(sessionsDir, { recursive: true })

const memory = await import('../lib/memory.js')
const corrections = await import('../lib/corrections.js')
const review = await import('../lib/review.js')

const AT = '2026-11-18T08:00:00.000Z'
const SAID = '最后测试相关功能，有bug就修，别问我，按你推荐的做'

function userMessage(seq, text) {
  return { type: 'user/message', seq, time: Date.parse(AT), data: { content: [{ type: 'text', text }], role: 'user', source: { kind: 'user' } } }
}

function writeSession(id, records) {
  const folder = join(sessionsDir, 'demo', id)
  mkdirSync(folder, { recursive: true })
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  writeFileSync(join(folder, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
}

/*
 * 真实文件的形状：头行没有 seq。
 * 第 0 行 session 头 · 第 1 行 seq=0 的 user · 第 2 行 seq=1 的 step/start（无正文）· 第 3 行 seq=2 的 user
 */
writeSession('s1', [
  { type: 'session', id: 's1', createdAt: AT },
  userMessage(0, '先看下这轮测试'),
  { type: 'step/start', seq: 1, time: Date.parse(AT), data: {} },
  userMessage(2, SAID),
])

/* 1. 解析出来要带 seq，且 index 是物理行号 —— 两个数差 1 */
const session = memory.listSessions().find((item) => item.id === 's1')
assert.ok(session, '会话要被索引到')
const parsed = memory.readSession(session)
const said = parsed.records.find((record) => record.text === SAID)
assert.ok(said, '那句原话要能被解析出来')
assert.equal(said.seq, 2, '记录要带 seq')
assert.equal(said.index, 3, 'index 仍是物理行号（seq + 1）')
console.log('1. 记录同时带 seq 与行号，两者差一行')

/* 2. 按 seq 核回能过，且返回的记录带着行号 */
const bySeq = memory.checkCitation({ sessionId: 's1', seq: 2 })
assert.equal(bySeq.ok, true, '按 seq 核回必须成功：' + bySeq.error)
assert.equal(bySeq.record.index, 3)
assert.equal(bySeq.date, '2026-11-18')
console.log('2. 按 seq 能核回，结果带行号')

/* 3. 按行号核回的旧语义不许变：存量 facts 的 citation 就是这么存的 */
const byLine = memory.checkCitation({ sessionId: 's1', index: 3 })
assert.equal(byLine.ok, true, '按行号核回必须继续可用：' + byLine.error)
assert.equal(byLine.record.text, SAID)
const lineMiss = memory.checkCitation({ sessionId: 's1', index: 2 })
assert.equal(lineMiss.ok, false, '第 2 行是 step/start，没有正文，按行号核回仍该打回')
assert.match(String(lineMiss.error), /不是可检索的消息/)
console.log('3. 行号口径向后兼容，落空仍然打回')

/* 4. 引文对不上就拒收：核到一条消息不等于它说了这句话 */
const badQuote = memory.checkCitation({ sessionId: 's1', seq: 2, quote: '这句他从来没说过' })
assert.equal(badQuote.ok, false, '引文不匹配必须拒收')
assert.match(String(badQuote.error), /引文/)
const goodQuote = memory.checkCitation({ sessionId: 's1', seq: 2, quote: '  最后测试相关功能，\n有bug就修 ' })
assert.equal(goodQuote.ok, true, '空白差异不算对不上：' + goodQuote.error)
console.log('4. 引文逐字比对，空白差异放过')

/* 5. 复盘证据包：事件存 seq，核回后 index 归一成行号，source 也用行号 */
corrections.writeEvents([
  {
    id: 'e1',
    at: AT,
    session: 's1',
    idx: 2,
    quote: SAID,
    used: false,
    usedAt: null,
    consumedBy: null,
    strength: 'strong',
  },
  {
    id: 'e2',
    at: AT,
    session: 's1',
    idx: 2,
    quote: '这句他从来没说过',
    used: false,
    usedAt: null,
    consumedBy: null,
    strength: 'weak',
  },
])
const collected = review.collectEvidence({ now: new Date(AT) })
assert.equal(collected.ok, true)
assert.equal(collected.evidence.length, 1, 'e1 该核回成功，e2 引文不匹配该打回')
assert.equal(collected.evidence[0].index, 3, '证据包的 index 是行号，不是 seq')
assert.equal(collected.evidence[0].seq, 2, 'seq 单独保留，供排查')
assert.equal(collected.evidence[0].source, 's1#3')
assert.equal(collected.evidence[0].originalText, SAID)
assert.equal(collected.rejected.length, 1)
assert.equal(collected.rejected[0].id, 'e2')
assert.match(String(collected.rejected[0].reason), /引文/)
console.log('5. 证据包存行号、留 seq，引文不符打回')

/* 6. 下游用证据包的 index 走 memory 那条路（stageFact）要能过 —— 一个字段只能一个含义 */
const citation = { sessionId: 's1', index: collected.evidence[0].index }
const staged = memory.stageFact({ text: '测试用：出处核回口径已统一为行号', citation })
assert.equal(staged.ok, true, '证据包的 index 必须能直接进 stageFact：' + staged.error)
assert.equal(staged.fact.citation.index, 3)
console.log('6. 证据包 index 能直接进候选事实，字段含义统一')

/* 7. 旧缓存必须作废：缓存里没有 seq 时不能「文件没变就照用」 */
const firstRead = memory.readSession(session)
assert.equal(firstRead.records.some((record) => record.seq !== undefined), true)
const cacheFile = join(memory.cacheDir(), session.id + '.json')
if (existsSync(cacheFile)) {
  const stale = JSON.parse(readFileSync(cacheFile, 'utf8'))
  stale.v = 6
  stale.records = stale.records.map(({ seq, ...rest }) => rest)
  writeFileSync(cacheFile, JSON.stringify(stale))
  const reread = memory.readSession(session)
  assert.equal(
    reread.records.every((record) => record.seq !== undefined),
    true,
    '旧版本缓存要重解析，不能把没有 seq 的记录继续当有效数据',
  )
  console.log('7. 旧版本缓存被作废，重新解析出 seq')
} else {
  console.log('7. 未落缓存文件，跳过（缓存目录未启用）')
}

console.log('\n全部通过：seq 与行号两套编号各归其位')
