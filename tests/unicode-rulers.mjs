/**
 * 码点尺子回归：全插件说「字」就按 Unicode 码点算，不许拿 UTF-16 .length 当尺子。
 *
 * 线上真 bug：cleanEntryText 用 .slice(0, 600) 把 🐋 的 surrogate pair 切成半个，
 * 落盘变成 U+FFFD —— 人打开 notes.md 看到的是替换字符，静默数据损坏。
 * 同一把错尺子还散在容量告警、配置落盘、各层「最多 N 字」校验里（含 emoji 会被误拒）。
 *
 * 跑法：node tests/unicode-rulers.mjs（自带临时目录隔离，不碰真实记忆）
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-rulers-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = join(dir, 'sessions')
process.env.DSH_SELFNOTE_NO_OPEN = '1'
mkdirSync(join(dir, 'memory'), { recursive: true })
mkdirSync(join(dir, 'sessions'), { recursive: true })

const WHALE = '\u{1F40B}' // 1 个码点 / 2 个 UTF-16 单位
const points = (s) => [...String(s)].length
const hasReplacement = (s) => String(s).includes('\uFFFD')
const hasLoneSurrogate = (s) => [...String(s)].some((ch) => {
  const c = ch.codePointAt(0)
  return c >= 0xd800 && c <= 0xdfff
})

const store = await import('../lib/store.js')
const { apply, currentAuthToken } = await import('../lib/index.js')
const HOST = '127.0.0.1:56645'

let handler = null
let injectionText = () => ''
const tools = []
apply(
  {
    logger: { info() {} },
    on() { return () => {} },
    agents: { currentInitiator: () => ({ session: { header: { id: 'rulers' } } }) },
    systemPrompt: {
      context(def) { injectionText = () => def.text(); return () => {} },
    },
    tools: { register(def) { tools.push(def); return () => {} } },
    webServer: {
      register(route) { handler = route.handler; return () => {} },
    },
  },
  { enabled: true },
)

function call(method, url, body) {
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
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
}

/* 1. 单条自述硬上限按码点截：600 码点里最后一个是 emoji，不许切出半个代理 */
{
  store.writeNotes([])
  const text = 'a'.repeat(599) + WHALE // 600 码点 / 601 UTF-16 单位
  assert.equal(points(text), 600)
  assert.equal(text.length, 601)
  store.appendNote(text, { maxChars: 1600, maxEntries: 40 }, { tier: 'stable' })
  const stored = store.readNotes().at(-1).text
  const raw = readFileSync(store.notesPath(), 'utf8')
  assert.equal(stored, text, '600 码点要原样存下，不能把 🐋 切成半个或换成 U+FFFD')
  assert.equal(hasReplacement(raw), false, '落盘文件不许出现替换字符')
  assert.equal(hasLoneSurrogate(stored), false, '不许留下孤立代理')
  console.log('1. 单条 600 码点（末尾 emoji）→ 完整落盘，无 U+FFFD')
}

/* 2. 容量告警里的「N 字」按码点报，别拿 UTF-16 冒充 */
{
  store.writeNotes([])
  writeFileSync(store.notesPath(), [
    store.renderNotes([{ date: '2026-11-08', text: 'T1', tier: 'temp', pin: false }]),
    store.renderNotes([{ date: '2026-11-08', text: 'T2', tier: 'temp', pin: false }]),
  ].join('\n') + '\n')
  const long = 'b'.repeat(150) + WHALE // 151 码点 / 152 UTF-16 单位；stableLimit = 150
  const res = await tools[0].execute({ action: 'write', text: long, tier: 'stable' })
  assert.match(res.warning, /151 字/, '文案要按码点说 151 字：' + JSON.stringify(res.warning))
  assert.doesNotMatch(res.warning, /152 字/, '不许用 UTF-16 的 152 冒充字数')
  console.log('2. 容量告警字数 → 按码点 151，不报 152')
}

/* 3. 配置落盘：profileOverride 240 码点末尾是 emoji，不许切半个 */
{
  const override = 'p'.repeat(239) + WHALE // 240 码点 / 241 UTF-16 单位
  const r = await call('POST', '/api/selfnote/config', { profileOverride: override })
  assert.equal(r.status, 200)
  const saved = JSON.parse(readFileSync(store.configPath(), 'utf8')).profileOverride
  assert.equal(saved, override, '240 码点要完整落盘')
  assert.equal(hasReplacement(saved), false, 'config.json 不许出现替换字符')
  assert.equal(hasLoneSurrogate(saved), false, 'config.json 不许留下孤立代理')
  console.log('3. profileOverride 240 码点（末尾 emoji）→ 完整落盘')
}

/* 4. noteGuide / heading 的「N 字」校验按码点，含 emoji 不误拒 */
{
  const guide = '很'.repeat(79) + WHALE // 80 码点 / 81 UTF-16 单位
  const r = await call('POST', '/api/selfnote/config', { noteGuide: guide })
  assert.equal(r.status, 200, '80 码点的 noteGuide 不该被当成 81 字拒掉：' + JSON.stringify(r.payload))
  const heading = '标'.repeat(23) + WHALE // 24 码点 / 25 UTF-16 单位
  const r2 = await call('POST', '/api/selfnote/config', { heading })
  assert.equal(r2.status, 200, '24 码点的抬头不该被当成 25 字拒掉：' + JSON.stringify(r2.payload))
  console.log('4. noteGuide / heading 校验 → 按码点，不误拒 emoji')
}

/* 5. 注入文本不许出现半个 emoji（覆盖 currentConfig 的截断路径） */
{
  const text = injectionText()
  assert.equal(hasReplacement(text), false, '注入文本里不许有替换字符')
  assert.equal(hasLoneSurrogate(text), false, '注入文本里不许有孤立代理')
  console.log('5. 注入文本 → 完整码点，无 U+FFFD / 孤立代理')
}

/* 6. 各存储层「最多 N 字」校验与 chars 同样按码点 */
{
  const warm = await import('../lib/warm.js')
  const memory = await import('../lib/memory.js')
  const profile = await import('../lib/profile.js')

  const summary = 'x'.repeat(299) + WHALE // 300 码点 / 301 UTF-16 单位
  const w = warm.writeSummary({ text: summary, pointers: [{ sessionId: 's', index: 0 }] })
  assert.equal(w.ok, true, '300 码点摘要不该被 301 拒掉：' + JSON.stringify(w))

  const habit = 'h'.repeat(79) + WHALE // 80 码点 / 81 UTF-16 单位
  const h = memory.setHabit(habit, 'active')
  assert.equal(h.ok, true, '80 码点习惯不该被 81 拒掉：' + JSON.stringify(h))

  const body = 'x'.repeat(59) + WHALE // 60 码点 / 61 UTF-16 单位
  const p = profile.buildProfile(
    [{ id: 'f1', status: 'approved', text: body, tags: ['标签'], created: '2026-11-08' }],
    { maxChars: 120, pieceMax: 60 },
  )
  assert.equal(p.parts.length, 1, '60 码点的画像句不该被 61 跳过')
  assert.equal(p.chars, points(p.text), 'buildProfile 的 chars 要按码点算')
  console.log('6. warm / habit / buildProfile → 校验与 chars 都按码点')
}

console.log('\n6 项全部通过')
process.exit(0)
