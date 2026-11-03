import assert from 'node:assert/strict'
import { buildBundle, mergeBundle, validateBundle, BUNDLE_VERSION } from '../lib/transfer.js'

/* 1. 导出：只带能带走的东西，配置只挑可调项 */
const bundle = buildBundle({
  notes: [{ date: '2026-11-03', text: '做插件先让它能跑' }],
  facts: [
    { id: 'f1', text: '以后回答先给结论', status: 'approved', hitCount: 3 },
    { id: 'f2', text: '本机 node 在 D:\\nodejs', status: 'approved', channel: 'env' },
  ],
  habits: [{ text: '收到要回收到', status: 'active', tag: '沟通' }],
  config: { heading: '记忆（我写的）', halfLifeDays: 30, 内部字段: '不该带出去' },
  now: new Date('2026-11-04T00:00:00Z'),
})
assert.equal(bundle.app, 'dsh-selfnote')
assert.equal(bundle.v, BUNDLE_VERSION)
assert.equal(bundle.exportedAt, '2026-11-04T00:00:00.000Z')
assert.deepEqual(bundle.counts, { notes: 1, facts: 2, habits: 1 })
assert.equal(bundle.config.heading, '记忆（我写的）')
assert.equal(bundle.config.内部字段, undefined, '配置只带白名单字段')
assert.equal(bundle.notes[0].text, '做插件先让它能跑')
console.log('1. 导出：结构、计数、配置白名单都对')

/* 2. 结构校验：坏文件要说清哪里不对，不能合并一半 */
assert.match(validateBundle(null), /不是 JSON 对象/)
assert.match(validateBundle({ app: 'other', v: 1 }), /不是本插件导出的/)
assert.match(validateBundle({ app: 'dsh-selfnote' }), /缺少版本号/)
assert.match(validateBundle({ app: 'dsh-selfnote', v: 99 }), /更新的版本/)
assert.match(validateBundle({ app: 'dsh-selfnote', v: 1, facts: {} }), /facts 不是数组/)
assert.equal(validateBundle({ app: 'dsh-selfnote', v: 1 }), null)
console.log('2. 校验：坏文件当场拒绝，不静默合并')

/* 3. 合并：同 id 跳过、同文本跳过、新的进来 */
const current = {
  notes: [{ date: '2026-11-01', text: '旧的一条' }],
  facts: [
    { id: 'f1', text: '以后回答先给结论', status: 'approved' },
    { id: 'f3', text: '索引只存词元', status: 'approved' },
  ],
  habits: [],
}
const incoming = {
  app: 'dsh-selfnote',
  v: 1,
  facts: [
    { id: 'f1', text: '同 id 的不该重复进来', status: 'approved' },
    { id: 'f9', text: '索引只存词元', status: 'candidate' },
    { id: 'f10', text: '新的环境事实', status: 'approved', channel: 'env' },
    { id: '', text: '没有 id 的丢弃' },
    { id: 'f11', text: '   ' },
  ],
  notes: [{ date: '2026-11-04', text: '旧的一条' }, { date: '2026-11-04', text: '新的一条' }],
  habits: [{ text: '收到要回收到', status: 'active' }],
}
const merged = mergeBundle(incoming, current)
assert.equal(merged.added.facts, 1, '只该进 f10 一条')
assert.equal(merged.added.notes, 1)
assert.equal(merged.added.habits, 1)
assert.equal(merged.skipped.facts, 2, '同 id + 同文本各跳过一条')
assert.equal(merged.skipped.invalid, 2, '没 id 的、空正文的算无效')
assert.equal(merged.conflicts[0].reason, 'same-text')
assert.equal(merged.facts.find((fact) => fact.id === 'f10').channel, 'env')
console.log('3. 合并：不覆盖、不重复、无效条目单独计数')

/* 4. 默认把 approved 降成 candidate：采纳得人在这里点一次 */
assert.equal(merged.keepStatus, false)
assert.equal(merged.facts.find((fact) => fact.id === 'f10').status, 'candidate')
assert.deepEqual(merged.demoted, ['f10'])
assert.equal(merged.facts.find((fact) => fact.id === 'f10').importedFrom, 'import')
console.log('4. 默认降级：导入的结论变回候选，且记账')

/* 5. keepStatus：想原样搬就明说 */
const kept = mergeBundle(incoming, current, { keepStatus: true })
assert.equal(kept.facts.find((fact) => fact.id === 'f10').status, 'approved')
assert.deepEqual(kept.demoted, [])
console.log('5. 保留原状态：勾了才生效')

/* 6. 不碰原来的数据：合并是纯函数 */
assert.equal(current.facts.length, 2, '原数组不能被改')
assert.equal(current.notes.length, 1)
console.log('6. 合并是纯函数，原数据不动')

/* 7. 空 bundle 什么都不做；习惯状态只有 active / retired 两种 */
const empty = mergeBundle({ app: 'dsh-selfnote', v: 1 }, current)
assert.deepEqual(empty.added, { notes: 0, facts: 0, habits: 0 })
assert.equal(empty.facts.length, 2)
const habitsMerged = mergeBundle(
  { app: 'dsh-selfnote', v: 1, habits: [{ text: 'a', status: 'weird' }, { text: 'b', status: 'active' }] },
  { habits: [] },
)
assert.deepEqual(
  habitsMerged.habits.map((habit) => habit.status),
  ['retired', 'active'],
)
console.log('7. 空导入无害；习惯状态只认 active')

console.log('\n8 项全部通过')
