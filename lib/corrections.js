/**
 * 纠偏证据的存储。
 *
 * 这里只做一件事：把「用户纠正过模型的那些原话」一行一条存下来，并记住哪条被哪个事务消费过。
 * 采集（信号词、水位、去重）在别处；语义归类永远不在这里做 ——
 * 插件只收集事实，规律由模型提、由人决定。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { selfnoteRoot } from './store.js'
import { writeAtomic } from './atomic.js'

export const CORRECTIONS_PATH = join(selfnoteRoot(), 'corrections.jsonl')

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
    if (entry.used && entry.consumedBy !== null && entry.consumedBy !== txId) {
      conflict.push(entry.id)
      continue
    }
    if (entry.used && entry.consumedBy === txId) continue
    entry.used = true
    entry.usedAt = now
    entry.consumedBy = txId
    marked += 1
  }
  if (marked > 0) writeEvents(events)
  return { marked, conflict }
}
