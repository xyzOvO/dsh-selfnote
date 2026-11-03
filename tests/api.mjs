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

const ctx = {
  logger: { info() {} },
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
assert.deepEqual(toolNames, ['self_note', 'memory_recall', 'memory_stage', 'memory_search', 'memory_write'])
assert.equal(toolHold[0].output.render({}, { action: 'stats', entries: 0, chars: 0, maxChars: 1, maxEntries: 1, archiveFiles: 0 })[0].type, 'text')
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
assert.deepEqual(files.map((item) => item.key), ['notes', 'facts', 'habits', 'config', 'cursor', 'index', 'archive'])
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
assert.equal(inj.limit, 800)
assert.deepEqual(inj.segments.map((seg) => seg.key), ['notes', 'guide', 'profile', 'env', 'facts', 'habits'])
assert.deepEqual(inj.segments.map((seg) => seg.label), ['自述', '写自述的时机', '画像', '环境', '结论', '习惯'])
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

/* 26. 体检：五项都要有明确结论，不许只说「看起来正常」 */
r = await call('GET', '/api/selfnote/doctor')
assert.equal(r.status, 200)
const doc = r.payload
assert.equal(typeof doc.ok, 'boolean')
assert.ok(['ok', 'warn', 'error'].includes(doc.level), '整体要有分级')
for (const key of ['index', 'capture', 'facts', 'notes', 'auth']) {
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
/* 十条检查里人只会动第一条 —— 所以要给出「先做这一件」，而且必须是真有问题的那条 */
assert.ok(r.payload.next, '有问题时要给出先做哪一件')
assert.equal(r.payload.next.key, 'facts', '数据完整性排最前：文件坏了别的都白搭')
assert.ok(String(r.payload.next.detail).length > 0)
console.log('26. 体检：五项各有判据，坏行会被抓出来，并给出先做哪一件')

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
  assert.equal(r.payload.v, 1)
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

console.log('\n40 项全部通过（data dir: ' + dir + '）')
process.exit(0)
