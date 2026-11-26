/**
 * 设置页 API 的冒烟测试：不启 HTTP 服务，直接拿 apply() 注册的 handler 打伪 req/res。
 * 跑法：node tests/api.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-api-'))
process.env.DSH_SELFNOTE_DIR = dir
// 别碰真实的记忆目录与会话目录
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = join(dir, 'sessions')
// 测试里不要去弹真实的资源管理器窗口
process.env.DSH_SELFNOTE_NO_OPEN = '1'

const { apply, currentAuthToken } = await import('../lib/index.js')
const HOST = '127.0.0.1:56645'
/** 准入头要等 apply() 跑完才拿得到真实 token，所以取头是惰性的。extra 后展开，好让用例覆盖它。 */
function authHeaders(extra) {
  return { 'x-selfnote': currentAuthToken(), host: HOST, ...extra }
}

let handler = null
const toolHold = []
let injectionDef = null
// 驱动循环整个生命周期都在 withInitiator(agent) 里，所以注入时要能问出「当前是哪个 agent」
let currentAgent = null

const warnLog = []
const ctx = {
  logger: { info() {}, warn(message) { warnLog.push(String(message)) } },
  on() {},
  agents: { currentInitiator: () => currentAgent },
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
assert.deepEqual(toolNames, ['self_note', 'memory_recall', 'memory_stage', 'memory_search', 'memory_write', 'selfnote_review', 'selfnote_extract'])
assert.equal(toolHold[0].output.render({}, { action: 'stats', entries: 0, chars: 0, maxChars: 1, maxEntries: 1, archiveFiles: 0 })[0].type, 'text')
// 批2-1：self_note schema 要声明 corrections 翻页实际读取的 cursor/limit
assert.equal(toolHold[0].parameters.properties.cursor.type, 'string')
assert.match(toolHold[0].parameters.properties.cursor.description, /corrections/)
assert.equal(toolHold[0].parameters.properties.limit.type, 'number')
assert.match(toolHold[0].parameters.properties.limit.description, /corrections/)
// 批2 复审：episodes.status 的合法值要在 schema 里写明，别让非法值静默回落还没提示
assert.deepEqual(toolHold[6].parameters.properties.episodes.items.properties.status.enum, ['open', 'closed', 'archived'])
assert.equal(toolHold[1].output.render({}, { query: 'x', raw: { total: 0 } })[0].type, 'text')

function call(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    // 默认带上准入头（含回环 Host），专门测鉴权的用例再自己覆盖
    req.headers = headers ?? authHeaders()
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

/* 7b. 清空要在 auth.log 留痕 —— 事后能答「那会儿到底清了什么」 */
const auditFile = join(dir, 'auth.log')
assert.ok(existsSync(auditFile), '成功清空也要写 auth.log')
const auditLines = readFileSync(auditFile, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const clearLine = auditLines.filter((item) => item.action === 'clear').pop()
assert.ok(clearLine, 'auth.log 里应有 action=clear 的记录')
assert.equal(clearLine.cleared, 1)
assert.ok(clearLine.archived && clearLine.archived.endsWith('.md'))
assert.equal(typeof clearLine.at, 'string')
console.log('7b. 清空在 auth.log 留痕')

/* 7c. doctor 不能把这条成功记录当成「拒绝」 */
assert.equal(
  auditLines.filter((item) => typeof item.reason === 'string').length,
  0,
  '成功操作的记录不该带 reason 字段',
)
console.log('7c. 成功记录不污染拒绝统计')

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

/* 11b. execute 内部抛错时要把错误交回模型，而不是把堆栈甩出去 */
const throwing = await stageTool.execute({
  get text() {
    throw new Error('读取参数时炸了')
  },
})
assert.match(String(throwing?.error ?? ''), /提交失败：读取参数时炸了/)
console.log('11b. execute 抛错 → 收成 error 字段，不冒泡')

/* 12. 采纳后进注入预算（第 5 步把注入关掉了，先开回来） */
r = await call('POST', '/api/selfnote/config', { enabled: true })
assert.equal(r.payload.enabled, true)
r = await call('POST', '/api/selfnote/fact', { id: staged.fact.id, status: 'approved' })
assert.equal(r.status, 200)
assert.equal(r.payload.facts.approved.length, 1)
assert.ok(r.payload.budget.facts + r.payload.budget.profile > 0, '采纳的内容要占注入预算（画像或结论段）')
assert.match(injectionDef.text(), /先结论/)
console.log('12. 采纳 → 进入注入文本')

/* 13. 升成习惯 */
r = await call('POST', '/api/selfnote/habit', { text: '回答先给结论', status: 'active' })
assert.equal(r.status, 200)
assert.equal(r.payload.habits.length, 1)
assert.match(injectionDef.text(), /回答先给结论/)
assert.ok(r.payload.budget.total <= r.payload.budget.limit)
// 撤销：以前设置页只给了「升成习惯」，升上去就下不来，界面里也看不见它
r = await call('POST', '/api/selfnote/habit', { text: '回答先给结论', status: 'retired' })
assert.equal(r.status, 200, JSON.stringify(r.payload))
assert.equal(r.payload.habits.length, 0, '撤销后不再是习惯')
assert.equal(injectionDef.text().includes('· 回答先给结论'), false, '撤销后要从注入的习惯段消失')
r = await call('POST', '/api/selfnote/habit', { text: '回答先给结论', status: 'active' })
assert.equal(r.payload.habits.length, 1, '还能再升回来')
console.log('13. 习惯升上去进注入、能撤销、能再升回来')

/* 14. 退役后立刻从注入里消失 */
r = await call('POST', '/api/selfnote/fact', { id: staged.fact.id, status: 'retired' })
assert.equal(r.status, 200)
assert.equal(r.payload.facts.approved.length, 0)
assert.ok(!injectionDef.text().includes('先结论'))
console.log('14. 退役 → 注入里立刻消失')

/* 15. 审核留痕：改状态要记下谁、从哪、从什么变成什么 */
const factsFile = join(dir, 'memory', 'facts.jsonl')
writeFileSync(factsFile, JSON.stringify({ id: 'audit1', text: '以后回答先给结论', status: 'candidate', evidence: [] }) + '\n')
r = await call('POST', '/api/selfnote/fact', { id: 'audit1', status: 'approved' })
assert.equal(r.status, 200)
const after = JSON.parse(readFileSync(factsFile, 'utf8').trim())
assert.equal(after.status, 'approved')
assert.equal(after.reviewedAt !== undefined, true, '要记审核时间')
assert.equal(after.history.length, 1)
assert.equal(after.history[0].to, 'approved')
assert.equal(after.history[0].from, 'candidate')
assert.equal(after.history[0].via, 'settings')
console.log('15. 采纳/退役留痕：时间、来源、前后状态')

/* 16. 没有准入头 → 403：别的网页不能直接读你全部记忆 */
r = await call('GET', '/api/selfnote/state', undefined, {})
assert.equal(r.status, 403)
assert.equal(r.payload.ok, false)
r = await call('POST', '/api/selfnote/fact', { id: 'audit1', status: 'retired' }, {})
assert.equal(r.status, 403)
assert.equal(JSON.parse(readFileSync(factsFile, 'utf8').trim()).status, 'approved', '被拒的写请求不该落盘')
console.log('16. 没有 x-selfnote 头 → 403，且不落盘')

/* 17. 跨站 Origin → 403，同源 → 放行；固定口令不再有效 */
r = await call('GET', '/api/selfnote/state', undefined, authHeaders({ origin: 'http://evil.example' }))
assert.equal(r.status, 403)
r = await call('GET', '/api/selfnote/state', undefined, authHeaders({ origin: `http://${HOST}` }))
assert.equal(r.status, 200)
r = await call('GET', '/api/selfnote/state', undefined, authHeaders({ 'x-selfnote': '1' }))
assert.equal(r.status, 403, 'README 里那个固定值不该再能进门')
console.log('17. 跨站 Origin / 固定口令 → 403，真实 token + 同源 → 200')

/* 18. 一条超长条目不该把整段预算挤空 */
await call('POST', '/api/selfnote/note', { text: '长'.repeat(400) })
await call('POST', '/api/selfnote/note', { text: '短的一条要留下' })
assert.match(injectionDef.text(), /短的一条要留下/)
assert.equal(injectionDef.text().includes('长'.repeat(20)), false, '放不进预算的条目要跳过，不是把后面的一起丢掉')
console.log('18. 超长条目不再把整段挤空')

/* 19. /state 带文件清单：只列和 AI 记忆有关的，带条数与字节 */
r = await call('GET', '/api/selfnote/state')
const files = r.payload.files
assert.equal(Array.isArray(files), true)
assert.deepEqual(files.map((item) => item.key), ['persona', 'notes', 'facts', 'habits', 'config', 'cursor', 'index', 'archive'], '人格文件也要能在这里看见、点开')
for (const item of files) {
  assert.equal(typeof item.label, 'string')
  assert.equal(typeof item.path, 'string')
  assert.equal(typeof item.count, 'string', item.key + ' 要给出可视化的条数说明')
  assert.equal(typeof item.bytes, 'number')
}
const notesRow = files.find((item) => item.key === 'notes')
assert.equal(notesRow.exists, true)
assert.ok(notesRow.bytes > 0)
assert.match(notesRow.path, /notes\.md$/)
console.log('19. 文件清单：7 项、带条数/字节/路径')

/* 20. 打开未知文件 → 400 */
r = await call('POST', '/api/selfnote/open', { key: 'nope' })
assert.equal(r.status, 400)
assert.equal(r.payload.ok, false)
console.log('20. 未知文件 key → 400')

/* 21. 打开已知文件 → 交给宿主（DSH_SELFNOTE_NO_OPEN 挡住真正的 explorer） */
r = await call('POST', '/api/selfnote/open', { key: 'notes' })
assert.equal(r.status, 200)
assert.equal(r.payload.ok, true)
assert.equal(r.payload.dryRun, true)
assert.match(r.payload.opened, /notes\.md$/)
console.log('21. 打开文件走宿主，测试里不 spawn')

/* 22. 索引卡片要用的数字：已索引 / 磁盘 / 待同步 */
r = await call('GET', '/api/selfnote/state')
assert.equal(typeof r.payload.index.disk, 'number', '要能算出磁盘上一共几个会话')
assert.ok(r.payload.index.disk >= 1, '测试里造过会话，磁盘会话数不该是 0')
assert.equal(typeof r.payload.index.missing, 'number', '要给出待同步会话数')
assert.equal(typeof r.payload.index.sessions, 'number')
console.log('22. 索引状态带磁盘会话与待同步数')

/* 23. 重建：跑完要用 freshness() 再验收一次，成功才报成功 */
r = await call('POST', '/api/selfnote/index', { action: 'build' })
assert.equal(r.status, 200)
assert.equal(r.payload.ok, true, String(r.payload.error ?? ''))
assert.equal(r.payload.verified.fresh, true, '重建完必须是 fresh，否则就等于没修好')
assert.ok(r.payload.verified.records >= 1, '造过会话，索引里至少要有记录')
assert.equal(r.payload.index.fresh, true)
console.log('23. 重建索引 → 用 freshness 验收通过')

/* 24. 有会话解不开时，重建不许把「跑完了」说成「修好了」 */
const badDir = join(process.env.DSH_SESSIONS_DIR, 'proj', 'session-bad')
mkdirSync(badDir, { recursive: true })
writeFileSync(join(badDir, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame at all', 'utf8'))
r = await call('POST', '/api/selfnote/index', { action: 'build' })
assert.equal(r.status, 200)
assert.equal(r.payload.ok, false, '解不开的会话没进索引，不能报成功')
assert.equal(r.payload.verified.fresh, true, '文件在、只是解不开：覆盖是齐的，但内容没进去')
assert.ok(r.payload.verified.failed >= 1, '解不开的会话要计入 failed')
assert.match(String(r.payload.error), /解不开/)
console.log('24. 有会话解不开时报失败，不伪装成功')

/* 25. 注入快照：四段结构、字数与原文对得上（设置页「注入」页照镜子用） */
r = await call('GET', '/api/selfnote/state')
const inj = r.payload.injection
assert.ok(inj && typeof inj === 'object', 'state 里要有 injection')
assert.equal(inj.limit, 1320)
assert.deepEqual(inj.segments.map((seg) => seg.key), ['persona', 'notes', 'preset', 'guide', 'profile', 'env', 'topic', 'facts', 'habits'])
assert.deepEqual(inj.segments.map((seg) => seg.label), ['人格', '自述', '协作默认', '写自述的时机', '画像', '环境', '话题', '结论', '习惯'])
assert.equal(inj.chars, inj.text.length, '字数要等于原文长度，别各算各的')
const segSum = inj.segments.reduce((n, seg) => n + seg.chars, 0)
assert.equal(segSum + inj.overhead, inj.chars, '四段字数 + 框架文字（标题/边界句/画像抬头）= 总字数')
assert.ok(
  inj.segments.every((seg) => Array.isArray(seg.kept) && Array.isArray(seg.skipped)),
  '每段都要给出进了什么、挤掉什么',
)
// 抬头是纯框架文字，不承载任何记忆。它要是长回去（曾经 92 字，占掉 20% 预算），这条会先响
assert.ok(inj.overhead <= 40, '抬头要短，实测 ' + inj.overhead + ' 字')
console.log('25. 注入快照：五段结构、字数与原文一致，抬头 ' + inj.overhead + ' 字')

/* 26. 体检：六项都要有明确结论，不许只说「看起来正常」 */
r = await call('GET', '/api/selfnote/doctor')
assert.equal(r.status, 200)
const doc = r.payload
assert.equal(typeof doc.ok, 'boolean')
assert.ok(['ok', 'warn', 'error'].includes(doc.level), '整体要有分级')
for (const key of ['index', 'capture', 'facts', 'notes', 'auth', 'beat']) {
  const check = doc.checks.find((item) => item.key === key)
  assert.ok(check, '缺了 ' + key + ' 这项')
  assert.ok(['ok', 'warn', 'error'].includes(check.level), key + ' 要有分级')
  assert.ok(String(check.detail).length > 0, key + ' 要写清为什么')
  assert.ok(!String(check.detail).includes('undefined'), key + ' 的结论里不能出现 undefined')
}
/* 自述的上限是配置项，不在 stats() 里 —— 直接拿 stats().maxChars 会得到 undefined，
   界面上就成了「（上限 undefined）」，等于什么都没说 */
assert.match(doc.checks.find((item) => item.key === 'notes').detail, /上限 \d+/, '自述这项要给出真实上限')
/* 塞一行坏 JSON，体检必须报出来 —— 这条记忆读不到，而且平时是静默的 */
writeFileSync(factsFile, readFileSync(factsFile, 'utf8') + '{"id":"broken",\n')
r = await call('GET', '/api/selfnote/doctor')
assert.equal(r.payload.level, 'error', '有坏行就要报 error')
assert.match(r.payload.checks.find((item) => item.key === 'facts').detail, /解析不出来/)
/* 六项检查里人只会动第一条 —— 所以要给出「先做这一件」，而且必须是真有问题的那条 */
assert.ok(r.payload.next, '有问题时要给出先做哪一件')
assert.equal(r.payload.next.key, 'facts', '数据完整性排最前：文件坏了别的都白搭')
assert.ok(String(r.payload.next.detail).length > 0)
console.log('26. 体检：六项各有判据，坏行会被抓出来，并给出先做哪一件')

/* 27. 心跳：注入真的跑过才写。只读不写的状态文件等于没有状态 */
injectionDef.text()
r = await call('GET', '/api/selfnote/state')
assert.equal(r.payload.heartbeat.present, true, '注入跑过就该有心跳')
assert.ok(r.payload.heartbeat.injections >= 1)
assert.ok(r.payload.warm && typeof r.payload.warm.total === 'number', 'state 里要有温层统计')
console.log('27. 心跳：注入一次就落一次盘')

/* 28. 注入归属：进过几次、上次什么时候、哪些三十天没碰过 */
{
  const stamp = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString()
  const attrRows = [
    { id: 'attr-live', text: '今天还在用的一条', status: 'approved', channel: 'rel', hitCount: 4, lastHit: stamp(1) },
    { id: 'attr-stale', text: '四十天没进过的一条', status: 'approved', channel: 'rel', hitCount: 9, lastHit: stamp(40) },
    { id: 'attr-never', text: '采纳了却从没进过的一条', status: 'approved', channel: 'env', hitCount: 0 },
    { id: 'attr-searched', text: '没进过注入但被搜到过的一条', status: 'approved', channel: 'rel', hitCount: 0, seenCount: 3, lastSeen: stamp(2) },
    { id: 'attr-cand', text: '还是候选', status: 'candidate', hitCount: 0 },
  ]
  writeFileSync(factsFile, attrRows.map((row) => JSON.stringify(row)).join('\n') + '\n')

  r = await call('GET', '/api/selfnote/state')
  assert.equal(r.status, 200)
  const attr = r.payload.attribution
  assert.ok(attr, 'state 里要有归属统计')
  assert.equal(attr.total, 4, '只统计已采纳的，候选不算')
  const byId = Object.fromEntries(attr.rows.map((row) => [row.id, row]))
  assert.equal(byId['attr-live'].state, 'live')
  assert.equal(byId['attr-stale'].state, 'stale', '超过 30 天没进注入就是 stale')
  assert.equal(byId['attr-never'].state, 'never', '采纳了但 hitCount 是 0，要标出来')
  assert.equal(byId['attr-never'].lastHit, null)
  assert.equal(byId['attr-stale'].hits, 9)
  assert.ok(byId['attr-stale'].days >= 39, '要能算出多少天前')
  assert.equal(byId['attr-searched'].state, 'searched', '被搜到过的不该被说成从没进过')
  assert.equal(byId['attr-searched'].seen, 3)
  assert.ok(byId['attr-searched'].seenDays >= 1, '要能算出多少天前搜到')
  assert.deepEqual([attr.live, attr.stale, attr.searched, attr.never], [1, 1, 1, 1], '四个计数要和行对上')
  assert.equal(attr.rows[0].state, 'stale', '没在用的排前面，方便清理')
  console.log('28. 注入归属：在用 / 静默 / 只搜到过 / 从没进过 四种状态都算对')
}

/* 29. 环境门牌句要报真数：门牌自己占字，加进去后可能又多挤掉几条 */
{
  const envRows = Array.from({ length: 20 }, (_, i) => ({
    id: 'env-' + i,
    text: '环境事实第' + i + '条：' + 'x'.repeat(24),
    status: 'approved',
    channel: 'env',
  }))
  writeFileSync(factsFile, envRows.map((row) => JSON.stringify(row)).join('\n') + '\n')

  r = await call('GET', '/api/selfnote/state')
  const envSeg = r.payload.injection.segments.find((seg) => seg.key === 'env')
  const pointed = r.payload.injection.text.match(/另有 (\d+) 条环境备忘/)
  assert.ok(pointed, '放不下时要留一句门牌，别假装没有')
  assert.ok(envSeg.skipped.length > 0, '这组数据本来就该放不下')
  assert.equal(Number(pointed[1]), envSeg.skipped.length, '门牌上写的条数要等于实际被挤掉的条数')
  console.log('29. 环境门牌：另有 N 条里的 N 是真数')
}

/* 30. 自定义「写自述的时机」：进注入、能改回空、超长拒绝；上次写入时间要能读 */
{
  r = await call('POST', '/api/selfnote/config', { noteGuide: '每次验收完写一条' })
  assert.equal(r.status, 200)
  assert.equal(r.payload.noteGuide, '每次验收完写一条')

  r = await call('GET', '/api/selfnote/state')
  const guideSeg = r.payload.injection.segments.find((seg) => seg.key === 'guide')
  assert.ok(guideSeg, '注入快照里要有这一段')
  assert.equal(guideSeg.chars, '每次验收完写一条'.length)
  assert.match(r.payload.injection.text, /写自述的时机：每次验收完写一条/, '自定义引导要真的进注入')
  assert.equal(r.payload.noteGuide, '每次验收完写一条', 'state 要回显当前引导')

  // 超长直接拒，不能悄悄截断
  r = await call('POST', '/api/selfnote/config', { noteGuide: '很'.repeat(81) })
  assert.equal(r.status, 400)

  // 清空 = 回到默认判据：注入里不再有这一行
  r = await call('POST', '/api/selfnote/config', { noteGuide: '' })
  assert.equal(r.status, 200)
  r = await call('GET', '/api/selfnote/state')
  assert.equal(r.payload.injection.text.indexOf('写自述的时机：'), -1, '清空后不该再出现这一行')

  // 上次写入时间：写一条就从「还没写过」变成具体时刻
  await call('POST', '/api/selfnote/note', { text: '测试：写一条看时间' })
  r = await call('GET', '/api/selfnote/state')
  assert.equal(typeof r.payload.notesLastWrite, 'string', '写过之后要有上次写入时间')
  assert.ok(Number.isFinite(Date.parse(r.payload.notesLastWrite)), '要是个能解析的时间')
  console.log('30. 写自述的时机：能改、能清空、超长拒绝；上次写入时间读得到')
}

/* 31. 温层检索命中事实要留痕：搜到过 ≠ 从没使用，但也不许冒充「进了注入」 */
{
  const stamp = new Date().toISOString()
  writeFileSync(
    factsFile,
    JSON.stringify({ id: 'seen-1', text: '温层检索能翻到的一条环境事实', status: 'approved', channel: 'env', hitCount: 0 }) + '\n',
  )
  const searchTool = toolHold.find((tool) => tool.name === 'memory_search')
  assert.ok(searchTool, '要有 memory_search 工具')
  const hits = await searchTool.execute({ query: '温层检索' })
  assert.equal(hits.total, 1, '这条事实应该被搜到')
  const after = JSON.parse(readFileSync(factsFile, 'utf8').trim())
  assert.equal(after.seenCount, 1, '搜到一次就要记一次')
  assert.equal(after.hitCount ?? 0, 0, '搜到不等于进了注入，热度不许动')
  assert.ok(Date.parse(after.lastSeen) >= Date.parse(stamp) - 1000, '要记下搜到的时间')

  r = await call('GET', '/api/selfnote/state')
  const seenRow = r.payload.attribution.rows.find((row) => row.id === 'seen-1')
  assert.equal(seenRow.state, 'searched', '归属里要显示成「只搜到过」，不是「从没进过」')
  assert.ok(seenRow.seen >= 1)

  // 十分钟内重复搜同一条不重复计数（一次翻找算一次）
  await searchTool.execute({ query: '温层检索' })
  const twice = JSON.parse(readFileSync(factsFile, 'utf8').trim())
  assert.equal(twice.seenCount, 1, '十分钟内重复搜不算第二次')
  console.log('31. 检索留痕：搜到记 seenCount，不动热度，十分钟内不重复计')
}

/* 32. 委派会话（子代理）不注入：去干活不是接着聊，460 字既是白烧 token，也会污染候选 */
{
  writeFileSync(factsFile, JSON.stringify({ id: 'inj-1', text: '主线会话才有的一条记忆', status: 'approved', channel: 'rel' }) + '\n')
  currentAgent = null
  const normal = injectionDef.text()
  assert.ok(normal.includes('主线会话才有的一条记忆'), '拿不到 agent 时按「不是委派」处理，宁可多注入')

  currentAgent = { session: { header: { origin: 'main' } } }
  assert.ok(injectionDef.text().includes('主线会话才有的一条记忆'), '主线会话照常注入')

  currentAgent = { session: { header: { origin: 'subagent', delegationDepth: 1 } } }
  assert.equal(injectionDef.text(), '', '子代理会话不注入')

  // 分叉会话仍是本人（不按 parentSession 判断）
  currentAgent = { session: { header: { origin: 'main', parentSession: 'session-x' } } }
  assert.ok(injectionDef.text().includes('主线会话才有的一条记忆'), '分叉会话照常注入')

  r = await call('GET', '/api/selfnote/state')
  assert.ok(r.payload.injection.delegatedSkips >= 1, '跳过次数要能在设置页看到，不能只是「应该跳了」')
  currentAgent = null
  console.log('32. 委派会话不注入：子代理跳过并计数，主线与分叉照常')
}

/* 33. 体检别喊狼来了：脚本探测被拒是设计如此，页面被拒才是毛病 */
{
  const now = new Date().toISOString()
  const line = (obj) => JSON.stringify({ at: now, ...obj })
  writeFileSync(
    join(dir, 'auth.log'),
    [
      // 旧版本留下的空凭据头：现在空头等于没带，直接放行，不该算拒绝
      line({ reason: 'token-length:0', host: '127.0.0.1:1234', origin: null, ua: 'curl/8.22.0', tokenLen: 0, url: '/api/selfnote/state' }),
      // 我自己的负向测试：脚本拿错凭据被挡，页面不受影响
      line({ reason: 'token-length:1', host: '127.0.0.1:1234', origin: null, ua: 'node', tokenLen: 1, url: '/api/selfnote/state' }),
    ].join('\n') + '\n',
  )

  r = await call('GET', '/api/selfnote/doctor')
  let auth = r.payload.checks.find((item) => item.key === 'auth')
  assert.equal(auth.level, 'ok', '只有脚本探测被拒时不该报警')
  assert.match(auth.detail, /脚本探测/, '要说清那是脚本，不是设置页')
  assert.equal(r.payload.next === null || !r.payload.next.key.startsWith('auth'), true, '这种记录也不该进「先做这一件」')

  // 浏览器页面被拒 → 这才该响，而且要说清原因与时间
  writeFileSync(
    join(dir, 'auth.log'),
    line({
      reason: 'token-mismatch',
      host: '127.0.0.1:1234',
      origin: 'http://127.0.0.1:1234',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
      tokenLen: 32,
      url: '/api/selfnote/state',
    }) + '\n',
  )
  r = await call('GET', '/api/selfnote/doctor')
  auth = r.payload.checks.find((item) => item.key === 'auth')
  assert.equal(auth.level, 'warn', '页面被拒要报 warn')
  assert.match(auth.detail, /设置页被拒了 1 次/)
  assert.match(auth.detail, /凭据不匹配/, '要把 reason 翻成人话，别让人猜 token-mismatch')
  console.log('33. 设置页准入：脚本探测不算报警，页面被拒才响，且说得清原因')
}

/* 34. 导出 / 导入：导出能带走，导入不覆盖、默认降级 */
{
  r = await call('GET', '/api/selfnote/export')
  assert.equal(r.status, 200)
  assert.equal(r.payload.app, 'dsh-selfnote')
  assert.equal(r.payload.v, 2, '带人格的导出是 v2')
  assert.equal(Array.isArray(r.payload.facts), true)
  assert.equal(Array.isArray(r.payload.notes), true)
  assert.equal(r.payload.config.halfLifeDays, 30)
  const before = r.payload.counts.facts

  // 造一份：一条同文本（该跳过）、一条新的 approved（默认该降成候选）、一条没 id（该算无效）
  const existingText = r.payload.facts[0].text
  const incoming = {
    app: 'dsh-selfnote',
    v: 1,
    facts: [
      { id: 'imp-1', text: existingText, status: 'approved' },
      { id: 'imp-2', text: '导入进来的一条：以后先给结论', status: 'approved', source: 'other-machine#7' },
      { id: '', text: '没有 id' },
    ],
    notes: [{ date: '2026-11-04', text: '从另一台机器带来的自述' }],
    habits: [{ text: '导入的习惯', status: 'active' }],
  }
  r = await call('POST', '/api/selfnote/import', { bundle: incoming })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.import.added.facts, 1, '只该进 imp-2')
  assert.equal(r.payload.import.skipped.facts, 1, '同文本跳过')
  assert.equal(r.payload.import.skipped.invalid, 1)
  assert.equal(r.payload.import.demoted, 1, '默认把 approved 降成候选')
  assert.equal(r.payload.import.added.notes, 1)
  assert.equal(r.payload.import.added.habits, 1)
  assert.equal(r.payload.import.indexStale, true, '导入后索引一定过期，要提示重建')

  const imported = r.payload.facts.candidates.find((fact) => fact.id === 'imp-2')
  assert.ok(imported, '导入的条目应当出现在候选里')
  assert.equal(imported.status, 'candidate')
  assert.equal(imported.importedFrom, 'other-machine#7')
  assert.equal(r.payload.facts.approved.length + r.payload.facts.candidates.length + r.payload.facts.retired.length, before + 1)

  // 勾了「保留原状态」才原样搬
  const kept = {
    app: 'dsh-selfnote',
    v: 1,
    facts: [{ id: 'imp-3', text: '这条要保留已采纳状态', status: 'approved' }],
  }
  r = await call('POST', '/api/selfnote/import', { bundle: kept, keepStatus: true })
  assert.equal(r.payload.import.demoted, 0)
  assert.ok(r.payload.facts.approved.some((fact) => fact.id === 'imp-3'), '勾了就该是已采纳')

  // 坏文件：直接 400，别合并一半
  const countBefore = r.payload.facts.approved.length + r.payload.facts.candidates.length + r.payload.facts.retired.length
  r = await call('POST', '/api/selfnote/import', { bundle: { app: 'other', v: 1, facts: [] } })
  assert.equal(r.status, 400)
  assert.match(r.payload.error, /不是本插件导出的/)
  r = await call('GET', '/api/selfnote/state')
  assert.equal(r.payload.facts.approved.length + r.payload.facts.candidates.length + r.payload.facts.retired.length, countBefore, '被拒的导入不该落盘')
  console.log('34. 导出 / 导入：不覆盖、默认降级、勾了才保留状态、坏文件 400 且不落盘')
}

/* 35. 改一条 / 删一条：注入里那句话能改，不用整份清空重写 */
{
  r = await call('GET', '/api/selfnote/state')
  const before35 = r.payload.notes
  assert.ok(before35.length >= 2, '前面该已经写过几条，才谈得上改')
  const at = before35.length - 1
  const oldText = before35[at].text
  const injBefore = injectionDef.text()
  assert.ok(injBefore.includes(oldText.slice(0, 6)), '改之前，旧的那句该在真实注入里（走缓存那条路）')

  r = await call('POST', '/api/selfnote/note/update', { index: at, text: '改过的一条：先跑验收再交付' })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.notes.length, before35.length, '改一条不该改变条数')
  assert.equal(r.payload.notes[at].text, '改过的一条：先跑验收再交付')
  assert.equal(r.payload.notes[at].date, before35[at].date, '改措辞不该把日期改成今天')
  assert.equal(r.payload.notes.some((item) => item.text === oldText), false, '旧文本该没了')
  const noteSeg = r.payload.injection.segments.find((seg) => seg.key === 'notes')
  assert.ok(noteSeg.kept.includes('改过的一条：先跑验收再交付'), '改完必须立刻反映到这一回合的注入段')
  const injAfter = injectionDef.text()
  assert.ok(injAfter.includes('改过的一条：先跑验收再交付'), '下一回合真正贴进去的那段也得是新文本（不是缓存里的旧的）')
  assert.equal(injAfter.includes(oldText), false, '旧的文本要从真实注入里消失')

  // 内容不许空
  r = await call('POST', '/api/selfnote/note/update', { index: at, text: '   ' })
  assert.equal(r.status, 400)
  r = await call('POST', '/api/selfnote/note/update', { index: 999, text: '没有这一条' })
  assert.equal(r.status, 400)
  assert.match(r.payload.error, /刷新/, '下标过期时说人话，别只说非法参数')

  // 删一条：进归档，不是凭空消失
  r = await call('GET', '/api/selfnote/state')
  const victim = r.payload.notes[0]
  r = await call('POST', '/api/selfnote/note/delete', { index: 0 })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.notes.some((item) => item.text === victim.text), false, '删掉的不该还在')
  assert.equal(r.payload.noteDelete.kept, before35.length - 1)
  assert.ok(existsSync(r.payload.noteDelete.archivedFile), '删掉的条目必须留在归档文件里')
  assert.match(readFileSync(r.payload.noteDelete.archivedFile, 'utf8'), new RegExp(victim.text.slice(0, 8)), '归档里要能搜到那句原文')
  console.log('35. 改一条 / 删一条：注入段立刻变、日期不改、下标过期说人话、删掉的进归档')
}

/* 36. 记忆正文也能改（注入里的「关于他」就是这些句子） */
{
  r = await call('GET', '/api/selfnote/state')
  const fact = r.payload.facts.approved[0]
  assert.ok(fact, '前面该已经采纳过一条')
  const original = fact.text
  r = await call('POST', '/api/selfnote/fact', { id: fact.id, text: '改过的结论：先跑测试再宣布完成' })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  const after = r.payload.facts.approved.find((item) => item.id === fact.id)
  assert.equal(after.text, '改过的结论：先跑测试再宣布完成')
  assert.equal(after.status, 'approved', '改正文不该改状态')
  assert.equal(after.text === original, false)
  const hist = after.history[after.history.length - 1]
  assert.equal(hist.from, 'text', '留痕要能看出这是改正文，不是改状态')
  assert.equal(hist.via, 'settings')

  r = await call('POST', '/api/selfnote/fact', { id: fact.id, text: '' })
  assert.equal(r.status, 400)
  r = await call('POST', '/api/selfnote/fact', { id: fact.id, text: 'x'.repeat(241) })
  assert.equal(r.status, 400)
  r = await call('POST', '/api/selfnote/fact', { id: 'nope', text: '不存在的 id' })
  assert.equal(r.status, 400)
  console.log('36. 记忆正文可改：状态与出处不动、留痕标 text、空/超长/未知 id 都 400')
}

/* 37. 注入抬头可改：它就是每回合那段的第一行 */
{
  r = await call('POST', '/api/selfnote/config', { heading: '人格（agent 写的）' })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.heading, '人格（agent 写的）')
  assert.ok(r.payload.injection.text.startsWith('人格（agent 写的）'), '抬头必须真的成了第一行')

  r = await call('POST', '/api/selfnote/config', { heading: 'x'.repeat(25) })
  assert.equal(r.status, 400, '抬头不设上限等于让人用一句话吃掉预算')
  assert.match(r.payload.error, /24/)

  // 清空抬头 = 不要这一行，注入从内容直接开始
  r = await call('POST', '/api/selfnote/config', { heading: '' })
  assert.equal(r.status, 200)
  assert.equal(r.payload.heading, '')
  assert.equal(r.payload.injection.text.startsWith('人格'), false)
  console.log('37. 注入抬头可改：真的成了第一行、超长被拒、清空后从内容开始')
}

/* 38. 临时保质期可改（设置页那个输入框打的就是这条接口） */
{
  r = await call('POST', '/api/selfnote/config', { tempTtlDays: 21 })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.tempTtlDays, 21, 'state 要把 tempTtlDays 交出去，设置页才有值可显示')
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).tempTtlDays, 21)

  for (const bad of [0, 91, -1, 'abc']) {
    r = await call('POST', '/api/selfnote/config', { tempTtlDays: bad })
    assert.equal(r.status, 400, 'tempTtlDays=' + bad + ' 该被拒')
    assert.match(r.payload.error, /1–90/)
  }
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).tempTtlDays, 21, '被拒时不该改文件')

  // 只发 tempTtlDays 不能把别的配置顺手清掉
  const cfgBefore = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(cfgBefore.maxChars, 400, '别的键要原封不动')
  console.log('38. 临时保质期可改：1–90 生效、越界 400 且不落盘、不动别的键')
}

