/**
 * 记忆索引（P5b 的 B 方案）
 *
 * 只索引「哪个词出现在哪条记录」，不索引正文：
 *   postings: 词元 → ["sessionId#行号", …]
 *   records:  行号 → { r: 'u'|'a', t: 时间 }
 *
 * 查询时先用倒排拿到候选 id，再只读那几个会话的缓存取正文做打分和截片段。
 * 所以索引体积跟「词元数量」成正比，而不是跟原文长度成正比。
 *
 * 中文按 bigram 切，英文按单词；两种混在一张表里。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './atomic.js'
import { listSessions, memoryRoot, readSession } from './memory.js'

const INDEX_VERSION = 3

export function indexPath() {
  return join(memoryRoot(), 'index.json')
}

const CJK_RUN = /[\u4e00-\u9fff]+/g
const WORD = /[a-z0-9_]{2,}/g

/** 把一段文本切成索引词元：中文 bigram + 英文单词。 */
export function indexTerms(text) {
  const lowered = String(text ?? '').toLowerCase()
  const terms = new Set()
  for (const run of lowered.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      terms.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2))
  }
  for (const word of lowered.match(WORD) ?? []) terms.add(word)
  return [...terms]
}

/**
 * 解析好的索引缓存。
 * 一份索引接近 10 MB，JSON.parse 一次要 200–300ms；设置页一次刷新会问好几遍，
 * 所以要按「文件 mtime + 大小」缓存，文件一变就重解析。
 */
let parsedCache = null // { stamp, index }

function indexStamp(file) {
  try {
    const info = statSync(file)
    return info.mtimeMs + ':' + info.size
  } catch {
    return null
  }
}

export function readIndex() {
  const file = indexPath()
  if (!existsSync(file)) {
    parsedCache = null
    return null
  }
  const stamp = indexStamp(file)
  if (stamp !== null && parsedCache !== null && parsedCache.stamp === stamp) return parsedCache.index
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const index = data?.v === INDEX_VERSION ? data : null
    parsedCache = { stamp, index }
    return index
  } catch {
    parsedCache = null
    return null
  }
}

/** 索引是否还能代表当前磁盘状态（所有会话的 mtime 都没变）。 */
/** 最近 5 分钟内还在写的会话：它们的 mtime 一直在变，不能拿它们判「索引过期」。 */
const HOT_MS = 5 * 60 * 1000

/**
 * 索引与磁盘的偏差。
 * fresh 只看「已冷下来的会话」；hot 记有多少个会话太新，索引里可能是旧的。
 */
export function freshness(index, sessions = listSessions()) {
  if (index === null) return { fresh: false, hot: 0, missing: 0 }
  return freshnessOfSessions(index.sessions ?? {}, sessions)
}

/**
 * 只拿「会话 id → mtime」这张表算偏差。
 * 索引本体有 10 MB，设置页不该为了报个数字去解析它 ——
 * 所以重建时顺手把这张小表写进 `index.meta.json`。
 */
export function freshnessOfSessions(known, sessions = listSessions()) {
  let hot = 0
  let missing = 0
  const ids = new Set()
  for (const session of sessions) {
    ids.add(session.id)
    const entry = known[session.id]
    // 索引本体里存的是 { mtime, date, size }；门牌文件里为了小，只存 mtime 数字
    const entryMtime = entry !== null && typeof entry === 'object' ? entry.mtime : entry
    const isHot = Date.now() - session.mtime < HOT_MS
    if (entry === undefined) {
      if (isHot) hot += 1
      else missing += 1
      continue
    }
    if (entryMtime === session.mtime) continue
    if (isHot) hot += 1
    else missing += 1
  }
  let extra = 0
  for (const id of Object.keys(known)) if (!ids.has(id)) extra += 1
  return { fresh: missing === 0 && extra === 0, hot, missing }
}

export function isFresh(index) {
  return freshness(index).fresh
}

/**
 * 同一时刻只准有一次重建：两次并行跑，index.json 与 index.meta.json 会来自不同的两次构建，
 * 之后 fresh 判断永远对不上，还白白多占几倍内存。
 */
let building = false

export function isBuilding() {
  return building
}

/** 全量重建。305 个会话大约十秒，跑一次就够。 */
export function buildIndex() {
  if (building) throw new Error('正在重建索引，等这次跑完')
  building = true
  try {
    const builder = createBuilder()
    for (const session of listSessions()) builder.feed(session)
    return builder.finish()
  } finally {
    building = false
  }
}

