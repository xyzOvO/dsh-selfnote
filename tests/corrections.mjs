/**
 * 纠偏证据存储 + 跨三文件事务。
 *
 * 这里测的都不是「函数能返回」，而是几条会咬人的契约：
 *   - 恢复必须幂等：重放任意次结果一样，count 不能重复加
 *   - 三个文件要么一起前进、要么一起不动，不许半新半旧
 *   - 证据一旦被别的事务消费过，不许被后来的事务覆盖
 *   - 非法 id（不存在 / 已被消费 / 已过期）必须整单拒绝，不能静默吞掉
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-tx-'))
process.env.DSH_SELFNOTE_DIR = join(dir, 'selfnote')
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(process.env.DSH_SELFNOTE_DIR, { recursive: true })
mkdirSync(process.env.DSH_MEMORY_DIR, { recursive: true })

const tx = await import('../lib/persona-tx.js')
const store = await import('../lib/corrections.js')
const persona = await import('../lib/persona.js')

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const evidencePath = join(process.env.DSH_SELFNOTE_DIR, 'persona.evidence.json')
const txPath = join(process.env.DSH_SELFNOTE_DIR, 'persona.pending.json')
const lockPath = join(process.env.DSH_SELFNOTE_DIR, 'persona.lock')

const event = (over) => ({ id: 'e1', at: '2026-11-05T10:00:00.000Z', session: 's1', idx: 1, quote: 'q', used: false, usedAt: null, consumedBy: null, ...over })

/* ---------------- 46. 事件存储：坏行跳过，写回保持一行一条 ---------------- */

store.writeEvents([event({ id: 'a' }), event({ id: 'b' })])
writeFileSync(store.CORRECTIONS_PATH, 'not json\n' + store.readEvents().map((row) => JSON.stringify(row)).join('\n') + '\n')
assert.equal(store.readEvents().length, 2, '坏行要跳过，不能整个文件读不出来')
assert.equal(store.findById('b').id, 'b')
assert.equal(store.findById('nope'), undefined)
console.log('46. 事件存储：一行一条，坏行跳过')

/* ---------------- 47. 标记消费：别的 txId 消费过的不覆盖 ---------------- */

store.writeEvents([event({ id: 'a' }), event({ id: 'b', used: true, usedAt: '2026-11-05T09:00:00.000Z', consumedBy: 'tx0' })])
const marked = store.markUsed(['a', 'b'], 'tx1')
assert.equal(marked.marked, 1, '只该标 a')
assert.deepEqual(marked.conflict, ['b'], 'b 已被 tx0 消费，不能抢')
assert.equal(store.findById('b').consumedBy, 'tx0', '冲突的不许覆盖')
assert.equal(store.findById('a').consumedBy, 'tx1')
assert.equal(store.markUsed(['a'], 'tx1').marked, 0, '同一个 txId 重复标是幂等的')
console.log('47. 标记消费：不同 txId 冲突不覆盖，同 txId 幂等')

/* ---------------- 48. 指纹：标点空白不影响，长度 16 ---------------- */

const fpA = tx.ruleFingerprint('- 回答先举例，再给结论。')
assert.equal(fpA, tx.ruleFingerprint('回答先举例 再给结论'), '规范化的规则正文相同就该同一个指纹')
assert.notEqual(fpA, tx.ruleFingerprint('回答先给结论，再举例'), '顺序不同是两条规则')
assert.equal(fpA.length, 16)
assert.equal(tx.RULE_ALGO, 'nfkc-wp1')
console.log('48. 规则指纹：标点与空白不参与算，16 位')

/* ---------------- 49. evidenceAfter 是目标状态（纯函数，可重放） ---------------- */