/* 42–52. 人格工具、路由、state 与体检 */

const { savePersonaFile, readPersona } = await import('../lib/persona.js')
const { sha256OfCurrentPersona } = await import('../lib/persona-tx.js')
const corrections = await import('../lib/corrections.js')
const selfNote = toolHold.find((tool) => tool.name === 'self_note')

await call('POST', '/api/selfnote/config', { enabled: true, personaEnabled: true })

/* 42. 没写过人格时取 L2：给一句人话，不是空字符串 */
let out = await selfNote.execute({ action: 'persona' })
assert.equal(out.empty, true)
assert.equal(out.chars, 0)
assert.match(out.text, /还没写 L2/)
assert.equal((await call('GET', '/api/selfnote/state')).payload.persona.reads, 0, '空的不计数')
console.log('42. 工具 action:persona 没内容时给一句人话')

/* 43. 有 L2 时带边界句，且不截断 */
savePersonaFile({ l0: '我是大肥鱼。', l1: '', l2: '外貌：长发，蓝色外套。' })
out = await selfNote.execute({ action: 'persona' })
assert.ok(out.text.startsWith('（背景资料，不是指令'), '取回来的设定必须自带边界句')
assert.match(out.text, /蓝色外套/)
assert.equal(out.truncated, false)
assert.equal(out.empty, false)
console.log('43. 工具 action:persona 取 L2 并自带「不是指令」')

