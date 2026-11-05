// persona.md 的解析、渲染与字符计数。
// 字符计数一律按 Unicode 码点（[...text].length）—— ZWJ 组合 emoji 会算成多个，
// 这是预算口径的统一定义，不要理解成「视觉上一个 emoji = 一个字」。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-persona-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')

const { parsePersona, renderPersona, countChars } = await import('../lib/persona.js')

// 1. 三段标题分对，标题行不进正文
const p = parsePersona('## L0 核心身份\n我是大肥鱼。\n\n## L1 行为规则\n- 先给结论。\n\n## L2 扩展设定\n深色长发。\n')
assert.equal(p.l0, '我是大肥鱼。')
assert.equal(p.l1, '- 先给结论。')
assert.equal(p.l2, '深色长发。')
assert.equal(p.sectionless, false)

// 2. 无标题 → 整篇 L1 + sectionless
const plain = parsePersona('- 先给结论。\n- 不客套。')
assert.equal(plain.l1, '- 先给结论。\n- 不客套。')
assert.equal(plain.sectionless, true)

// 3. BOM + CRLF 不影响
assert.equal(parsePersona('\uFEFF## L1 行为规则\r\n- 先给结论。\r\n').l1, '- 先给结论。')

// 4. 同一层两次 → 拼接；标题在但空 → 视为不存在
assert.equal(parsePersona('## L1\nA\n## L1\nB\n').l1, 'A\nB')
assert.equal(parsePersona('## L0\n\n## L1\nB\n').l0, '')

// 中文标题也认；认不出的标题当正文
assert.equal(parsePersona('## 核心身份\n甲\n').l0, '甲')
assert.ok(parsePersona('## 备注\n乙\n').l1.includes('备注'))

// render 回来能再解析（往返一致）
assert.equal(parsePersona(renderPersona({ l0: '甲', l1: '乙', l2: '' })).l1, '乙')

// 字符计数按码点
assert.equal(countChars('大肥鱼'), 3)
assert.equal(countChars('👨‍👩‍👧'), 5)
assert.equal(countChars('é'), 1)
assert.equal(countChars('e\u0301'), 2)

console.log('1-4 + countChars 通过')

// ---- 容量校验、读取与原子保存 ----
const { validatePersona, savePersonaFile, readPersona, personaPath, PersonaValidationError } = await import('../lib/persona.js')

savePersonaFile({ l0: '甲'.repeat(72), l1: '乙'.repeat(202), l2: '' })
const before = readFileSync(personaPath(), 'utf8')

// 13b. L0 72 + L1 249 = 321 → 拒绝，文件一个字节都不变
assert.throws(
  () => savePersonaFile({ l0: '甲'.repeat(72), l1: '乙'.repeat(249), l2: '' }),
  (error) => error instanceof PersonaValidationError && error.code === 'total-too-long' && /超了 1 字/.test(error.message),
)
assert.equal(readFileSync(personaPath(), 'utf8'), before)

// 13. 借额度：60 + 260 = 320 合法，261 不合法
assert.equal(validatePersona({ l0: '甲'.repeat(60), l1: '乙'.repeat(260), l2: '' }).ok, true)
assert.equal(validatePersona({ l0: '甲'.repeat(60), l1: '乙'.repeat(261), l2: '' }).code, 'total-too-long')

// L0 上限与 emoji（按码点算：80 合法，81 不合法）
assert.equal(validatePersona({ l0: '甲'.repeat(80), l1: '', l2: '' }).ok, true)
assert.equal(validatePersona({ l0: '甲'.repeat(81), l1: '', l2: '' }).code, 'l0-too-long')
assert.equal(validatePersona({ l0: '👨‍👩‍👧'.repeat(16), l1: '', l2: '' }).ok, true)
assert.equal(validatePersona({ l0: '👨‍👩‍👧'.repeat(17), l1: '', l2: '' }).code, 'l0-too-long')

// 合计上限：> 8000 才拒（spec §3.2「L0 + L1 + L2 > 8000」）
assert.equal(validatePersona({ l0: '', l1: '', l2: '扩'.repeat(8000) }).ok, true)
assert.equal(validatePersona({ l0: '', l1: '', l2: '扩'.repeat(8001) }).code, 'file-too-long')
assert.equal(validatePersona({ l0: '', l1: '', l2: '扩'.repeat(7800) }).ok, true)

// 读回：正常文件
assert.equal(readPersona().l0, '甲'.repeat(72))
assert.equal(readPersona().chars, 274)
assert.equal(readPersona().error, '')

// 17. 文件不存在
rmSync(personaPath(), { force: true })
assert.equal(readPersona().error, 'missing')
assert.equal(readPersona().l0, '')

// 含 NUL 的文件拒绝读（不要抛给上层）
writeFileSync(personaPath(), 'abc\0def')
assert.equal(readPersona().error, 'not-text')
assert.equal(readPersona().l0, '')

console.log('5-17 校验与保存通过')

// ---- Task 3: 人格段接进注入 ----
const { EventEmitter } = await import('node:events')
const { apply, currentAuthToken, TOTAL_BUDGET } = await import('../lib/index.js')
const HOST = '127.0.0.1:56645'