const base = { v: 1, algo: tx.RULE_ALGO, rules: {} }
const once = tx.buildEvidenceAfter(base, ['- 回答先举例，再给结论。'], '2026-11-05T10:00:00.000Z')
assert.equal(once.rules[fpA].count, 1)
assert.equal(once.rules[fpA].firstAt, '2026-11-05T10:00:00.000Z')
assert.equal(once.rules[fpA].lastAt, '2026-11-05T10:00:00.000Z')
const twice = tx.buildEvidenceAfter(once, ['- 回答先举例，再给结论。'], '2026-11-06T10:00:00.000Z')
assert.equal(twice.rules[fpA].count, 2)
assert.equal(twice.rules[fpA].firstAt, '2026-11-05T10:00:00.000Z', 'firstAt 只记第一次')
assert.equal(twice.rules[fpA].lastAt, '2026-11-06T10:00:00.000Z')
assert.equal(base.rules[fpA], undefined, '不许改传入的 base')
console.log('49. evidenceAfter 是目标状态，算两次结果只由 base 决定')

/* ---------------- 50. 提交：三个文件一起前进 ---------------- */

store.writeEvents([event({ id: 'a' })])
const okCommit = await tx.commitPersona({ l0: '我是大肥鱼。', l1: '- 回答先举例，再给结论。', l2: '深海底。', consume: ['a'] })
assert.equal(okCommit.ok, true)
assert.deepEqual(okCommit.consumed, ['a'])
assert.equal(persona.readPersona().l0, '我是大肥鱼。')
assert.equal(store.findById('a').used, true)
assert.equal(store.findById('a').consumedBy.startsWith('tx-'), true, 'consumedBy 要记下是哪个事务')
assert.equal(tx.readEvidence().rules[fpA].count, 1, '证据计数要跟着前进')
assert.equal(tx.readTx(), null, '成功之后日志必须删掉')
console.log('50. 提交：persona / 事件 / 证据一起前进，日志清空')

/* ---------------- 51. 幂等恢复：日志没删掉也不重复计数 ---------------- */

const shaWritten = sha(persona.renderPersona({ l0: '我是大肥鱼。', l1: '- 回答先举例，再给结论。', l2: '深海底。' }))
const replayTarget = tx.buildEvidenceAfter(tx.readEvidence(), ['- 回答先举例，再给结论。'], '2026-11-07T10:00:00.000Z')
tx.beginTx({ txId: 'tx-replay', personaSha256: shaWritten, consume: ['a'], evidenceAfter: replayTarget })
const firstReplay = tx.recover()
assert.equal(firstReplay.action, 'replayed', '摘要对得上就该重放：' + JSON.stringify(firstReplay))
const countAfterReplay = tx.readEvidence().rules[fpA].count
const secondReplay = tx.recover()
assert.equal(secondReplay.action, 'none', '第二次没有日志了，什么都不做')
assert.equal(tx.readEvidence().rules[fpA].count, countAfterReplay, '重放不许重复计数')
console.log('51. 幂等恢复：重放任意次，计数不重复加')

/* ---------------- 52. 摘要对不上 → 回滚，不消费任何证据 ---------------- */

store.writeEvents([event({ id: 'b' })])
tx.beginTx({ txId: 'tx-stale', personaSha256: sha('这不是当前文件的摘要'), consume: ['b'], evidenceAfter: { v: 1, algo: tx.RULE_ALGO, rules: {} } })
const rolled = tx.recover()
assert.equal(rolled.action, 'rolled-back', 'persona 没写成这个摘要，就不能消费证据：' + JSON.stringify(rolled))
assert.equal(store.findById('b').used, false, '回滚后证据仍然未消费')
assert.equal(tx.readTx(), null, '回滚也要把日志清掉')
console.log('52. 摘要对不上：回滚，证据一条不消费')

/* ---------------- 53. 坏日志 → 隔离，不动数据 ---------------- */

writeFileSync(txPath, '{ not json')
const quarantined = tx.recover()
assert.equal(quarantined.action, 'quarantined')
assert.equal(tx.readTx(), null, '坏日志要挪走，不能每次启动都撞它')
assert.equal(readdirSync(process.env.DSH_SELFNOTE_DIR).some((name) => name.startsWith('persona.pending.bad-')), true, '坏日志留档')
console.log('53. 坏日志：隔离留档，不动数据')

/* ---------------- 54. 三文件一致：证据写不下去要报 pending，不许谎报成功 ---------------- */