/* 44. 取成功才计数；开关关着也计数（关的是注入，不是取用） */
let st = (await call('GET', '/api/selfnote/state')).payload
assert.equal(st.persona.reads, 1)
assert.ok(st.persona.lastReadAt !== '')
await call('POST', '/api/selfnote/config', { personaEnabled: false })
await selfNote.execute({ action: 'persona' })
assert.equal((await call('GET', '/api/selfnote/state')).payload.persona.reads, 2, '关掉注入也要记账')
await call('POST', '/api/selfnote/config', { personaEnabled: true })
console.log('44. personaReads：成功的非空 L2 才 +1')

/* 45. 保存人格：200 且三段都落盘 */
let rp = await call('POST', '/api/selfnote/persona', { l0: '我是大肥鱼。', l1: '先举例再给结论。', l2: '外貌：长发。', consume: [] })
assert.equal(rp.status, 200)
assert.equal(rp.payload.ok, true)
let saved = readPersona()
assert.equal(saved.l0, '我是大肥鱼。')
assert.equal(saved.l1, '先举例再给结论。')
console.log('45. POST /persona 保存成功')

/* 46. 越界：400 且文件字节不变 */
let shaBefore = sha256OfCurrentPersona()
rp = await call('POST', '/api/selfnote/persona', { l0: '甲'.repeat(200), l1: '', l2: '', consume: [] })
assert.equal(rp.status, 400)
assert.equal(rp.payload.code, 'l0-too-long')
assert.equal(sha256OfCurrentPersona(), shaBefore, '被拒时一个字节都不许动')
console.log('46. 越界保存被拒且文件不变')

