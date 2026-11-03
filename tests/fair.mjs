/**
 * P0 分账注入测试：冷门条目有预留份额、一轮一轮轮着进；压缩之后把用过的记忆补一次。
 * 跑法：node tests/fair.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-fair-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(join(dir, 'memory'), { recursive: true })

const memory = await import('../lib/memory.js')
const { apply } = await import('../lib/index.js')

const pad = (marker) => marker + '说明'.repeat(28) // 约 60 字，逼近真实环境备忘的长度

function writeEnvFacts(rows) {
  writeFileSync(
    memory.factsPath(),
    rows.map((row) => JSON.stringify({ channel: 'env', status: 'approved', created: '2026-01-01', updated: '2026-01-01', ...row })).join('\n') + '\n',
  )
}

function boot(sessionId) {
  const captured = { contexts: [], on: {} }
  apply(
    {
      logger: { info: () => {} },
      on: (type, handler) => {
        captured.on[type] = handler
        return () => {}
      },
      systemPrompt: { context: (def) => (captured.contexts.push(def), () => {}) },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      agents: { currentInitiator: () => ({ session: { header: { id: sessionId } } }) },
    },
    { enabled: true, profileEnabled: false },
  )
  return { text: () => captured.contexts[0].text(), on: captured.on }
}

/* 1. 冷门预留：热的一直赢，但预留那 1/4 得留给从没进过的 */
writeEnvFacts([
  ...Array.from({ length: 8 }, (_, i) => ({ id: 'hot' + i, text: pad('热的' + i), hitCount: 9, lastHit: '2026-11-03T00:00:00Z' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'cold' + i, text: pad('冷的' + i) })),
])
const s1 = boot('s1')
const first = s1.text()
assert.ok(first.includes('热的0'), '热的照旧在里头')
const coldInFirst = [0, 1, 2, 3].filter((i) => first.includes('冷的' + i + '说'))
assert.ok(coldInFirst.length > 0, '从没进过的条目必须有人进得来，实际进了 ' + JSON.stringify(coldInFirst))
console.log('1. 冷门条目拿到预留份额（进了 ' + coldInFirst.length + ' 条）')

/* 2. 轮着来：进过一次就被记账，下一轮该让位给还没进过的。
   缓存按「数据有没有变」冻结文本（0.12.1 故意的：每轮重排会白白打碎前缀缓存），
   所以这里原样重写一次数据文件（不改内容、只动 mtime）来触发重算，模拟「过一阵又装配了一次」。 */
const rewriteFacts = () => {
  const rows = memory.readFacts()
  writeFileSync(memory.factsPath(), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}
rewriteFacts()
const second = s1.text()
const coldInSecond = [0, 1, 2, 3].filter((i) => second.includes('冷的' + i + '说'))
assert.ok(coldInSecond.length > 0, '第二轮仍应有冷门条目（' + JSON.stringify(coldInSecond) + '）')
assert.notDeepEqual(coldInSecond, coldInFirst, '第二轮该换成还没进过的那几条，实际 ' + JSON.stringify(coldInFirst) + ' → ' + JSON.stringify(coldInSecond))
console.log('2. 冷门条目排队轮换（' + JSON.stringify(coldInFirst) + ' → ' + JSON.stringify(coldInSecond) + '）')

/* 3. 压缩之后补偿：新条目挤掉旧条目，压缩后下一轮把旧的补回来，只补一次 */
writeEnvFacts(Array.from({ length: 6 }, (_, i) => ({ id: 'old' + i, text: pad('旧的' + i), hitCount: 8, lastHit: '2026-11-03T05:00:00Z' })))
const before = s1.text()
const markerOf = (text) => [0, 1, 2, 3, 4, 5].filter((i) => text.includes('旧的' + i + '说'))
const injectedBefore = markerOf(before)
assert.ok(injectedBefore.length > 0, '先得真的有旧条目进过注入')

// 一批更新的条目挤进来：热度更高、时间更新，旧条目该被挤到队尾
// 旧的这一批保留第一次装配时的记账（lastHit），否则它们会因为「从没进过」被当成冷门重新优待
const touched = memory.readFacts()
writeEnvFacts([
  ...touched,
  ...Array.from({ length: 8 }, (_, i) => ({ id: 'new' + i, text: pad('新的' + i), hitCount: 20, lastHit: '2026-11-04T05:00:00Z' })),
])
// 换个会话做对照：没有压缩补偿，旧条目应当被挤出
const control = boot('s2').text()
const squeezed = markerOf(control)
assert.ok(squeezed.length < injectedBefore.length, '新条目进来后旧条目该被挤掉（' + squeezed.length + ' < ' + injectedBefore.length + '）')

// s1 压缩了：下一轮把 s1 之前用过的条目再贴一遍
assert.equal(typeof s1.on['session/event'], 'function', '要监听 session/event')
s1.on['session/event']({ id: 's1', header: {} }, { type: 'compaction/prune', data: {} })
const compensated = s1.text()
const restored = markerOf(compensated)
const overlap = (a, b) => a.filter((id) => b.includes(id))
assert.equal(overlap(squeezed, injectedBefore).length, 0, '没有补偿时，之前进过的旧条目应当被挤干净（' + JSON.stringify(squeezed) + '）')
assert.ok(overlap(restored, injectedBefore).length > 0, '压缩之后，之前进过的旧条目应当被补回来（' + JSON.stringify(injectedBefore) + ' ∩ ' + JSON.stringify(restored) + '）')
assert.ok(compensated.includes('新的0'), '补回来不等于把新条目踢掉')
console.log('3. 压缩后补回用过的条目（' + JSON.stringify(injectedBefore) + ' → 补回 ' + JSON.stringify(overlap(restored, injectedBefore)) + '）')

/* 4. 只补一次：下一轮恢复正常顺序 */
const afterOnce = s1.text()
assert.equal(overlap(markerOf(afterOnce), injectedBefore).length, 0, '补偿只该发生一轮，之后回到常态')
console.log('4. 补偿只补一轮')

console.log('\n4 项全部通过')
process.exit(0)