store.writeEvents([event({ id: 'c' })])
rmSync(evidencePath, { force: true })
mkdirSync(evidencePath, { recursive: true }) // 让 evidence 写成目录 → 必然失败
const pending = await tx.commitPersona({ l0: '我是大肥鱼。', l1: '- 回答先举例，再给结论。\n- 不说客套话。', l2: '', consume: ['c'] })
assert.equal(pending.ok, true, 'persona 已经写成功了，不能报整体失败')
assert.equal(pending.pending, true, '要说清「已保存但消费待恢复」：' + JSON.stringify(pending))
assert.equal(store.findById('c').used, true, '消费其实已经发生了（第 4 步前半）')
assert.notEqual(tx.readTx(), null, '日志要留着给恢复用')
// 修好磁盘，让恢复跑得下去
rmSync(evidencePath, { recursive: true, force: true })
const healed = tx.recover()
assert.equal(healed.action, 'replayed')
assert.equal(tx.readEvidence().rules[tx.ruleFingerprint('- 不说客套话。')].count, 1, '恢复后计数要正确')
assert.equal(tx.readTx(), null)
console.log('54. 三文件一致：写不下去报 pending，恢复后计数正确')

/* ---------------- 55. 串行化：外部持锁 → locked；并发提交各自成功 ---------------- */

writeFileSync(lockPath, 'other-process')
const locked = await tx.commitPersona({ l0: '我是大肥鱼。', l1: '- 先说结论。', l2: '', consume: [] })
assert.equal(locked.ok, false)
assert.equal(locked.code, 'locked', '有人正在保存，就该说 locked，不是排队等死：' + JSON.stringify(locked))
rmSync(lockPath, { force: true })
const [one, two] = await Promise.all([
  tx.commitPersona({ l0: '我是大肥鱼。', l1: '- 先说结论。', l2: '', consume: [] }),
  tx.commitPersona({ l0: '我是大肥鱼。', l1: '- 先说结论。', l2: '', consume: [] }),
])
assert.equal(one.ok && two.ok, true, '进程内两次提交要串行跑完，都成功：' + JSON.stringify([one, two]))
assert.equal(tx.readTx(), null, '跑完不能留日志')
assert.equal(existsSync(lockPath), false, '跑完要放锁')
console.log('55. 串行化：外部持锁报 locked，并发提交串行完成')

/* ---------------- 56. 非法 id 整单拒绝，文件一个字节都不动 ---------------- */

const beforePersona = persona.readPersona()
const beforeEvidence = tx.readEvidence()
const badMissing = await tx.commitPersona({ l0: '改一下。', l1: '- 先说结论。', l2: '', consume: ['不存在'] })
assert.equal(badMissing.ok, false)
assert.equal(badMissing.code, 'validation')
const badUsed = await tx.commitPersona({ l0: '改一下。', l1: '- 先说结论。', l2: '', consume: ['c'] })
assert.equal(badUsed.ok, false, '已消费的证据不许二次消费')
assert.equal(badUsed.code, 'validation')
assert.equal(persona.readPersona().l0, beforePersona.l0, '校验失败时 persona 一个字都不许动')
assert.deepEqual(tx.readEvidence(), beforeEvidence, '校验失败时证据也不许动')
console.log('56. 非法 id：整单拒绝，三个文件都不动')

/* ---------------- 57. 超长校验同样整单拒绝 ---------------- */

const tooLong = await tx.commitPersona({ l0: '我'.repeat(200), l1: '- 先说结论。', l2: '', consume: [] })
assert.equal(tooLong.ok, false)
assert.equal(tooLong.code, 'l0-too-long', '校验码要透出来，别糊成一句「失败」')
assert.equal(persona.readPersona().l0, beforePersona.l0)
console.log('57. 超长：拒绝并说清是哪一段')

/* ---------------- 58–66. 采集：信号、去重、上限、游标、水位、清理 ---------------- */

store.writeEvents([])

