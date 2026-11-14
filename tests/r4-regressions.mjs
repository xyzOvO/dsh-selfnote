/**
 * 2026-11-14 全部修复回归：日历炸弹、注入预算账、索引异常降级。
 * 跑法：node tests/r4-regressions.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'selfnote-r4-'))
process.env.DSH_SELFNOTE_DIR = root
process.env.DSH_MEMORY_DIR = join(root, 'memory')
process.env.DSH_SESSIONS_DIR = join(root, 'sessions')
process.env.DSH_SELFNOTE_NO_OPEN = '1'
mkdirSync(process.env.DSH_MEMORY_DIR, { recursive: true })
mkdirSync(process.env.DSH_SESSIONS_DIR, { recursive: true })

const store = await import('../lib/store.js')
const memory = await import('../lib/memory.js')
const indexStore = await import('../lib/index-store.js')
const { apply, currentAuthToken } = await import('../lib/index.js')

const HOST = '127.0.0.1:56645'
let handler = null
let injectionDef = null
const toolHold = []
const authHeaders = (extra) => ({ 'x-selfnote': currentAuthToken(), host: HOST, ...(extra ?? {}) })
const ctx = {
  logger: { info() {} },
  on: () => () => {},
  agents: { currentInitiator: () => ({ session: { header: { id: 'r4' } } }) },
  systemPrompt: { context(def) { injectionDef = def; return () => {} } },
  tools: { register(def) { toolHold.push(def); return () => {} } },
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
assert.equal(typeof handler, 'function')
assert.equal(typeof injectionDef?.text, 'function')
assert.equal(toolHold[1].name, 'memory_recall')

function call(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = headers ?? authHeaders()
    const res = {
      status: 0,
      headers: null,
      payload: null,
      writeHead(status, got) { this.status = status; this.headers = got },
      end(text) { this.payload = JSON.parse(text); resolve(this) },
    }
    handler(req, res).catch(reject)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
}

let n = 0
const ok = (label) => { n += 1; console.log(String(n) + '. ' + label) }

/* 1. 时间夹具不能写死日历日期：否则跨日期后热度衰减会把新条目压到旧条目后面 */
const fairText = readFileSync(new URL('./fair.mjs', import.meta.url), 'utf8')
assert.ok(!/2026-11-0[34]T\d{2}:00:00Z/.test(fairText), 'fair.mjs 还留着固定日期，跨日期会复发')
assert.ok(/Date\.now\(\)|new Date\(\)/.test(fairText), 'fair.mjs 要按当前时刻造相对时间夹具')
ok('fair 夹具改为相对时间，跨日期不退化')

/* 2. 手改画像可完整存 240 码点，但注入/预算不能超过 profile 段上限 */
const WHALE = '\u{1F40B}'
const longOverride = 'p'.repeat(239) + WHALE
store.writeConfig({
  enabled: true,
  heading: '',
  maxChars: 1600,
  maxEntries: 40,
  profileEnabled: true,
  personaEnabled: false,
  profileOverride: longOverride,
  profileMaxChars: 120,
  halfLifeDays: 30,
  noteGuide: '',
  tempTtlDays: 14,
})
const savedOverride = JSON.parse(readFileSync(store.configPath(), 'utf8')).profileOverride
assert.equal(savedOverride, longOverride, '240 码点仍要完整落盘，不能用 UTF-16 切坏 emoji')
let r = await call('GET', '/api/selfnote/state')
assert.equal(r.status, 200)
const profileSeg = r.payload.injection.segments.find((seg) => seg.key === 'profile')
assert.ok(profileSeg.chars <= 120, '手改画像注入不能超过 120 码点，实际 ' + profileSeg.chars)
assert.ok(r.payload.budget.profile <= 120, '预算账里的画像段也不能越界')
assert.equal(r.payload.budget.profile, profileSeg.chars, '设置页预算必须等于真注入 profile.chars')
ok('240 码点完整落盘，注入层按 120 码点截断')

/* 3. env 预算账要包含 3 轮门牌收敛，与真注入 segments.env.chars 对上 */
const envRows = Array.from({ length: 20 }, (_, i) => ({
  id: 'env-' + i,
  text: '环境事实第' + i + '条：' + 'x'.repeat(24),
  status: 'approved',
  channel: 'env',
}))
writeFileSync(memory.factsPath(), envRows.map((row) => JSON.stringify(row)).join('\n') + '\n')
r = await call('GET', '/api/selfnote/state')
const envSeg = r.payload.injection.segments.find((seg) => seg.key === 'env')
assert.ok(envSeg.skipped.length > 0, '这组数据本来就该放不下')
assert.match(r.payload.injection.text, /另有 \d+ 条环境备忘/, '真注入里要有门牌')
assert.equal(r.payload.budget.env, envSeg.chars, 'budget.env 要算上门牌收敛后的真实字数')
const budgetSum = ['persona', 'notes', 'profile', 'env', 'facts', 'habits'].reduce((sum, key) => sum + Number(r.payload.budget[key]), 0)
assert.equal(r.payload.budget.total, budgetSum, 'total 必须等于六段之和')
assert.ok(r.payload.budget.total <= r.payload.budget.limit, 'total 不能突破总预算')
ok('env 门牌收敛进预算账，total 与六段之和闭合')

/* 4. 索引坏了不能吞掉线性 recall：应标记降级并仍返回 raw 命中 */
const sessionDir = join(process.env.DSH_SESSIONS_DIR, 'proj', 'session-aaa')
mkdirSync(sessionDir, { recursive: true })
const userMessage = (seq, time, text) => ({
  type: 'user/message',
  seq,
  time,
  data: { content: [{ type: 'text', text }], role: 'user', source: { kind: 'user' } },
})
const sessionFile = join(sessionDir, 'session.v4.jsonl.zstd')
writeFileSync(sessionFile, zstdCompressSync(Buffer.from([
  JSON.stringify(userMessage(1, 1762000000000, '插件安装失败的时候先看日志，不要瞎猜。')),
  JSON.stringify(userMessage(2, 1762000100000, '晕字，你写得太多字了。')),
].join('\n') + '\n', 'utf8')))
const old = new Date(Date.now() - 10 * 60 * 1000)
utimesSync(sessionFile, old, old)
const session = memory.listSessions().find((entry) => entry.id === 'session-aaa')
assert.ok(session, '线性检索要有一个真实会话')
memory.writeState({ ...memory.readState(), indexEnabled: true })
const brokenIndex = {
  v: 3,
  builtAt: new Date().toISOString(),
  sessions: { [session.id]: { mtime: session.mtime - 1000, date: '2026-11-14', size: 1 } },
  records: { broken: true },
  postings: {},
  failed: 0,
  scanned: 1,
}
writeFileSync(indexStore.indexPath(), JSON.stringify(brokenIndex))
const result = await toolHold[1].execute({ query: '插件安装失败', mode: 'raw', limit: 5 })
assert.equal(result.error, undefined, '索引坏掉时不该把整次 recall 变成检索失败：' + String(result.error))
assert.equal(result.indexDegraded, true, '要如实标记索引降级')
assert.match(String(result.indexError ?? ''), /slice/, '保留排障用的索引错误摘要')
assert.ok(result.raw && result.raw.total > 0, '降级后仍要返回线性 raw 命中')
assert.match(JSON.stringify(result.raw.hits), /插件安装失败/, '线性命中要带原文片段')
ok('坏索引触发线性 recall 兜底并如实标降级')

console.log('\n4 项全部通过')
process.exit(0)
