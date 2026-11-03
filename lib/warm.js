/**
 * 温层（P3）
 *
 * 定位：**带指针的摘要**，介于「每回合注入的热记忆」和「按需检索的原始会话」之间。
 *   - 一条摘要必须指回原文（sessionId + 行号）。没有指针的摘要不许写进来 ——
 *     否则它就是一段无法核对的自述，跟幻觉没区别。
 *   - 可以吊销（status: void），不能删除：删了就不知道「我曾经这么以为过」。
 *   - 不进注入。只有 memory_search 命中时才浮出来，所以条数可以很多。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { memoryRoot, readFacts, tokenize } from './memory.js'
import { writeAtomic } from './atomic.js'

const MAX_TEXT = 300
const MAX_POINTERS = 8

export const warmPath = () => join(memoryRoot(), 'warm.jsonl')

export function readWarm() {
  const file = warmPath()
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const item = JSON.parse(line)
      if (item && typeof item === 'object') out.push(item)
    } catch {
      // 坏行跳过：一条摘要读不出来，不该让整层都废掉
    }
  }
  return out
}

function writeWarm(items) {
  // 目录可能还不存在（第一次写温层）
  mkdirSync(memoryRoot(), { recursive: true })
  writeAtomic(warmPath(), items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : ''))
}

function validPointer(pointer) {
  return (
    pointer &&
    typeof pointer === 'object' &&
    String(pointer.sessionId ?? '').trim() !== '' &&
    Number.isSafeInteger(Number(pointer.index)) &&
    Number(pointer.index) >= 0
  )
}

/** 写一条摘要。没指针直接拒 —— 这条规矩是温层唯一的护栏。 */
export function writeSummary(input = {}) {
  const text = String(input.text ?? '').trim()
  if (text === '') return { ok: false, error: 'text 不能为空' }
  if (text.length > MAX_TEXT) return { ok: false, error: `一条摘要最多 ${MAX_TEXT} 字，拆成两条` }

  const raw = Array.isArray(input.pointers) ? input.pointers : []
  const pointers = raw
    .filter(validPointer)
    .map((pointer) => ({ sessionId: String(pointer.sessionId).trim(), index: Number(pointer.index) }))
    .slice(0, MAX_POINTERS)
  if (pointers.length === 0) {
    return { ok: false, error: '摘要必须带指针（sessionId + 行号）—— 核不到原文的摘要，就是一段无法证伪的自述' }
  }

  const items = readWarm()
  const at = new Date().toISOString()
  const item = {
    id: 'w' + Math.random().toString(36).slice(2, 10),
    text,
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 6) : [],
    pointers,
    status: 'active',
    created: at,
  }
  items.push(item)
  writeWarm(items)
  return { ok: true, item, total: items.length }
}

/** 吊销：不删，只标 void —— 以后还能查到「当时是这么以为的」。 */
export function voidSummary(id, reason = '') {
  const items = readWarm()
  const item = items.find((entry) => entry.id === id)
  if (!item) return { ok: false, error: '没有这条摘要' }
  item.status = 'void'
  item.voidedAt = new Date().toISOString()
  item.voidReason = String(reason ?? '')
  writeWarm(items)
  return { ok: true, item }
}

function score(text, terms) {
  const lower = String(text ?? '').toLowerCase()
  let matched = 0
  let total = 0
  for (const term of terms) {
    if (lower.includes(term)) {
      matched += 1
      total += 3
    }
  }
  return { matched, total }
}

/**
 * 温层检索：摘要 + 事实（含环境事实的 detail 段落）。
 * 返回的每条都带指针，能顺着回原文核对 —— 这是它跟「让模型凭印象说」的区别。
 */
export function searchWarm(query, options = {}) {
  const terms = tokenize(query)
  if (terms.length === 0) return { mode: 'warm', total: 0, terms, hits: [] }
  const limit = Math.max(1, Math.min(Number(options.limit ?? 8) || 8, 20))

  const hits = []
  for (const item of readWarm()) {
    if (item.status === 'void') continue
    const hit = score(item.text + ' ' + (item.tags ?? []).join(' '), terms)
    if (hit.matched === 0) continue
    hits.push({ kind: 'summary', id: item.id, text: item.text, tags: item.tags ?? [], pointers: item.pointers ?? [], matched: hit.matched, scaled: hit.total })
  }

  for (const fact of readFacts()) {
    const hit = score(fact.text + ' ' + (fact.detail ?? '') + ' ' + (fact.tags ?? []).join(' '), terms)
    if (hit.matched === 0) continue
    hits.push({
      kind: 'fact',
      id: fact.id,
      text: fact.text,
      detail: fact.detail ?? '',
      status: fact.status,
      channel: fact.channel ?? 'rel',
      pointers: fact.citation ? [{ sessionId: fact.citation.sessionId, index: fact.citation.index }] : [],
      matched: hit.matched,
      scaled: hit.total,
    })
  }

  // 全词命中优先，其次分数
  hits.sort((a, b) => b.matched - a.matched || b.scaled - a.scaled)
  return { mode: 'warm', total: hits.length, terms, hits: hits.slice(0, limit) }
}

export function warmStats() {
  const items = readWarm()
  return {
    total: items.length,
    active: items.filter((item) => item.status !== 'void').length,
    voided: items.filter((item) => item.status === 'void').length,
    withPointers: items.filter((item) => Array.isArray(item.pointers) && item.pointers.length > 0).length,
  }
}
