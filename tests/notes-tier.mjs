/**
 * 自述三型 + pin + 门牌。
 * 跑法：node tests/notes-tier.mjs
 *
 * 要守住的四件事：
 *   1. 行格式能来回（旧文件不动一个字也会被原样认回来）
 *   2. 类型只写在「非默认」的条目上，存量 notes.md 不会平白多出一堆 [稳定]
 *   3. 注入顺序是 核心 → 稳定（★ 先）→ 临时，核心最多占 60%
 *   4. 装不下的必须有门牌 —— 模型不能把「没看见」当成「没有」
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-tier-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(join(dir, 'memory'), { recursive: true })

const store = await import('../lib/store.js')
const { apply } = await import('../lib/index.js')

/* ---------------- 1. 解析 / 渲染 ---------------- */

assert.deepEqual(store.parseNotes('- 2026-11-04 [核心] 我是谁'), [{ date: '2026-11-04', text: '我是谁', tier: 'core', pin: false }])
assert.deepEqual(store.parseNotes('- 2026-11-04 [稳定*] 别喊我肥鱼'), [{ date: '2026-11-04', text: '别喊我肥鱼', tier: 'stable', pin: true }])
assert.deepEqual(store.parseNotes('- [临时] 今晚早睡'), [{ date: '', text: '今晚早睡', tier: 'temp', pin: false }])
// 老文件（没标记）= 稳定，零迁移
assert.equal(store.parseNotes('- 2026-11-04 普通一句')[0].tier, 'stable')
assert.equal(store.parseNotes('- 2026-11-04 普通一句')[0].pin, false)
// 认不出的标记原样留在正文里：宁可多个怪括号，不能吞掉人写的东西
const weird = store.parseNotes('- 2026-11-04 [重要] 别忘')[0]
assert.equal(weird.text, '[重要] 别忘')
assert.equal(weird.tier, 'stable')
// 渲染：默认型不加前缀，非默认型加
assert.equal(store.renderNotes([{ date: '2026-11-04', text: '旧格式', tier: 'stable', pin: false }]), '- 2026-11-04 旧格式')
assert.equal(store.renderNotes([{ date: '', text: '核心句', tier: 'core', pin: true }]), '- [核心*] 核心句')
console.log('1. 行格式来回一致（认不出的标记不吞正文）')

/* ---------------- 2. 写入：类型存得下、改正文不丢类型 ---------------- */

store.writeNotes([])
store.appendNote('我是大肥鱼', {}, { tier: 'core' })
store.appendNote('别喊我肥鱼', {}, { tier: 'stable', pin: true })
store.appendNote('今晚早睡', {}, { tier: 'temp' })
assert.deepEqual(
  store.readNotes().map((entry) => [entry.tier, entry.pin]),
  [['core', false], ['stable', true], ['temp', false]],
)
// 文件本身是人能读、能改的
const raw = readFileSync(store.notesPath(), 'utf8')
assert.ok(raw.includes('[核心] '), 'notes.md 里该看得见中文标记')
assert.ok(raw.includes('[稳定*] '), 'pin 要能一眼看出来')

store.setNoteMeta(2, { pin: true })
assert.equal(store.readNotes()[2].tier, 'temp', '只改 pin 不该动类型')
assert.equal(store.readNotes()[2].pin, true)
store.updateNote(0, '我是大肥鱼，改一下')
assert.equal(store.readNotes()[0].tier, 'core', '改正文不该把核心身份偷偷降级')
console.log('2. 类型随写入落盘，改正文保留原类型')

/* ---------------- 3. 注入顺序 ---------------- */

const pad = (n) => 'x'.repeat(n)
const boot = (extra) => {
  const captured = { contexts: [] }
  apply(
    {
      logger: { info: () => {} },
      on: () => () => {},
      systemPrompt: { context: (def) => (captured.contexts.push(def), () => {}) },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      agents: { currentInitiator: () => ({ session: { header: { id: 'tier' } } }) },
    },
    { enabled: true, profileEnabled: false, ...(extra || {}) },
  )
  return captured.contexts[0].text()
}

const shot = (rows) => {
  store.writeNotes([])
  writeFileSync(store.notesPath(), rows.map((row) => store.renderNotes([row])).join('\n') + '\n')
  return boot()
}

