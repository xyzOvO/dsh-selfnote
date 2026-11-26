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
  pickCandidates,
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

/* 2. 候选只按眼前事实取：去重、限 N、剔除同 signal 已保留的那条，与作废句字面无关 */
const facts = [
  { id: 'f-1', text: '甲地办公的规矩记在这里' },
  { id: 'f-1', text: '甲地办公的规矩记在这里' },
  { id: 'f-2', text: '乙地办公的规矩记在这里' },
  { id: 'f-3', text: '丙地办公的规矩记在这里' },
  { id: 'f-4', text: '丁地办公的规矩记在这里' },
  { id: 'f-5', text: '戊地办公的规矩记在这里' },
  { id: 'f-6', text: '己地办公的规矩记在这里' },
]
// 函数签名只吃 facts / signal / limit，没有任何"作废句文本"参数 —— 候选与字面彻底解耦
const candidates = pickCandidates(facts, 'sig-2', 5)
assert.equal(candidates.length, 5, '最多取 limit 条')
assert.equal(new Set(candidates.map((item) => item.id)).size, 5, '按 id 去重')
assert.deepEqual(candidates.map((item) => item.id), ['f-1', 'f-2', 'f-3', 'f-4', 'f-5'], '按眼前事实顺序取前 N 条')
assert.ok(candidates.every((item) => typeof item.id === 'string' && typeof item.text === 'string'))
assert.equal(pickCandidates(facts, 'sig-2', 0).length, 0, 'limit=0 返回空')
console.log('2. pickCandidates：只按眼前事实去重限流，不看作废句字面')

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
assert.deepEqual(cards[0].candidates, cardFacts.map(({ id, text }) => ({ id, text })), '候选恰为本轮眼前事实，与作废句字面无关')
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

/* 7. 同一信号点过「保留」的那条被剔除，其余候选还在；无眼前事实不出卡 */
const sig = 'sig-7'
const withKept = [
  { id: 'kept-one', text: '旧地址是人民路 1 号', status: 'approved',
    history: [{ at: '2026-11-26T00:00:00.000Z', from: null, to: null, via: 'validity-kept', signal: sig }] },
  { id: 'live-one', text: '旧地址是人民路 1 号', status: 'approved', history: [] },
  { id: 'unrelated', text: '回答先给结论', status: 'approved', history: [] },
]
const keptCandidates = pickCandidates(withKept, sig, 5)
assert.deepEqual(keptCandidates.map((item) => item.id), ['live-one', 'unrelated'], '保留过的那条不再列候选，其余事实保留')
// 换一个信号，之前保留过的那条仍可重新进候选（保留只对当前这句生效）
assert.ok(
  pickCandidates(withKept, 'another-sig', 5).some((item) => item.id === 'kept-one'),
  '换信号后保留记录不生效'
)
// 本轮没有眼前事实时根本不出卡（不是出一张空卡）
const noFactsCards = buildValidityCards({
  events: [{ session: 's9', idx: 1, quote: '这条不算数了', at: '2026-11-26', strength: 'strong' }],
  facts: [],
  check: () => ({ ok: true, session: { id: 's9', date: '2026-11-26' }, record: { role: 'user', index: 1 } }),
  provenance: () => 'own',
})
assert.deepEqual(noFactsCards, [], '无眼前事实 → 不出卡')
console.log('7. pickCandidates：保留过的按信号剔除；无眼前事实不出卡')

console.log('\n7 组全部通过（data dir: ' + dir + '）')
process.exit(0)