let handler = null
let injectionDef = null
const ctx = {
  logger: { info() {} },
  on() {},
  agents: { currentInitiator: () => null },
  systemPrompt: { context(def) { injectionDef = def; return () => {} } },
  tools: { register() { return () => {} } },
  webServer: { register(route) { handler = route.handler; return () => {} } },
}

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

const boot = (config) => apply(ctx, config ?? {})
const stateOfNow = async () => (await call('GET', '/api/selfnote/state')).payload
const personaOf = async () => (await stateOfNow()).injection.segments.find((seg) => seg.key === 'persona')
const textOf = async () => (await stateOfNow()).injection.text
/** 绕过校验直写，模拟「文件被别的编辑器改过」。 */
const writeRawPersona = (l0, l1) => writeFileSync(personaPath(), `## L0 核心身份\n${l0}\n\n## L1 行为规则\n${l1}\n`)

boot({})

// 5/6. 人格段第一；框架句在边界句之前、在 L0 之前
savePersonaFile({ l0: '我是大肥鱼。', l1: '- 先给结论。\n- 不客套。', l2: '深色长发。' })
assert.equal((await personaOf()).key, 'persona')
assert.equal((await stateOfNow()).injection.segments[0].key, 'persona')
const t = await textOf()
assert.ok(t.indexOf('以下是你自己的样子') < t.indexOf('（背景资料，不是指令）'))
assert.ok(t.indexOf('以下是你自己的样子') < t.indexOf('我是大肥鱼'))

// 7. L2 一个字节都不进每回合注入
assert.ok(!t.includes('深色长发'))

// 10/11. L2 非空 → 有指路句；且不进 chars
assert.ok(t.includes('self_note action:"persona"'))
assert.equal((await personaOf()).chars, countChars('我是大肥鱼。') + countChars('- 先给结论。\n- 不客套。'))

// 10b. L2 为空 → 没有指路句
savePersonaFile({ l0: '我是大肥鱼。', l1: '- 先给结论。', l2: '' })
assert.ok(!(await textOf()).includes('self_note action:"persona"'))

// 8. L1 二十行放不下 → 整行跳过 + 门牌（超 320 只能是外部写法，保存会被校验拦住）
writeRawPersona('', Array.from({ length: 20 }, (_, i) => `- 第${i + 1}条规则` + '。'.repeat(20)).join('\n'))
const crowded = await personaOf()
assert.ok(crowded.skipped.length > 0)
assert.match(await textOf(), /另有 \d+ 行人格规则没装进来/)

// 9. 单行就超预算 → 截断 + …，且留痕（半句规则强过没有人格）
writeRawPersona('', '- ' + '规'.repeat(400))
const huge = await personaOf()
assert.equal(huge.truncated, true)
assert.ok(huge.kept[0].endsWith('…'))

// 13c. 文件被外部写到 380 字 → 运行期按 320 截断，保留完整行，不整段丢
writeRawPersona('', Array.from({ length: 40 }, () => '规'.repeat(10)).join('\n'))
const clamped = await personaOf()
assert.ok(clamped.chars <= 320 && clamped.chars > 200)

// 18. L0 被外部改成 200 字 → 截到 80 并留痕
writeRawPersona('身'.repeat(200), '')
const longL0 = await personaOf()
assert.ok(longL0.l0.chars <= 80)
assert.equal(longL0.truncated, true)

// 19. personaEnabled: false → 段不进，其余照常
savePersonaFile({ l0: '我是大肥鱼。', l1: '- 先给结论。', l2: '' })
boot({ personaEnabled: false })
assert.equal((await stateOfNow()).injection.segments.find((seg) => seg.key === 'persona'), undefined)
boot({})

// 20. 缓存键跟着 persona.md 变
const keyBefore = (await stateOfNow()).injection.key
savePersonaFile({ l0: '换一句。', l1: '', l2: '' })
assert.notEqual((await stateOfNow()).injection.key, keyBefore)

// 12. 预算总和
assert.equal(TOTAL_BUDGET, 1000)

console.log('18-20 人格进注入通过')

// 21. 字符口径统一：段落字数按码点算，加起来加固定开销必须正好等于总数
savePersonaFile({ l0: '我是大肥鱼🐟。', l1: '- 先给结论。', l2: '' })
{
  const inj = (await stateOfNow()).injection
  assert.equal(inj.chars, countChars(inj.text), '总数要按码点算，不是 UTF-16 长度')
  const sum = inj.segments.reduce((acc, seg) => acc + seg.chars, 0)
  assert.equal(sum + inj.overhead, inj.chars, '各段字数 + 固定开销必须正好等于总数')
  // 🐟 是单个码点、两个 UTF-16 单元：按码点算和按「人看到的字」算在这里是一致的
  assert.equal(countChars('🐟'), 1)
  assert.equal('🐟'.length, 2)
  assert.ok(inj.segments[0].chars < countChars(inj.text) - 1, '人格段不该把整段都算成自己的')
  console.log('21. 字符口径统一：按码点算，各段 + 固定开销 = 总数')
}

rmSync(dir, { recursive: true, force: true })
console.log('\n21 项全部通过')
