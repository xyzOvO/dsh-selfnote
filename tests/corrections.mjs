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

console.log('\n12 项全部通过')
process.exit(0)
