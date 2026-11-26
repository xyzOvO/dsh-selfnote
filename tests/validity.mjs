/**
 * 有效性纯函数与数据层：只测判据本身，不测调用方的接线。
 * 跑法：node tests/validity.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-validity-'))
process.env.DSH_SELFNOTE_DIR = join(dir, 'selfnote')
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = join(dir, 'sessions')

const {
  STALE_FACTOR,
  STALE_FLOOR,
  VALIDITY_VERSION,
  signalKey,
  validityWeight,
  findCandidates,
  buildValidityCards,
  readProcessedKeys,
  appendProcessedKeys,
} = await import('../lib/validity.js')
const { eventId } = await import('../lib/corrections.js')
const { provenanceOf } = await import('../lib/review.js')
const { writeFacts, listFacts, markSignalHandled } = await import('../lib/memory.js')

/* 1. 结构信号每中一档降一档；零档原样；结果不低于下限 */
assert.equal(STALE_FACTOR, 0.7)
assert.equal(STALE_FLOOR, 0.25)
assert.equal(VALIDITY_VERSION, '1')
assert.equal(validityWeight({}), 1)
assert.equal(validityWeight({ conflictWith: ['x'] }), 0.7)
assert.equal(validityWeight({ conflictWith: ['x'], similarTo: ['y'] }), 0.7 * 0.7)
assert.ok(validityWeight({ conflictWith: ['x'], similarTo: ['y'] }) >= 0.25)
assert.equal(validityWeight({ conflictWith: [], similarTo: [] }), 1)
console.log('1. validityWeight：0 → 1，1 档 → 0.7，2 档 → 0.49，且不低于下限')

/* 2. 候选按相关度排序、去重、受 limit 约束 */
const facts = [
  { id: 'addr-1', text: '旧地址是人民路 1 号，联系时用这个地址' },
  { id: 'addr-1', text: '旧地址是人民路 1 号，联系时用这个地址' },
  { id: 'note', text: '旧结论写在这里' },
  { id: 'addr-2', text: '另一个地址在别处的旧说法' },
]
const candidates = findCandidates('别再提旧地址和旧结论了', facts, 3)
assert.equal(candidates.length, 3)
assert.deepEqual(new Set(candidates.map((item) => item.id)).size, 3, '候选按 id 去重')
const firstAddress = candidates.findIndex((item) => item.id === 'addr-1')
const firstNote = candidates.findIndex((item) => item.id === 'note')
assert.ok(firstAddress !== -1 && firstNote !== -1 && firstAddress < firstNote, '含“地址”的候选排在含“结论”的无关条之前')
assert.ok(candidates.every((item) => typeof item.id === 'string' && typeof item.text === 'string'))
assert.equal(findCandidates('随便', facts, 2).length, 0, '零分不再兜底：无词元匹配时不硬凑候选')
assert.equal(findCandidates('随便', facts, 0).length, 0)
console.log('2. findCandidates：Top-N 排序、去重、limit 生效')

/* 3. 三重收敛 + 已处理台账：只有第一条原始信号出卡 */
// s1=本人原话，s2=核回失败，s3=已处理，s4=强信号且核回成功但未处理的非本人来源。
// s4 与 s1 的唯一差别是 role/文本来源，own-only 判定一旦放松就必须转红。
const events = [
  { session: 's1', idx: 12, quote: '我说过别再提旧地址了', at: '2026-11-26', strength: 'strong' },
  { session: 's2', idx: 7, quote: '别再提旧地址了', at: '2026-11-26', strength: 'strong' },
  { session: 's3', idx: 8, quote: '我说过别再提旧地址了', at: '2026-11-26', strength: 'strong' },
  { session: 's4', idx: 9, quote: '我说过别再提旧地址了', at: '2026-11-26', strength: 'strong', sourceKind: 'pasted' },
]
const processedKey = signalKey(events[2])
const checks = []
const provenanceCalls = []
const cardFacts = [
  { id: 'addr', text: '旧地址是人民路 1 号' },
  { id: 'other', text: '回答先给结论' },
]
const cards = buildValidityCards({
  events,
  facts: cardFacts,
  processedKeys: new Set([processedKey]),
  check: ({ sessionId, seq, quote }) => {
    checks.push({ sessionId, seq, quote })
    if (sessionId === 's2') return { ok: false }
    const own = sessionId === 's1'
    return {
      ok: true,
      session: { id: sessionId, date: '2026-11-26' },
      record: { role: own ? 'user' : 'assistant', index: own ? 34 : 56 },
      date: '2026-11-26',
    }
  },
  provenance: ({ role, text }) => {
    provenanceCalls.push({ role, text })
    if (role !== 'user') return 'quoted'
    return provenanceOf({ role, text })
  },
})
assert.equal(cards.length, 1)
assert.deepEqual(Object.keys(cards[0]).sort(), ['at', 'candidates', 'key', 'quote', 'source'])
assert.equal(cards[0].key, signalKey(events[0]))
assert.equal(cards[0].quote, events[0].quote)
assert.equal(cards[0].at, events[0].at)
assert.equal(cards[0].source, 's1#34')
assert.deepEqual(cards[0].candidates, findCandidates(events[0].quote, cardFacts))
assert.deepEqual(checks, events.map((event) => ({ sessionId: event.session, seq: event.idx, quote: event.quote })))
assert.deepEqual(provenanceCalls, [
  { role: 'user', text: events[0].quote },
  { role: 'assistant', text: events[3].quote },
])
console.log('3. buildValidityCards：强信号 + 本人原话 + 核回成功 + 未处理 → 仅一条卡，非本人来源不出卡')