/**
 * 分片重建：每片之间让出事件循环，重建索引时对话不会被冻住。
 * 一片的耗时跟会话大小有关，取 8 个一片，让出间隔大约 200–400ms。
 */
export async function buildIndexChunked(options = {}) {
  const chunk = Number.isInteger(options.chunk) && options.chunk > 0 ? options.chunk : 8
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  if (building) throw new Error('正在重建索引，等这次跑完')
  building = true
  try {
    const sessions = listSessions()
    const builder = createBuilder()
    const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve))
    for (let i = 0; i < sessions.length; i += 1) {
      builder.feed(sessions[i])
      if ((i + 1) % chunk === 0) {
        if (onProgress !== null) onProgress({ done: i + 1, total: sessions.length })
        await yieldToEventLoop()
      }
    }
    if (onProgress !== null) onProgress({ done: sessions.length, total: sessions.length })
    return builder.finish()
  } finally {
    building = false
  }
}

/**
 * 索引落后几个会话时，就地补上再查 —— 不写盘。
 *
 * 背景：会话只要被追加过、又冷过 5 分钟，`freshness` 就判它 missing，整份索引随之作废，
 * 于是「聊完一轮，过一会儿查昨天的事」正好落进线性扫描。落后的一般就是当前这一两个会话，
 * 把它们的记录现解析进内存索引，既不误报新鲜，也不用重建十秒。
 *
 * 落后太多（默认 >20）就不折腾了，直接返回 null 让调用方退回线性扫描。
 */
export function topUpIndex(index, sessions = listSessions(), options = {}) {
  const maxMissing = Number.isInteger(options.maxMissing) ? options.maxMissing : 20
  if (index === null) return { index: null, gaps: 0, degraded: true }
  const known = index.sessions ?? {}
  const ids = new Set(sessions.map((session) => session.id))
  for (const id of Object.keys(known)) if (!ids.has(id)) return { index: null, gaps: 0, degraded: true, extra: true }

  const gaps = []
  for (const session of sessions) {
    const entry = known[session.id]
    const mtime = entry !== null && typeof entry === 'object' ? entry.mtime : entry
    if (mtime !== session.mtime) gaps.push(session)
  }
  if (gaps.length === 0) return { index, gaps: 0, degraded: false }
  if (gaps.length > maxMissing) return { index: null, gaps: gaps.length, degraded: true }

  const records = index.records.slice()
  const postings = { ...index.postings }
  for (const session of gaps) {
    let parsed = null
    try {
      parsed = readSession(session)
    } catch {
      return { index: null, gaps: gaps.length, degraded: true }
    }
    if (parsed.failed === true) return { index: null, gaps: gaps.length, degraded: true }
    for (const record of parsed.records) {
      const id = records.length
      records.push({ s: session.id, i: record.index, r: record.role === 'user' ? 'u' : record.role === 'delegated' ? 'd' : 'a' })
      for (const term of indexTerms(record.text)) {
        postings[term] = [...(postings[term] ?? []), id]
      }
    }
  }
  return { index: { ...index, records, postings }, gaps: gaps.length, degraded: false }
}

function createBuilder() {
  const sessions = []
  const postings = Object.create(null)
  const records = []
  const meta = {}
  const state = { failed: 0, scanned: 0 }

  return {
    feed(session) {
      state.scanned += 1
      sessions.push(session.id)
      let parsed = null
      try {
        parsed = readSession(session)
      } catch {
        state.failed += 1
        return
      }
      // 解不开的会话仍然记 meta（文件确实在这儿），但要计入 failed ——
      // 否则「重建完成」等于宣称这些会话也收进来了
      if (parsed.failed === true) state.failed += 1
      meta[session.id] = { mtime: session.mtime, date: parsed.date, size: sizeOf(session) }
      for (const record of parsed.records) {
        const id = records.length
        records.push({ s: session.id, i: record.index, r: record.role === 'user' ? 'u' : record.role === 'delegated' ? 'd' : 'a' })
        for (const term of indexTerms(record.text)) {
          const bucket = postings[term] ?? (postings[term] = [])
          bucket.push(id)
        }
      }
    },
    finish() {
      const index = {
        v: INDEX_VERSION,
        builtAt: new Date().toISOString(),
        sessions: meta,
        records,
        postings,
        failed: state.failed,
        scanned: state.scanned,
      }
      writeJsonAtomic(indexPath(), index, { pretty: false })
      writeIndexMeta(index)
      return index
    },
  }
}

