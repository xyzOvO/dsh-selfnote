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

rmSync(dir, { recursive: true, force: true })
