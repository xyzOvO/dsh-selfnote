// persona.md：三段（L0 核心身份 / L1 行为规则 / L2 扩展设定）的解析、渲染与字符计数。
//
// 计数口径是全插件唯一的：按 Unicode 码点（[...text].length）。
// ZWJ 组合 emoji（如 👨‍👩‍👧 五个码点）会算成多个 —— 这是统一的预算单位，
// 不要在任何界面或文档里说成「视觉上一个 emoji 只算一个字」。
//
// 解析规则见 docs/分层人格-20261105.md §4：
//   - 先去掉 BOM、把 CRLF 规整成 LF
//   - `## L0` / `## L1` / `## L2`（也认「核心身份 / 行为规则 / 扩展设定」）开新段，标题行本身丢弃
//   - 同一层出现两次 → 用换行拼接
//   - 标题在、正文空 → 这一层当不存在（返回空串）
//   - 全篇没有可认的标题 → 整篇进 L1，sectionless = true
//   - 认不出的标题行原样留在正文里（不吞内容）

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { writeAtomic, writeJsonAtomic } from './atomic.js'
import { selfnoteRoot } from './store.js'

const TITLE_RE = /^#{1,6}\s*(.*)$/

// L0 硬上限 = 320 × 0.25；L0 + L1 硬顶 320；整份文件（含 L2）上限 8000。
export const PERSONA_L0_MAX = 80
export const PERSONA_TOTAL = 320
export const MAX_PERSONA_CHARS = 8000
export const MAX_PERSONA_BYTES = 1024 * 1024

export class PersonaValidationError extends Error {
  constructor(message, code = 'total-too-long') {
    super(message)
    this.name = 'PersonaValidationError'
    this.code = code
  }
}

const ZH_LABELS = [
  ['核心身份', 'l0'],
  ['行为规则', 'l1'],
  ['扩展设定', 'l2'],
]

function tierOfLine(line) {
  const match = TITLE_RE.exec(line)
  if (!match) return null
  const label = match[1].trim()
  const head = label.toUpperCase()
  if (/^L0\b/.test(head)) return 'l0'
  if (/^L1\b/.test(head)) return 'l1'
  if (/^L2\b/.test(head)) return 'l2'
  for (const [word, tier] of ZH_LABELS) {
    if (label.startsWith(word)) return tier
  }
  return null
}

function joinBlocks(blocks) {
  return blocks
    .map((lines) => lines.join('\n').replace(/^\n+|\n+$/g, ''))
    .filter((text) => text !== '')
    .join('\n')
}

export function countChars(text) {
  return [...String(text ?? '')].length
}

export function parsePersona(raw) {
  const text = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
  if (text.trim() === '') return { l0: '', l1: '', l2: '', sectionless: true }

  const blocks = { l0: [], l1: [], l2: [] }
  const orphan = []
  let current = null

  for (const line of text.split('\n')) {
    const tier = tierOfLine(line)
    if (tier !== null) {
      current = tier
      blocks[tier].push([])
      continue
    }
    if (current === null) {
      orphan.push(line)
      continue
    }
    blocks[current][blocks[current].length - 1].push(line)
  }

  const sectionless = current === null
  if (sectionless) {
    return { l0: '', l1: text.replace(/^\n+|\n+$/g, ''), l2: '', sectionless: true }
  }

  // 第一个标题之前的零散行不丢：并入 L1 的最前面
  if (orphan.length > 0) {
    const lead = orphan.join('\n').replace(/^\n+|\n+$/g, '')
    if (lead !== '') blocks.l1.unshift([lead])
  }

  return {
    l0: joinBlocks(blocks.l0),
    l1: joinBlocks(blocks.l1),
    l2: joinBlocks(blocks.l2),
    sectionless: false,
  }
}

const HEADINGS = [
  ['l0', '## L0 核心身份'],
  ['l1', '## L1 行为规则'],
  ['l2', '## L2 扩展设定'],
]

