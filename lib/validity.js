/**
 * 有效性判据的纯函数与台账：只做确定性判断，不生成卡、不改采集热路径。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { writeJsonAtomic } from './atomic.js'
import { eventId, STRONG_SIGNALS, WEAK_SIGNALS } from './corrections.js'
import { tokenize } from './memory.js'
import { selfnoteRoot } from './store.js'

export const STALE_FACTOR = 0.7
export const STALE_FLOOR = 0.25
export const VALIDITY_VERSION = '1'

const PROCESSED_FILE = 'validity-processed.json'
const SIGNAL_WORDS = new Set([
  ...STRONG_SIGNALS,
  ...WEAK_SIGNALS,
  '那个',
  '这个',
  '了',
])

export function signalKey(event) {
  return eventId(event.session, event.idx, event.quote)
}

export function validityWeight(fact) {
  let tiers = 0
  if (Array.isArray(fact?.conflictWith) && fact.conflictWith.length > 0) tiers += 1
  if (Array.isArray(fact?.similarTo) && fact.similarTo.length > 0) tiers += 1
  if (tiers === 0) return 1
  return Math.max(STALE_FLOOR, STALE_FACTOR ** tiers)
}

function stripSignals(quote) {
  let text = tokenize(quote).join(' ')
  for (const word of [...SIGNAL_WORDS].sort((a, b) => b.length - a.length)) {
    text = text.split(word).join(' ')
  }
  return text
}

function scoringTerms(quote) {
  const terms = []
  for (const token of tokenize(stripSignals(quote))) {
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      for (let size = Math.min(3, token.length); size >= 2; size -= 1) {
        for (let i = 0; i + size <= token.length; i += 1) {
          terms.push(token.slice(i, i + size))
        }
      }
    } else {
      terms.push(token)
    }
  }
  return terms
}

function scoreFact(fact, terms) {
  const text = String(fact?.text ?? '').toLowerCase()
  let score = 0
  for (const term of terms) {
    const count = text.split(term).length - 1
    if (count > 0) score += count * (term.length >= 3 ? 2 : 1)
  }
  return score
}

export function findCandidates(quote, facts, limit = 5) {
  const size = Math.max(0, Math.floor(Number(limit) || 0))
  if (size === 0) return []

  const unique = []
  const seen = new Set()
  for (const fact of facts ?? []) {
    if (fact === null || fact === undefined) continue
    if (seen.has(fact.id)) continue
    seen.add(fact.id)
    unique.push(fact)
  }

  const terms = scoringTerms(quote)
  const ranked = unique.map((fact, index) => ({ fact, index, score: scoreFact(fact, terms) }))
  if (ranked.every((item) => item.score === 0)) {
    return ranked.slice(0, size).map(({ fact }) => ({ id: fact.id, text: fact.text }))
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  return ranked.slice(0, size).map(({ fact }) => ({ id: fact.id, text: fact.text }))
}

export function buildValidityCards({ events = [], facts = [], check, provenance, processedKeys = new Set() }) {
  const cards = []
  for (const event of events ?? []) {
    if (event?.strength !== 'strong') continue
    const checked = check({ sessionId: event.session, seq: event.idx, quote: event.quote })
    if (!checked?.ok) continue
    const key = signalKey(event)
    if (processedKeys?.has?.(key)) continue
    if (provenance({ role: checked.record?.role, text: event.quote }) !== 'own') continue
    const sessionId = checked.session?.id ?? event.session
    cards.push({
      key,
      quote: event.quote,
      at: event.at,
      source: `${sessionId}#${checked.record.index}`,
      candidates: findCandidates(event.quote, facts),
    })
  }
  return cards
}

function processedPath() {
  return join(selfnoteRoot(), PROCESSED_FILE)
}

function readProcessed() {
  const file = processedPath()
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export function readProcessedKeys() {
  return new Set(readProcessed().filter((key) => typeof key === 'string' && key !== ''))
}

export function appendProcessedKeys(keys) {
  const merged = readProcessedKeys()
  for (const key of keys ?? []) {
    if (typeof key === 'string' && key !== '') merged.add(key)
  }
  const file = processedPath()
  mkdirSync(dirname(file), { recursive: true })
  writeJsonAtomic(file, [...merged])
  return merged
}
