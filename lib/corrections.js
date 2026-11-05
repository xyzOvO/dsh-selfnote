/**
 * 纠偏证据的存储。
 *
 * 这里只做一件事：把「用户纠正过模型的那些原话」一行一条存下来，并记住哪条被哪个事务消费过。
 * 采集（信号词、水位、去重）在别处；语义归类永远不在这里做 ——
 * 插件只收集事实，规律由模型提、由人决定。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { selfnoteRoot } from './store.js'
import { writeAtomic, writeJsonAtomic } from './atomic.js'

export const CORRECTIONS_PATH = join(selfnoteRoot(), 'corrections.jsonl')
const WATERMARK_PATH = join(selfnoteRoot(), 'corrections.watermark.json')

/** 池子上限：满了丢最旧的 —— 前 200 条足够让人看出规律，再多就是噪声压着真话。 */
const MAX_EVENTS = 200
/** 未被处理的证据留 90 天；处理过的留 30 天（留着只为对账）。 */
const UNUSED_DAYS = 90
const USED_DAYS = 30

/** 强信号：出现就基本可以确定是在纠正上一轮的做法，不需要别的上下文。 */
export const STRONG_SIGNALS = ['我说过', '我说的是', '谁让你', '怎么又', '别再', '你错了', '你又错']
/** 弱信号：单看太模糊（「别」「不是」），必须带了「你」或指代上一版才算数。 */
export const WEAK_SIGNALS = ['不要', '别', '不是', '改成', '应该是', '重新', '又']

/** 「不要太长」「别太啰嗦」是在提要求的下限，不是纠正，别当证据。 */
const DEGREE = /^(太|很|特别|更|过)/
/** 指代上一轮的词：有它，弱信号才站得住。 */
const REFER = /(刚才|上一版|上一步|上一轮|上面|前面)/
const SENTENCE = /[。！？!?\n]+/
/** 一句话太长不像「纠偏」，像在写需求文档。 */
const MAX_QUOTE_CHARS = 80

/** 一条证据的字段齐不齐：坏行宁可跳过，也别把整个池子读挂。 */
function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = String(raw.id ?? '').trim()
  if (id === '') return null
  return {
    id,
    at: String(raw.at ?? ''),
    session: String(raw.session ?? ''),
    idx: Number(raw.idx ?? 0),
    quote: String(raw.quote ?? ''),
    used: raw.used === true,
    usedAt: raw.usedAt === null || raw.usedAt === undefined ? null : String(raw.usedAt),
    consumedBy: raw.consumedBy === null || raw.consumedBy === undefined ? null : String(raw.consumedBy),
  }
}

export function readEvents() {
  if (!existsSync(CORRECTIONS_PATH)) return []
  const list = []
  for (const line of readFileSync(CORRECTIONS_PATH, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const entry = normalizeEvent(JSON.parse(text))
      if (entry !== null) list.push(entry)
    } catch {
      // 一行坏了不等于整个池子坏了：留着它也没用，跳过
    }
  }
  return list
}

export function writeEvents(list) {
  const rows = list.map((entry) => JSON.stringify(normalizeEvent(entry) ?? entry))
  writeAtomic(CORRECTIONS_PATH, rows.length === 0 ? '' : rows.join('\n') + '\n')
}

export function findById(id) {
  const key = String(id ?? '')
  return readEvents().find((entry) => entry.id === key)
}

/**
 * 标记消费。
 * 同一个 txId 重复标是幂等的（恢复重放会走到这里）；
 * 已经被别的 txId 消费过的，**不覆盖**并如实报冲突 —— 那是两个事务抢一条证据，得让人看见。
 */
export function markUsed(ids, txId) {
  const wanted = new Set(ids.map((id) => String(id)))
  const conflict = []
  let marked = 0
  const events = readEvents()
  const now = new Date().toISOString()
  for (const entry of events) {
    if (!wanted.has(entry.id)) continue
    if (entry.used && entry.consumedBy === txId) continue
    if (entry.used) {
      // 已被别的 tx 消费、或者被用户丢弃（consumedBy 为空）—— 都不许再改写
      conflict.push(entry.id)
      continue
    }
    entry.used = true
    entry.usedAt = now
    entry.consumedBy = txId
    marked += 1
  }
  if (marked > 0) writeEvents(events)
  return { marked, conflict }
}

/* ---------------- 采集：从对话里挑出「他在纠正上一轮」的句子 ---------------- */

/**
 * 一句话里挑出候选。
 * 强信号单看就够；弱信号（「别」「不是」）必须还带着「你」或指代上一版 ——
 * 否则「这次不是技术问题」这种陈述句会被当成纠偏，池子被噪声占满。
 */
