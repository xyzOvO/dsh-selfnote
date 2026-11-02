/**
 * P1-A 原型：自动采集的「发现」部分（不做提取模型调用，不做写库）。
 *
 * 设计约束（来自评审）：
 *   - 只发现，不确认：产出永远是 candidate，永远不碰 approved
 *   - 轻量触发：不满足条件就什么都不做
 *   - 相似不等于相同：词面相近但方向相反（简洁 / 详细）判冲突，不合并
 *   - 幂等：按会话 seq 推进游标，同一条消息不会被处理两次
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './atomic.js'
import { memoryRoot } from './memory.js'

/* ------------------------------ 触发 ------------------------------ */

/** 长期偏好 / 明确约束 / 主动纠正 —— 三类才采，普通闲聊不采。 */
const TRIGGERS = [
  { id: 'standing', re: /(以后|今后|往后|从现在起|之后都|一直|每次都)/ },
  { id: 'prohibit', re: /(不要再|别再|不要用|不许|禁止|别用|不要再给|不用再)/ },
  { id: 'prefer', re: /(我(更)?(喜欢|偏好|习惯|想要)|我讨厌|我受不了|请(你)?(记住|记下))/ },
  { id: 'correct', re: /(你(刚才|这次)?(说|写|做)错了|不是这样|别这样|应该(先|用)|重来)/ },
]

const NEGATION = /(不|别|没|勿|禁止|避免|少|勿用)/

/** 方向相反的两组词：词面再像也不能合并。 */
const DIRECTIONS = [
  ['简洁', '详细'],
  ['简短', '详尽'],
  ['短', '长'],
  ['快', '慢'],
  ['少', '多'],
]

const SENTENCE = /[^。！？!?；;\n]+[。！？!?；;]?/g

/** 判一条用户消息值不值得采。返回命中的触发原因（空数组 = 不采）。 */
export function triggersOf(text) {
  const value = String(text ?? '')
  if (value.trim() === '') return []
  const hits = []
  for (const trigger of TRIGGERS) {
    if (trigger.re.test(value)) hits.push(trigger.id)
  }
  return hits
}

/** 从一条消息里挑出候选句：只留命中触发的句子，压成一行。 */
export function candidatesOf(text, limit = 3) {
  const value = String(text ?? '')
  const out = []
  for (const sentence of value.match(SENTENCE) ?? []) {
    const line = sentence.trim()
    if (line.length < 4 || line.length > 200) continue
    if (triggersOf(line).length === 0) continue
    if (out.includes(line)) continue
    out.push(line)
    if (out.length >= limit) break
  }
  return out
}

/* ------------------------------ 去重 ------------------------------ */

function bigrams(text) {
  const value = String(text ?? '').toLowerCase().replace(/[\s\p{P}]/gu, '')
  const set = new Set()
  for (let i = 0; i + 1 < value.length; i += 1) set.add(value.slice(i, i + 2))
  if (value.length === 1) set.add(value)
  return set
}

/** 词面相似度（bigram Jaccard），只作第一层筛选。 */
export function similarity(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  // 用重叠系数而不是 Jaccard：中文长句稍改几个字，Jaccard 掉得太快
  return shared / Math.min(left.size, right.size)
}

/** 方向词：返回这条话站在哪一边（没提就返回 null）。 */
export function directionOf(text) {
  const value = String(text ?? '')
  for (const [left, right] of DIRECTIONS) {
    const hasLeft = value.includes(left)
    const hasRight = value.includes(right)
    if (hasLeft !== hasRight) return hasLeft ? left : right
  }
  return null
}

/**
 * 两个候选该不该合并。
 * 相似 + 同向 → 合并（只合并证据，状态各归各）
 * 相似 + 反向 / 否定不同 → 冲突，不许自动合并
 */
export function compareCandidate(incoming, existing) {
  const score = similarity(incoming, existing)
  if (score < 0.5) return { action: 'new', score }
  const negA = NEGATION.test(incoming)
  const negB = NEGATION.test(existing)
  const dirA = directionOf(incoming)
  const dirB = directionOf(existing)
  if (negA !== negB || (dirA !== null && dirB !== null && dirA !== dirB) || (dirA !== null) !== (dirB !== null)) {
    return { action: 'conflict', score }
  }
  return { action: 'merge', score }
}

/* ------------------------------ 游标（幂等） ------------------------------ */

export function cursorPath() {
  return join(memoryRoot(), 'capture-cursor.json')
}

export function readCursor() {
  const file = cursorPath()
  if (!existsSync(file)) return {}
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data !== null && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/** 这条消息处理过了吗？用 seq 判断，不靠时间戳。 */
export function alreadySeen(sessionId, seq, cursor = readCursor()) {
  const last = Number(cursor[sessionId] ?? 0)
  return Number(seq) <= last
}

export function markSeen(sessionId, seq) {
  const cursor = readCursor()
  const last = Number(cursor[sessionId] ?? 0)
  if (Number(seq) <= last) return cursor
  cursor[sessionId] = Number(seq)
  mkdirSync(memoryRoot(), { recursive: true })
  writeJsonAtomic(cursorPath(), cursor)
  return cursor
}