// 核心两条（旧的在前）、稳定一 pin 一新一旧、临时一条
const ordered = shot([
  { date: '2026-11-01', text: 'CORE1' + pad(10), tier: 'core', pin: false },
  { date: '2026-11-02', text: 'CORE2' + pad(10), tier: 'core', pin: false },
  { date: '2026-11-03', text: 'STABLE-OLD' + pad(10), tier: 'stable', pin: false },
  { date: '2026-11-04', text: 'STABLE-PIN' + pad(10), tier: 'stable', pin: true },
  { date: '2026-11-05', text: 'STABLE-NEW' + pad(10), tier: 'stable', pin: false },
  { date: '2026-11-06', text: 'TEMP1' + pad(10), tier: 'temp', pin: false },
])
const at = (marker) => ordered.indexOf(marker)
assert.ok(at('CORE1') >= 0 && at('TEMP1') >= 0, '六条都该进得来：' + JSON.stringify(ordered))
assert.ok(at('CORE1') < at('CORE2'), '核心按原顺序（老的人格底子先保住）')
assert.ok(at('CORE2') < at('STABLE-PIN'), '核心整体排在稳定前面')
assert.ok(at('STABLE-PIN') < at('STABLE-NEW'), '稳定的 pin 要先于普通条目')
assert.ok(at('STABLE-NEW') < at('STABLE-OLD'), '稳定里同优先级按时间倒序')
assert.ok(at('STABLE-OLD') < at('TEMP1'), '临时排最后')
console.log('3. 注入顺序：核心 → 稳定（★ 先）→ 临时')

/* ---------------- 3b. 核心段也认 pin ---------------- */

// 三条核心，钉住的是**最后写入**的那条。按「老→新」它排最后、会被 120 字上限挡掉；
// 只有 pin 真的生效，它才会插到最前面进场。
const corePin = shot([
  { date: '2026-11-01', text: 'CP-OLD' + pad(45), tier: 'core', pin: false },
  { date: '2026-11-02', text: 'CP-NEW' + pad(45), tier: 'core', pin: false },
  { date: '2026-11-03', text: 'CP-PIN' + pad(45), tier: 'core', pin: true },
])
assert.ok(corePin.includes('CP-PIN'), '钉住的核心必须进场（它在文件里排最后）：' + JSON.stringify(corePin))
assert.ok(corePin.includes('CP-OLD'), '没钉的按老→新，老的先保住')
assert.ok(!corePin.includes('CP-NEW'), '装不下时该挤掉的是中间那条（老的先保住、钉住的最先）')
assert.ok(corePin.indexOf('CP-PIN') < corePin.indexOf('CP-OLD'), 'pin 的核心排在普通核心前面')
console.log('3b. 核心段也认 pin（钉住的先占位，其余仍按老→新）')

/* ---------------- 4. 核心最多 60%，装不下的有门牌 ---------------- */

// 3 条 50 字的核心：120 字上限只装得下两条
const coreHeavy = shot([
  ...Array.from({ length: 3 }, (_, i) => ({ date: '2026-11-0' + (i + 1), text: 'CORE' + i + pad(45), tier: 'core', pin: false })),
])
assert.ok(coreHeavy.includes('CORE0'), '第一条核心在')
assert.ok(coreHeavy.includes('CORE1'), '第二条核心在')
assert.ok(!coreHeavy.includes('CORE2'), '第三条核心该被 60% 上限挡住')
assert.ok(coreHeavy.includes('另有 1 条自述（self_note read）'), '被挤掉的必须有门牌：' + JSON.stringify(coreHeavy))
console.log('4. 核心 60% 上限生效，装不下的留门牌')

/* ---------------- 5. 临时有保底，不会被稳定全部挤掉 ---------------- */

const stableHeavy = shot([
  ...Array.from({ length: 5 }, (_, i) => ({ date: '2026-11-1' + i, text: 'ST' + i + pad(40), tier: 'stable', pin: false })),
  { date: '2026-11-20', text: 'TEMP-KEEP' + pad(8), tier: 'temp', pin: false },
])
assert.ok(stableHeavy.includes('TEMP-KEEP'), '临时段有 1/4 保底：' + JSON.stringify(stableHeavy))
assert.ok(stableHeavy.includes('另有'), '稳定段被挤掉时同样有门牌')
console.log('5. 临时段拿到保底份额')

/* ---------------- 6. 全部装得下时不出门牌 ---------------- */

const roomy = shot([{ date: '2026-11-04', text: '只有一条' + pad(5), tier: 'core', pin: false }])
assert.ok(!roomy.includes('另有'), '没有条目被挤掉就不该有门牌：' + JSON.stringify(roomy))
console.log('6. 没东西被挤掉时不出门牌')

/* ---------------- 7. 临时自述会过期：不再自动进场，但内容不丢 ---------------- */

