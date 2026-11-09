// 第三轮全量审查回归：迁移、采集、索引、温层/纠偏坏行、人格锁、缓存/鉴权、UI 可读性。
// 规则：先红后绿；全部断言用隔离目录，不碰真实 ~/.dsh。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

const root = mkdtempSync(join(tmpdir(), 'selfnote-r3-'))
process.env.DSH_SELFNOTE_DIR = join(root, 'selfnote')
process.env.DSH_MEMORY_DIR = join(root, 'memory')
process.env.DSH_SESSIONS_DIR = join(root, 'sessions')
process.env.DSH_SELFNOTE_NO_OPEN = '1'
process.env.DSH_SELFNOTE_TOKEN = 'tok</script><b>x'
for (const d of [process.env.DSH_SELFNOTE_DIR, process.env.DSH_MEMORY_DIR, process.env.DSH_SESSIONS_DIR]) mkdirSync(d, { recursive: true })

const transfer = await import('../lib/transfer.js')
const captureRun = await import('../lib/capture-run.js')
const indexStore = await import('../lib/index-store.js')
const atomic = await import('../lib/atomic.js')
const corrections = await import('../lib/corrections.js')
const warm = await import('../lib/warm.js')
const store = await import('../lib/store.js')
const personaTx = await import('../lib/persona-tx.js')
const { apply } = await import('../lib/index.js')

let n = 0
function ok(name, fn) { fn(); n += 1; console.log(n + '. ' + name) }

// 1. 导入缺 status 的 fact 必须落成 candidate，并清掉审核残留
ok('F8: 缺 status 的导入 fact 变成 candidate（不是 undefined）', () => {
  const merged = transfer.mergeBundle(
    { app: 'dsh-selfnote', v: 2, notes: [], facts: [{ id: 'f1', text: '一条事实', reviewedAt: '2026-01-01', retiredAt: '2026-02-01' }], habits: [], persona: null },
    { notes: [], facts: [], habits: [] },
    { keepStatus: false },
  )
  const f = merged.facts.find((x) => x.text === '一条事实')
  assert.ok(f, 'fact 应被导入')
  assert.equal(f.status, 'candidate')
  assert.equal(f.reviewedAt, undefined)
  assert.equal(f.retiredAt, undefined)
})

// 2/3. textOfEvent 认嵌套 message.content、顶层 content、input_text 块
ok('textOfEvent: data.message.content 嵌套正文不丢', () => {
  assert.equal(captureRun.textOfEvent({ data: { message: { content: [{ type: 'text', text: '嵌套正文' }] } } }), '嵌套正文')
})
ok('textOfEvent: event.content 字符串 + input_text 块', () => {
  assert.equal(captureRun.textOfEvent({ content: '顶层正文' }), '顶层正文')
  assert.equal(captureRun.textOfEvent({ data: { content: [{ type: 'input_text', text: '输入块' }] } }), '输入块')
})

// 4. queryIndex 对原型键不炸
ok('queryIndex: constructor 不抛异常（当成空 posting）', () => {
  assert.doesNotThrow(() => indexStore.queryIndex({ v: 3, postings: {}, records: {}, sessions: {} }, ['constructor']))
})

// 5. indexStats: meta 还在但 body 没了 → 不报健康
ok('indexStats: meta 孤悬（index.json 缺失）不算 present', () => {
  writeFileSync(indexStore.indexMetaPath(), JSON.stringify({ v: 3, builtAt: '2026-01-01T00:00:00Z', sessions: {}, counts: { sessions: 0, records: 0, terms: 0, failed: 0 } }))
  assert.equal(existsSync(indexStore.indexPath()), false)
  assert.equal(indexStore.indexStats([]).present, false)
})

// 6. writeJsonAtomic 拒绝 undefined
ok('writeJsonAtomic: undefined 抛错，不写 "undefined"', () => {
  assert.throws(() => atomic.writeJsonAtomic(join(root, 'bad.json'), undefined), /undefined/)
  assert.equal(existsSync(join(root, 'bad.json')), false)
})

// 7. corrections: strength 落盘不丢
ok('corrections: appendEvents 保留 strength', () => {
  corrections.appendEvents([{ session: 's1', idx: 0, quote: '别这样写', strength: 'strong', at: '2026-01-01T00:00:00Z' }])
  const rows = corrections.readEvents()
  assert.ok(rows.some((e) => e.strength === 'strong'), 'strength 应能读回')
})

