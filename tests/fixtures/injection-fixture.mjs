/**
 * Task 2 夹具：一套完全确定的临时数据，给「字节级注入文本 + overhead」当基线。
 *
 * 直接跑 `node tests/fixtures/injection-fixture.mjs` 会生成两个基线文件；
 * 被 tests/skipped.mjs 引用时只导出 bootFixture() 与几个正文常量。
 *
 * 注意：三个 DSH_* 环境变量必须在第一次 await import('../lib/index.js') 之前设好，
 * 因为 apply() 里的 initAuthToken() 会按这些路径落文件。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)

export const DUP_TEXT = '自述重复-' + 'x'.repeat(48)
export const CROSS_TEXT = '同文跨型-' + 'x'.repeat(48)
export const EXPIRED_DUP_TEXT = '过期重复-' + 'x'.repeat(48)
export const CORE_TEXT = '核心素材'

export const TEXT_BASELINE_URL = new URL('./injection-text-baseline.txt', import.meta.url)
export const OVERHEAD_BASELINE_URL = new URL('./injection-overhead-baseline.txt', import.meta.url)

/** 过期日期相对生成：30 天前，tempTtlDays=14，必定判为过期。 */
function oldDate() {
  return new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
}

/** 12 条自述，文件里从旧到新（renderNotes 最新在后）。正文写死长度，字节基线才确定。 */
function notesBody() {
  const d = oldDate()
  const lines = [
    `- ${d} ${DUP_TEXT}`,                        // 1 stable（同文重复）
    `- ${d} ${DUP_TEXT}`,                        // 2 stable（同文重复）
    `- ${d} [核心] ${CORE_TEXT}`,                // 3 core
    `- ${d} ${CROSS_TEXT}`,                      // 4 stable（与 #5 同文）
    `- ${d} [临时] ${CROSS_TEXT}`,              // 5 temp 过期（与 #4 同文）
    `- ${d} [临时] ${EXPIRED_DUP_TEXT}`,         // 6 temp 过期（同文重复）
    `- ${d} [临时] ${EXPIRED_DUP_TEXT}`,         // 7 temp 过期（同文重复）
  ]
  for (let i = 8; i <= 12; i += 1) {
    lines.push(`- ${d} 自述-${i}-` + 'x'.repeat(48)) // 8-12 stable，撑满预算
  }
  return lines.join(NL) + NL
}

/** 恰好 1 条 approved fact（rel 通道 → 走结论段）、1 条 active habit；条目数固定，rankByHeat 不受 Date.now() 影响。 */
function factsBody() {
  return JSON.stringify({ id: 'fx-1', text: '结论：先给结果再展开', status: 'approved' }) + NL
}
function habitsBody() {
  return JSON.stringify({ id: 'hb-1', text: '回答用中文', status: 'active' }) + NL
}

export async function bootFixture() {
  const selfnoteDir = mkdtempSync(join(tmpdir(), 'selfnote-a-notes-'))
  const memoryDir = mkdtempSync(join(tmpdir(), 'selfnote-a-memory-'))
  const sessionsDir = mkdtempSync(join(tmpdir(), 'selfnote-a-sessions-'))
  process.env.DSH_SELFNOTE_DIR = selfnoteDir
  process.env.DSH_MEMORY_DIR = memoryDir
  process.env.DSH_SESSIONS_DIR = sessionsDir
  process.env.DSH_SELFNOTE_NO_OPEN = '1'

  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(selfnoteDir, 'config.json'), JSON.stringify({
    enabled: true,
    personaEnabled: false,
    profileEnabled: false,
    heading: 'AI记忆',
    noteGuide: '',
    tempTtlDays: 14,
    halfLifeDays: 30,
  }), 'utf8')
  writeFileSync(join(selfnoteDir, 'persona.md'), '', 'utf8')
  writeFileSync(join(selfnoteDir, 'notes.md'), notesBody(), 'utf8')
  writeFileSync(join(memoryDir, 'facts.jsonl'), factsBody(), 'utf8')
  writeFileSync(join(memoryDir, 'habits.jsonl'), habitsBody(), 'utf8')

  const { apply, currentAuthToken } = await import('../../lib/index.js')
  const HOST = '127.0.0.1:56645'
  const authHeaders = () => ({ 'x-selfnote': currentAuthToken(), host: HOST })

  let handler = null
  let injectionDef = null
  const ctx = {
    logger: { info() {}, warn() {} },
    on() {},
    agents: { currentInitiator: () => null },
    systemPrompt: { context(def) { injectionDef = def; return () => {} } },
    tools: { register() { return () => {} } },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  apply(ctx, {})

  function call(method, url, body, headers) {
    return new Promise((done, fail) => {
      const req = new EventEmitter()
      req.method = method
      req.url = url
      req.headers = headers ?? authHeaders()
      const res = {
        status: 0,
        payload: null,
        writeHead(status) { this.status = status },
        end(text) { this.payload = JSON.parse(text); done(this) },
      }
      handler(req, res).catch(fail)
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
      req.emit('end')
    })
  }

  return {
    injectionText: () => injectionDef.text(),
    state: () => call('GET', '/api/selfnote/state'),
    notesPath: () => join(selfnoteDir, 'notes.md'),
    configPath: () => join(selfnoteDir, 'config.json'),
    selfnoteDir,
    cleanup() {
      for (const dir of [selfnoteDir, memoryDir, sessionsDir]) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录，删不掉就算了 */ }
      }
    },
  }
}

/** 仅在直接运行时生成两个基线文件。 */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const f = await bootFixture()
  const text = f.injectionText()
  const st = (await f.state()).payload
  writeFileSync(TEXT_BASELINE_URL, text, 'utf8')
  writeFileSync(OVERHEAD_BASELINE_URL, String(st.injection.overhead) + NL, 'utf8')
  console.log('injection-text-baseline.txt bytes:', Buffer.byteLength(text, 'utf8'))
  console.log('injection-overhead-baseline.txt:', String(st.injection.overhead))
  f.cleanup()
}
