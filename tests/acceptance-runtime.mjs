/**
 * 运行时验收：真实 HTTP 服务 + 真实多进程并发，验证三个 P0 修复。
 * 跑法：node tests/acceptance-runtime.mjs
 *
 * 不碰真实记忆目录：DSH_MEMORY_DIR 指向临时目录。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'selfnote-accept-'))
process.env.DSH_SELFNOTE_DIR = root
process.env.DSH_MEMORY_DIR = join(root, 'memory')
process.env.DSH_SESSIONS_DIR = join(root, 'sessions')

const { apply, currentAuthToken } = await import('../lib/index.js')

let handler = null
let injectionDef = null
const ctx = {
  logger: { info() {} },
  on() {},
  systemPrompt: { context(def) { injectionDef = def; return () => {} } },
  tools: { register() { return () => {} } },
  webServer: {
    register(route) {
      handler = route.handler
      return () => {}
    },
  },
}
apply(ctx, {})
const token = currentAuthToken()
assert.ok(token && token !== '1', '准入 token 必须是随机值，不再是固定口令')

/* ------------------------------- 1. 接口鉴权 ------------------------------- */

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    res.writeHead(500)
    res.end(JSON.stringify({ ok: false, error: String(error) }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/api/selfnote`
const host = `127.0.0.1:${port}`

async function hit(path, init = {}) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

// fetch 不允许改 Host（forbidden header），伪造 Host 只能用底层 http 请求
async function hitWithHost(path, hostValue) {
  const http = await import('node:http')
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/selfnote' + path, headers: { Host: hostValue } },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// 1a. 桌面壳的页面请求不带准入头（3c4ae7e 之后的策略：token 可选）
//     但 Host 必须回环 —— 别的机器/域名解析过来打不到这里
let r = await hit('/state')
assert.equal(r.status, 200, '回环 + 无头 = 放行（桌面壳就是这样调的）')
console.log('1. 回环、不带 x-selfnote 头 → 200（页面形态）')

// 1a'. 伪造 Host（DNS 重绑定）：即使本机发起也必须拒
const evil = await hitWithHost('/state', 'evil.example')
assert.equal(evil.status, 403, '非回环 Host 必须拒绝')
console.log('1c. 伪造 Host → 403（挡住 DNS 重绑定）')

// 1a''. 带了头但值是错的：说明有人在猜
r = await hit('/state', { headers: { 'x-selfnote': 'not-the-token' } })
assert.equal(r.status, 403, '错误的 x-selfnote 值必须拒绝')
console.log('1b. 错的 x-selfnote 值 → 403')

// 1b. 带上准入头 —— 相当于设置页自己
r = await hit('/state', { headers: { 'x-selfnote': token } })
assert.equal(r.status, 200)
assert.equal(r.body.ok, true)
console.log('2. 带正确请求头 → 200，正常返回状态')

// 1c. 跨 Origin（带着正确头也不行）
r = await hit('/state', { headers: { 'x-selfnote': token, origin: 'http://evil.example' } })
assert.equal(r.status, 403, '跨站 Origin 必须拒绝')
console.log('3. 跨站 Origin → 403')

// 1d. 同 Origin 放行
r = await hit('/state', { headers: { 'x-selfnote': token, origin: `http://${host}`, host } })
assert.equal(r.status, 200, '同源必须放行')
console.log('4. 同源 Origin → 200')

// 1e. 老式跨站表单提交（简单请求、text/plain、无自定义头）打写入路由
const factsPath = join(process.env.DSH_MEMORY_DIR, 'facts.jsonl')
r = await hit('/fact', {
  method: 'POST',
  headers: { 'content-type': 'text/plain', origin: 'http://evil.example' },
  body: JSON.stringify({ id: 'x', status: 'approved' }),
})
assert.equal(r.status, 403)
assert.equal(existsSync(factsPath), false, '被拒的跨站写入不能落盘')
console.log('5. 跨站 text/plain 表单写入 → 403，且没落盘')

// 1f. 外部 curl 等价物：没有 Origin 但有头 → 放行（脚本/自测要带这个头）
r = await hit('/state', { headers: { 'x-selfnote': token, accept: 'application/json' } })
assert.equal(r.status, 200)
console.log('6. curl 带 x-selfnote 头 → 200（外部脚本的用法）')

server.close()

/* ------------------------- 2. facts 写入：真实多进程并发 ------------------------- */

const { readFacts, mutateFacts } = await import('../lib/memory.js')

const rich = {
  id: 'keep',
  text: '索引只存词元，不复制正文',
  status: 'approved',
  tags: ['设计'],
  importance: 3,
  hitCount: 5,
  createdAt: '2026-10-01T00:00:00.000Z',
  updated: '2026-10-02T00:00:00.000Z',
  evidence: ['session-a#1', 'session-b#2'],
  history: [{ at: '2026-10-02T00:00:00.000Z', from: 'candidate', to: 'approved', via: 'settings' }],
}
const seed = [rich]
for (let i = 0; i < 24; i += 1) {
  seed.push({ id: 't' + i, text: '热度对象' + i, status: 'approved', hitCount: 0 })
  seed.push({ id: 'p' + i, text: '待审候选' + i, status: 'candidate' })
}
mkdirSync(process.env.DSH_MEMORY_DIR, { recursive: true })
writeFileSync(factsPath, seed.map((fact) => JSON.stringify(fact)).join('\n') + '\n')

const worker = join(here, 'worker-facts.mjs')

/**
 * 跑一批子进程，返回失败的那些。
 * touchFacts 是「软写入」（抢不到锁就这回合不记，下回合再试），压力阶段不该要求它落地；
 * 硬写入 append / approve / capture 则必须一条不丢。
 */
async function runBatch(indexes, modes = ['touch', 'append', 'approve', 'capture']) {
  const jobs = []
  for (const index of indexes) {
    for (const mode of modes) jobs.push(runWorker(worker, root, mode, index))
  }
  const results = await Promise.all(jobs)
  return results.filter((item) => item.code !== 0)
}

// 阶段 A：真实场景规模（两个窗口同时写），要求一条都不丢
const realistic = ['0', '1', '2', '3']
let failed = await runBatch(realistic)
assert.deepEqual(failed, [], '并发子进程不该失败：' + JSON.stringify(failed.slice(0, 2)))

let after = readFacts()
let byId = new Map(after.map((fact) => [fact.id, fact]))
for (const index of realistic) {
  assert.ok(byId.has('c' + index), '并发新增的候选丢了：c' + index)
  assert.ok(byId.has('t' + index), '原有事实丢了：t' + index)
  assert.equal(byId.get('t' + index).hitCount, 1, 'touchFacts 的热度没落到 t' + index)
  const approved = byId.get('p' + index)
  assert.equal(approved.status, 'approved', 'setFactStatus 没落到 p' + index)
  assert.equal(approved.history.at(-1).via, 'settings')
  assert.equal(approved.history.at(-1).from, 'candidate')
}
let capturedSources = new Set()
for (const fact of after) for (const source of fact.evidence ?? []) capturedSources.add(source)
for (const index of realistic) {
  assert.ok(capturedSources.has('cap-' + index + '#1'), 'capture-run 采集的事件丢了：cap-' + index)
}
console.log('7. 16 个并发进程（新增/热度/审核/采集各 4）：改动一条没丢')

// 阶段 B：压力（36 个硬写入进程同时写）—— 要求硬写入一条不丢、文件不坏
const stress = ['10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21']
failed = await runBatch(stress, ['append', 'approve', 'capture'])
assert.deepEqual(failed, [], '压力阶段不该有子进程报错：' + JSON.stringify(failed.slice(0, 2)))

after = readFacts()
byId = new Map(after.map((fact) => [fact.id, fact]))
let landed = 0
for (const index of stress) {
  if (byId.has('c' + index)) landed += 1
  assert.ok(byId.has('t' + index), '压力阶段丢了原有事实：t' + index)
  assert.ok(byId.has('p' + index), '压力阶段丢了原有候选：p' + index)
}
capturedSources = new Set()
for (const fact of after) for (const source of fact.evidence ?? []) capturedSources.add(source)
const captured = stress.filter((index) => capturedSources.has('cap-' + index + '#1')).length
console.log('8. 压力阶段 36 个硬写入进程：候选落地 ' + landed + '/12、采集落地 ' + captured + '/12，文件未损坏')

// 2c. 原有事实完整保留（字段一个不少，值没被改）
const kept = byId.get('keep')
assert.deepEqual(kept, rich, '已有事实被改动了：' + JSON.stringify(kept))
console.log('9. 已有事实逐字段完好（含 history / evidence / tags）')

// 2d. 锁一直被别的进程占着：放弃，不写半份
const lockPath = join(process.env.DSH_MEMORY_DIR, 'facts.jsonl.lock')
writeFileSync(lockPath, '')
const beforeBlocked = readFileSync(factsPath, 'utf8')
const lost = mutateFacts((current) => {
  current.push({ id: 'mine', text: '我的改动', status: 'candidate' })
  return { changed: true }
}, 2)
assert.equal(lost.changed, false)
assert.match(lost.error, /一直被别的进程占着/)
assert.equal(readFileSync(factsPath, 'utf8'), beforeBlocked, '放弃时文件必须原样不动')
unlinkSync(lockPath)
console.log('10. 锁被占满两次尝试 → 放弃且文件原样不动')

// 2e. 没有留下临时文件或锁
const leftovers = readdirSync(process.env.DSH_MEMORY_DIR).filter((name) => name.includes('.tmp') || name.endsWith('.lock'))
assert.deepEqual(leftovers, [], '不该留下临时文件或锁：' + leftovers.join(','))
console.log('11. 目录里没有残留临时文件或锁')

/* ------------------------------ 3. 注入预算 ------------------------------ */

const { writeNotes } = await import('../lib/store.js')
const longNote = '长'.repeat(400)
writeNotes([{ text: longNote, date: '2026-11-03' }, { text: '短的一条要留下', date: '2026-11-03' }])

const text = injectionDef.text()
assert.match(text, /短的一条要留下/, '超长条目后面那条要能进注入')
assert.equal(text.includes('长'.repeat(20)), false, '放不进预算的条目不该出现')
assert.equal(text.includes('…'), false, '不做截断，不出现省略号')
console.log('12. 超长条目被跳过，后续短条目仍进注入，且不是截断')

console.log('\n运行时验收 12 项全部通过（临时目录：' + root + '）')
process.exit(0)

function runWorker(script, dir, mode, index) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, dir, mode, index], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => {
      err += chunk.toString()
    })
    child.on('close', (code) => resolve({ code, mode, index, err }))
  })
}
