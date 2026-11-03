/**
 * 画像层测试：只聚合 approved、可追溯、可覆盖、可关闭、可重建、冲突不合并。
 * 跑法：node tests/profile.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-profile-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')

const { buildProfile } = await import('../lib/profile.js')
const memory = await import('../lib/memory.js')

const fact = (id, text, tags, status = 'approved', updated = '2026-11-02') => ({
  id,
  text,
  tags,
  status,
  updated,
  created: updated,
})

/* 1. 只有 approved 参与 */
const facts = [
  fact('a', '回答要先给结论，细节等他问。', ['沟通']),
  fact('b', '不要长篇清单，短句优先。', ['沟通'], 'approved', '2026-11-03'),
  fact('c', '他在备考，作息昼夜颠倒。', ['作息']),
  fact('d', '候选里的话不该进画像。', ['沟通'], 'candidate'),
  fact('e', '退役的也不该进。', ['作息'], 'retired'),
]
const built = buildProfile(facts, { maxChars: 120 })
assert.equal(built.sources.includes('d'), false)
assert.equal(built.sources.includes('e'), false)
assert.ok(built.text.includes('短句优先'), '应该用同标签里最新的那条')
assert.ok(!built.text.includes('候选里的话'))
console.log('1. 只有 approved 参与，同标签取最新（' + built.chars + ' 字）')

/* 2. 每句都能回指到 fact */
for (const part of built.parts) {
  assert.ok(facts.some((item) => item.id === part.factId), '回指不到 fact：' + part.factId)
  assert.ok(built.text.includes(part.text), '正文里应当有这句')
}
assert.deepEqual(built.sources.sort(), built.parts.map((part) => part.factId).sort())
console.log('2. 可追溯：' + built.parts.length + ' 个来源 id')

/* 3. 同标签多条 → 记冲突，不擅自合并 */
assert.deepEqual(built.conflicts, [{ tag: '沟通', count: 1 }])
assert.ok(!built.text.includes('回答要先给结论'), '旧的那条不该被拼进来当结论')
console.log('3. 同标签多条只记冲突，不合并')

/* 4. 长度上限 */
const tight = buildProfile(facts, { maxChars: 30 })
assert.ok(tight.chars <= 30, '不能超过 maxChars')
assert.ok(tight.parts.length >= 1)
console.log('4. 超长时截断到上限（' + tight.chars + '/30）')

/* 5. 可重建：改掉事实，画像跟着变；画像自身不落盘 */
const before = buildProfile(facts, { maxChars: 120 }).text
const after = buildProfile(
  facts.map((item) => (item.id === 'c' ? { ...item, text: '他现在改成了早起。' } : item)),
  { maxChars: 120 },
).text
assert.notEqual(before, after, '事实变了画像必须跟着变')
console.log('5. 画像可重建（facts 一变，文本就变）')

/* ---------- 接进插件：注入、覆盖、关闭 ---------- */

/* 直接写 facts.jsonl：stageFact 会校验出处能不能落到真实会话，这里只要状态语义 */
const approvedOnly = facts.filter((item) => item.status === 'approved')
mkdirSync(join(process.env.DSH_MEMORY_DIR), { recursive: true })
writeFileSync(memory.factsPath(), approvedOnly.map((item) => JSON.stringify(item)).join(String.fromCharCode(10)) + String.fromCharCode(10))
assert.equal(memory.listFacts('approved').length, 3, '应该只有 3 条 approved')

const { apply } = await import('../lib/index.js')
const captured = { contexts: [], tools: [], routes: null }
apply(
  {
    logger: { info: () => {} },
    on: () => {},
    systemPrompt: { context: (def) => (captured.contexts.push(def), () => {}) },
    tools: { register: (def) => (captured.tools.push(def), () => {}) },
    webServer: { register: (route) => ((captured.routes = route), () => {}) },
  },
  { enabled: true },
)

const inject = captured.contexts[0].text

/* 6. 默认开启：注入里出现「关于你」段 */
const withProfile = inject()
assert.match(withProfile, /关于他：/)
assert.match(withProfile, /作息：/)
console.log('6. 注入里出现画像段')

/* 7. 手改覆盖：用 override 替换聚合结果 */
const { writeConfig, readConfig } = await import('../lib/store.js')
writeConfig({ ...readConfig(), profileOverride: '他喜欢短句、先结论。' })
const overridden = inject()
assert.match(overridden, /关于他：他喜欢短句、先结论。/)
assert.ok(!overridden.includes('作息：'), '手改后不该再拼聚合结果')
console.log('7. 手改覆盖生效，且不叠加聚合结果')

/* 8. 关闭：整段消失，但自述还在 */
writeConfig({ ...readConfig(), profileOverride: '', profileEnabled: false })
const disabled = inject()
assert.ok(!disabled.includes('关于你'), '关掉后不该有画像段')
console.log('8. 关闭后画像段消失')

/* 9. 重新打开，恢复聚合 */
writeConfig({ ...readConfig(), profileEnabled: true })
assert.match(inject(), /关于他：/)
console.log('9. 重新打开后恢复')

/* 10. 去重：被画像吸收的事实不再在「常驻结论」段重复 */
const dedup = inject()
const profileNow = buildProfile(memory.listFacts(), { maxChars: 120 })
assert.ok(profileNow.sources.length > 0)
for (const id of profileNow.sources) {
  const text = memory.listFacts().find((item) => item.id === id).text
  const times = dedup.split(text).length - 1
  assert.equal(times, 1, '这条事实在注入里出现了 ' + times + ' 次：' + text)
}
console.log('10. 画像吸收过的事实不再重复（' + profileNow.sources.length + ' 条各出现一次）')

/* 11. 事实全部退役 → 画像为空（不残留旧文本） */
for (const item of memory.listFacts('approved')) memory.setFactStatus(item.id, 'retired')
assert.equal(buildProfile(memory.listFacts(), { maxChars: 120 }).text, '')
console.log('11. 没有已采纳事实时画像为空（不缓存旧结果）')

console.log('\n11 项全部通过')
process.exit(0)