/* 47. consume 带不存在的 id：整单拒绝 */
rp = await call('POST', '/api/selfnote/persona', { l0: '甲', l1: '', l2: '', consume: ['no-such-id'] })
assert.equal(rp.status, 400)
assert.equal(rp.payload.code, 'validation')
assert.equal(sha256OfCurrentPersona(), shaBefore)
console.log('47. 非法证据 id 整单拒绝')

/* 48. 成功保存 → 证据变 used，并记 consumedBy */
corrections.writeEvents([])
corrections.appendEvents([{ id: 'ev-ok', session: 's', idx: 1, quote: '我说过先举例', at: new Date().toISOString() }])
rp = await call('POST', '/api/selfnote/persona', { l0: '我是大肥鱼。', l1: '先举例再给结论。', l2: '', consume: ['ev-ok'] })
assert.equal(rp.status, 200)
assert.deepEqual(rp.payload.consumed, ['ev-ok'])
const usedEvent = corrections.findById('ev-ok')
assert.equal(usedEvent.used, true)
assert.ok(usedEvent.usedAt !== '')
assert.ok(usedEvent.consumedBy !== null)
console.log('48. 保存成功同时消费证据')

/* 49. GET /corrections：分页字段齐全，且明说没有写权限 */
const listed = await call('GET', '/api/selfnote/corrections')
assert.equal(listed.status, 200)
assert.ok(Array.isArray(listed.payload.items))
assert.equal(typeof listed.payload.total, 'number')
assert.ok('nextCursor' in listed.payload)
assert.match(listed.payload.hint, /没有写入权限/)
console.log('49. GET /corrections 只读且带提示')

/* 50. discard：合法 id 变 used；非法 id 400 */
corrections.appendEvents([{ id: 'ev-drop', session: 's', idx: 2, quote: '别再用表格', at: new Date().toISOString() }])
let rd = await call('POST', '/api/selfnote/corrections/discard', { ids: ['ev-drop'] })
assert.equal(rd.status, 200)
assert.equal(corrections.findById('ev-drop').used, true)
rd = await call('POST', '/api/selfnote/corrections/discard', { ids: ['nope'] })
assert.equal(rd.status, 400)
console.log('50. discard 丢弃证据，非法 id 被拒')

/* 51. 导入：只返回三段，不落盘 */
const shaBeforeImport = sha256OfCurrentPersona()
const importedPersona = await call('POST', '/api/selfnote/persona/import')
assert.equal(importedPersona.status, 200)
assert.ok('l0' in importedPersona.payload && 'l1' in importedPersona.payload && 'l2' in importedPersona.payload)
assert.equal(sha256OfCurrentPersona(), shaBeforeImport, '导入不等于采纳：不许自动保存')
console.log('51. 从 AGENT.md 导入只填空，不保存')