/**
 * 索引的「门牌文件」：只有统计数字和会话 mtime 表，几十 KB。
 * 设置页读它就能报全部指标，不用解析 10 MB 的索引本体。
 */
export function indexMetaPath() {
  return join(memoryRoot(), 'index.meta.json')
}

function writeIndexMeta(index) {
  const counts = {
    sessions: Object.keys(index.sessions ?? {}).length,
    records: Array.isArray(index.records) ? index.records.length : 0,
    terms: Object.keys(index.postings ?? {}).length,
    failed: index.failed ?? 0,
    bytes: 0,
  }
  try {
    counts.bytes = statSync(indexPath()).size
  } catch {
    counts.bytes = 0
  }
  const sessions = {}
  for (const [id, entry] of Object.entries(index.sessions ?? {})) sessions[id] = entry.mtime
  writeJsonAtomic(indexMetaPath(), { v: INDEX_VERSION, builtAt: index.builtAt, sessions, counts })
}

export function readIndexMeta() {
  const file = indexMetaPath()
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data?.v === INDEX_VERSION ? data : null
  } catch {
    return null
  }
}

function sizeOf(session) {
  try {
    return statSync(session.file).size
  } catch {
    return 0
  }
}

export function ensureIndex(options = {}) {
  const existing = readIndex()
  if (options.force !== true && isFresh(existing)) return { index: existing, built: false }
  return { index: buildIndex(), built: true }
}

/** AND 优先：所有词都出现的记录；没有就退回「出现任意词」。 */
export function queryIndex(index, terms) {
  const buckets = []
  for (const term of terms) {
    const hits = index.postings?.[term]
    if (hits === undefined) buckets.push([])
    else buckets.push(hits)
  }
  if (buckets.length === 0) return { ids: [], degraded: false }

  const intersect = (a, b) => {
    const set = new Set(b)
    return a.filter((id) => set.has(id))
  }

  const nonEmpty = buckets.filter((bucket) => bucket.length > 0)
  if (nonEmpty.length === 0) return { ids: [], degraded: false }

  let strict = nonEmpty[0].slice()
  for (let i = 1; i < nonEmpty.length; i += 1) strict = intersect(strict, nonEmpty[i])

  if (strict.length > 0) return { ids: strict, degraded: false }

  const union = new Set()
  for (const bucket of nonEmpty) for (const id of bucket) union.add(id)
  return { ids: [...union], degraded: true }
}

/** 倒排命中的记录号 → 「会话#行号」字符串，交给 memory.searchByIds。 */
export function hitKeys(index, ids) {
  const out = []
  for (const id of ids) {
    const record = index.records?.[id]
    if (record === undefined) continue
    out.push(record.s + '#' + record.i)
  }
  return out
}

export function indexStats(sessions = listSessions()) {
  const disk = sessions.length
  // 优先走门牌文件：几十 KB，免得为了报数字去解析 10 MB 索引
  const meta = readIndexMeta()
  if (meta !== null) {
    const state = freshnessOfSessions(meta.sessions ?? {}, sessions)
    return {
      present: true,
      fresh: state.fresh,
      hot: state.hot,
      missing: state.missing,
      builtAt: meta.builtAt,
      sessions: meta.counts?.sessions ?? Object.keys(meta.sessions ?? {}).length,
      disk,
      records: meta.counts?.records ?? 0,
      terms: meta.counts?.terms ?? 0,
      bytes: meta.counts?.bytes ?? 0,
      failed: meta.counts?.failed ?? 0,
    }
  }
  const index = readIndex()
  if (index === null) {
    return { present: false, fresh: false, builtAt: null, sessions: 0, disk, records: 0, terms: 0, bytes: 0, hot: 0, missing: 0, failed: 0 }
  }
  let bytes = 0
  try {
    bytes = statSync(indexPath()).size
  } catch {
    bytes = 0
  }
  const state = freshnessOfSessions(index.sessions ?? {}, sessions)
  return {
    present: true,
    fresh: state.fresh,
    hot: state.hot,
    missing: state.missing,
    builtAt: index.builtAt,
    sessions: Object.keys(index.sessions ?? {}).length,
    // 磁盘上一共有多少个会话：设置页要用「已索引 / 磁盘」这一对数字判断覆盖率
    disk,
    records: Array.isArray(index.records) ? index.records.length : Object.keys(index.records ?? {}).length,
    terms: Object.keys(index.postings ?? {}).length,
    bytes,
    failed: index.failed ?? 0,
  }
}
