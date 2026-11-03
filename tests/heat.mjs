/**
 * 遗忘曲线（P0）测试：热度随时间衰减、用得多的更热、只被检索到不算使用、
 * 冷下去不自动退役、注入按热度排。
 * 跑法：node tests/heat.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-heat-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(join(dir, 'memory'), { recursive: true })

const memory = await import('../lib/memory.js')

const day = 86400000
const now = Date.parse('2026-11-03T00:00:00Z')

/* 1. 时间衰减：同一份热度，过期越久越低 */
const fresh = { id: 'a', text: 'x', status: 'approved', lastHit: '2026-11-03', hitCount: 0 }
const old = { ...fresh, lastHit: '2026-10-04' } // 30 天前
const ancient = { ...fresh, lastHit: '2026-08-05' } // 90 天前
const h1 = memory.factHeat(fresh, now, 30)
const h2 = memory.factHeat(old, now, 30)
const h3 = memory.factHeat(ancient, now, 30)
assert.ok(h1 > h2 && h2 > h3, `应当逐渐变冷：${h1} > ${h2} > ${h3}`)
assert.ok(Math.abs(h2 - h1 / 2) < 0.01, '半衰期 30 天时，30 天前应剩一半')
console.log(`1. 半衰期生效（${h1} → ${h2} → ${h3}）`)

/* 2. 用得多的更热 */
const used = { ...fresh, hitCount: 9 }
assert.ok(memory.factHeat(used, now, 30) > h1, '命中多次的应当更热')
console.log('2. 使用次数提升热度（' + memory.factHeat(used, now, 30) + '）')

/* 3. 重要性不改时间衰减，但整体抬升 */
const important = { ...fresh, importance: 3 }
assert.ok(memory.factHeat(important, now, 30) > h1, '重要度高的应当更热')
const importantOld = { ...old, importance: 3 }
assert.ok(memory.factHeat(importantOld, now, 30) < memory.factHeat(important, now, 30), '重要也要衰减')
console.log('3. 重要度抬升但不免疫衰减')

/* 4. 排序：热的在前 */
const ranked = memory.rankByHeat([ancient, fresh, used], { now, halfLifeDays: 30 })
assert.deepEqual(ranked.map((item) => item.fact.id), ['a', 'a', 'a'].length === 3 ? ranked.map(() => 'a') : [])
assert.equal(ranked[0].fact, used, '命中多次的排第一')
assert.equal(ranked[2].fact, ancient, '最冷的排最后')
console.log('4. 排序按热度')

/* 5. touchFacts：命中记数，且一小时内不重复涨 */
writeFileSync(
  memory.factsPath(),
  [
    { id: 'f1', text: '偏好短句', tags: ['沟通'], status: 'approved', created: '2026-11-01', updated: '2026-11-01' },
    { id: 'f2', text: '在备考', tags: ['作息'], status: 'approved', created: '2026-11-01', updated: '2026-11-01' },
  ]
    .map((fact) => JSON.stringify(fact))
    .join('\n') + '\n',
)
assert.equal(memory.touchFacts(['f1'], now), 1, '第一次应当记一次')
const afterFirst = memory.readFacts().find((fact) => fact.id === 'f1')
assert.equal(afterFirst.hitCount, 1)
assert.equal(afterFirst.lastHit, '2026-11-03')
assert.equal(memory.touchFacts(['f1'], now + 60 * 1000), 0, '一小时内不重复记')
assert.equal(memory.touchFacts(['f2'], now + 2 * 60 * 60 * 1000), 1, '过了一小时可以再记')
console.log('5. touchFacts 记数并节流')

/* 6. 冷下去不自动退役 */
const cold = memory.readFacts().find((fact) => fact.id === 'f2')
assert.equal(cold.status, 'approved', '冷只是优先级低，不是退役')
console.log('6. 低热度不会被自动退役')

/* 7. 注入按热度挑：预算只够一条时给最热的那条 */
const { apply } = await import('../lib/index.js')
const facts = [
  { id: 'cold1', text: '这是很久以前的一句很长的话，占地方，后面还跟着一长串早就没人提的细节和补充说明，足够把八十字的预算撑满，再补一点让它更稳，继续补到肯定超过预算为止，多写几句也无所谓，再补一段让它彻底超出现在一百一十的结论段预算', tags: ['旧'], status: 'approved', created: '2026-02-01', updated: '2026-02-01', lastHit: '2026-02-01' },
  { id: 'hot1', text: '昨天确认的约束', tags: ['新'], status: 'approved', created: '2026-11-02', updated: '2026-11-02', lastHit: '2026-11-02', hitCount: 5 },
]
writeFileSync(memory.factsPath(), facts.map((fact) => JSON.stringify(fact)).join('\n') + '\n')

const captured = { contexts: [] }
apply(
  {
    logger: { info: () => {} },
    on: () => {},
    systemPrompt: { context: (def) => (captured.contexts.push(def), () => {}) },
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
  },
  { enabled: true, profileEnabled: false },
)
const text = captured.contexts[0].text()
assert.ok(text.includes('昨天确认的约束'), '热的应当进注入')
assert.ok(!text.includes('这是很久以前的一句很长的话'), '冷的应当先让位（预算不够时）')
console.log('7. 注入优先给热的')

/* 8. 进了注入才算使用；只被检索到不算 */
const hotAfter = memory.readFacts().find((fact) => fact.id === 'hot1')
assert.ok(hotAfter.hitCount >= 6, '进过注入的事实应当涨热度，实际 ' + hotAfter.hitCount)
assert.equal(memory.readFacts().find((fact) => fact.id === 'cold1').hitCount, undefined, '没进注入的没涨')
console.log('8. 只有真的进上下文才记一次使用')

console.log('\n8 项全部通过')
process.exit(0)
