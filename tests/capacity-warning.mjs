/**
 * 写入容量告警：一条能自己挤进上下文、却把别的规则挤掉时，必须当场说清。
 *
 * 回归的是线上真实翻车：4 条短规则本来全进，写进一条 95 字长自述后，
 * 它自己进了、旧规则被静默挤掉，旧版告警却返回空字符串（只问「这条进不进得来」，
 * 不问「它把谁挤下去了」）。
 *
 * 跑法：node tests/capacity-warning.mjs（自带临时目录隔离，不碰真实记忆）
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-capwarn-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(join(dir, 'memory'), { recursive: true })

const store = await import('../lib/store.js')
const { apply } = await import('../lib/index.js')

const pad = (n) => 'x'.repeat(n)
const shortRules = [
  { date: '2026-11-01', text: 'RULE-A' + pad(32), tier: 'stable', pin: false }, // 38
  { date: '2026-11-02', text: 'RULE-B' + pad(26), tier: 'stable', pin: false }, // 32
  { date: '2026-11-03', text: 'RULE-C' + pad(25), tier: 'stable', pin: false }, // 31
  { date: '2026-11-04', text: 'RULE-D' + pad(20), tier: 'stable', pin: false }, // 26
]
const reset = (rows = shortRules) => {
  store.writeNotes([])
  writeFileSync(store.notesPath(), rows.map((r) => store.renderNotes([r])).join('\n') + '\n')
}
const warningOf = async (tier, text) => {
  const captured = { tools: [] }
  apply(
    {
      logger: { info: () => {} },
      on: () => () => {},
      systemPrompt: { context: () => () => {} },
      tools: { register: (def) => (captured.tools.push(def), () => {}) },
      webServer: { register: () => () => {} },
      agents: { currentInitiator: () => ({ session: { header: { id: 'capwarn' } } }) },
    },
    { enabled: true, profileEnabled: false },
  )
  const result = await captured.tools[0].execute({ action: 'write', text, tier })
  return result.warning
}

/* 1. 核心 bug：长条能进，却挤掉了原本进得来的旧规则 */
reset()
const long = 'NEW' + 'z'.repeat(92) // 95 字
const warnLong = await warningOf('stable', long)
assert.match(warnLong, /挤掉/, '自己进得来却挤掉旧条，必须当场报警：' + JSON.stringify(warnLong))
assert.match(warnLong, /\d+ 条自述/, '要说清挤掉几条：' + JSON.stringify(warnLong))
console.log('1. 长条挤掉旧规则 → 明确报「挤掉 N 条」')

/* 2. 保护：短条谁也没挤掉，不该吓唬人 */
reset()
assert.equal(await warningOf('stable', 'SHORT'), '', '没挤掉任何旧条就别报警')
console.log('2. 短条不挤人 → 不误报')

/* 3. 保护：整条自己都进不来，仍给「实际能用的字数」告警 */
reset()
const huge = 'Q'.repeat(210)
const warnHuge = await warningOf('stable', huge)
assert.match(warnHuge, /实际能用的|每回合都看不到它/, '超长条仍要给原本的额度告警：' + JSON.stringify(warnHuge))
console.log('3. 超长条进不来 → 保留原有额度告警')

console.log('\n3 项全部通过')
process.exit(0)
