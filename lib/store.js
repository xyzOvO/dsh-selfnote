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

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic, writeJsonAtomic } from './atomic.js'

/** 当前生效内容的上限（字符）。默认 1600 字，约 1.1k token。 */
export function countChars(text) {
  return [...String(text ?? '')].length
}

/** 按码点截断：不把 emoji / 增补汉字的代理对切一半。 */
export function truncateChars(text, max) {
  const room = Math.max(0, Math.floor(max))
  return [...String(text ?? '')].slice(0, room).join('')
}

export const DEFAULT_MAX_CHARS = 1600
/** 条数上限，和字符上限共同生效。 */
export const DEFAULT_MAX_ENTRIES = 40
/** 单条自述的硬上限，防止一次写入撑爆。 */
export const MAX_ENTRY_CHARS = 600

/**
 * 自述分三型。混在一起装的时候，人格和「今晚推个提醒」抢同一份预算，
 * 抢输的永远是人味那一条 —— 所以分开排：
 *   core   核心身份（人格、长期身份、基本原则），先装，独立配额
 *   stable 稳定偏好（语言、表达习惯、工作偏好），按 pin → 时间
 *   temp   临时自述（当前阶段的目标、近期变化），最后装，时间倒序
 */
export const NOTE_TIERS = ['core', 'stable', 'temp']
/** 类型在 notes.md 里写成中文：人打开文件看得懂、改得动，不用查代码。 */
export const TIER_TAG = { core: '核心', stable: '稳定', temp: '临时' }
const TAG_TO_TIER = { 核心: 'core', 稳定: 'stable', 临时: 'temp' }
/** 没打标记的按「稳定」算：存量条目零迁移，行为跟改版前一模一样。 */
export const DEFAULT_TIER = 'stable'

/**
 * 临时自述的保质期（天）。过了就不再每回合自动在场 —— 只留在库里，等人自己翻，
 * 这样「这周在弄什么」不会一直跟人格抢预算。核心与稳定型永不到期。
 */
export const DEFAULT_TEMP_TTL_DAYS = 14

/**
 * 一条自述到期没有。
 * date 只有「年月日」（没有时刻），按当天零点算；正好第 N 天还在保质期内，
 * 免得写出「今天刚写、明天就过期」这种一日游。
 */
export function isExpiredNote(entry, ttlDays = DEFAULT_TEMP_TTL_DAYS, now = Date.now()) {
  if (normalizeTier(entry?.tier) !== 'temp') return false
  const raw = typeof entry?.date === 'string' ? entry.date.trim() : ''
  const at = Date.parse(`${raw}T00:00:00`)
  if (!Number.isFinite(at)) return false
  const days = Number.isFinite(Number(ttlDays)) ? Math.max(1, Math.round(Number(ttlDays))) : DEFAULT_TEMP_TTL_DAYS
  return now - at > days * 86400000
}

/** 把外部传进来的 tier 收成合法值，认不出就是默认型（不抛错 —— 别为了个标记把写自述弄失败）。 */
export function normalizeTier(value) {
  if (typeof value !== 'string') return DEFAULT_TIER
  const raw = value.trim().toLowerCase()
  if (NOTE_TIERS.includes(raw)) return raw
  // 也认中文写法，方便人直接对着接口手搓
  return TAG_TO_TIER[raw] ?? TAG_TO_TIER[value.trim()] ?? DEFAULT_TIER
}

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

/** 正文归一：回车换行压成空格、去掉首尾空白、截到硬上限。 */
function cleanEntryText(text) {
  return truncateChars(String(text ?? '').replace(/\s+/g, ' ').trim(), MAX_ENTRY_CHARS)
}

/**
 * 把 notes.md 解析成 [{ date, text, tier, pin }]，忽略空行与注释。
 * 行格式：`- 2026-11-04 [核心*] 正文` —— 日期可省、标记可省、`*` 表示 pin。
 * 标记认不出就原样留在正文里：宁可多显示一个怪括号，也不能吞掉人写的内容。
 */
export function parseNotes(raw) {
  const out = []
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^[-*]\s+(\d{4}-\d{2}-\d{2})?\s*(?:\[([^\]]{1,8})\]\s*)?(.*)$/)
    if (!m) continue
    let text = (m[3] ?? '').trim()
    let tier = DEFAULT_TIER
    let pin = false
    const tag = (m[2] ?? '').trim()
    if (tag !== '') {
      const hit = tag.match(/^(核心|稳定|临时)\s*(\*)?$/)
      if (hit) {
        tier = TAG_TO_TIER[hit[1]]
        pin = hit[2] === '*'
      } else {
        text = `[${tag}] ${text}`.trim()
      }
    }
    if (text === '') continue
    out.push({ date: m[1] ?? '', text, tier, pin })
  }
  return out
}

