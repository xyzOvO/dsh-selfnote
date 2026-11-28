/**
 * 协作默认的「旧文案」检测与同步。
 * 跑法：node tests/preset-drift.mjs
 *
 * 为什么要有这个：presets.json 存的是导入那一刻的文案快照，所以插件升级改了默认
 * 也不会传到老用户身上。但快照是刻意的（不偷偷换用户点过头的句子），所以这里只做
 * 「认出来 + 等人点」，绝不自动替换。
 *
 * 要守住四件事：
 *   1. 导入过、且文案正好是历史默认 → 判 superseded（可以换新）
 *   2. 导入过、但自己改过 → 判 customized（同步时一个字都不动）
 *   3. 没导入过的 → 不出现在 drift 里
 *   4. 同步幂等：第二次调用没有变化
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-drift-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(join(dir, 'memory'), { recursive: true })

const OLD_STYLE = '回答长度不限，该多长就多长；结论先给，不铺垫。'
const MINE = '我要先问过我妈。'

writeFileSync(
  join(dir, 'presets.json'),
  JSON.stringify(
    {
      version: 1,
      applied: {
        'style.length': { text: OLD_STYLE, tier: 'stable', importedAt: '2026-11-19T16:05:40.631Z' },
        'risk.ask': { text: MINE, tier: 'stable', importedAt: '2026-11-19T16:05:40.631Z' },
      },
    },
    null,
    2,
  ),
)

const presets = await import('../lib/presets.js')

/* ---------------- 1. 区分「旧默认」和「自己改过」 ---------------- */

const drift = presets.presetDrift()
assert.equal(drift.length, 2, '两条与当前默认不同：' + JSON.stringify(drift))
const byKey = Object.fromEntries(drift.map((row) => [row.key, row]))
assert.equal(byKey['style.length'].kind, 'superseded', '正好等于历史默认的，要判成旧文案')
assert.equal(byKey['risk.ask'].kind, 'customized', '自己改过的不能当成旧文案')
assert.equal(byKey['style.length'].current, presets.findPreset('style.length').text, '要带上当前默认供界面展示')
assert.equal(byKey['verify.evidence'], undefined, '没导入过的条目不该出现在 drift 里')
console.log('1. drift 能分开旧文案与自己改过，未导入的不出现')

/* ---------------- 2. 同步：只换旧文案，改过的不动 ---------------- */

const out = presets.syncPresets()
assert.deepEqual(out.synced, ['style.length'], '只该同步旧文案那条：' + JSON.stringify(out))
assert.deepEqual(out.customized, ['risk.ask'], '改过的要如实报出来：' + JSON.stringify(out))
const after = presets.readPresets()
assert.equal(after.applied['style.length'].text, presets.findPreset('style.length').text, '要换成当前默认')
assert.equal(after.applied['style.length'].importedAt, '2026-11-19T16:05:40.631Z', '导入时间不能被改写')
assert.equal(after.applied['risk.ask'].text, MINE, '自己改的一个字都不能动')
console.log('2. 同步只替换旧默认为当前默认，改过的原样保留')

/* ---------------- 3. 幂等 ---------------- */

const again = presets.syncPresets()
assert.deepEqual(again.synced, [], '第二次同步不该再有变化：' + JSON.stringify(again))
console.log('3. 同步幂等，重复点不会反复改')

/* ---------------- 4. 指定 key 与未知 key ---------------- */

const scoped = presets.syncPresets(['style.length', 'nope.not-exist'])
assert.deepEqual(scoped.synced, [], '指定已同步的 key 时没有变化')
assert.deepEqual(scoped.unknown, ['nope.not-exist'], '未知 key 要如实报')
console.log('4. 指定 key 只处理那几条，未知 key 单独报')

console.log('preset-drift: 全部通过')
