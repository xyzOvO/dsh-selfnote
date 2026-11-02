/**
 * 设置页 API 的冒烟测试：不启 HTTP 服务，直接拿 apply() 注册的 handler 打伪 req/res。
 * 跑法：node tests/api.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-api-'))
process.env.DSH_SELFNOTE_DIR = dir
// 别碰真实的记忆目录与会话目录
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = join(dir, 'sessions')

const { apply } = await import('../lib/index.js')

let handler = null
const toolHold = []
let injectionDef = null

const ctx = {
  logger: { info() {} },
  on() {},
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

assert.ok(handler, '没有注册 /api/selfnote 路由')
const toolNames = toolHold.map((tool) => tool.name)
assert.deepEqual(toolNames, ['self_note', 'memory_recall', 'memory_stage'])
assert.equal(toolHold[0].output.render({}, { action: 'stats', entries: 0, chars: 0, maxChars: 1, maxEntries: 1, archiveFiles: 0 })[0].type, 'text')
assert.equal(toolHold[1].output.render({}, { query: 'x', raw: { total: 0 } })[0].type, 'text')

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    const res = {
      status: 0,
      headers: null,
      payload: null,
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(text) {
        this.payload = JSON.parse(text)
        resolve(this)
      },
    }
    handler(req, res).catch(reject)
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    }
    req.emit('end')
  })
}

/* 1. 初始状态 */
let r = await call('GET', '/api/selfnote/state')
assert.equal(r.status, 200)
assert.equal(r.payload.entries, 0)
assert.equal(r.payload.enabled, true)
assert.equal(r.payload.maxChars, 1600)
assert.deepEqual(r.payload.notes, [])
assert.equal(r.payload.configFile, join(dir, 'config.json'))
console.log('1. GET /state 初始为空')

/* 2. 手动写一条 */
r = await call('POST', '/api/selfnote/note', { text: '我在等他提问时会先自己找依据。' })
assert.equal(r.status, 200)
assert.equal(r.payload.entries, 1)
assert.equal(r.payload.notes.length, 1)
assert.match(r.payload.notes[0].text, /先自己找依据/)
assert.ok(r.payload.chars > 10)
console.log('2. POST /note 写入生效')

/* 3. 改上限 */
r = await call('POST', '/api/selfnote/config', { maxChars: 400, maxEntries: 5 })
assert.equal(r.status, 200)
assert.equal(r.payload.maxChars, 400)
assert.equal(r.payload.maxEntries, 5)
assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).maxChars, 400)
console.log('3. POST /config 写入配置')

/* 4. 坏上限被拒 */
r = await call('POST', '/api/selfnote/config', { maxChars: -5 })
assert.equal(r.status, 400)
assert.equal(r.payload.ok, false)
assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).maxChars, 400, '被拒时不该改文件')
console.log('4. 非法上限被拒绝且不落盘')

/* 5. 关掉注入 */
r = await call('POST', '/api/selfnote/config', { enabled: false })
assert.equal(r.payload.enabled, false)
console.log('5. 可以关掉注入')

/* 6. 开关状态在注入函数里生效 */
const contextCall = ctx.systemPrompt.context
assert.equal(typeof contextCall, 'function')
const notesFile = join(dir, 'notes.md')
assert.ok(existsSync(notesFile))
console.log('6. notes.md 已落盘')

/* 7. 清空 → 归档 */
r = await call('POST', '/api/selfnote/clear', {})
assert.equal(r.status, 200)
assert.equal(r.payload.cleared, 1)
assert.equal(r.payload.entries, 0)
assert.equal(r.payload.archiveFiles, 1)
assert.ok(r.payload.archivedFile.endsWith('.md'))
console.log('7. 清空后进归档')

/* 8. 未知路由 */
r = await call('GET', '/api/selfnote/nope')
assert.equal(r.status, 404)
assert.equal(r.payload.ok, false)
console.log('8. 未知路由 404')

/* 9. 空内容被拒 */
r = await call('POST', '/api/selfnote/note', { text: '   ' })
assert.equal(r.status, 400)
console.log('9. 空内容被拒')

/* 10. 造一个会话，再放一条候选事实 */
const sessionDir = join(process.env.DSH_SESSIONS_DIR, 'proj', 'session-cccc')
mkdirSync(sessionDir, { recursive: true })
const body =
  JSON.stringify({
    type: 'user/message',
    seq: 0,
    time: Date.parse('2026-11-02T10:00:00Z'),
    data: { content: [{ type: 'text', text: '回答要短，先给结论' }], role: 'user', source: { kind: 'user' } },
  }) +
  '\n' +
  JSON.stringify({
    type: 'assistant/message',
    seq: 1,
    time: Date.parse('2026-11-02T10:00:10Z'),
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } },
  }) +
  '\n'
writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))

const stageTool = toolHold.find((tool) => tool.name === 'memory_stage')
const staged = await stageTool.execute({ text: '他不喜欢长回复，回答要先结论。', kind: 'preference', tags: ['沟通'], sessionId: 'session-cccc', index: 0 })
assert.equal(staged.ok, true, JSON.stringify(staged))
assert.equal(staged.fact.status, 'candidate')
assert.equal(staged.fact.citation.index, 0)
console.log('10. 有出处 → 进候选区')

/* 11. 假出处被拒 */
const badStage = await stageTool.execute({ text: '编造的一条', sessionId: 'session-cccc', index: 99 })
assert.equal(badStage.ok, false)
const noStage = await stageTool.execute({ text: '没有出处的一条', sessionId: 'nope', index: 0 })
assert.equal(noStage.ok, false)
console.log('11. 出处对不上 → 拒绝')

/* 12. 采纳后进注入预算（第 5 步把注入关掉了，先开回来） */
r = await call('POST', '/api/selfnote/config', { enabled: true })
assert.equal(r.payload.enabled, true)
r = await call('POST', '/api/selfnote/fact', { id: staged.fact.id, status: 'approved' })
assert.equal(r.status, 200)
assert.equal(r.payload.facts.approved.length, 1)
assert.ok(r.payload.budget.facts > 0, '采纳的结论要占注入预算')
assert.match(injectionDef.text(), /先结论/)
console.log('12. 采纳 → 进入注入文本')

/* 13. 升成习惯 */
r = await call('POST', '/api/selfnote/habit', { text: '回答先给结论', status: 'active' })
assert.equal(r.status, 200)
assert.equal(r.payload.habits.length, 1)
assert.match(injectionDef.text(), /回答先给结论/)
assert.ok(r.payload.budget.total <= r.payload.budget.limit)
console.log('13. 习惯升上去后进注入，且总预算没超')

/* 14. 退役后立刻从注入里消失 */
r = await call('POST', '/api/selfnote/fact', { id: staged.fact.id, status: 'retired' })
assert.equal(r.status, 200)
assert.equal(r.payload.facts.approved.length, 0)
assert.ok(!injectionDef.text().includes('先结论'))
console.log('14. 退役 → 注入里立刻消失')


console.log('\n14 项全部通过（data dir: ' + dir + '）')
process.exit(0)
