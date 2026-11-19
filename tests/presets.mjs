/**
 * 协作默认（preset）：五条交互默认值，用户自己决定导不导。
 * 跑法：node tests/presets.mjs
 *
 * 要守住的六件事：
 *   1. 默认一条都不导 —— 空态下注入只有一句提示，没有内容
 *   2. 导入存的是文案快照：内置定义以后改了，也不动用户点过头的那些字
 *   3. 幂等：重复导入不重复记账、不重写 importedAt
 *   4. 用户自己写一条同 key 的自述，预设那条自动让位（不是两条都贴）
 *   5. 移除只删 preset 状态，notes.md 里用户写的字一个都不动
 *   6. presets.json 手滑写坏了要降级成空态，不能让整段注入挂掉
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-preset-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(join(dir, 'memory'), { recursive: true })

const store = await import('../lib/store.js')
const presets = await import('../lib/presets.js')
const { apply, PRESET_EMPTY_HINT } = await import('../lib/index.js')

/* ---------------- 1. 空态：五条在架上，一条没生效 ---------------- */

assert.deepEqual(presets.readPresets(), { version: 1, applied: {} })
const empty = presets.presetState()
assert.equal(empty.total, 5, '内置五条')
assert.equal(empty.importedCount, 0, '默认一条都不导')
assert.ok(
  empty.items.every((item) => item.imported === false && item.text !== '' && item.tier === 'stable'),
  '未导入时也要给预览文案：' + JSON.stringify(empty.items),
)
console.log('1. 默认一条都不导：五条都在架上，各有预览文案')

/* ---------------- 2. 行格式：{key} 能来回，正文里的花括号不当 key ---------------- */

const keyed = store.parseNotes('- 2026-11-04 [稳定] {style.length} 回答短一点')[0]
assert.equal(keyed.key, 'style.length')
assert.equal(keyed.text, '回答短一点', 'key 不该留在正文里')
assert.equal(keyed.tier, 'stable')
// 稳定是默认型，回写时不带 [稳定] 标记（与 notes-tier 的约定一致）
assert.equal(store.renderNotes([keyed]), '- 2026-11-04 {style.length} 回答短一点', '回写要同形')

// 正文里本来就有的花括号是用户写的字，不是 key：认不出就一直留在正文
const notKey = store.parseNotes('- 2026-11-04 {随便写写} 一句话')[0]
assert.equal(notKey.key, '')
assert.equal(notKey.text, '{随便写写} 一句话')
// 没有 key 的老行照旧
assert.equal(store.parseNotes('- 2026-11-04 普通一句')[0].key, '')
console.log('2. 行格式往返一致；认不出的花括号原样留在正文')

/* ---------------- 3. 导入：幂等，靠 importedAt 记账 ---------------- */

const first = presets.importPresets(['style.length'])
assert.deepEqual(first.imported, ['style.length'])
assert.deepEqual(first.already, [])
assert.equal(presets.presetState().importedCount, 1)

const stamp = presets.readPresets().applied['style.length'].importedAt
assert.ok(stamp !== '', '要记下导入时间')

const repeat = presets.importPresets(['style.length'])
assert.deepEqual(repeat.imported, [], '重复导入不该再记一次')
assert.deepEqual(repeat.already, ['style.length'])
assert.equal(presets.readPresets().applied['style.length'].importedAt, stamp, '重拿按钮不该改写导入时间')

const bogus = presets.importPresets(['no.such.key'])
assert.deepEqual(bogus.unknown, ['no.such.key'], '认不出的 key 报 unknown，不静默吞掉')
assert.equal(presets.presetState().importedCount, 1)
console.log('3. 导入幂等：不重复记账、不改导入时间、未知 key 报出来')

/* ---------------- 4. 快照：定义改了也不偷偷换掉用户点过头的字 ---------------- */

const onDisk = presets.readPresets()
onDisk.applied['style.length'].text = '旧版文案，用户当时点的是这句'
writeFileSync(presets.presetsPath(), JSON.stringify(onDisk))

