import assert from 'node:assert/strict'
import {
  CORE_PREVIEW,
  PREVIEW_MAX_CHARS,
  SKIP_PRIORITY,
  SKIP_REASONS,
  contentId,
  describeSkipped,
  normalizeForId,
  pickReason,
  previewOf,
  skippedId,
} from '../lib/explain.js'

console.log('1. normalizeForId 六步：NFKC / CRLF / trim / 折叠空白')
assert.equal(normalizeForId('\uFF21'), 'A')
assert.equal(normalizeForId('e\u0301'), '\u00E9')
assert.equal(normalizeForId('a\r\nb'), normalizeForId('a\nb'))
assert.equal(normalizeForId('  x   y  '), 'x y')
assert.equal(normalizeForId(null), '')
assert.equal(normalizeForId(undefined), '')

console.log('2. contentId 内容指纹稳定（含记事本 BOM+CRLF）')
assert.equal(contentId('a\r\nb'), contentId('a\nb'))
assert.equal(contentId('  x   y  '), contentId('x y'))
assert.equal(contentId('\uFF21'), contentId('A'))
assert.equal(contentId('\uFEFFa\r\nb'), contentId('a\nb'))
assert.match(contentId('x'), /^[0-9a-f]{12}$/)
assert.equal(contentId('a\nb'), contentId('a   b'))

console.log('3. 封闭枚举与 first-match-wins')
assert.deepEqual([...SKIP_REASONS], ['budget', 'expired', 'scope', 'duplicate'])
assert.deepEqual([...SKIP_PRIORITY], ['scope', 'expired', 'duplicate', 'budget'])
assert.ok(Object.isFrozen(SKIP_REASONS))
assert.ok(Object.isFrozen(SKIP_PRIORITY))
assert.equal(pickReason({}), null)
assert.equal(pickReason({ budget: true }), 'budget')
assert.equal(pickReason({ expired: true, budget: true }), 'expired')
assert.equal(pickReason({ duplicate: true, budget: true }), 'duplicate')
assert.equal(pickReason({ scope: true, expired: true, duplicate: true, budget: true }), 'scope')

console.log('4. skippedId 带段前缀，跨段不撞')
assert.equal(skippedId('notes', 'x'), 'notes:' + contentId('x'))
assert.notEqual(skippedId('notes', 'x'), skippedId('facts', 'x'))
assert.equal(PREVIEW_MAX_CHARS, 60)
assert.equal(CORE_PREVIEW, '素材层，不注入')

console.log('5. previewOf 按字素簇截，组合字符与 ZWJ 都不切')
const fish = '\u{1F41F}'
const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
assert.equal(previewOf(fish.repeat(80)), fish.repeat(60) + '…')
assert.equal(previewOf(family.repeat(80)), family.repeat(60) + '…')
const boundary = 'x'.repeat(59) + 'e\u0301' + 'tail'
const cut = previewOf(boundary)
assert.ok(cut.endsWith('e\u0301…'), '组合字符不许被切开')
assert.ok(!cut.includes('e…'), '不许留下孤立的 e')
assert.equal(previewOf('e\u0301'), 'e\u0301')
assert.equal(previewOf(''), '')
assert.equal(previewOf(null), '')

console.log('6. describeSkipped 只读 sources 平行数组：同文 / 重复 / 空串 / core')
const notes = [{ date: '2026-11-07', text: '核心素材', tier: 'core' }]
const skipped = ['同一句话', '同一句话', '同一句话', '', '普通稳定条', '同一句话']
const sources = ['budget', 'expired', 'expired', 'expired', 'budget', 'expired']
const detail = describeSkipped({ key: 'notes', skipped, sources, notes })
assert.equal(detail.length, skipped.length + 1)
assert.deepEqual(detail.map((d) => d.reason),
  ['budget', 'expired', 'expired', 'expired', 'budget', 'expired', 'budget'])
assert.equal(detail[0].reason, 'budget')
assert.equal(detail[1].reason, 'expired')
assert.equal(detail[3].preview, '')
assert.ok(detail[3].id !== '' && detail[3].reason === 'expired')
assert.equal(detail[6].preview, '素材层，不注入')
assert.equal(detail[0].id, detail[1].id)
assert.equal(detail.filter((d) => d.id === skippedId('notes', '同一句话')).length, 4)
assert.ok(detail.every((d) => SKIP_REASONS.includes(d.reason) && typeof d.id === 'string' && d.id !== ''))
assert.ok(detail.every((d) => typeof d.preview === 'string'))

console.log('7. 来源缺失 / 对不齐 / 未知值 → 保守降级 budget')
assert.deepEqual(describeSkipped({ key: 'notes', skipped: ['a', 'b'], sources: null, notes: [] })
  .map((d) => d.reason), ['budget', 'budget'])
assert.deepEqual(describeSkipped({ key: 'notes', skipped: ['a', 'b'], sources: ['expired'], notes: [] })
  .map((d) => d.reason), ['budget', 'budget'])
assert.deepEqual(describeSkipped({ key: 'notes', skipped: ['a'], sources: ['mystery'], notes: [] })
  .map((d) => d.reason), ['budget'])

console.log('8. 非 notes 段与空 skipped 也显式返回数组')
assert.deepEqual(describeSkipped({ key: 'guide', skipped: [] }), [])
assert.equal(describeSkipped({ key: 'facts', skipped: ['x'] })[0].reason, 'budget')
assert.deepEqual(describeSkipped({}), [])

console.log('\n8 项全部通过')
