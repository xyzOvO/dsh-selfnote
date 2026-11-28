#!/usr/bin/env node
// 交接卡导入导出：把一个项目的 .handover/ 打包成一份 markdown，或从这份 markdown 还原。
// 零依赖，只用 node 内置模块。既能被 shell 直接调用，也能被插件 require 进来复用。
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const CORE_FILES = ['CONTEXT', 'STATE', 'PROTOCOL', 'TASKS', 'HISTORY', 'JOURNAL', 'CLAIMS']
const BUNDLE_VERSION = 1
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

function projectMeta(ctxText) {
  const text = ctxText || ''
  const pick = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  }
  return { id: pick('project_id'), name: pick('project_name') }
}

function listChangesets(root) {
  const dir = path.join(root, 'CHANGESETS')
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'TEMPLATE.md')
  } catch {
    return []
  }
  return names.sort().map((name) => {
    const text = readIf(path.join(dir, name)) || ''
    const pick = (key) => {
      const m = text.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
      return m ? m[1].trim() : ''
    }
    return { name, id: pick('id') || name.replace(/\.md$/, ''), status: pick('status'), risk: pick('risk'), created: pick('created'), text }
  })
}

function section(title, body) {
  return [`## ${title}`, '', FENCE + 'md', body.replace(/\s+$/, ''), FENCE, ''].join('\n')
}

function bundleMarkdown(root, date = new Date()) {
  const ctx = readIf(path.join(root, 'CONTEXT.md'))
  const meta = projectMeta(ctx)
  const files = {}
  for (const name of CORE_FILES) files[name] = readIf(path.join(root, `${name}.md`))
  const missing = CORE_FILES.filter((n) => files[n] === null)
  const sets = listChangesets(root)

  const headLines = [
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
  ]
  if (missing.length) headLines.push(`> ⚠️ 导出时缺这些文件：${missing.join('、')}`)
  headLines.push('')
  const head = headLines.join('\n')

  const parts = [head]
  for (const name of CORE_FILES) {
    if (files[name] === null) continue
    parts.push(section(name, files[name]))
  }
  if (sets.length) {
    parts.push('## 变更集\n')
    parts.push('| id | 状态 | 风险 | 创建 |\n|---|---|---|---|\n' + sets.map((s) => `| ${s.id} | ${s.status || '-'} | ${s.risk || '-'} | ${s.created || '-'} |`).join('\n') + '\n')
    for (const s of sets) parts.push(section(`CHANGESET: ${s.name}`, s.text))
  }
  return parts.join('\n')
}

function parseBundle(markdown) {
  const text = String(markdown || '')
  const result = { meta: {}, files: {}, changesets: {} }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([a-z_]+):\s*(.*)$/)
      if (m) result.meta[m[1]] = m[2].trim()
    }
  }
  const re = new RegExp(`^## (CHANGESET: )?([A-Za-z0-9_.-]+)\\s*\\r?\\n\\r?\\n\`\`\`\`md\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`\``, 'gm')
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
  const target = `${root}.bak-${stamp()}`
  fs.cpSync(root, target, { recursive: true })
  return target
}

function importBundle(markdown, root) {
  const parsed = parseBundle(markdown)
  const names = Object.keys(parsed.files)
  if (!names.length) throw new Error('这份文件里没有找到任何交接卡段落（需要 "## CONTEXT" 这类标题 + `````md 代码块）')
  const backup = backupIfExists(root)
  fs.mkdirSync(path.join(root, 'CHANGESETS'), { recursive: true })
  for (const [name, body] of Object.entries(parsed.files)) {
    fs.writeFileSync(path.join(root, `${name}.md`), body.endsWith('\n') ? body : `${body}\n`)
  }
  for (const [name, body] of Object.entries(parsed.changesets)) {
    fs.writeFileSync(path.join(root, 'CHANGESETS', name), body.endsWith('\n') ? body : `${body}\n`)
  }
  return { backup, files: Object.keys(parsed.files), changesets: Object.keys(parsed.changesets), meta: parsed.meta }
}

function usage() {
  return [
    '用法：',
    '  node bundle.cjs export [--root <项目根>] [--out <文件>]',
    '  node bundle.cjs import --file <包.md> [--root <项目根>]',
    '',
    '默认 root = 当前目录；export 默认输出到 stdout。',
  ].join('\n')
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else out[key] = true
    } else out._.push(a)
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  const root = path.resolve(args.root || process.cwd())
  if (cmd === 'export') {
    const md = bundleMarkdown(root)
    if (args.out) {
      fs.writeFileSync(path.resolve(args.out), md)
      console.error(`已导出：${path.resolve(args.out)}（${md.length} 字符）`)
    } else process.stdout.write(md)
    return
  }
  if (cmd === 'import') {
    if (!args.file) throw new Error('import 需要 --file <包.md>')
    const md = fs.readFileSync(path.resolve(args.file), 'utf8')
    const r = importBundle(md, root)
    console.error(`已导入到 ${root}：${r.files.length} 个核心文件、${r.changesets.length} 个变更集${r.backup ? `；原目录已备份为 ${r.backup}` : ''}`)
    return
  }
  console.error(usage())
  process.exit(cmd ? 1 : 0)
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error(`出错：${err.message}`)
    process.exit(1)
  }
}

module.exports = { bundleMarkdown, parseBundle, importBundle, CORE_FILES, BUNDLE_VERSION }
