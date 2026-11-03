/**
 * 性能探针（不属于测试套件）：/state 的真实延迟。
 * 跑法：node tests/perf-state.mjs
 *
 * 用真实会话目录（只读扫描）+ 真实记忆目录的副本，所以测出来的数字跟设置页一致。
 */

import { cpSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()
const realMemory = join(home, '.dsh', 'memory')
const realSessions = join(home, '.dsh', 'sessions')

const work = mkdtempSync(join(tmpdir(), 'selfnote-perf-'))
process.env.DSH_MEMORY_DIR = join(work, 'memory')
process.env.DSH_SESSIONS_DIR = realSessions
try {
  cpSync(realMemory, process.env.DSH_MEMORY_DIR, { recursive: true })
} catch {
  /* 没有记忆目录就用空的 */
}

const { apply, currentAuthToken } = await import('../lib/index.js')

let handler = null
const ctx = {
  logger: { info() {} },
  on() {},
  systemPrompt: { context() { return () => {} } },
  tools: { register() { return () => {} } },
  webServer: { register(route) { handler = route.handler; return () => {} } },
}
apply(ctx, {})
const token = currentAuthToken()

const server = http.createServer((req, res) => handler(req, res).catch(() => { res.statusCode = 500; res.end('{}') }))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

async function hit(path) {
  const started = performance.now()
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-selfnote': token } })
  const body = await res.text()
  return { ms: Math.round(performance.now() - started), status: res.status, body }
}

for (let i = 1; i <= 3; i += 1) {
  const r = await hit('/state')
  let summary = ''
  try {
    const j = JSON.parse(r.body)
    summary = `index.sessions=${j.index?.sessions} disk=${j.index?.disk} fresh=${j.index?.fresh} files=${j.files?.length}`
  } catch {
    summary = r.body.slice(0, 80)
  }
  console.log(`#${i} /state ${r.ms}ms (${r.status}) ${summary}`)
}

const single = await hit('/state')
console.log(`单次 /state：${single.ms}ms`)

server.close()
console.log(`data dir: ${work}`)
process.exit(0)