/** 读当前生效的自述。 */
export function readNotes() {
  const file = notesPath()
  if (!existsSync(file)) return []
  return parseNotes(readFileSync(file, 'utf8'))
}

/**
 * 标记只在「非默认」时才写出来：稳定型且没 pin 的条目不带前缀，
 * 存量 notes.md 不会因为升级平白多出一堆 `[稳定]`。
 */
function tagOf(entry) {
  const tier = normalizeTier(entry?.tier)
  const pin = entry?.pin === true
  if (tier === DEFAULT_TIER && !pin) return ''
  return `[${TIER_TAG[tier]}${pin ? '*' : ''}] `
}

/** 渲染成注入/展示用的文本（最新在后）。 */
export function renderNotes(entries) {
  return entries.map((entry) => `- ${entry.date ? `${entry.date} ` : ''}${tagOf(entry)}${entry.text}`).join('\n')
}

/** 写回当前生效的自述（整份重写，内容不超过上限）。 */
export function writeNotes(entries) {
  ensureDir(selfnoteRoot())
  const body = entries.length === 0 ? '' : `${renderNotes(entries)}\n`
  // 原子写：notes.md 是注入来源，被截断等于每回合注入半句话
  writeAtomic(notesPath(), body)
}

/**
 * 按容量裁剪：从最旧的一端丢，直到同时满足条数与字符上限。
 * 返回 { kept, overflow }，overflow 是要归档的旧条目（旧的在前）。
 */
