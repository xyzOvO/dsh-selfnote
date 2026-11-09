/**
 * 迁移包往返回归：自述分型 / 钉住与白名单配置不许在导出导入途中丢掉。
 *
 * notes.md 的行格式带 [临时] / [稳定*] 标记，parseNotes() 还原成 { tier, pin }；
 * 但迁移包只导出 { date, text }，导入又只按这两个字段重建，
 * 于是「导出去再导回来」会把临时自述变成稳定、把钉住弄丢。
 * 配置同理：包里带了白名单字段，/import 却从不落盘。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-transfer-roundtrip-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = join(dir, 'sessions')
process.env.DSH_SELFNOTE_NO_OPEN = '1'
mkdirSync(process.env.DSH_MEMORY_DIR, { recursive: true })
mkdirSync(process.env.DSH_SESSIONS_DIR, { recursive: true })

const { apply, currentAuthToken } = await import('../lib/index.js')
const store = await import('../lib/store.js')
const { buildBundle, mergeBundle, validateBundle, mergeConfig, BUNDLE_VERSION } = await import('../lib/transfer.js')

const HOST = '127.0.0.1:56645'
const authHeaders = () => ({ 'x-selfnote': currentAuthToken(), host: HOST })
let handler = null
const ctx = {
  logger: { info() {} },
  on() { return () => {} },
  agents: { currentInitiator: () => null },
  systemPrompt: { context() { return () => {} } },
  tools: { register() { return () => {} } },
  webServer: {
    register(route) { handler = route.handler; return () => {} },
  },
}
apply(ctx, {})
assert.ok(handler, '没有注册 /api/selfnote 路由')

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = authHeaders()
    const res = {
      status: 0,
      payload: null,
      writeHead(status) { this.status = status },
      end(text) { this.payload = JSON.parse(text); resolve(this) },
    }
    handler(req, res).catch(reject)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
}

/* 1. 纯函数层：导出要带自述分型与钉住，导入要还原它们 */
const originalNotes = [
  { date: '2026-11-08', text: '这周在做全量复测', tier: 'temp', pin: false },
  { date: '2026-11-07', text: '回答先给结论', tier: 'stable', pin: true },
  { date: '2026-11-06', text: '身份素材一条', tier: 'core', pin: false },
]
const roundTrip = buildBundle({
  notes: originalNotes,
  facts: [],
  habits: [],
  config: { heading: '演示抬头', personaEnabled: false, tempTtlDays: 21, halfLifeDays: 90 },
  now: new Date('2026-11-10T00:00:00Z'),
})
assert.equal(roundTrip.v, BUNDLE_VERSION)
assert.equal(validateBundle(roundTrip), null)
assert.equal(roundTrip.notes[0].tier, 'temp', '导出要保留临时型，否则导回来会变成稳定型')
assert.equal(roundTrip.notes[1].pin, true, '导出要保留钉住，否则优先级悄悄掉了')
assert.equal(roundTrip.notes[2].tier, 'core', '核心身份素材也要能带走')
assert.equal(roundTrip.config.heading, '演示抬头')
assert.equal(roundTrip.config.tempTtlDays, 21)

const restored = mergeBundle(roundTrip, { notes: [], facts: [], habits: [] })
assert.deepEqual(
  restored.notes.map((entry) => ({ date: entry.date, text: entry.text, tier: entry.tier, pin: entry.pin })),
  originalNotes,
  '导出去再导回来，三型与 pin 必须原样',
)
console.log('1. 迁移包纯函数往返：自述三型 / pin / 白名单配置不丢')

/* 2. 配置合并是纯函数，且只认白名单基本类型 */
const configPlan = mergeConfig(roundTrip, {
  heading: '别的抬头',
  tempTtlDays: 7,
  halfLifeDays: 10,
  personaEnabled: true,
  内部字段: '不许带进来',
})
assert.equal(configPlan.config.heading, '演示抬头')
assert.equal(configPlan.config.tempTtlDays, 21)
assert.equal(configPlan.config.halfLifeDays, 90)
assert.equal(configPlan.config.personaEnabled, false)
assert.equal(configPlan.config.内部字段, undefined, '非白名单字段不许被导入')
assert.equal(configPlan.applied.length, 4)
const dirtyConfig = mergeConfig({ app: 'dsh-selfnote', v: 2, config: { halfLifeDays: 'oops', heading: 42, tempTtlDays: null } }, {})
assert.equal(dirtyConfig.applied.length, 0, '畸形字段整条跳过，不写坏 config.json')
console.log('2. 配置合并：白名单 + 类型校验，畸形字段跳过')