// 58. 强弱信号与三种误命中
assert.equal(store.extractSignals({ text: '你又错了，这不对', isReply: true }).length, 1, '强信号要落')
assert.equal(store.extractSignals({ text: '这次不是技术问题', isReply: false }).length, 0, '没有「你」也没有指上一版的弱信号不落')
assert.equal(store.extractSignals({ text: '不要太长', isReply: true }).length, 0, '「不要太长」是程度不是纠偏')
assert.equal(store.extractSignals({ text: '我又想到一个新方案', isReply: true }).length, 0, '「我又想到」不是纠错')
assert.equal(store.extractSignals({ text: '我说过先举例再给结论', isReply: false }).length, 1, '强信号不需要 isReply')
assert.ok(store.extractSignals({ text: '我说过 A。我说过 B。你又错 C。', isReply: true }).length <= 2, '单条消息最多 2 条证据')
const weakHit = store.extractSignals({ text: '你把结论改成表格了', isReply: false })
assert.equal(weakHit.length, 1, '弱信号带「你」就该落')
assert.equal(weakHit[0].strength, 'weak')
console.log('58. 强弱信号：该落的落，三种误命中不落')

// 59. 同一消息重复扫描去重；不同消息里同一句话必须保留
const dupId = store.eventId('s1', 1, '我说过先举例再给结论')
store.appendEvents([{ id: dupId, session: 's1', idx: 1, quote: '我说过先举例再给结论', at: '2026-11-05T10:00:00.000Z' }])
store.appendEvents([{ id: dupId, session: 's1', idx: 1, quote: '我说过先举例再给结论', at: '2026-11-05T10:00:00.000Z' }])
assert.equal(store.listCorrections({}).total, 1, '同一条消息重扫不能变两条')
store.appendEvents([{ id: store.eventId('s1', 9, '我说过先举例再给结论'), session: 's1', idx: 9, quote: '我说过先举例再给结论', at: '2026-11-06T10:00:00.000Z' }])
assert.equal(store.listCorrections({}).total, 2, '两天说了两遍是两次纠正，不许合并')
console.log('59. 事件级去重：同消息合并，不同消息保留')

// 60. 分页：每页 30、翻页途中插入新记录不漂、末页 nextCursor 为 null
store.writeEvents([])
for (let i = 0; i < 40; i += 1) {
  store.appendEvents([{ id: `x-${i}`, session: 's', idx: i, quote: 'q', at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }])
}
const page1 = store.listCorrections({ limit: 30 })
assert.equal(page1.items.length, 30)
const seen = new Set(page1.items.map((item) => item.id))
store.appendEvents([{ id: 'late', session: 's9', idx: 0, quote: '别再用表格', at: '2026-11-07T00:00:00.000Z' }])
const page2 = store.listCorrections({ cursor: page1.nextCursor, limit: 30 })
assert.equal(page2.items.filter((item) => seen.has(item.id)).length, 0, '第二页不许重复第一页')
assert.equal(store.listCorrections({ cursor: page2.nextCursor, limit: 500 }).nextCursor, null, '末页 nextCursor 必须是 null')
console.log('60. 分页：稳定游标，翻页不重不漏')

// 61. 200 条上限：丢最旧（按 at），不是丢最新
for (let i = 0; i < 200; i += 1) {
  store.appendEvents([{ id: `pad-${i}`, session: 's', idx: i, quote: 'q', at: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString() }])
}
assert.equal(store.listCorrections({}).total, 200)
assert.equal(store.listCorrections({ limit: 500 }).items.some((item) => item.id === 'x-0'), false, '最旧的先丢')
assert.equal(store.listCorrections({ limit: 500 }).items.some((item) => item.id === 'pad-199'), true, '最新的要留着')
console.log('61. 200 条上限：丢最旧，最新的一定在')

// 62. 清理按 usedAt 算，不按 at：29 天前发生、今天才消费的不能被删
store.writeEvents([]) // 先清干净：上一段铺的 200 条是二月的，早该过期，会把计数搅浑
const oldAt = new Date(Date.now() - 29 * 86400000).toISOString()
store.appendEvents([{ id: 'old-event', session: 's', idx: 0, quote: 'q', at: oldAt }])
store.markUsed(['old-event'], 'tx-x')
assert.equal(store.sweep().removed, 0, '刚消费的不该被清掉')
assert.ok(store.findById('old-event'), '29 天前的证据还在')
const ancient = new Date(Date.now() - 91 * 86400000).toISOString()
store.appendEvents([{ id: 'ancient', session: 's', idx: 1, quote: 'q', at: ancient }])
assert.equal(store.sweep().removed, 1, '未处理超过 90 天该清')
assert.equal(store.findById('ancient'), undefined)
console.log('62. 清理：已处理按 usedAt 30 天，未处理按 at 90 天')