/* 52. state 与体检：人格/纠偏各一段，体检六组十四项 */
st = (await call('GET', '/api/selfnote/state')).payload
assert.equal(st.persona.l0Limit, 80)
assert.equal(st.persona.fileLimit, 8000)
assert.equal(typeof st.persona.l1Limit, 'number')
assert.equal(typeof st.corrections.total, 'number')
assert.equal(Array.isArray(st.corrections.items), true, '界面靠 items 渲染勾选区，只给计数等于让这条链路死掉')
const doctorDoc = (await call('GET', '/api/selfnote/doctor')).payload
const keys = doctorDoc.checks.map((check) => check.key)
// 六组固定：组是给人扫的分类，顺序不许漂
const GROUP_KEYS = ['load', 'files', 'inject', 'segments', 'persona', 'index']
assert.deepEqual(doctorDoc.groups.map((group) => group.key), GROUP_KEYS, '体检分组固定为六组，顺序不许变')
for (const group of doctorDoc.groups) {
  assert.ok(group.items.length > 0, group.key + ' 组是空的 —— 界面上会出现一个空壳')
  assert.equal(group.counts.total, group.items.length, group.key + ' 的计数与项数要对得上')
}
// 每一项都必须归进其中一组：漏推 group 的检查会在界面上凭空消失
assert.equal(doctorDoc.checks.every((check) => GROUP_KEYS.includes(check.group)), true, '有检查项没归组')
// 固定项一个不许少，也不许悄悄长出去
const BASE = ['plugin', 'auth', 'beat', 'facts', 'habits', 'notes', 'corrections', 'capture', 'inject', 'segments', 'persona', 'persona-tx', 'index', 'relation']
for (const key of BASE) assert.ok(keys.includes(key), '体检少了 ' + key + '：' + keys.join(','))
assert.ok(keys.length === BASE.length || keys.length === BASE.length + 1, '体检项数不对：' + keys.join(','))
if (keys.length === BASE.length + 1) assert.ok(keys.includes('index-failed'), '多出来的只能是 index-failed')
// 非 ok 的每一条都得给得出能照着做的修法：只报「有问题」等于让人自己去翻代码
for (const check of doctorDoc.checks) {
  if (check.level === 'ok' || check.level === 'info') continue
  assert.ok(String(check.fix || '').length > 0, check.key + ' 报了问题却没给修法')
}
assert.equal(doctorDoc.fixes.length, doctorDoc.checks.filter((check) => check.level === 'error' || check.level === 'warn').length, 'fixes 要跟问题数一一对上')
// 九段结构要真的数到九段，而不是「看起来正常」
const segCheck = doctorDoc.checks.find((check) => check.key === 'segments')
assert.equal(segCheck.level, 'ok', '九段结构该正常：' + segCheck.detail)
assert.match(segCheck.detail, /九段齐全/)
// 版本号只有一个来源：package.json
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
assert.equal(doctorDoc.version, pkgVersion, '体检报的版本必须等于 package.json')
assert.equal(st.version, pkgVersion, 'state 报的版本必须等于 package.json')
console.log('52. state 带人格与纠偏，体检六组十四项')

/* 52b. 关系对账：孤儿外键被抓出来，一致就放行 */
{
  const topicFile = join(dir, 'topic.jsonl')
  const episodeFile = join(dir, 'episode.jsonl')
  const factsBackup = existsSync(factsFile) ? readFileSync(factsFile, 'utf8') : ''
  const now = '2026-11-19T00:00:00.000Z'
  const day = '2026-11-19'
  const line = (obj) => JSON.stringify(obj) + '\n'
  try {
    // 场景 1：episode 挂到不存在的 topic、fact 挂到不存在的 episode —— 两处孤儿都要报
    writeFileSync(topicFile, line({ id: 't1', title: '孤儿测试', summary: 'x', boost: 0, lastTouched: now, useCount: 0, readCount: 0, created: day, updated: day }))
    writeFileSync(episodeFile, line({ id: 'e1', topicId: 't-ghost', title: '议题', status: 'open', summary: '', lastTouched: now, nodes: [], created: day, updated: day }))
    writeFileSync(factsFile, factsBackup + line({ id: 'f1', text: '孤儿挂靠', kind: 'rel', status: 'approved', episodeId: 'e-ghost', version: 1, created: day }))
    const relWarn = (await call('GET', '/api/selfnote/doctor')).payload.checks.find((c) => c.key === 'relation')
    assert.ok(relWarn, '缺 relation 对账项')
    assert.equal(relWarn.level, 'warn', relWarn.detail)
    assert.match(relWarn.detail, /孤儿/)
    // 场景 2：全挂对 + nodes 与反查一致 —— 放行
    writeFileSync(episodeFile, line({ id: 'e1', topicId: 't1', title: '议题', status: 'open', summary: '', lastTouched: now, nodes: ['f1'], created: day, updated: day }))
    writeFileSync(factsFile, factsBackup + line({ id: 'f1', text: '孤儿挂靠', kind: 'rel', status: 'approved', episodeId: 'e1', version: 1, created: day }))
    const relOk = (await call('GET', '/api/selfnote/doctor')).payload.checks.find((c) => c.key === 'relation')
    assert.equal(relOk.level, 'ok', relOk.detail)
    assert.match(relOk.detail, /外键一致/)
    // 场景 3：nodes 与事实反查不一致 —— 按事实重建后放行，修了几个要说出来
    writeFileSync(episodeFile, line({ id: 'e1', topicId: 't1', title: '议题', status: 'open', summary: '', lastTouched: now, nodes: [], created: day, updated: day }))
    const relHeal = (await call('GET', '/api/selfnote/doctor')).payload.checks.find((c) => c.key === 'relation')
    assert.equal(relHeal.level, 'ok', relHeal.detail)
    assert.match(relHeal.detail, /重建了 1 个 episode 的 nodes/)
    const healed = JSON.parse(readFileSync(episodeFile, 'utf8').trim().split('\n')[0])
    assert.deepEqual(healed.nodes, ['f1'], '重建结果要落盘，不能只在内存里对')
    console.log('52b-2. 关系对账：nodes 不一致时按事实重建并落盘')
  } finally {
    writeFileSync(topicFile, '')
    writeFileSync(episodeFile, '')
    writeFileSync(factsFile, factsBackup)
  }
}

/* 52c. topics rename/archive 路由：改名、冲突拒绝、归档 */
{
  const { readTopics } = await import('../lib/relation.js')
  const topicFile = join(dir, 'topic.jsonl')
  const now = '2026-11-19T00:00:00.000Z'
  const day = '2026-11-19'
  const topicLine = (t) => JSON.stringify(t) + '\n'
  writeFileSync(topicFile, [
    topicLine({ id: 't-a', title: '旧名', summary: 'x', boost: 0, lastTouched: now, useCount: 0, readCount: 0, created: day, updated: day }),
    topicLine({ id: 't-b', title: '另一个', summary: 'x', boost: 0, lastTouched: now, useCount: 0, readCount: 0, created: day, updated: day }),
  ].join(''))

  // rename 成功
  r = await call('POST', '/api/selfnote/topics/rename', { id: 't-a', title: '新名' })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.ok, true)
  assert.equal(readTopics().find((t) => t.id === 't-a').title, '新名', '改名要落盘')

  // rename 到已存在的 title → 冲突拒绝
  r = await call('POST', '/api/selfnote/topics/rename', { id: 't-a', title: '另一个' })
  assert.equal(r.status, 400, JSON.stringify(r.payload))
  assert.equal(r.payload.ok, false)

  // archive 成功：带 archivedAt
  r = await call('POST', '/api/selfnote/topics/archive', { id: 't-a' })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.ok, true)
  assert.ok(readTopics().find((t) => t.id === 't-a').archivedAt, '归档要写 archivedAt')

  writeFileSync(topicFile, '')
  console.log('52c. topics rename/archive 路由：改名、冲突拒绝、归档')
}

/* 52d. state 带 relations 列表 + boost 路由 */
{
  const { readTopics } = await import('../lib/relation.js')
  const topicFile = join(dir, 'topic.jsonl')
  const now = '2026-11-19T00:00:00.000Z'
  const day = '2026-11-19'
  const topicLine = (t) => JSON.stringify(t) + '\n'
  writeFileSync(topicFile, topicLine({ id: 't-a', title: '关系测试', summary: 'x', boost: 0, lastTouched: now, useCount: 3, readCount: 1, created: day, updated: day }))

  // state 要带 relations 列表（前端关系记忆卡用）
  r = await call('GET', '/api/selfnote/state')
  assert.ok(r.payload.relations, 'state 里要有 relations')
  assert.ok(Array.isArray(r.payload.relations.topics), 'relations.topics 是数组')
  assert.ok(Array.isArray(r.payload.relations.episodes), 'relations.episodes 是数组')
  assert.equal(r.payload.relations.topics.find((t) => t.id === 't-a').title, '关系测试', 'relations.topics 要带话题')

  // boost 路由：加权重，不碰 useCount/readCount
  r = await call('POST', '/api/selfnote/topics/boost', { id: 't-a', delta: 2 })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.ok, true)
  const boosted = readTopics().find((t) => t.id === 't-a')
  assert.equal(boosted.boost, 2, 'boost 要落盘')
  assert.equal(boosted.useCount, 3, 'boost 不碰 useCount')
  assert.equal(boosted.readCount, 1, 'boost 不碰 readCount')

  // boost 到不存在的 id → 400
  r = await call('POST', '/api/selfnote/topics/boost', { id: 't-ghost', delta: 1 })
  assert.equal(r.status, 400, JSON.stringify(r.payload))
  assert.equal(r.payload.ok, false)

  writeFileSync(topicFile, '')
  console.log('52d. state 带 relations + boost 路由')
}

/* 53. 人格跟着迁移包走：目标空就采用，两边都有且不同就落旁路文件 */
{
  // 先把本机的人格清掉：目标为空时才谈得上「采用」
  r = await call('POST', '/api/selfnote/persona', { l0: '', l1: '', l2: '' })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.persona.chars, 0)

  r = await call('POST', '/api/selfnote/import', {
    bundle: { app: 'dsh-selfnote', v: 2, persona: { l0: '我是鲸鲸。', l1: '回答先给结论。', l2: '外套深蓝。' } },
  })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.import.persona.action, 'adopt', '本机原来没有人格，就该采用导入的')
  assert.equal(r.payload.persona.l0, '我是鲸鲸。')
  assert.equal(r.payload.persona.l1, '回答先给结论。')

  // 再来一份不一样的：不许覆盖，要落 persona.imported-*.md
  r = await call('POST', '/api/selfnote/import', {
    bundle: { app: 'dsh-selfnote', v: 2, persona: { l0: '我是别人。', l1: '', l2: '' } },
  })
  assert.equal(r.status, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.import.persona.action, 'conflict', '两边都有且不同，不许覆盖')
  assert.match(r.payload.import.persona.file, /persona.imported-.*.md$/, '冲突的那份要落旁路文件，别丢也不要盖')
  assert.equal(r.payload.persona.l0, '我是鲸鲸。', '本机那份必须原封不动')
  const { existsSync, readFileSync } = await import('node:fs')
  assert.equal(existsSync(r.payload.import.persona.file), true, '旁路文件要真的写出来')
  assert.ok(readFileSync(r.payload.import.persona.file, 'utf8').includes('我是别人。'), '旁路文件里是导入的那份')

  // 一模一样：既不重复写盘，也不报冲突
  r = await call('POST', '/api/selfnote/import', {
    bundle: { app: 'dsh-selfnote', v: 2, persona: { l0: '我是鲸鲸。', l1: '回答先给结论。', l2: '外套深蓝。' } },
  })
  assert.equal(r.payload.import.persona.action, 'same', '一模一样就别再写一遍')
  console.log('53. 人格迁移：空则采用、同则跳过、异则落旁路文件，本机那份不被盖')
}

