/**
 * 有效性判据的纯函数与台账：只做确定性判断，不生成卡、不改采集热路径。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { writeJsonAtomic } from './atomic.js'
import { eventId } from './corrections.js'
import { selfnoteRoot } from './store.js'

export const STALE_FACTOR = 0.7
export const STALE_FLOOR = 0.25
export const VALIDITY_VERSION = '1'

const PROCESSED_FILE = 'validity-processed.json'

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

function keptForSignal(fact, signal) {
  if (typeof signal !== 'string' || signal === '') return false
  return (fact?.history ?? []).some((item) => item?.via === 'validity-kept' && item?.signal === signal)
}

/**
 * 作废卡的候选只取「本轮眼前事实」——即刚注入进上下文的已采纳事实。
 * 刻意不接收作废句文本、不做字面打分：定位靠人在侧栏就地点选，不靠系统猜。
 */
export function pickCandidates(facts, signal, limit = 5) {
  const size = Math.max(0, Math.floor(Number(limit) || 0))
  if (size === 0) return []

  const picked = []
  const seen = new Set()
  for (const fact of facts ?? []) {
    if (fact === null || fact === undefined) continue
    if (seen.has(fact.id)) continue
    seen.add(fact.id)
    // 这张卡上点过「保留」的那条不再列为候选；换一句新信号会重新出现
    if (keptForSignal(fact, signal)) continue
    picked.push({ id: fact.id, text: fact.text })
    if (picked.length >= size) break
  }
  return picked
}

export function buildValidityCards({ events = [], facts = [], check, provenance, processedKeys = new Set() }) {
  const cards = []
  // 本轮没有眼前事实时根本不出卡 —— 不是出一张空卡让人对着空气点
  if (!Array.isArray(facts) || facts.length === 0) return cards
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
      candidates: pickCandidates(facts, key, 5),
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