// 63. 水位：没有水位就不回填历史
assert.equal(store.shouldScan({ at: '2026-01-01T00:00:00.000Z', session: 's', idx: 1 }, null), false, '第一次启用不许回填')
store.writeWatermark({ enabledAt: '2026-11-05T00:00:00.000Z', lastScannedAt: '2026-11-05T12:00:00.000Z', lastSession: 's1', lastIdx: 3 })
assert.equal(store.shouldScan({ at: '2026-11-05T13:00:00.000Z', session: 's9', idx: 0 }, store.readWatermark()), true)
assert.equal(store.shouldScan({ at: '2026-11-05T11:00:00.000Z', session: 's9', idx: 0 }, store.readWatermark()), false, '水位之前的不重扫')
console.log('63. 水位：不回填，只扫新消息')

// 64. 引号 / 换行 / 制表符：一条一行，回读一模一样
store.appendEvents([{ id: 'q1', session: 's', idx: 0, quote: '他说"别这样"\n第二行\t制表', at: '2026-11-05T14:00:00.000Z' }])
assert.equal(store.findById('q1').quote, '他说"别这样"\n第二行\t制表')
console.log('64. 证据原文：引号换行制表符原样往返')

// 65. 从一段真实对话里扫：靠前的旧消息不落，正常纠偏落
const conv = [
  { at: '2026-11-05T08:00:00.000Z', session: 's2', idx: 1, text: '我说过先举例再给结论', isReply: false },
  { at: '2026-11-05T13:00:00.000Z', session: 's2', idx: 2, text: '你又错了，这次不是技术问题', isReply: true },
  { at: '2026-11-05T13:05:00.000Z', session: 's2', idx: 3, text: '今天天气不错', isReply: false },
]
const collected = conv.flatMap((msg) =>
  store.shouldScan(msg, store.readWatermark())
    ? store.extractSignals(msg).map((hit) => ({ id: store.eventId(msg.session, msg.idx, hit.quote), session: msg.session, idx: msg.idx, quote: hit.quote, at: msg.at }))
    : [],
)
assert.equal(collected.length, 1, '水位前的那条不扫：' + JSON.stringify(collected))
assert.equal(store.appendEvents(collected), 1)
assert.equal(store.findById(store.eventId('s2', 2, collected[0].quote)).used, false)
console.log('65. 采集整段对话：水位前不扫，纠偏落进池子')

// 66. 采集入口：第一次只写水位不回填，之后只扫新的
store.writeEvents([])
store.writeWatermark(null)
assert.equal(store.readWatermark(), null, '先确认水位是空的')
const first = store.collectCorrections({ session: 's3', idx: 1, text: '我说过先举例再给结论', at: '2026-11-05T09:00:00.000Z' })
assert.equal(first.reason, 'just-enabled', '第一次调用只开闸，不扫历史')
assert.equal(store.listCorrections({}).total, 0, '启用那一刻之前的消息一条都不回填')
const older = store.collectCorrections({ session: 's3', idx: 2, text: '你又错了', at: '2026-11-05T08:00:00.000Z', isReply: true })
assert.equal(older.reason, 'before-watermark', '比水位旧的消息不扫')
const fresh = store.collectCorrections({ session: 's3', idx: 3, text: '你又错了，这次不是技术问题', at: '2026-11-05T10:00:00.000Z', isReply: true })
assert.equal(fresh.collected, 1, '水位之后的新消息要扫：' + JSON.stringify(fresh))
assert.equal(store.readWatermark().lastScannedAt, '2026-11-05T10:00:00.000Z', '扫完要推水位')
assert.equal(store.collectCorrections({ session: 's3', idx: 4, text: '今天天气不错', at: '2026-11-05T11:00:00.000Z' }).reason, 'no-signal')
console.log('66. 采集入口：开闸不回填，只扫新消息')

console.log('\n21 项全部通过')
process.exit(0)
