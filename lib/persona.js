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

const TITLE_RE = /^#{1,6}\s*(.*)$/

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
