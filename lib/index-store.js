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

export function readIndex() {
  const file = indexPath()
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data?.v === INDEX_VERSION ? data : null
  } catch {
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
export function freshness(index) {
  if (index === null) return { fresh: false, hot: 0, missing: 0 }
  const sessions = listSessions()
  let hot = 0
  let missing = 0
  const known = index.sessions ?? {}
  for (const session of sessions) {
    const entry = known[session.id]
    const isHot = Date.now() - session.mtime < HOT_MS
    if (entry === undefined) {
      if (isHot) hot += 1
      else missing += 1
      continue
    }
    if (entry.mtime === session.mtime) continue
    if (isHot) hot += 1
    else missing += 1
  }
  const extra = Object.keys(known).filter((id) => !sessions.some((session) => session.id === id)).length
  return { fresh: missing === 0 && extra === 0, hot, missing }
}

export function isFresh(index) {
  return freshness(index).fresh
}

/** 全量重建。254 个会话大约几秒，跑一次就够。 */
export function buildIndex() {
  const sessions = listSessions()
  const postings = Object.create(null)
  const records = []
  const meta = {}
  let failed = 0
  let scanned = 0

  for (const session of sessions) {
    scanned += 1
    let parsed = null
    try {
      parsed = readSession(session)
    } catch {
      failed += 1
      continue
    }
    meta[session.id] = { mtime: session.mtime, date: parsed.date, size: sizeOf(session) }
    for (const record of parsed.records) {
      const id = records.length
      records.push({ s: session.id, i: record.index, r: record.role === 'user' ? 'u' : record.role === 'delegated' ? 'd' : 'a' })
      for (const term of indexTerms(record.text)) {
        const bucket = postings[term] ?? (postings[term] = [])
        bucket.push(id)
      }
    }
  }

  const index = {
    v: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    sessions: meta,
    records,
    postings,
    failed,
    scanned,
  }
  writeJsonAtomic(indexPath(), index)
  return index
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

export function indexStats() {
  const index = readIndex()
  if (index === null) return { present: false, fresh: false, builtAt: null, sessions: 0, records: 0, terms: 0, bytes: 0 }
  let bytes = 0
  try {
    bytes = statSync(indexPath()).size
  } catch {
    bytes = 0
  }
  return {
    present: true,
    fresh: freshness(index).fresh,
    hot: freshness(index).hot,
    missing: freshness(index).missing,
    builtAt: index.builtAt,
    sessions: Object.keys(index.sessions ?? {}).length,
    records: Array.isArray(index.records) ? index.records.length : Object.keys(index.records ?? {}).length,
    terms: Object.keys(index.postings ?? {}).length,
    bytes,
    failed: index.failed ?? 0,
  }
}