/* 3. HTTP 层：导出后清空，再导入，盘上的 notes.md 与 config.json 要恢复原样 */
store.writeNotes(originalNotes)
store.writeConfig({
  enabled: true,
  heading: '演示抬头',
  maxChars: 1200,
  maxEntries: 30,
  profileEnabled: true,
  profileOverride: '',
  profileMaxChars: 80,
  halfLifeDays: 90,
  noteGuide: '先给结论',
  personaEnabled: false,
  tempTtlDays: 21,
})

const exported = await call('GET', '/api/selfnote/export')
assert.equal(exported.status, 200, JSON.stringify(exported.payload))
assert.equal(exported.payload.notes[0].tier, 'temp', 'GET /export 不能只吐 date/text')
assert.equal(exported.payload.notes[1].pin, true)
assert.equal(exported.payload.config.heading, '演示抬头')
assert.equal(exported.payload.config.tempTtlDays, 21)

store.writeNotes([])
store.writeConfig({ heading: '别的抬头', tempTtlDays: 7, halfLifeDays: 10, personaEnabled: true })
assert.deepEqual(store.readNotes(), [], '清空后确实没有当前生效自述')

const imported = await call('POST', '/api/selfnote/import', { bundle: exported.payload })
assert.equal(imported.status, 200, JSON.stringify(imported.payload))
assert.equal(imported.payload.import.added.notes, 3)
assert.deepEqual(
  store.readNotes().map((entry) => ({ date: entry.date, text: entry.text, tier: entry.tier, pin: entry.pin })),
  originalNotes,
  '导入后 notes.md 必须恢复分型与钉住',
)
const onDiskConfig = store.readConfig()
assert.equal(onDiskConfig.heading, '演示抬头', '白名单配置要落盘，不能只在 JSON 里看着有')
assert.equal(onDiskConfig.tempTtlDays, 21)
assert.equal(onDiskConfig.halfLifeDays, 90)
assert.equal(onDiskConfig.personaEnabled, false)
console.log('3. HTTP 导出→清空→导入：notes.md 分型/pin 与 config.json 白名单字段都还原')

/* 4. 老包（v1）不带 tier/pin：按默认稳定型导入，不能把未知字段当真 */
const legacy = {
  app: 'dsh-selfnote',
  v: 1,
  notes: [{ date: '2026-10-01', text: '老包里的一条自述' }],
  facts: [],
  habits: [],
}
assert.equal(validateBundle(legacy), null, 'v1 老包仍可导入')
const legacyMerged = mergeBundle(legacy, { notes: [], facts: [], habits: [] })
assert.equal(legacyMerged.notes[0].tier, 'stable', '老包没标记，按默认稳定型')
assert.equal(legacyMerged.notes[0].pin, false)
console.log('4. v1 老包兼容：缺字段按默认稳定型，不误认')

/* 5. 畸形分型不许写坏 notes.md：认不出的值回落默认，pin 只认真布尔 */
const dirty = {
  app: 'dsh-selfnote',
  v: BUNDLE_VERSION,
  notes: [
    { date: '2026-11-10', text: '脏分型', tier: 'root', pin: 'yes' },
    { date: '2026-11-10', text: '中文分型', tier: '临时', pin: false },
  ],
  facts: [],
  habits: [],
}
const dirtyMerged = mergeBundle(dirty, { notes: [], facts: [], habits: [] })
assert.equal(dirtyMerged.notes[0].tier, 'stable', '未知分型回落默认，不能让 renderNotes 写出怪方括号')
assert.equal(dirtyMerged.notes[0].pin, false, 'pin 只认真布尔')
assert.equal(dirtyMerged.notes[1].tier, 'temp', '中文分型也认')
console.log('5. 畸形分型与 pin 归一：不会往 notes.md 写脏标记')

console.log('5 项全部通过')
process.exit(0)
