/**
 * selfnote 的存储层：把「AI 写给自己看的叙述」落成纯文本，零依赖。
 *
 * 目录（默认 <DSH_HOME>/selfnote，可用 DSH_SELFNOTE_DIR 覆盖）：
 *   notes.md              当前生效的自述，一行一条，最新的在最后
 *   archive/YYYY-MM.md    被挤出容量的旧条目，只追加不改写
 *
 * 为什么用纯文本：用户能直接打开看、能 grep、能进 git；
 * 插件崩了也不影响内容，删掉文件就是重置。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 当前生效内容的上限（字符）。默认 1600 字，约 1.1k token。 */
export const DEFAULT_MAX_CHARS = 1600
/** 条数上限，和字符上限共同生效。 */
export const DEFAULT_MAX_ENTRIES = 40
/** 单条自述的硬上限，防止一次写入撑爆。 */
export const MAX_ENTRY_CHARS = 600

function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

export function selfnoteRoot() {
  const fromEnv = typeof process.env.DSH_SELFNOTE_DIR === 'string' ? process.env.DSH_SELFNOTE_DIR.trim() : ''
  return fromEnv.length > 0 ? fromEnv : join(dshHome(), 'selfnote')
}

export function notesPath() {
  return join(selfnoteRoot(), 'notes.md')
}

export function archiveDir() {
  return join(selfnoteRoot(), 'archive')
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function today() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 把 notes.md 解析成 [{ date, text }]，忽略空行与注释。 */
export function parseNotes(raw) {
  const out = []
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^[-*]\s+(\d{4}-\d{2}-\d{2})?\s*(.*)$/)
    if (!m) continue
    const text = (m[2] ?? '').trim()
    if (text === '') continue
    out.push({ date: m[1] ?? '', text })
  }
  return out
}

/** 读当前生效的自述。 */
export function readNotes() {
  const file = notesPath()
  if (!existsSync(file)) return []
  return parseNotes(readFileSync(file, 'utf8'))
}

/** 渲染成注入/展示用的文本（最新在后）。 */
export function renderNotes(entries) {
  return entries.map((entry) => `- ${entry.date ? `${entry.date} ` : ''}${entry.text}`).join('\n')
}

/** 写回当前生效的自述（整份重写，内容不超过上限）。 */
export function writeNotes(entries) {
  ensureDir(selfnoteRoot())
  const body = entries.length === 0 ? '' : `${renderNotes(entries)}\n`
  writeFileSync(notesPath(), body, 'utf8')
}

/**
 * 按容量裁剪：从最旧的一端丢，直到同时满足条数与字符上限。
 * 返回 { kept, overflow }，overflow 是要归档的旧条目（旧的在前）。
 */
export function trim(entries, { maxChars = DEFAULT_MAX_CHARS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const kept = [...entries]
  const overflow = []
  let total = renderNotes(kept).length
  while (kept.length > maxEntries || (total > maxChars && kept.length > 1)) {
    const dropped = kept.shift()
    if (!dropped) break
    overflow.push(dropped)
    total = renderNotes(kept).length
  }
  return { kept, overflow }
}

/** 把被挤出来的条目追加到当月归档文件。 */
export function archive(entries) {
  if (entries.length === 0) return ''
  ensureDir(archiveDir())
  const month = entries[0]?.date?.slice(0, 7) || today().slice(0, 7)
  const file = join(archiveDir(), `${month}.md`)
  if (!existsSync(file)) writeFileSync(file, `# 自述归档 ${month}\n\n`, 'utf8')
  appendFileSync(file, `${renderNotes(entries)}\n`, 'utf8')
  return file
}

/** 追加一条自述并裁剪归档。返回 { kept, archived, notesFile }。 */
export function appendNote(text, limits) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_CHARS)
  if (clean === '') throw new Error('自述内容不能为空')
  const entries = readNotes()
  entries.push({ date: today(), text: clean })
  const { kept, overflow } = trim(entries, limits)
  writeNotes(kept)
  const archivedFile = archive(overflow)
  return { kept: kept.length, archived: overflow.length, archivedFile, notesFile: notesPath() }
}

/** 统计：生效条数、字符数、归档文件数。 */
export function stats() {
  const entries = readNotes()
  const dir = archiveDir()
  let archiveFiles = 0
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.md')) archiveFiles += 1
    }
  }
  return { entries: entries.length, chars: renderNotes(entries).length, archiveFiles, notesFile: notesPath() }
}

/* ------------------------------ 配置 ------------------------------ */

export function configPath() {
  return join(selfnoteRoot(), 'config.json')
}

/** 读配置；文件不存在或坏掉都返回 {}，由调用方补默认值。 */
export function readConfig() {
  const file = configPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 整块写入配置（保留未知字段由调用方决定）。 */
export function writeConfig(next) {
  ensureDir(selfnoteRoot())
  writeFileSync(configPath(), `${JSON.stringify(next ?? {}, null, 2)}\n`, 'utf8')
  return configPath()
}

/** 清空当前生效的自述：全部进归档，不丢内容。 */
export function clearNotes() {
  const entries = readNotes()
  if (entries.length === 0) return { cleared: 0, archivedFile: '' }
  const archivedFile = archive(entries)
  writeNotes([])
  return { cleared: entries.length, archivedFile }
}