const ago = (days) => {
  const d = new Date(Date.now() - days * 86400000)
  const pad2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const ttlShot = shot([
  { date: ago(60), text: 'CORE-OLD' + pad(5), tier: 'core', pin: false },
  { date: ago(60), text: 'STABLE-OLD' + pad(5), tier: 'stable', pin: true },
  { date: ago(20), text: 'TEMP-EXPIRED' + pad(5), tier: 'temp', pin: false },
  { date: ago(1), text: 'TEMP-FRESH' + pad(5), tier: 'temp', pin: false },
])
assert.ok(ttlShot.includes('CORE-OLD'), '核心永不过期（人格不能因为时间掉出去）')
assert.ok(ttlShot.includes('STABLE-OLD'), '稳定型也不过期（pin 的偏好更不该掉）')
assert.ok(ttlShot.includes('TEMP-FRESH'), '没过期的临时自述照常进场')
assert.ok(!ttlShot.includes('TEMP-EXPIRED'), '过了 14 天的临时自述不再自动进场：' + JSON.stringify(ttlShot))
assert.ok(ttlShot.includes('另有 1 条自述'), '过期的也要进门牌 —— 它在库里，只是没进场')
console.log('7. 临时自述到期后不再自动进场，核心与稳定不受影响')

/* ---------------- 8. 保质期是配置项，边界不糊 ---------------- */

assert.equal(store.isExpiredNote({ date: ago(20), tier: 'temp' }, 14), true)
assert.equal(store.isExpiredNote({ date: ago(13), tier: 'temp' }, 14), false)
assert.equal(store.isExpiredNote({ date: ago(60), tier: 'core' }, 14), false, '核心不参与过期')
assert.equal(store.isExpiredNote({ date: ago(60), tier: 'stable', pin: true }, 14), false, '稳定不参与过期')
assert.equal(store.isExpiredNote({ date: '', tier: 'temp' }, 14), false, '没日期就不敢判过期')

// 把保质期调长，同一条又回来了：过期是「按当前设置算出来的」，不是给数据打钢印
const looseShot = (() => {
  store.writeNotes([])
  writeFileSync(
    store.notesPath(),
    store.renderNotes([{ date: ago(20), text: 'TEMP-REVIVED' + pad(5), tier: 'temp', pin: false }]) + '\\n',
  )
  return boot({ tempTtlDays: 30 })
})()
assert.ok(looseShot.includes('TEMP-REVIVED'), '保质期调到 30 天，20 天前的那条该回来')
console.log('8. 保质期可配（1–90 天），核心与稳定永不到期')

/* ---------------- 9. 写入告警说的是「这轮真能用的字数」 ---------------- */

// 核心先占掉 120 字（两条 58 字），稳定再吃掉一份 —— 临时段实际只剩几十字。
// 一条 110 字的临时自述：按「整段 200 字」比是过关的，实际每回合都被跳过。
const writeWarn = async (tier, text) => {
  const captured = { tools: [] }
  apply(
    {
      logger: { info: () => {} },
      on: () => () => {},
      systemPrompt: { context: () => () => {} },
      tools: { register: (def) => (captured.tools.push(def), () => {}) },
      webServer: { register: () => () => {} },
      agents: { currentInitiator: () => ({ session: { header: { id: 'tier' } } }) },
    },
    { enabled: true, profileEnabled: false },
  )
  return captured.tools[0].execute({ action: 'write', text, tier })
}

store.writeNotes([])
writeFileSync(
  store.notesPath(),
  [
    ...['CORE0', 'CORE1'].map((tag, i) =>
      store.renderNotes([{ date: '2026-11-0' + (i + 1), text: tag + pad(52), tier: 'core', pin: false }]),
    ),
    ...['ST0', 'ST1'].map((tag, i) =>
      store.renderNotes([{ date: '2026-11-0' + (i + 5), text: tag + pad(32), tier: 'stable', pin: false }]),
    ),
  ].join('\n') + '\n',
)

const tooLongForTemp = await writeWarn('temp', 'T'.repeat(110))
assert.ok(tooLongForTemp.warning, '写不进去就得当场说，不能静默')
assert.match(tooLongForTemp.warning, /实际能用的 \d+ 字/, '要说清这轮真实额度，不是整段 200：' + tooLongForTemp.warning)
assert.match(tooLongForTemp.warning, /模型每回合都看不到它/)

const fitsTemp = await writeWarn('temp', 'SHORT')
assert.equal(fitsTemp.warning, '', '装得下就别吓唬人：' + JSON.stringify(fitsTemp.warning))
console.log('9. 写入告警按「这轮实际能用的字数」算，不是整段 200 字')

console.log('\n9 项全部通过')
process.exit(0)
