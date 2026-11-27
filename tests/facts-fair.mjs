/**
 * 防马太效应：结论段冷门兜底 + 缓存版本串。
 * 跑法：node tests/facts-fair.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-facts-fair-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(join(dir, 'memory'), { recursive: true })

const memory = await import('../lib/memory.js')
const index = await import('../lib/index.js')

const stamp = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()
// 热条目：吃满预算的长文本；冷条目：短、从没进过
const hotText = (i) => '热点' + i + '甲'.repeat(34)
const coldText = (i) => '冷门' + i

function writeRelFacts(rows) {
  writeFileSync(
    memory.factsPath(),
    rows.map((row) => JSON.stringify({
      status: 'approved', created: '2026-01-01', updated: '2026-01-01', ...row,
    })).join('\n') + '\n',
  )
}

function boot() {
  const captured = { contexts: [], on: {} }
  index.apply(
    {
      logger: { info: () => {} },
      on: (type, handler) => { captured.on[type] = handler; return () => {} },
      systemPrompt: { context: (def) => (captured.contexts.push(def), () => {}) },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      agents: { currentInitiator: () => ({ session: { header: { id: 'facts-fair-s' } } }) },
    },
    { enabled: true, profileEnabled: false },
  )
  return { text: () => captured.contexts[0].text() }
}

/* 1. 纯函数形状：packFactsFair 导出存在，kept 是带 id 的对象数组、text 可逐条回指 */
assert.equal(typeof index.packFactsFair, 'function', 'packFactsFair 必须导出（形状断言直接测它）')
const packed = index.packFactsFair(
  [
    { id: 'fa', text: '第一条甲乙', heat: 9, lastHit: stamp(-1000) },
    { id: 'fb', text: '第二条丙丁', heat: 8, lastHit: null },
  ],
  90,
)
assert.ok(Array.isArray(packed.kept), 'kept 必须是数组')
assert.ok(packed.kept.every((item) => typeof item.id === 'string' && item.id !== ''), 'kept 每项 id 必须是非空字符串')
assert.ok(packed.kept.every((item) => packed.text.includes(String(item.text).trim())), 'text 必须逐条回指 kept')
assert.ok(Array.isArray(packed.skipped), 'skipped 必须是数组')
assert.ok(Array.isArray(packed.ids), 'ids 必须是数组')
console.log('1. packFactsFair 形状：kept 带 id、text 可回指')

/* 2. 退化：空池 / limit<=0 不抛错、kept 为空 */
assert.deepEqual(index.packFactsFair([], 90).kept, [])
assert.deepEqual(index.packFactsFair([{ id: 'x', text: '内容', heat: 1 }], 0).kept, [])
console.log('2. 空池 / limit=0 退化正常')

/* 3. 缓存串：两处都含 fpack1，升级后旧缓存不会挡住新机制 */
const cfg = {
  enabled: true, personaEnabled: true, heading: 'AI记忆', profileEnabled: false,
  profileMaxChars: 1600, profileOverride: '', noteGuide: '', halfLifeDays: 30, tempTtlDays: 14,
}
assert.ok(index.algorithmKeyForCache().includes('fpack1'), 'algorithmKeyForCache 必须含 fpack1')
assert.ok(index.injectionKey(cfg).includes('fpack1'), 'injectionKey 必须含 fpack1')
console.log('3. 缓存串含 fpack1')

/* 4. 端到端冷门兜底：热条目吃满预算，从没进过的短条目仍能拿到预留位 */
writeRelFacts([
  { id: 'hot0', text: hotText(0), hitCount: 99, lastHit: stamp(-1000) },
  { id: 'hot1', text: hotText(1), hitCount: 99, lastHit: stamp(-1000) },
  { id: 'hot2', text: hotText(2), hitCount: 99, lastHit: stamp(-1000) },
  { id: 'coldA', text: coldText('A'), hitCount: 0 },
  { id: 'coldB', text: coldText('B'), hitCount: 0 },
])
const s = boot()
const first = s.text()
assert.ok(first.includes(hotText(0)), '热条目仍在注入')
assert.ok(first.includes(coldText('A')) || first.includes(coldText('B')), '从没进过的冷条目必须有人进得来')
console.log('4. 冷门条目拿到预留位（热条目仍在）')

/* 5. 退役残余：冷条目退役后不再进注入 */
const rows = memory.readFacts()
writeRelFacts(rows.map((row) => row.id === 'coldA' ? { ...row, status: 'retired', retiredAt: '2026-11-27' } : row))
const afterRetire = boot().text()
assert.ok(!afterRetire.includes(coldText('A')), '退役冷条目不得进注入')
console.log('5. 退役冷条目残余为 0')

console.log('\nfacts-fair 全部通过')