export function trim(entries, { maxChars = DEFAULT_MAX_CHARS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const kept = [...entries]
  const overflow = []
  let total = countChars(renderNotes(kept))
  while (kept.length > maxEntries || (total > maxChars && kept.length > 1)) {
    const dropped = kept.shift()
    if (!dropped) break
    overflow.push(dropped)
    total = countChars(renderNotes(kept))
  }
  return { kept, overflow }
}

/** 把被挤出来的条目追加到当月归档文件。 */
export function archive(entries) {
  if (entries.length === 0) return ''
  ensureDir(archiveDir())
  const month = entries[0]?.date?.slice(0, 7) || today().slice(0, 7)
  const file = join(archiveDir(), `${month}.md`)
  // 归档文件小（每月一个），整份读回再原子写，比 append 更能扛「写到一半被杀」
  const head = existsSync(file) ? readFileSync(file, 'utf8') : `# 自述归档 ${month}\n\n`
  writeAtomic(file, `${head}${renderNotes(entries)}\n`)
  return file
}

/** 追加一条自述并裁剪归档。返回 { kept, archived, notesFile }。 */
export function appendNote(text, limits, meta = {}) {
  const clean = cleanEntryText(text)
  if (clean === '') throw new Error('自述内容不能为空')
  const entries = readNotes()
  const entry = { date: today(), text: clean, tier: normalizeTier(meta.tier), pin: meta.pin === true }
  entries.push(entry)
  const { kept, overflow } = trim(entries, limits)
  // 先归档、再改 notes.md：反过来的话，归档一抛错（磁盘满、被占用），
  // 被挤出预算的那几条既已从 notes.md 消失、又没进归档，等于静默丢掉。
  // 万一 notes.md 写失败，最坏是归档里有重复，还能人工删 —— 丢内容没法补。
  const archivedFile = archive(overflow)
  writeNotes(kept)
  return { kept: kept.length, archived: overflow.length, archivedFile, notesFile: notesPath(), tier: entry.tier, pin: entry.pin }
}

/**
 * 改一条（0 = 最旧，和 readNotes 的顺序一致）。
 * 日期保留原样：改的是措辞，不是「今天又写了一条」。
 * 改长了照样按容量裁剪，被挤出去的进归档 —— 和追加走同一条规则。
 */
export function updateNote(index, text, limits, meta = {}) {
  const entries = readNotes()
  const at = Number(index)
  if (!Number.isInteger(at) || at < 0 || at >= entries.length) {
    // 列表可能是几秒前拉的：给一句能照着做的话，而不是「非法参数」
    throw new Error('没有这一条了（可能刚被改过），刷新一下再试')
  }
  const clean = cleanEntryText(text)
  if (clean === '') throw new Error('自述内容不能为空')
  const prev = entries[at]
  const next = {
    date: prev.date || today(),
    text: clean,
    // meta 没传 = 保留原来那个型，别偷偷把一条核心身份降级成临时
    tier: meta.tier === undefined ? normalizeTier(prev.tier) : normalizeTier(meta.tier),
    pin: meta.pin === undefined ? prev.pin === true : meta.pin === true,
  }
  if (next.text === prev.text && next.tier === normalizeTier(prev.tier) && next.pin === (prev.pin === true)) {
    return { kept: entries.length, archived: 0, unchanged: true, notesFile: notesPath() }
  }
  entries[at] = next
  const { kept, overflow } = trim(entries, limits)
  const archivedFile = archive(overflow)
  writeNotes(kept)
  return { kept: kept.length, archived: overflow.length, archivedFile, unchanged: false, notesFile: notesPath(), tier: next.tier, pin: next.pin }
}

/**
 * 只改一条的类型 / pin，不动正文。设置页上「把这条设成核心身份」就是这个接口。
 * 不走 trim：标记只多几个字，为这点长度把一条旧自述挤进归档不值当。
 */
export function setNoteMeta(index, meta = {}) {
  const entries = readNotes()
  const at = Number(index)
  if (!Number.isInteger(at) || at < 0 || at >= entries.length) {
    throw new Error('没有这一条了（可能刚被改过），刷新一下再试')
  }
  const prev = entries[at]
  const next = {
    date: prev.date,
    text: prev.text,
    tier: meta.tier === undefined ? normalizeTier(prev.tier) : normalizeTier(meta.tier),
    pin: meta.pin === undefined ? prev.pin === true : meta.pin === true,
  }
  entries[at] = next
  writeNotes(entries)
  return { kept: entries.length, tier: next.tier, pin: next.pin, notesFile: notesPath() }
}

/** 删一条：先归档再摘除，删掉的东西仍然找得回来（archive/YYYY-MM.md）。 */
export function deleteNote(index) {
  const entries = readNotes()
  const at = Number(index)
  if (!Number.isInteger(at) || at < 0 || at >= entries.length) {
    throw new Error('没有这一条了（可能刚被删过），刷新一下再试')
  }
  const [dropped] = entries.splice(at, 1)
  const archivedFile = archive([dropped])
  writeNotes(entries)
  return { kept: entries.length, removed: dropped, archivedFile, notesFile: notesPath() }
}

/** 三型各几条。 */
export function countTiers(entries) {
  const out = { core: 0, stable: 0, temp: 0 }
  for (const entry of entries) out[normalizeTier(entry.tier)] += 1
  return out
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
  return {
    entries: entries.length,
    chars: countChars(renderNotes(entries)),
    // 三型各几条：设置页要能解释「为什么我这条没进上下文」
    tiers: countTiers(entries),
    pinned: entries.filter((entry) => entry.pin === true).length,
    archiveFiles,
    notesFile: notesPath(),
    // 上次真正写进 notes.md 的时刻：条目里只存日期（YYYY-MM-DD），看不出「几小时前」，
    // 所以用文件 mtime —— 它就是写入那一刻，设置页拿这个算「上次写入：N 小时前」。
    lastWrite: lastWriteAt(),
  }
}

function lastWriteAt() {
  try {
    const info = statSync(notesPath())
    if (info.size === 0) return null
    return info.mtime.toISOString()
  } catch {
    return null
  }
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
  // 原子写：config.json 被截断会让插件静默回落默认值，等于悄悄改行为
  writeJsonAtomic(configPath(), next ?? {})
  return configPath()
}

/* ------------------------------ 准入 token ------------------------------ */

export function authTokenPath() {
  return join(selfnoteRoot(), 'auth-token')
}

/** 读本地 token；没有或空文件都返回 ''。 */
export function readAuthToken() {
  try {
    return readFileSync(authTokenPath(), 'utf8').trim()
  } catch {
    return ''
  }
}

/** 写本地 token，尽量收成 600（Windows 上 chmod 基本是空操作，不报错即可）。 */
export function writeAuthToken(value) {
  ensureDir(selfnoteRoot())
  const file = authTokenPath()
  writeAtomic(file, `${String(value).trim()}\n`)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* 平台不支持就算了，token 本身不是密钥材料 */
  }
  return file
}

/** 清空当前生效的自述：全部进归档，不丢内容。 */export function clearNotes() {
  const entries = readNotes()
  if (entries.length === 0) return { cleared: 0, archivedFile: '' }
  const archivedFile = archive(entries)
  writeNotes([])
  return { cleared: entries.length, archivedFile }
}