export function extractSignals({ text, isReply = false } = {}) {
  const body = String(text ?? '')
  if (body.trim() === '') return []
  // 「我又想到一个新方案」是自述进展，不是纠错；整条排除，别按句拆。
  if (body.includes('我又想')) return []
  const hits = []
  for (const raw of body.split(SENTENCE)) {
    if (hits.length >= 2) break
    const sentence = raw.trim()
    if (sentence === '') continue
    if (countOf(sentence) > MAX_QUOTE_CHARS) continue
    const strong = STRONG_SIGNALS.find((signal) => sentence.includes(signal))
    if (strong !== undefined) {
      hits.push({ quote: sentence, signal: strong, strength: 'strong' })
      continue
    }
    const weak = WEAK_SIGNALS.find((signal) => {
      const at = sentence.indexOf(signal)
      if (at < 0) return false
      // 「不要太长」「别太难」是在给下限，不是纠正
      return !DEGREE.test(sentence.slice(at + signal.length))
    })
    if (weak === undefined) continue
    const anchored = sentence.includes('你') || REFER.test(sentence) || isReply
    if (!anchored) continue
    hits.push({ quote: sentence, signal: weak, strength: 'weak' })
  }
  return hits.slice(0, 2)
}

/** 码点计数：与 persona 那边同一个口径，别一处按 UTF-16、一处按肉眼。 */
function countOf(text) {
  return [...String(text)].length
}