/* 4. signalKey 是 eventId(session, idx, quote) 的确定性封装 */
const event = { session: 'sess-1', idx: 12, quote: '  别再  改  ' }
assert.equal(signalKey(event), signalKey({ ...event }))
assert.equal(signalKey(event), eventId(event.session, event.idx, event.quote))
assert.notEqual(signalKey(event), signalKey({ ...event, quote: '别再改' }))
console.log('4. signalKey：同 (session, idx, quote) 得同值，且与 eventId 一致')

/* 5. 台账读写：追加、去重、持久化 */
const keys = readProcessedKeys()
assert.ok(keys instanceof Set)
assert.equal(keys.size, 0)
appendProcessedKeys(['k1', 'k2', 'k1'])
const keys2 = readProcessedKeys()
assert.ok(keys2 instanceof Set)
assert.deepEqual([...keys2].sort(), ['k1', 'k2'])
appendProcessedKeys(new Set(['k3']))
assert.deepEqual([...readProcessedKeys()].sort(), ['k1', 'k2', 'k3'])
const ledger = join(process.env.DSH_SELFNOTE_DIR, 'validity-processed.json')
assert.ok(existsSync(ledger))
assert.ok(Array.isArray(JSON.parse(readFileSync(ledger, 'utf8'))))
console.log('5. readProcessedKeys / appendProcessedKeys：去重追加、持久化')

/* 6. 保留信号只写 fact 自己的 history，不改状态/版本/日期 */
writeFacts([{
  id: 'kept',
  text: '旧地址是人民路 1 号',
  status: 'approved',
  version: 3,
  updated: '2026-01-02',
  retiredAt: undefined,
  history: [{ at: '2026-01-02T00:00:00.000Z', from: null, to: 'approved', via: 'settings' }],
}])
const before = listFacts()[0]
const signal = { session: 's1', idx: 12, quote: '别再提旧地址了' }
const marked = markSignalHandled('kept', signal, 'validity-kept')
assert.equal(marked.ok, true)
const after = listFacts()[0]
assert.equal(after.status, before.status)
assert.equal(after.version, before.version)
assert.equal(after.updated, before.updated)
assert.equal(after.retiredAt, undefined)
assert.equal(after.history.length, before.history.length + 1)
assert.deepEqual(after.history.slice(0, -1), before.history)
const added = after.history.at(-1)
assert.ok(typeof added.at === 'string' && added.at.length > 0)
assert.equal(added.from, null)
assert.equal(added.to, null)
assert.equal(added.via, 'validity-kept')
assert.deepEqual(added.signal, signal)
assert.equal(marked.fact.id, 'kept')
console.log('6. markSignalHandled：只追加 signal history，不动 status / version / updated / retiredAt')

/* 7. 同一信号点过「保留」的那条被剔除，其余候选还在；零分无关项不硬凑 */
const sig = 'sig-7'
const withKept = [
  { id: 'kept-one', text: '旧地址是人民路 1 号', status: 'approved',
    history: [{ at: '2026-11-26T00:00:00.000Z', from: null, to: null, via: 'validity-kept', signal: sig }] },
  { id: 'live-one', text: '旧地址是人民路 1 号', status: 'approved', history: [] },
  { id: 'unrelated', text: '回答先给结论', status: 'approved', history: [] },
]
const keptCandidates = findCandidates('别再提旧地址了', withKept, 5, sig)
assert.deepEqual(keptCandidates.map((item) => item.id), ['live-one'], '保留过的那条不再列候选，其余相关条保留')
// 换一个信号，之前保留过的那条仍可重新进候选（保留只对当前这句生效）
assert.ok(
  findCandidates('别再提旧地址了', withKept, 5, 'another-sig').some((item) => item.id === 'kept-one'),
  '换信号后保留记录不生效'
)
console.log('7. findCandidates：保留过的候选按信号剔除；零分无关项不硬凑')

console.log('\n7 组全部通过（data dir: ' + dir + '）')
process.exit(0)
