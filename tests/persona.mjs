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

rmSync(dir, { recursive: true, force: true })