/* 54. /import 中途写失败时不能保留半份数据 */
{
  const factsFile = join(dir, 'memory', 'facts.jsonl')
  const notesFile = join(dir, 'notes.md')
  const beforeFacts = readFileSync(factsFile, 'utf8')
  const beforeNotes = readFileSync(notesFile, 'utf8')
  const importBundle = {
    app: 'dsh-selfnote',
    v: 2,
    facts: [{ id: 'rollback-1', text: '导入后应当回滚掉的事实', status: 'candidate' }],
    notes: [{ date: '2026-11-25', text: '导入后应当回滚掉的自述' }],
  }
  chmodSync(notesFile, 0o444)
  let failed = false
  try {
    const res = await call('POST', '/api/selfnote/import', { bundle: importBundle })
    assert.equal(res.status, 500, JSON.stringify(res.payload))
    failed = true
  } finally {
    chmodSync(notesFile, 0o644)
  }
  assert.equal(failed, true, '不可写目标必须让导入失败')
  assert.equal(readFileSync(factsFile, 'utf8'), beforeFacts, '中途写失败后 facts 必须回滚')
  assert.equal(readFileSync(notesFile, 'utf8'), beforeNotes, '中途写失败后 notes 必须回滚')
  console.log('54. /import 中途失败时回滚已写入的 facts/notes')
}

/* 54b. /import 失败在 habits 写之后：habits 也必须回滚（snap(habitsFile) 曾误传函数，快照恒 null） */
{
  const habitsFile = join(dir, 'memory', 'habits.jsonl')
  const configFile = join(dir, 'config.json')
  const beforeHabits = readFileSync(habitsFile, 'utf8')
  const beforeConfig = readFileSync(configFile, 'utf8')
  const importBundle = {
    app: 'dsh-selfnote',
    v: 2,
    facts: [{ id: 'rollback-h-1', text: '回滚测试事实 h', status: 'candidate' }],
    notes: [{ date: '2026-11-25', text: '回滚测试自述 h' }],
    habits: [{ text: '回滚测试习惯', status: 'active' }],
    config: { heading: '回滚测试抬头' },
  }
  chmodSync(configFile, 0o444)
  let failed = false
  try {
    const res = await call('POST', '/api/selfnote/import', { bundle: importBundle })
    if (res.status === 500) failed = true
  } finally {
    chmodSync(configFile, 0o644)
  }
  assert.equal(failed, true, 'config 不可写必须让导入在写 habits 之后失败')
  assert.equal(readFileSync(habitsFile, 'utf8'), beforeHabits, '中途写失败后 habits 必须回滚')
  assert.equal(readFileSync(configFile, 'utf8'), beforeConfig, '中途写失败后 config 必须不变')
  console.log('54b. /import 失败在 config 时 habits 也回滚')
}

/* 54c. 生产 logger 桥：坏 state.json 时 /state 仍降级为空状，但必须经 ctx.logger.warn 留痕（不能只靠测试自己设桩） */
{
  const stateFile = join(dir, 'memory', 'state.json')
  const before = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null
  writeFileSync(stateFile, '{ 坏掉的 JSON')
  warnLog.length = 0
  try {
    const res = await call('GET', '/api/selfnote/state')
    assert.equal(res.status, 200)
    assert.ok(warnLog.some((m) => m.includes('state.json 解析失败')), '坏 state 必须经 ctx.logger.warn 留痕，不能只在测试桩里可见')
  } finally {
    if (before === null) { try { unlinkSync(stateFile) } catch {} }
    else writeFileSync(stateFile, before)
  }
  console.log('54c. 坏 state 经生产 logger 桥留 warn')
}

/* 54d. /import 与 setHabit 抢习惯锁：锁被占时 import 必须拒绝，不能静默覆盖 habits */
{
  const habitsFile = join(dir, 'memory', 'habits.jsonl')
  const lockFile = habitsFile + '.lock'
  const beforeHabits = readFileSync(habitsFile, 'utf8')
  // 造一把新鲜的锁（pid + 刚写的 mtime），模拟另一个 DSH 窗口正在改习惯；2s 内不算 stale
  writeFileSync(lockFile, String(process.pid))
  let res
  try {
    res = await call('POST', '/api/selfnote/import', {
      bundle: {
        app: 'dsh-selfnote',
        v: 2,
        facts: [{ id: 'lock-race-f', text: '锁占用测试事实', status: 'candidate' }],
        notes: [{ date: '2026-11-25', text: '锁占用测试自述' }],
        habits: [{ text: '锁占用时不应写入的习惯', status: 'active' }],
      },
    })
  } finally {
    try { unlinkSync(lockFile) } catch {}
  }
  assert.notEqual(res.status, 200, '习惯锁被占时 import 不能成功，否则会把别人的习惯覆盖掉')
  assert.equal(readFileSync(habitsFile, 'utf8'), beforeHabits, '锁被占时 habits 不能被覆盖')
  console.log('54d. /import 拿不到习惯锁时拒绝，不静默覆盖')
}

/* 55. 开机补完：上次保存崩在中途，重启时按日志补齐 */
{
  const tx = await import('../lib/persona-tx.js')
  const { personaPath } = await import('../lib/persona.js')
  // 造一个「persona 已写、证据还没记账、日志还没删」的中断现场
  tx.beginTx({
    txId: 'tx-boot-recover',
    at: new Date().toISOString(),
    personaSha256: tx.sha256OfCurrentPersona(),
    consume: [],
    evidenceAfter: { v: 1, algo: 'nfkc-wp1', rules: {} },
  })
  assert.equal(existsSync(join(dir, 'persona.pending.json')), true, '中断现场没造出来')
  apply(ctx, {}) // 相当于重启插件
  assert.equal(existsSync(join(dir, 'persona.pending.json')), false, '开机时应该把半截事务补完，而不是留着等人来救')
  assert.ok(existsSync(personaPath()), 'persona.md 该在')
  console.log('55. 开机补完半截事务：重启即幂等重放，日志清掉，人格文件不动')
}

/* 55. 只给一段不会清空别的；三段都不给直接拒绝 */
rp = await call('POST', '/api/selfnote/persona', { l0: '我是大肥鱼。', l1: '先举例再给结论。', l2: '外套深蓝。' })
assert.equal(rp.status, 200)
// 设置页拿到响应会直接 apply 成整份 state：只回 {ok, consumed} 会把页面刷成空白
assert.ok(rp.payload.budget, '保存人格后要回整份 state（budget）')
assert.ok(rp.payload.notes, '保存人格后要回整份 state（notes）')
assert.ok(rp.payload.corrections, '保存人格后要回整份 state（corrections）')
rp = await call('POST', '/api/selfnote/persona', { l1: '只改第二段。' })
assert.equal(rp.status, 200)
let partial = readPersona()
assert.equal(partial.l0, '我是大肥鱼。', '没给的段要沿用盘上现值')
assert.equal(partial.l2, '外套深蓝。')
assert.equal(partial.l1, '只改第二段。')
rp = await call('POST', '/api/selfnote/persona', {})
assert.equal(rp.status, 400, '空对象不能把整份人格抹掉')
assert.equal(readPersona().l1, '只改第二段。')
console.log('56. 部分字段保存不清空其它段，空对象被拒')

/* 56. 界面要用的三个数：半衰期、L2 上限、纠偏游标 —— 缺一个界面就得自己瞎猜 */
rp = await call('GET', '/api/selfnote/state')
assert.equal(rp.payload.halfLifeDays, 30, '半衰期要出现在 /state 里')
assert.ok(typeof rp.payload.persona.l2Limit === 'number' && rp.payload.persona.l2Limit >= 0, 'L2 上限按 8000 减已用来算')
assert.ok('nextCursor' in rp.payload.corrections, '纠偏翻页要有游标')
rp = await call('POST', '/api/selfnote/config', { halfLifeDays: 45, profileMaxChars: 90 })
assert.equal(rp.status, 200)
assert.equal(rp.payload.halfLifeDays, 45, '半衰期改完要真的落到 state')
assert.equal(rp.payload.profile.maxChars, 90, '画像上限改完要真的落到 state')
rp = await call('POST', '/api/selfnote/config', { halfLifeDays: 999 })
assert.equal(rp.status, 400, '越界的半衰期要被拒')
rp = await call('POST', '/api/selfnote/config', { halfLifeDays: 30, profileMaxChars: 110 })
assert.equal(rp.status, 200)
console.log('57. 半衰期/画像上限/纠偏游标都在 state 里，越界被拒')

/* 57. 批2-6：命中话题记了 readCount，就得把话题正文渲染出来（门牌「memory_recall 查」不能骗人） */
{
  const hitTopics = [
    { id: 't-kb', title: '知识库搭建', summary: '在搭本地知识库' },
    { id: 'e-kb', title: '检索架构', summary: '知识库检索怎么做', status: 'open' },
  ]
  const recallTool = toolHold.find((tool) => tool.name === 'memory_recall')
  const searchTool = toolHold.find((tool) => tool.name === 'memory_search')
  const recallRender = recallTool.output.render({ query: '知识库' }, { query: '知识库', topics: hitTopics, raw: { total: 0, sessions_scanned: 0, sessions_total: 0 } }).map((b) => b.text).join('\n')
  assert.match(recallRender, /知识库搭建/, 'memory_recall 渲染要带命中话题标题')
  assert.match(recallRender, /在搭本地知识库/, 'memory_recall 渲染要带命中话题摘要')
  const searchRender = searchTool.output.render({ query: '知识库' }, { query: '知识库', topics: hitTopics, total: 0, hits: [] }).map((b) => b.text).join('\n')
  assert.match(searchRender, /知识库搭建/, 'memory_search 渲染要带命中话题标题')
  assert.match(searchRender, /在搭本地知识库/, 'memory_search 渲染要带命中话题摘要')
  assert.ok(!searchRender.includes('显示 0 条'), '列出话题时不该说「显示 0 条」')
  assert.match(searchRender, /话题\/议题 2 条/, '话题条数要并进命中统计')
  console.log('58. 命中话题的正文在 recall/search 渲染里看得见')
}