const drifted = presets.presetState()
const driftedRow = drifted.items.find((item) => item.key === 'style.length')
assert.equal(driftedRow.text, '旧版文案，用户当时点的是这句', '生效的是快照，不是现行定义')
assert.equal(driftedRow.edited, true, '要标出「你导入的是旧版」')
assert.equal(presets.findPreset('style.length').text.startsWith('回答长度不限'), true, '定义本身没被改')
console.log('4. 导入是文案快照：定义改了只标 edited，不动已导入的字')

/* ---------------- 5. 用户同 key 自述覆盖预设 ---------------- */

store.writeNotes([])
store.appendNote('回答短一点，一屏就够', {}, { tier: 'stable', key: 'style.length' })
const injected = presets.presetsForInjection(store.readNotes())
assert.equal(injected.entries.some((one) => one.key === 'style.length'), false, '被覆盖的不该再进注入')
assert.deepEqual(injected.hidden.map((one) => one.key), ['style.length'])
assert.equal(injected.hidden[0].reason, 'user-override')
console.log('5. 同 key 用户自述优先：预设那条让位，并留下让位理由')

/* ---------------- 6. 注入段：空态给提示，导入后给内容 ---------------- */

const boot = (extra) => {
  const captured = { contexts: [] }
  apply(
    {
      logger: { info: () => {} },
      on: () => () => {},
      systemPrompt: { context: (def) => (captured.contexts.push(def), () => {}) },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      agents: { currentInitiator: () => ({ session: { header: { id: 'preset' } } }) },
    },
    { enabled: true, profileEnabled: false, ...(extra || {}) },
  )
  return captured.contexts[0].text()
}

store.writeNotes([])
presets.removePresets()
const blank = boot()
assert.ok(blank.includes(PRESET_EMPTY_HINT), '空态要有一行提示，模型才知道可以建议用户导：' + JSON.stringify(blank))
assert.ok(!blank.includes('来源 preset，可删改'), '没导入就不该有无内容的段头')

presets.importPresets()
const full = boot()
assert.ok(full.includes('协作默认（来源 preset，可删改）：'), '导入后要能看出这几条是可删改的默认值')
const shown = presets.PRESETS.filter((preset) => full.includes(preset.text))
assert.equal(shown.length, 5, '五条是一套，预算按五条定过（160 字）；缺一条就说明预算被改小了：' + JSON.stringify(full))
// 装不下就整条跳过，不截半句：出现的每一条都是完整句子
for (const preset of shown) {
  assert.ok(full.includes(preset.text), '句子必须完整：' + preset.key)
}

store.appendNote('回答短一点，一屏就够', {}, { tier: 'stable', key: 'style.length' })
const overridden = boot()
assert.ok(overridden.includes('回答短一点，一屏就够'), '用户那句照旧进注入')
assert.equal(overridden.includes('回答长度不限，该多长就多长；结论先给，不铺垫。'), false, '预设那条要让位')
console.log('6. 注入段：空态给提示、导入后带来源标记、装不下整条跳过')

/* ---------------- 7. 移除：只删 preset，不碰 notes.md ---------------- */

const removed = presets.removePresets(['style.length', 'verify.evidence'])
assert.deepEqual(removed.removed.sort(), ['style.length', 'verify.evidence'])
const missing = presets.removePresets(['style.length'])
assert.deepEqual(missing.missing, ['style.length'], '没导入过的报 missing')
assert.deepEqual(missing.unknown, [])
assert.equal(store.readNotes().length, 1, '用户自己写的那条一条不少')
assert.equal(store.readNotes()[0].key, 'style.length', '移除预设不该动用户的 key 标记')
console.log('7. 移除只清 preset 状态：notes.md 一个字不动')

/* ---------------- 8. 坏文件降级 ---------------- */

writeFileSync(presets.presetsPath(), '{ 这不是 json')
assert.deepEqual(presets.readPresets(), { version: 1, applied: {} }, '坏文件当没导入过')
assert.equal(presets.presetState().importedCount, 0)
// 降级之后还能正常导入（坏文件被覆盖，不留残渣）
assert.deepEqual(presets.importPresets(['risk.ask']).imported, ['risk.ask'])
assert.equal(presets.presetState().importedCount, 1)
console.log('8. presets.json 坏掉时降级成空态，之后还能正常导入')

console.log('\n全部通过：协作默认（preset）')
