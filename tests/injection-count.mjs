/**
 * 注入计数的独立观测口径：只看「文本真返回给模型」这一次，缓存命中也算。
 * 与 tests/skipped.mjs（解释链）互不复用夹具、互不写对方断言。
 * 跑法：node tests/injection-count.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'selfnote-count-notes-'))
const memoryDir = mkdtempSync(join(tmpdir(), 'selfnote-count-memory-'))
const sessionsDir = mkdtempSync(join(tmpdir(), 'selfnote-count-sessions-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = memoryDir
process.env.DSH_SESSIONS_DIR = sessionsDir
process.env.DSH_SELFNOTE_NO_OPEN = '1'

const configFile = join(dir, 'config.json')
const stateFile = join(memoryDir, 'state.json')
mkdirSync(memoryDir, { recursive: true })

function writeConfig(enabled) {
  writeFileSync(configFile, JSON.stringify({
    enabled, heading: '计数测试', noteGuide: '', personaEnabled: false,
    profileEnabled: false, tempTtlDays: 14, halfLifeDays: 30,
  }, null, 2) + NL, 'utf8')
}
writeConfig(true)
// 一条自述：没有正文时 text 为空，不该计数；有正文才谈得上「真注入」
writeFileSync(join(dir, 'notes.md'), '- 2026-11-07 一条用来让注入非空的稳定自述。' + NL, 'utf8')

const { apply, currentAuthToken } = await import('../lib/index.js')
const HOST = '127.0.0.1:56645'
let handler = null
let injectionDef = null

const ctx = {
  logger: { info() {} },
  on() {},
  agents: { currentInitiator: () => null },
  systemPrompt: { context(def) { injectionDef = def; return () => {} } },
  tools: { register() { return () => {} } },
  webServer: {
    register(route) {
      assert.equal(route.kind, 'prefix')
      assert.equal(route.path, '/api/selfnote')
      handler = route.handler
      return () => {}
    },
  },
}
apply(ctx, {})

function call(method, url) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = { 'x-selfnote': currentAuthToken(), host: HOST }
    const res = {
      status: 0,
      payload: null,
      writeHead(status) { this.status = status },
      end(text) { this.payload = JSON.parse(text); resolve(this) },
    }
    handler(req, res).catch(reject)
    req.emit('end')
  })
}
const stateOfNow = async () => (await call('GET', '/api/selfnote/state')).payload

/* 1. 全新目录：/state 预览不计数 */
let st = await stateOfNow()
assert.equal(st.injectionCount, 0, '预览不是真注入，不许计数')
assert.equal(st.lastInjectedAt, '', '从没注入过就是空串')
console.log('1. 预览不计数')

/* 2. 真注入一次 */
const firstText = injectionDef.text()
assert.ok(firstText !== '', '夹具要能产出非空注入文本')
st = await stateOfNow()
assert.equal(st.injectionCount, 1, '文本真返回给模型才算一次')
assert.ok(Number.isFinite(Date.parse(st.lastInjectedAt)), 'lastInjectedAt 要是能解析的时间')
console.log('2. 真注入一次 → 1')

/* 3. 缓存命中再注入 → 2；heartbeat 仍只有 1（证明没复用它） */
const cachedText = injectionDef.text()
assert.equal(cachedText, firstText, '缓存命中返回同一份文本')
st = await stateOfNow()
assert.equal(st.injectionCount, 2, '缓存命中也算一次真返回')
assert.equal(st.heartbeat.injections, 1, 'beat() 有 60 秒节流且缓存命中不写，绝不能当计数用')
console.log('3. 缓存命中 → 2，heartbeat 仍为 1')

/* 4. disabled / 空串都不计 */
writeConfig(false)
assert.equal(injectionDef.text(), '', '关掉插件就没有注入文本')
st = await stateOfNow()
assert.equal(st.injectionCount, 2, 'disabled 与空串都不计数')
console.log('4. disabled / 空串不计')

/* 5. 读改写保留其它键 */
writeConfig(true)
writeFileSync(stateFile, JSON.stringify({
  indexEnabled: true, injectionCount: 5, lastInjectedAt: '2026-01-01T00:00:00.000Z',
}, null, 2) + NL, 'utf8')
assert.ok(injectionDef.text() !== '')
st = await stateOfNow()
assert.equal(st.injectionCount, 6, '要在已有计数上 +1')
assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).indexEnabled, true, 'state.json 的其它键不许被覆盖掉')
console.log('5. 读改写保留 indexEnabled')

/* 6. state.json 坏了：注入照常、计数不抛、文件被重建 */
writeFileSync(stateFile, 'not-json', 'utf8')
assert.ok(injectionDef.text() !== '', '计数写入失败绝不影响注入返回')
st = await stateOfNow()
assert.equal(typeof st.injectionCount, 'number', '坏文件下 /state 仍要给数字')
const rebuilt = JSON.parse(readFileSync(stateFile, 'utf8'))
assert.equal(typeof rebuilt.injectionCount, 'number', '坏文件要被重建为合法 JSON')
console.log('6. 坏 state.json 不拖垮注入，且被重建')

/* 7. 两个观测口径分开：计数在 /state 顶层，不混进 injection 解释数据 */
assert.ok(!('injectionCount' in st.injection), '计数不许塞进 injection.segments 那一份解释里')
assert.ok(!('lastInjectedAt' in st.injection))
console.log('7. 计数与解释数据分属两处')

rmSync(dir, { recursive: true, force: true })
rmSync(memoryDir, { recursive: true, force: true })
rmSync(sessionsDir, { recursive: true, force: true })
console.log('\n7 项全部通过')