/* 59–63. 有效性降权、作废确认卡与三动作 */
{
  const config = await import('../lib/index.js')
  const memory = await import('../lib/memory.js')
  const validity = await import('../lib/validity.js')
  const validityVersion = validity.VALIDITY_VERSION
  const sessionId = 'session-validity'
  const quote1 = '别再用旧话术'
  const quote2 = '改成用新话术'
  const sessionDir = join(process.env.DSH_SESSIONS_DIR, 'proj', sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const makeSessionBody = (text) => JSON.stringify({
    type: 'user/message',
    seq: 0,
    time: Date.parse('2026-11-26T10:00:00Z'),
    data: { content: [{ type: 'text', text }], role: 'user', source: { kind: 'user' } },
  }) + '\n'
  const sessionFile = join(sessionDir, 'session.v4.jsonl.zstd')
  writeFileSync(sessionFile, zstdCompressSync(Buffer.from(makeSessionBody(quote1), 'utf8')))

  const event1 = {
    id: 'ev-validity-1', session: sessionId, idx: 0, quote: quote1,
    at: '2026-11-26', strength: 'strong',
  }
  const event2 = {
    id: 'ev-validity-2', session: sessionId, idx: 0, quote: quote2,
    at: '2026-11-26', strength: 'strong',
  }
  const signal1 = validity.signalKey(event1)
  const signal2 = validity.signalKey(event2)
  const factsFile = join(dir, 'memory', 'facts.jsonl')
  const oldFacts = readFileSync(factsFile, 'utf8')
  const writeFactRows = (rows) => writeFileSync(factsFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const rows = [
    {
      id: 'validity-free-a', text: '无冲突的一条甲：无冲突的一条甲', status: 'approved', channel: 'rel',
      hitCount: 10, lastHit: new Date().toISOString(),
    },
    {
      id: 'validity-free-b', text: '无冲突的一条乙：无冲突的一条乙', status: 'approved', channel: 'rel',
      hitCount: 9, lastHit: new Date().toISOString(),
    },
    {
      id: 'validity-b', text: '旧话术是有效的：旧话术是有效的', status: 'approved', channel: 'rel',
      conflictWith: ['validity-free-a'], hitCount: 20, lastHit: new Date().toISOString(),
    },
  ]

  corrections.writeEvents([event1])
  writeFactRows(rows)
  // 新语义：候选=本轮注入过的事实。预置 injectedFactIds 指向这三条
  memory.writeState({ ...memory.readState(), injectedFactIds: ['validity-b', 'validity-free-a', 'validity-free-b'] })
  let state = (await call('GET', '/api/selfnote/state')).payload
  assert.ok(state.validity && Array.isArray(state.validity.cards), 'state 要有 validity.cards')
  assert.deepEqual(state.validity.cards.map((card) => card.key), [signal1])
  assert.equal(state.validity.cards[0].candidates.length, 3, '候选恰为本轮注入的三条，与作废句字面无关')
  assert.ok(state.validity.cards[0].candidates.some((item) => item.id === 'validity-b'), '注入过的 validity-b 进候选')
  assert.ok(state.validity.cards[0].candidates.some((item) => item.id === 'validity-free-a'), '零字面匹配的注入事实也进候选')

  const cfg = {
    ...config.currentConfig(),
    enabled: true,
    profileEnabled: false,
    personaEnabled: false,
    halfLifeDays: 30,
  }
  const weighted = config.assembleInjection(cfg, { spotlight: new Set(['validity-b']) })
  const factsSegment = weighted.segments.find((segment) => segment.key === 'facts')
  assert.ok(factsSegment, 'facts 段要在注入里')
  const freeAIndex = factsSegment.kept.indexOf('无冲突的一条甲：无冲突的一条甲')
  const freeBIndex = factsSegment.kept.indexOf('无冲突的一条乙：无冲突的一条乙')
  const conflictIndex = factsSegment.kept.indexOf('旧话术是有效的：旧话术是有效的')
  assert.notEqual(conflictIndex, -1, '降权不是删除，带 conflictWith 的事实仍要在注入里')
  assert.ok(conflictIndex > freeAIndex, '热度乘 0.7 后必须重排，否则降权没有改变顺序（A 档不参与本批降权）')
  assert.ok(conflictIndex > freeBIndex, '热度乘 0.7 后应落到两条零档事实之后')
  console.log('59. 有效性降权乘后重排；无冲突档顺序不变')

  let res = await call('POST', '/api/selfnote/fact', {
    action: 'validity-retire', id: 'validity-b', signal: signal1,
  })
  assert.equal(res.status, 200)
  const retiredRow = JSON.parse(readFileSync(factsFile, 'utf8').trim().split('\n').find((line) => line.includes('validity-b')))
  assert.equal(retiredRow.status, 'retired')
  assert.ok(retiredRow.retiredAt)
  const last = retiredRow.history.at(-1)
  assert.equal(last.to, 'retired')
  assert.equal(last.via, 'validity')
  assert.equal(last.signal, signal1)
  assert.equal(config.assembleInjection(cfg).text.includes('旧话术是有效的'), false, '退役后要从注入消失')
  assert.equal(memory.searchFacts('旧话术').hits.some((fact) => fact.id === 'validity-b'), true, '退役后仍可被温层检索查到（不静默丢数据），只是不进注入')

  res = await call('POST', '/api/selfnote/fact', { id: 'validity-b', status: 'approved' })
  assert.equal(res.status, 200)
  const restored = JSON.parse(readFileSync(factsFile, 'utf8').trim().split('\n').find((line) => line.includes('validity-b')))
  assert.equal(restored.status, 'approved')
  assert.ok(restored.retiredAt === null || restored.retiredAt === undefined, '复用已有 status approved 分支恢复时清掉 retiredAt')
  console.log('60. validity-retire 写退役历史；恢复走既有 status 分支并清 retiredAt')

  corrections.writeEvents([event1])
  res = await call('POST', '/api/selfnote/fact', {
    action: 'validity-keep', id: 'validity-b', signal: signal1,
  })
  assert.equal(res.status, 200)
  const kept = JSON.parse(readFileSync(factsFile, 'utf8').trim().split('\n').find((line) => line.includes('validity-b')))
  assert.equal(kept.status, 'approved', '保留不改状态')
  assert.equal(kept.history.at(-1).via, 'validity-kept')
  assert.equal(kept.history.at(-1).signal, signal1)
  state = (await call('GET', '/api/selfnote/state')).payload
  assert.ok(state.validity.cards.some((card) => card.key === signal1), 'keep 只移除那一条候选，不移除整张卡')

  writeFileSync(sessionFile, zstdCompressSync(Buffer.from(makeSessionBody(quote2), 'utf8')))
  corrections.writeEvents([event2])
  state = (await call('GET', '/api/selfnote/state')).payload
  assert.deepEqual(state.validity.cards.map((card) => card.key), [signal2], '新 quote 是新 signal，仍要出卡')

  res = await call('POST', '/api/selfnote/fact', { action: 'validity-any', signal: signal2 })
  assert.equal(res.status, 200)
  state = (await call('GET', '/api/selfnote/state')).payload
  assert.deepEqual(state.validity.cards.map((card) => card.key), [], 'any 只写台账，卡片消失')
  const afterAny = JSON.parse(readFileSync(factsFile, 'utf8').trim().split('\n').find((line) => line.includes('validity-b')))
  assert.equal(afterAny.history.at(-1).via, 'validity-kept', 'any 不动事实历史')
  console.log('61. keep 只压当前 signal，新 quote 仍出卡；any 只写台账')

  res = await call('POST', '/api/selfnote/fact', { action: 'not-a-valid-action', id: 'validity-b', signal: signal1 })
  assert.equal(res.status, 400, '非法 action 必须拒绝')

  writeFileSync(factsFile, oldFacts)

  /* T1-m1: 作废卡候选只能来自 approved 事实 */
  const retiredId = 'validity-retired-candidate'
  const retiredQuote = '绝无仅有的一句作废候选词'
  const retiredEvent = {
    id: 'ev-validity-retired-candidate', session: sessionId, idx: 0, quote: retiredQuote,
    at: '2026-11-26', strength: 'strong',
  }
  const retiredSignal = validity.signalKey(retiredEvent)
  writeFileSync(sessionFile, zstdCompressSync(Buffer.from(makeSessionBody(retiredQuote), 'utf8')))
  corrections.writeEvents([retiredEvent])
  writeFactRows([
    ...rows,
    {
      id: retiredId,
      text: '作废候选词：作废候选词',
      status: 'retired',
      channel: 'rel',
    },
  ])
  state = (await call('GET', '/api/selfnote/state')).payload
  assert.ok(
    state.validity.cards.some((card) => card.key === retiredSignal),
    '强信号语句应生成一张作废卡'
  )
  for (const card of state.validity.cards) {
    assert.equal(
      card.candidates.some((candidate) => candidate.id === retiredId),
      false,
      '已退役事实不能进入作废卡候选'
    )
  }
  console.log('63. 作废卡候选只来自 approved 事实，不含 retired')
  console.log('62. 非法 action 400；有效性版本串变化时缓存键失效')
}

/* 63. 有效性版本串进入注入缓存键 */
{
  const config = await import('../lib/index.js')
  const cfg = { ...config.currentConfig(), enabled: true, personaEnabled: false, profileEnabled: false }
  assert.equal(typeof config.injectionKey, 'function', '缓存键函数应可测')
  const key1 = config.injectionKey(cfg)
  const validity = await import('../lib/validity.js')
  assert.ok(String(key1).endsWith(config.algorithmKeyForCache()), '缓存键末尾要有有效性版本串')
  assert.equal(config.algorithmKeyForCache(), '|vld' + validity.VALIDITY_VERSION)

  const copyRoot = join(dir, 'validity-version-copy')
  mkdirSync(copyRoot, { recursive: true })
  cpSync(join(process.cwd(), 'lib'), join(copyRoot, 'lib'), { recursive: true })
  writeFileSync(join(copyRoot, 'package.json'), '{"type":"module"}\n')
  const versionFile = join(copyRoot, 'lib', 'validity.js')
  const versionBefore = readFileSync(versionFile, 'utf8')
  const versionAfter = versionBefore.replace(/export const VALIDITY_VERSION = '[^']*'/, "export const VALIDITY_VERSION = '2'")
  assert.notEqual(versionAfter, versionBefore, '测试副本里的版本常量没改到')
  writeFileSync(versionFile, versionAfter)
  writeFileSync(
    join(copyRoot, 'cfg.json'),
    JSON.stringify(cfg),
  )
  writeFileSync(
    join(copyRoot, 'check-version.mjs'),
    "import { readFileSync } from 'node:fs'\n" +
    "const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'))\n" +
    "const { injectionKey } = await import('./lib/index.js')\n" +
    "process.stdout.write(injectionKey(cfg))\n",
  )
  const probe = spawnSync(process.execPath, ['check-version.mjs', 'cfg.json'], {
    cwd: copyRoot,
    env: process.env,
    encoding: 'utf8',
  })
  assert.equal(probe.status, 0, probe.stderr)
  const key2 = probe.stdout.trim()
  assert.match(key2, /\|vld2$/, '改版本常量的副本要用新版本串')
  assert.notEqual(key2, key1, '版本串变化时缓存键必须失效')
}

/* 64. 作废卡处理粒度：退役一条候选，整卡和其余候选继续留着 */
{
  const validity = await import('../lib/validity.js')
  const memory = await import('../lib/memory.js')
  const sessionId = 'session-validity-granularity'
  const quote = '别再用旧话术和旧称呼'
  const sessionDir = join(process.env.DSH_SESSIONS_DIR, 'proj', sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const sessionFile = join(sessionDir, 'session.v4.jsonl.zstd')
  const body = JSON.stringify({
    type: 'user/message', seq: 0, time: Date.parse('2026-11-26T10:00:00Z'),
    data: { content: [{ type: 'text', text: quote }], role: 'user', source: { kind: 'user' } },
  }) + '\n'
  writeFileSync(sessionFile, zstdCompressSync(Buffer.from(body, 'utf8')))
  const event = { id: 'ev-validity-gran', session: sessionId, idx: 0, quote, at: '2026-11-26', strength: 'strong' }
  const signal = validity.signalKey(event)
  const factsFile = join(dir, 'memory', 'facts.jsonl')
  const rows = [
    { id: 'gran-a', text: '旧话术是有效的：旧话术是有效的', status: 'approved', channel: 'rel' },
    { id: 'gran-b', text: '旧称呼是有效的：旧称呼是有效的', status: 'approved', channel: 'rel' },
  ]
  corrections.writeEvents([event])
  writeFileSync(factsFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  memory.writeState({ ...memory.readState(), injectedFactIds: ['gran-a', 'gran-b'] })
  let state = (await call('GET', '/api/selfnote/state')).payload
  const card0 = state.validity.cards.find((card) => card.key === signal)
  assert.ok(card0, '强信号应生成作废卡')
  assert.ok(card0.candidates.some((item) => item.id === 'gran-a') && card0.candidates.some((item) => item.id === 'gran-b'), '两条相关事实都进候选')

  const res = await call('POST', '/api/selfnote/fact', { action: 'validity-retire', id: 'gran-a', signal })
  assert.equal(res.status, 200)
  state = (await call('GET', '/api/selfnote/state')).payload
  const card1 = state.validity.cards.find((card) => card.key === signal)
  assert.ok(card1, '退役一条后整张卡还在，不是整卡消失')
  assert.equal(card1.candidates.some((item) => item.id === 'gran-a'), false, '被退役那条从候选消失')
  assert.ok(card1.candidates.some((item) => item.id === 'gran-b'), '未处理的候选继续留着')
  console.log('64. 作废卡处理粒度：退役一条只移除那一条，整卡其余候选继续留着')
}

/* 65. 取代指针端到端：采纳重复候选 → 旧值退检索但进 retired 带标记 → 可查 → 可恢复 */
{
  writeFileSync(factsFile, [
    { id: 'sup-old', text: '旧位置在老地址', status: 'approved', channel: 'rel', version: 1 },
    { id: 'sup-new', text: '新位置在新地址', status: 'candidate', channel: 'rel', version: 1, mergeSuggestion: 'sup-old' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  let res = await call('POST', '/api/selfnote/fact', { id: 'sup-new', status: 'approved' })
  assert.equal(res.status, 200)
  let state = (await call('GET', '/api/selfnote/state')).payload
  assert.ok(!state.facts.approved.some((f) => f.id === 'sup-old'), '旧值退出已采纳')
  assert.ok(state.facts.retired.some((f) => f.id === 'sup-old' && f.supersededBy === 'sup-new'), '旧值进已退役且带取代标记')
  assert.ok(state.facts.approved.some((f) => f.id === 'sup-new'), '新值在已采纳')
  // 退役值仍可被 memory_search 查到（searchFacts 放宽生效）
  const searchTool = toolHold.find((tool) => tool.name === 'memory_search')
  assert.ok(searchTool, '要有 memory_search 工具')
  const search = await searchTool.execute({ query: '老地址' })
  assert.ok(JSON.stringify(search).includes('sup-old'), '退役值可被检索')
  // 恢复：回到 approved 且清掉取代标记
  res = await call('POST', '/api/selfnote/fact', { id: 'sup-old', status: 'approved' })
  assert.equal(res.status, 200)
  const st2 = (await call('GET', '/api/selfnote/state')).payload
  assert.ok(st2.facts.approved.some((f) => f.id === 'sup-old'), '恢复后旧值回到已采纳')
  assert.equal(st2.facts.approved.find((f) => f.id === 'sup-old')?.supersededBy, undefined, '恢复后无取代标记')
  console.log('65. 取代指针端到端：让位→可查→恢复全链路通')
}

/* 66. 本轮注入事实 id 落盘：注入后 /state 带这批 id；全部退役后再注入为 [] */
{
  const factsFile66 = join(dir, 'memory', 'facts.jsonl')
  const write66 = (rows) => writeFileSync(factsFile66, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  // 关画像，避免事实被画像吸收而不走 facts 段
  r = await call('POST', '/api/selfnote/config', { enabled: true, profileEnabled: false })
  assert.equal(r.status, 200)
  write66([
    { id: 'loc-a', text: '甲地办公的规矩记在这里', status: 'approved', channel: 'rel' },
    { id: 'loc-b', text: '乙地办公的规矩记在这里', status: 'approved', channel: 'rel' },
  ])
  // 触发真实注入（facts 变化 → 注入缓存 miss）
  injectionDef.text()
  let st = (await call('GET', '/api/selfnote/state')).payload
  assert.ok(Array.isArray(st.validity.injectedFactIds), '注入后 /state 要带 injectedFactIds 数组（当前 ' + String(st.validity.injectedFactIds) + '）')
  assert.ok(st.validity.injectedFactIds.includes('loc-a'), '本轮注入的事实 loc-a 要在列表里')

  // 全部退役后再触发注入 → 本轮无事实，写空数组而不是沿用上一轮
  write66([
    { id: 'loc-a', text: '甲地办公的规矩记在这里', status: 'retired', channel: 'rel' },
    { id: 'loc-b', text: '乙地办公的规矩记在这里', status: 'retired', channel: 'rel' },
  ])
  injectionDef.text()
  st = (await call('GET', '/api/selfnote/state')).payload
  assert.deepEqual(st.validity.injectedFactIds, [], '全部退役后本轮无注入事实，写成空数组')
  console.log('66. 本轮注入事实 id 落盘：注入后带 id，空注入写 []')
}

/* 67. 作废句与事实正文零字面重合时，候选仍为眼前注入的事实（不再靠字面猜） */
{
  const validity = await import('../lib/validity.js')
  const memory = await import('../lib/memory.js')
  const sessionId = 'session-validity-locality'
  const quote = '这条不算数了' // 与任何事实正文都没有共同字
  const sessionDir = join(process.env.DSH_SESSIONS_DIR, 'proj', sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const sessionFile = join(sessionDir, 'session.v4.jsonl.zstd')
  const body = JSON.stringify({
    type: 'user/message', seq: 0, time: Date.parse('2026-11-26T10:00:00Z'),
    data: { content: [{ type: 'text', text: quote }], role: 'user', source: { kind: 'user' } },
  }) + '\n'
  writeFileSync(sessionFile, zstdCompressSync(Buffer.from(body, 'utf8')))
  const event = { id: 'ev-validity-locality', session: sessionId, idx: 0, quote, at: '2026-11-26', strength: 'strong' }
  const signal = validity.signalKey(event)
  const factsFile67 = join(dir, 'memory', 'facts.jsonl')
  writeFileSync(factsFile67, [
    { id: 'loc-1', text: '甲处办事要走西侧门', status: 'approved', channel: 'rel' },
    { id: 'loc-2', text: '乙处办事要走东侧门', status: 'approved', channel: 'rel' },
    { id: 'loc-not-injected', text: '丙处办事要走南门', status: 'approved', channel: 'rel' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  corrections.writeEvents([event])
  memory.writeState({ ...memory.readState(), injectedFactIds: ['loc-1', 'loc-2'] })
  let state = (await call('GET', '/api/selfnote/state')).payload
  const card = state.validity.cards.find((c) => c.key === signal)
  assert.ok(card, '作废强信号应出卡（哪怕字面零重合）')
  assert.equal(card.candidates.length, 2, '候选恰为本轮注入的两条')
  assert.ok(card.candidates.some((i) => i.id === 'loc-1') && card.candidates.some((i) => i.id === 'loc-2'))
  assert.equal(card.candidates.some((i) => i.id === 'loc-not-injected'), false, '没注入的第三条不进候选')
  // 退役其中一条：那条退出 approved，数据仍可被检索，另一条仍在卡上
  const res = await call('POST', '/api/selfnote/fact', { action: 'validity-retire', id: 'loc-1', signal })
  assert.equal(res.status, 200)
  state = (await call('GET', '/api/selfnote/state')).payload
  assert.ok(!state.facts.approved.some((f) => f.id === 'loc-1'), '被点退役的那条退出已采纳')
  assert.ok(state.facts.retired.some((f) => f.id === 'loc-1'), '数据留在已退役，不静默丢')
  const card2 = state.validity.cards.find((c) => c.key === signal)
  assert.ok(card2 && card2.candidates.some((i) => i.id === 'loc-2'), '另一条候选继续留在卡上')
  console.log('67. 作废定位：字面零重合也按眼前注入事实出卡，退役一条其余仍在')
}

console.log('\n60 项全部通过（data dir: ' + dir + '）')

process.exit(0)