/** 规范化只为了算 id：同一个意思换个空白/全角，不该变成两条证据。 */
function normalizeQuote(text) {
  return String(text ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

/** 事件级 id：同一会话同一条消息重扫是同一个 id；换一条消息就算两次纠正。 */
export function eventId(session, idx, quote) {
  return createHash('sha1').update(`${session}:${idx}:${normalizeQuote(quote)}`).digest('hex').slice(0, 12)
}

/**
 * 追加证据。按 id 去重（重扫同一条消息不重复），按 at 升序，超过 200 条丢最旧的。
 * 返回真正新增的条数 —— 全是旧的时返回 0，调用方据此别报「又记了几条」。
 */
export function appendEvents(events = []) {
  const byId = new Map()
  for (const entry of readEvents()) byId.set(entry.id, entry)
  let added = 0
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue
    const quote = String(raw.quote ?? '')
    if (quote.trim() === '') continue
    const session = String(raw.session ?? '')
    const idx = Number(raw.idx ?? 0)
    const id = String(raw.id ?? eventId(session, idx, quote))
    if (byId.has(id)) continue
    byId.set(id, normalizeEvent({ ...raw, id, session, idx, quote }))
    added += 1
  }
  if (added === 0) return 0
  const list = [...byId.values()].sort(compareEvents)
  const trimmed = list.length > MAX_EVENTS ? list.slice(list.length - MAX_EVENTS) : list
  writeEvents(trimmed)
  return added
}

function compareEvents(a, b) {
  const left = String(a.at ?? '')
  const right = String(b.at ?? '')
  if (left !== right) return left < right ? -1 : 1
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
}

function encodeCursor(event) {
  return Buffer.from(`${event.at}|${event.id}`, 'utf8').toString('base64')
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return null
  const raw = Buffer.from(cursor, 'base64').toString('utf8')
  const sep = raw.lastIndexOf('|')
  // 没有分隔符就是一段垃圾：宁可当作「从头开始」，也不要拿半截字符串去比对
  if (sep <= 0 || sep === raw.length - 1) return null
  const at = raw.slice(0, sep)
  const id = raw.slice(sep + 1)
  if (at === '' || id === '') return null
  return { at, id }
}

/**
 * 翻页用「上一条的 (at,id)」当游标，不用 offset ——
 * 池子边翻边有新证据进来时，offset 会让同一条被看两次或漏一次。
 */
export function listCorrections({ cursor = null, limit = 30, includeUsed = false } = {}) {
  const all = readEvents().sort(compareEvents)
  // 默认只给未处理的：模型和界面要的都是「还能当依据的」，
  // 已消费/已丢弃的那些留在池子里只是为了计数和审计。
  const pool = includeUsed ? all : all.filter((entry) => entry.used !== true)
  const mark = decodeCursor(cursor)
  const rest = mark === null ? pool : pool.filter((entry) => compareEvents(entry, mark) > 0)
  const size = Math.max(1, Number(limit) || 30)
  const items = rest.slice(0, size)
  const nextCursor = rest.length > items.length ? encodeCursor(items[items.length - 1]) : null
  return { items, nextCursor, total: all.length, unused: all.filter((entry) => !entry.used).length }
}

/* ---------------- 水位：从哪条消息之后才开始扫 ---------------- */

export function readWatermark() {
  try {
    const raw = JSON.parse(readFileSync(WATERMARK_PATH, 'utf8'))
    if (raw === null || typeof raw !== 'object') return null
    // 两个时间戳都是空的等于没开闸：文件在不在都一样，别让空记录冒充「已启用」
    if (String(raw.enabledAt ?? '') === '' && String(raw.lastScannedAt ?? '') === '') return null
    return raw
  } catch {
    return null
  }
}

export function writeWatermark(value) {
  const payload = value === null || typeof value !== 'object' ? {} : value
  writeJsonAtomic(WATERMARK_PATH, {
    enabledAt: String(payload.enabledAt ?? ''),
    lastScannedAt: String(payload.lastScannedAt ?? ''),
    lastSession: String(payload.lastSession ?? ''),
    lastIdx: Number(payload.lastIdx ?? 0),
  })
}

/**
 * 这条消息要不要扫。
 * 没有水位就是第一次启用：返回 false，**不回填历史** ——
 * 历史里没有「这句是不是在回上一句」的上下文，回填只会把旧闲聊当纠偏。
 */
export function shouldScan(message, watermark = readWatermark()) {
  if (message === null || typeof message !== 'object') return false
  if (watermark === null || typeof watermark !== 'object') return false
  const since = String(watermark.lastScannedAt ?? '') || String(watermark.enabledAt ?? '')
  if (since === '') return false
  const at = String(message.at ?? '')
  if (at === '') return false
  return at > since
}

/* ---------------- 清理 ---------------- */

/**
 * 清理过期证据：处理过的按 usedAt 算 30 天，没处理的按 at 算 90 天。
 * 按 usedAt 而不是 at，是为了不误伤「一个月前发生、今天才处理」的证据。
 */
export function sweep(now = Date.now()) {
  const list = readEvents()
  const keep = []
  let removed = 0
  for (const entry of list) {
    const stamp = entry.used ? String(entry.usedAt ?? entry.at ?? '') : String(entry.at ?? '')
    const days = entry.used ? USED_DAYS : UNUSED_DAYS
    const at = Date.parse(stamp)
    if (Number.isFinite(at) && now - at > days * 86400000) {
      removed += 1
      continue
    }
    keep.push(entry)
  }
  if (removed > 0) writeEvents(keep)
  return { removed }
}

/* ---------------- 一条消息进来：扫、记、推水位 ---------------- */

/**
 * 采集入口：capture 每收到一条人说过的消息就调一次。
 *
 * 第一次调用只写水位（`enabledAt = lastScannedAt = 此刻`），不扫 ——
 * 从这一刻开始攒，之前的历史一条都不回填。之后只扫比水位新的消息。
 * 任何异常都吞掉并如实返回：采集坏了不能连累候选事实那条主路径。
 */
export function collectCorrections({ session = '', idx = 0, text = '', at = '', isReply = false, now = new Date() } = {}) {
  const stamp = String(at ?? '') === '' ? now.toISOString() : String(at)
  try {
    const current = readWatermark()
    if (current === null) {
      writeWatermark({ enabledAt: stamp, lastScannedAt: stamp, lastSession: String(session), lastIdx: Number(idx) || 0 })
      return { enabled: true, scanned: false, collected: 0, reason: 'just-enabled' }
    }
    if (shouldScan({ at: stamp }, current) === false) {
      return { enabled: true, scanned: false, collected: 0, reason: 'before-watermark' }
    }
    const hits = extractSignals({ text, isReply })
    const events = hits.map((hit) => ({
      id: eventId(session, idx, hit.quote),
      session: String(session),
      idx: Number(idx) || 0,
      quote: hit.quote,
      at: stamp,
      strength: hit.strength,
    }))
    const added = events.length === 0 ? 0 : appendEvents(events)
    writeWatermark({
      enabledAt: current.enabledAt,
      lastScannedAt: stamp,
      lastSession: String(session),
      lastIdx: Number(idx) || 0,
    })
    return { enabled: true, scanned: true, collected: added, reason: added === 0 ? 'no-signal' : 'collected' }
  } catch (error) {
    return { enabled: true, scanned: false, collected: 0, reason: 'failed', error: String(error?.message ?? error) }
  }
}

/**
 * 丢弃证据：人看不上眼的候选，标成 used 但不算「被某条规则用掉」。
 * 只认未处理的 id —— 已处理的再丢没有意义，还会把 consumedBy 搅乱。
 */
export function discardByIds(ids, now = new Date()) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)).filter((id) => id !== ''))]
  if (wanted.length === 0) return { ok: false, error: 'ids 不能为空' }
  const events = readEvents()
  const known = new Map(events.map((entry) => [entry.id, entry]))
  for (const id of wanted) {
    const entry = known.get(id)
    if (entry === undefined) return { ok: false, error: `没有这条证据：${id}` }
    if (entry.used) return { ok: false, error: `证据 ${id} 已经处理过了` }
  }
  const stamp = now.toISOString()
  for (const id of wanted) {
    const entry = known.get(id)
    entry.used = true
    entry.usedAt = stamp
    entry.consumedBy = null
  }
  writeEvents(events)
  return { ok: true, discarded: wanted }
}
