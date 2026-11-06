/**
 * Task 2 回归：7 个 segment 都给 skippedDetail，且注入文本 / overhead 一字节不变。
 * 跑法：node tests/skipped.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { SKIP_REASONS, skippedId } from '../lib/explain.js'
import {
  bootFixture,
  CROSS_TEXT,
  DUP_TEXT,
  OVERHEAD_BASELINE_URL,
  TEXT_BASELINE_URL,
} from './fixtures/injection-fixture.mjs'

const NL = String.fromCharCode(10)
const baseline = readFileSync(TEXT_BASELINE_URL)
const overheadBaseline = Number(readFileSync(OVERHEAD_BASELINE_URL, 'utf8').trim())

const f = await bootFixture()

/* 1. 两把锁：改前逐字节锁死，RED 阶段它们必须是绿的 */
assert.equal(Buffer.compare(Buffer.from(f.injectionText(), 'utf8'), baseline), 0, '注入文本一个字节都不许变')
const st = (await f.state()).payload
assert.equal(st.injection.overhead, overheadBaseline, '人格单关时 overhead 必须与改前完全一致')
console.log('1. 注入文本与 overhead 双基线保持')

/* 2. 启用时恒 7 段；personaEnabled:false 补零值段 */
assert.equal(st.injection.segments.length, 7)
assert.deepEqual(st.injection.segments.map((s) => s.key),
  ['persona', 'notes', 'guide', 'profile', 'env', 'facts', 'habits'])
assert.equal(st.injection.segments[0].chars, 0, 'personaEnabled:false 时人格段是零值')
assert.deepEqual(st.injection.segments[0].skippedDetail, [])
assert.ok(st.injection.segments.every((s) => Array.isArray(s.skippedDetail)), '7 段都要显式给 skippedDetail')
assert.ok(st.injection.segments.every((s) => s.skippedDetail.every((d) => SKIP_REASONS.includes(d.reason))))
console.log('2. 7 段全带 skippedDetail，reason 都在封闭枚举内')

/* 3. notes 段闭合 + P1 同文跨型 + P3 重复 ID */
const notesSeg = st.injection.segments.find((s) => s.key === 'notes')
assert.equal(notesSeg.skippedDetail.length, notesSeg.skipped.length + 1, 'skipped 每条 + core 每条，各恰好一条解释')
assert.equal(notesSeg.skippedDetail.length, 12 - notesSeg.kept.length, '12 条自述闭合：进来的 + 被跳过的 + core')
assert.ok(notesSeg.skippedDetail.some((d) => d.preview === CROSS_TEXT && d.reason === 'budget'), '稳定条同文不许被误标 expired')
assert.ok(notesSeg.skippedDetail.some((d) => d.preview === CROSS_TEXT && d.reason === 'expired'), '过期条同文不许被误标 budget')
assert.equal(notesSeg.skippedDetail.filter((d) => d.reason === 'expired').length, 3, '3 条过期（含重复文本）一条都不能少')
assert.equal(notesSeg.skippedDetail[notesSeg.skipped.length].preview, '素材层，不注入')
assert.equal(notesSeg.skippedDetail[notesSeg.skipped.length].reason, 'budget')
const dupDetails = notesSeg.skippedDetail.filter((d) => d.id === skippedId('notes', DUP_TEXT))
assert.equal(dupDetails.length, 2, '两条相同文本都必须保留')
assert.equal(dupDetails[0].id, dupDetails[1].id, '同文 → 同 id 是允许的')
console.log('3. notes 闭合；同文靠 sources 分开；core 归 budget；重复 ID 不去重')

/* 4. packNotes 逐位对应（动态 import：Step 4 才给它加 export） */
const { packNotes } = await import('../lib/index.js')
assert.equal(typeof packNotes, 'function', 'Step 4 必须把 packNotes 导出给测试验逐位对应')
const oldDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
const entries = [
  { date: oldDate, text: '稳定甲', tier: 'stable' },
  { date: oldDate, text: DUP_TEXT, tier: 'stable' },
  { date: oldDate, text: DUP_TEXT, tier: 'stable' },
  { date: oldDate, text: '核心素材', tier: 'core' },
  { date: oldDate, text: CROSS_TEXT, tier: 'stable' },
  { date: oldDate, text: CROSS_TEXT, tier: 'temp' },
  { date: oldDate, text: '', tier: 'temp' }, // 空串过期条目：parseNotes 会丢，但 packNotes 自己要保住位置
]
const out = packNotes(entries, 200, 14)
assert.equal(out.skippedSources.length, out.skipped.length, 'skippedSources 必须与 skipped 等长')
assert.equal(out.skippedSources.filter((s) => s === 'expired').length, out.tiers.temp.expired, 'expired 条数必须等于 tiers.temp.expired')
assert.ok(out.skippedSources.every((s) => s === 'budget' || s === 'expired'), '来源只能是 budget / expired')
const emptyAt = out.skipped.findIndex((text) => text === '')
assert.ok(emptyAt >= 0, '空串过期条目不许被丢掉')
assert.equal(out.skippedSources[emptyAt], 'expired', '空串那条靠平行数组认，不靠文本比对')
console.log('4. packNotes 的 skippedSources 与 skipped 逐位平行（含空串过期条）')

/* 5. 各自实际那一遍：改 notes.md 后 /state 的解释与 key 都得变（边界 7） */
const before = (await f.state()).payload
const detailA = before.injection.segments.find((s) => s.key === 'notes').skippedDetail
writeFileSync(f.notesPath(), readFileSync(f.notesPath(), 'utf8') + '- 2026-11-07 ' + '超长新条目-' + 'y'.repeat(80) + NL, 'utf8')
const now = new Date()
utimesSync(f.notesPath(), now, now)
const after = (await f.state()).payload
const detailB = after.injection.segments.find((s) => s.key === 'notes').skippedDetail
assert.notEqual(JSON.stringify(detailB), JSON.stringify(detailA), '解释数据必须来自各自实际那一遍')
assert.notEqual(after.injection.key, before.injection.key, 'notes.md 变了，injection.key 也得变')
assert.notEqual(Buffer.compare(Buffer.from(f.injectionText(), 'utf8'), baseline), 0, '改过数据后真注入文本也要变')
console.log('5. /state 的解释不是缓存的旧快照；真注入那遍也独立变化')

/* 6. 两种关闭态 */
writeFileSync(f.configPath(), JSON.stringify({
  enabled: false, personaEnabled: false, profileEnabled: false,
  heading: 'AI记忆', noteGuide: '', tempTtlDays: 14, halfLifeDays: 30,
}), 'utf8')
const off = (await f.state()).payload
assert.deepEqual(off.injection.segments, [], '插件全关时 /state 形状不许冒出 7 个空段')
assert.equal(off.injection.text, '')
assert.equal(f.injectionText(), '')
console.log('6. enabled:false 仍是 segments:[]；人格单关的 overhead 已在第 1 段锁死')

f.cleanup()
console.log('\n6 项全部通过')
