/**
 * 协作默认的「旧文案」检测与同步。
 * 跑法：node tests/preset-drift.mjs
 *
 * 为什么要有这个：presets.json 存的是导入那一刻的文案快照，所以插件升级改了默认
 * 也不会传到老用户身上。但快照是刻意的（不偷偷换用户点过头的句子），所以这里只做
 * 「认出来 + 等人点」，绝不自动替换。
 *
 * 要守住四件事：
 *   1. 三分归类：跟当前默认一致 / 正好等于某个历史默认 / 自己改过
 *   2. drift 只列「和当前默认不一致」的，自己改过的只报出来，同步时一个字都不动
 *   3. 没导入过的 → 不出现在 drift 里
 *   4. 同步幂等：第二次调用没有变化
 *
 * 现状：默认文案已回滚到最早那句，历史默认表（SUPERSEDED_PRESET_TEXTS）是空的，
 * 所以 superseded 这一支用 classifyPresetText 的 history 参数单独验，不靠真表。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-drift-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(join(dir, 'memory'), { recursive: true })

const presets = await import('../lib/presets.js')
const CURRENT = presets.findPreset('style.length').text
const MINE = '我要先问过我妈。'

writeFileSync(
  join(dir, 'presets.json'),
  JSON.stringify(
    {
      version: 1,
      applied: {
        'style.length': { text: CURRENT, tier: 'stable', importedAt: '2026-11-19T16:05:40.631Z' },
        'risk.ask': { text: MINE, tier: 'stable', importedAt: '2026-11-19T16:05:40.631Z' },
      },
    },
    null,
    2,
  ),
)

/* ---------------- 1. 三分归类 ---------------- */

assert.equal(presets.classifyPresetText(CURRENT, CURRENT, ['老句子']), 'same', '跟当前默认一样就是 same')
assert.equal(presets.classifyPresetText('老句子', CURRENT, ['老句子']), 'superseded', '正好等于历史默认才能换新')
assert.equal(presets.classifyPresetText('我自己改的', CURRENT, ['老句子']), 'customized', '表里没有的一律算自己改过')
assert.equal(presets.classifyPresetText('老句子', CURRENT), 'customized', '默认空表时不认旧默认，宁可不给换新')
console.log('1. classifyPresetText 三分归类正确，空表不误判')

/* ---------------- 2. drift 只列不一致的 ---------------- */

const drift = presets.presetDrift()
assert.equal(drift.length, 1, '只有自己改过那条算 drift：' + JSON.stringify(drift))
const row = drift[0]
assert.equal(row.key, 'risk.ask', '自己改过的那条要报出来')
assert.equal(row.kind, 'customized', '自己改过的不能当成旧文案')
assert.equal(row.current, presets.findPreset('risk.ask').text, '要带上当前默认供界面展示')
assert.equal(
  drift.some((item) => item.key === 'style.length'),
  false,
  '跟当前默认一致的条目不该出现在 drift 里',
)
assert.equal(
  drift.some((item) => item.key === 'verify.evidence'),
  false,
  '没导入过的条目不该出现在 drift 里',
)
console.log('2. drift 只列和当前默认不一致的，一致的与未导入的都不出现')

/* ---------------- 3. presetState 的四态 ---------------- */

const state = presets.presetState()
const kinds = Object.fromEntries(state.items.map((item) => [item.key, item.kind]))
assert.equal(kinds['style.length'], 'same', '一致的要标 same')
assert.equal(kinds['risk.ask'], 'customized', '自己改过的要标 customized')
assert.equal(kinds['verify.evidence'], 'none', '没导入的标 none')
assert.equal(state.importedCount, 2, '导入计数只算真的导入过的')
console.log('3. presetState 给齐 none / same / customized 三态（superseded 见第 1 组）')

/* ---------------- 4. 同步：自己改的一个字都不动 ---------------- */

const out = presets.syncPresets()
assert.deepEqual(out.synced, [], '没有旧默认可同步：' + JSON.stringify(out))
assert.deepEqual(out.customized, ['risk.ask'], '改过的要如实报出来：' + JSON.stringify(out))
const after = presets.readPresets()
assert.equal(after.applied['risk.ask'].text, MINE, '自己改的一个字都不能动')
assert.equal(after.applied['style.length'].importedAt, '2026-11-19T16:05:40.631Z', '导入时间不能被改写')
console.log('4. 没有旧默认时不换任何东西，改过的原样保留')

/* ---------------- 5. 幂等 ---------------- */

const again = presets.syncPresets()
assert.deepEqual(again.synced, [], '第二次同步不该再有变化：' + JSON.stringify(again))
console.log('5. 同步幂等，重复点不会反复改')

/* ---------------- 6. 指定 key 与未知 key ---------------- */

const scoped = presets.syncPresets(['risk.ask', 'nope.not-exist'])
assert.deepEqual(scoped.unknown, ['nope.not-exist'], '未知 key 要如实报')
assert.deepEqual(scoped.customized, ['risk.ask'], '指定 key 也只处理那几条')
console.log('6. 指定 key 只处理那几条，未知 key 单独报')