// 8. corrections: 坏行写回被隔离，不静默删除
ok('corrections: 坏行写回隔离到 .bad 文件', () => {
  const p = corrections.CORRECTIONS_PATH
  writeFileSync(p, '{这是一行坏 JSON}\n' + JSON.stringify({ id: 'keep', session: 's', idx: 1, quote: '保留我', at: '2026-01-01T00:00:00Z' }) + '\n')
  corrections.appendEvents([{ session: 's2', idx: 2, quote: '新增一条', at: '2026-01-02T00:00:00Z' }])
  const bad = readdirSync(dirname(p)).filter((f) => f.startsWith('corrections.bad'))
  assert.ok(bad.length > 0, '坏行应隔离留存，不能被无声抹掉')
  assert.ok(readFileSync(join(dirname(p), bad[0]), 'utf8').includes('这是一行坏 JSON'))
})

// 9. warm: 坏行写回被隔离
ok('warm: 坏行写回隔离到 .bad 文件', () => {
  const p = warm.warmPath()
  writeFileSync(p, '{坏摘要}\n' + JSON.stringify({ text: '好摘要', pointers: [{ sessionId: 's', index: 0 }], created: '2026-01-01T00:00:00Z' }) + '\n')
  const r = warm.writeSummary({ text: '新摘要', pointers: [{ sessionId: 's2', index: 1 }] })
  assert.equal(r.ok, true)
  const bad = readdirSync(dirname(p)).filter((f) => f.startsWith('warm.bad'))
  assert.ok(bad.length > 0, '坏行应隔离留存')
  assert.ok(readFileSync(join(dirname(p), bad[0]), 'utf8').includes('坏摘要'))
})

// 10. persona-tx: 空锁不算 stale
ok('persona-tx: 刚建的空 persona.lock 不能被当陈旧锁抢走', () => {
  writeFileSync(join(store.selfnoteRoot(), 'persona.lock'), '')
  const st = personaTx.lockState()
  assert.equal(st.stale, false)
})

// 11/12. apply() 捕获注入定义与 tapIndex
let injectionDef = null
let tapFn = null
const HOST = '127.0.0.1:56645'
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on() { return () => {} },
  agents: { currentInitiator: () => 'r3-test' },
  systemPrompt: { context(def) { injectionDef = def; return () => {} } },
  tools: { register() { return () => {} } },
  webServer: {
    register(route) { return () => {} },
    tapIndex(fn) { tapFn = fn; return () => {} },
  },
}
apply(ctx, {})

// 11. noteGuide 改了缓存键要变
ok('injectionKey: 改 noteGuide 后注入文本必须跟着变', () => {
  const before = injectionDef.text()
  store.writeConfig({ ...store.readConfig(), noteGuide: '写短句' })
  const after = injectionDef.text()
  assert.notEqual(after, before, 'noteGuide 必须进缓存键')
  assert.ok(after.includes('写自述的时机：写短句'))
})

// 12. token 里的 </script> 不能提前闭合脚本
ok('injectTokenScript: token 含 </script> 不能闭合脚本', () => {
  assert.equal(typeof tapFn, 'function')
  const out = tapFn('<html><head></head><body>x</body></html>')
  assert.ok(!out.includes('</script><b>'), 'token 里的 </script> 必须转义')
})

// 13. client.js 静态可读性回归
ok('client.js: UTF-16 maxLength / 错误变量 / 悬空 aria / 重复截断 / 导入无 busy 闸 全部清掉', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(/\bmaxLength:\s*\d/.test(src), false, '不许再用 HTML maxLength（按 UTF-16 计）')
  assert.equal(src.includes('--dsh-text-secondary'), false, '变量命名空间应是 --dsw-alias-*')
  assert.ok(src.includes('.sn-transfer-warn{color:#fcd34d}'), 'dark media 要覆盖 warn 前景')
  assert.equal(src.includes('setMoreEvidence([])'), false, 'apply() 不该清掉翻页追加')
  assert.ok(src.includes("'aria-controls': 'sn-panel-' + activeTab"), '所有页签指向同一个真实面板')
  assert.ok(src.includes("if (busy !== '') return"), 'importBundle 要有 busy 闸')
})

console.log('\n' + n + ' 项全部通过')
process.exit(0)