export function renderPersona({ l0 = '', l1 = '', l2 = '' } = {}) {
  const parts = []
  for (const [key, heading] of HEADINGS) {
    const body = String({ l0, l1, l2 }[key] ?? '').replace(/^\n+|\n+$/g, '')
    if (body === '') continue
    parts.push(`${heading}\n${body}`)
  }
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`
}

export function personaPath() {
  return join(selfnoteRoot(), 'persona.md')
}

// 逐段比，错误文案逐字对应 spec §3.2 / §8：
//   L0 现有 92 字，超过 80 字上限
//   L0 72 + L1 249 = 321，超了 1 字
//   合计 8213 字，超过 8000 字上限
export function validatePersona({ l0 = '', l1 = '', l2 = '' } = {}) {
  const a = countChars(l0)
  const b = countChars(l1)
  const c = countChars(l2)
  if (a > PERSONA_L0_MAX) {
    return { ok: false, code: 'l0-too-long', error: `L0 现有 ${a} 字，超过 ${PERSONA_L0_MAX} 字上限` }
  }
  if (a + b > PERSONA_TOTAL) {
    return { ok: false, code: 'total-too-long', error: `L0 ${a} + L1 ${b} = ${a + b}，超了 ${a + b - PERSONA_TOTAL} 字` }
  }
  if (a + b + c > MAX_PERSONA_CHARS) {
    return { ok: false, code: 'file-too-long', error: `合计 ${a + b + c} 字，超过 ${MAX_PERSONA_CHARS} 字上限` }
  }
  return { ok: true }
}

const EMPTY_PERSONA = { l0: '', l1: '', l2: '', sectionless: true, chars: 0, truncated: false }

// 读文件不截断：运行期怎么装进 320 是注入层的事（Task 3），
// 这里只负责「读不出内容时别抛给上层」。
export function readPersona() {
  const file = personaPath()
  let size
  try {
    size = statSync(file).size
  } catch {
    return { ...EMPTY_PERSONA, error: 'missing' }
  }
  if (size > MAX_PERSONA_BYTES) return { ...EMPTY_PERSONA, error: 'not-text' }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { ...EMPTY_PERSONA, error: 'not-text' }
  }
  if (raw.includes('\0')) return { ...EMPTY_PERSONA, error: 'not-text' }
  const parsed = parsePersona(raw)
  return {
    ...parsed,
    chars: countChars(parsed.l0) + countChars(parsed.l1) + countChars(parsed.l2),
    truncated: false,
    error: '',
  }
}

export function savePersonaFile({ l0 = '', l1 = '', l2 = '' } = {}) {
  const verdict = validatePersona({ l0, l1, l2 })
  if (!verdict.ok) throw new PersonaValidationError(verdict.error, verdict.code)
  writeAtomic(personaPath(), renderPersona({ l0, l1, l2 }))
}

/* ---------------- 取用记账：L2 到底有没有人看 ---------------- */

const STATS_PATH = join(selfnoteRoot(), 'persona.reads.json')

export function personaStatsPath() {
  return STATS_PATH
}

/**
 * 读「取用过几次」。
 * 记这个不为统计好看：L2 是设了不看的死配置，30 天没人取就得在体检里说一声。
 */
export function readPersonaStats() {
  try {
    const raw = JSON.parse(readFileSync(STATS_PATH, 'utf8'))
    return {
      reads: Number.isFinite(Number(raw?.reads)) ? Number(raw.reads) : 0,
      lastReadAt: typeof raw?.lastReadAt === 'string' ? raw.lastReadAt : '',
    }
  } catch {
    return { reads: 0, lastReadAt: '' }
  }
}

/** 只有「真的取到了一段非空 L2」才计数：取了个空壳不算有人看过。 */
export function notePersonaRead(now = new Date()) {
  const before = readPersonaStats()
  const next = { reads: before.reads + 1, lastReadAt: now.toISOString() }
  try {
    writeJsonAtomic(STATS_PATH, next)
  } catch {
    /* 记不上账不该影响这次取用 */
  }
  return next
}
