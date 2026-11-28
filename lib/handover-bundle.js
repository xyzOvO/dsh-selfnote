// 交接卡打包：把 .handover/ 拼成一份 markdown，或从这份 markdown 还原。
// 与 handover-scaffold 里的 scripts/bundle.cjs 同一套逻辑，区别是这里的版本给插件调用（ESM）。
import fs from 'node:fs'
import path from 'node:path'

export const CORE_FILES = ['CONTEXT', 'STATE', 'PROTOCOL', 'TASKS', 'HISTORY', 'JOURNAL', 'CLAIMS']
export const BUNDLE_VERSION = 1
const FENCE = '````'

function readIf(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}`
}

function isoNow(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}Z`
}

function pickField(text, key) {
  const m = String(text || '').match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
}

export function listChangesets(root) {
  const dir = path.join(root, 'CHANGESETS')
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'TEMPLATE.md')
  } catch {
    return []
  }
  return names.sort().map((name) => {
    const text = readIf(path.join(dir, name)) || ''
    return {
      name,
      id: pickField(text, 'id') || name.replace(/\.md$/, ''),
      status: pickField(text, 'status'),
      risk: pickField(text, 'risk'),
      created: pickField(text, 'created'),
      text,
    }
  })
}

function section(title, body) {
  return [`## ${title}`, '', `${FENCE}md`, String(body).replace(/\s+$/, ''), FENCE, ''].join('\n')
}

export function bundleMarkdown(root, date = new Date()) {
  const ctx = readIf(path.join(root, 'CONTEXT.md'))
  const meta = { id: pickField(ctx, 'project_id'), name: pickField(ctx, 'project_name') }
  const files = {}
  for (const name of CORE_FILES) files[name] = readIf(path.join(root, `${name}.md`))
  const missing = CORE_FILES.filter((n) => files[n] === null)
  const sets = listChangesets(root)

  const head = [
    '---',
    `handover_bundle: ${BUNDLE_VERSION}`,
    `project_id: ${meta.id}`,
    `project_name: ${meta.name}`,
    `exported_at: ${isoNow(date)}`,
    `core_files: ${CORE_FILES.length - missing.length}/${CORE_FILES.length}`,
    `changesets: ${sets.length}`,
    '---',
    '',
    `# 交接卡 · ${meta.name || meta.id || '未命名项目'}（导出 ${isoNow(date)}）`,
    '',
    '> 这份文件是一个项目 `.handover/` 的完整快照，给接手的人或 Agent 看。',
    '> 建议阅读顺序：STATE（当前工作 / 阻塞）→ TASKS（非 verified 的）→ PROTOCOL（行为约束）→ CONTEXT（边界）。',
    ...(missing.length ? [`> ⚠️ 导出时缺这些文件：${missing.join('、')}`] : []),
    '',
  ].join('\n')

  const parts = [head]
  for (const name of CORE_FILES) {
    if (files[name] === null) continue
    parts.push(section(name, files[name]))
  }
  if (sets.length) {
    parts.push('## 变更集\n')
    parts.push(
      '| id | 状态 | 风险 | 创建 |\n|---|---|---|---|\n' +
        sets.map((s) => `| ${s.id} | ${s.status || '-'} | ${s.risk || '-'} | ${s.created || '-'} |`).join('\n') +
        '\n'
    )
    for (const s of sets) parts.push(section(`CHANGESET: ${s.name}`, s.text))
  }
  return parts.join('\n')
}

export function parseBundle(markdown) {
  const text = String(markdown || '')
  const result = { meta: {}, files: {}, changesets: {} }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([a-z_]+):\s*(.*)$/)
      if (m) result.meta[m[1]] = m[2].trim()
    }
  }
  const re = new RegExp(
    '^## (CHANGESET: )?([A-Za-z0-9_.-]+)\\s*\\r?\\n\\r?\\n' + FENCE + 'md\\r?\\n([\\s\\S]*?)\\r?\\n' + FENCE,
    'gm'
  )
  let m
  while ((m = re.exec(text))) {
    const isChangeset = Boolean(m[1])
    const name = m[2]
    const body = m[3]
    if (isChangeset) result.changesets[name] = body
    else result.files[name] = body
  }
  return result
}

function backupIfExists(root) {
  if (!fs.existsSync(root)) return ''
  let hasContent = false
  try {
    hasContent = fs.readdirSync(root).some((n) => n.endsWith('.md'))
  } catch {
    hasContent = false
  }
  if (!hasContent) return ''
  const target = `${root}.bak-${stamp()}`
  fs.cpSync(root, target, { recursive: true })
  return target
}

export function importBundle(markdown, root) {
  const parsed = parseBundle(markdown)
  const names = Object.keys(parsed.files)
  if (!names.length) throw new Error('这份内容里没有找到交接卡段落（要 "## CONTEXT" 这类标题 + md 代码块）')
  const backup = backupIfExists(root)
  fs.mkdirSync(path.join(root, 'CHANGESETS'), { recursive: true })
  for (const [name, body] of Object.entries(parsed.files)) {
    fs.writeFileSync(path.join(root, `${name}.md`), body.endsWith('\n') ? body : `${body}\n`)
  }
  for (const [name, body] of Object.entries(parsed.changesets)) {
    fs.writeFileSync(path.join(root, 'CHANGESETS', name), body.endsWith('\n') ? body : `${body}\n`)
  }
  return {
    backup,
    files: Object.keys(parsed.files),
    changesets: Object.keys(parsed.changesets),
    meta: parsed.meta,
  }
}

export function bundleFileName(root, date = new Date()) {
  const meta = { id: pickField(readIf(path.join(root, 'CONTEXT.md')), 'project_id') }
  const base = meta.id || path.basename(path.resolve(root, '..')) || 'handover'
  return `handover-${base}-${stamp(date)}.md`
}
