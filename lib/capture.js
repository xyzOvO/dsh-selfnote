/**
 * P1-A 原型：自动采集的「发现」部分（不做提取模型调用，不做写库）。
 *
 * 设计约束（来自评审）：
 *   - 只发现，不确认：产出永远是 candidate，永远不碰 approved
 *   - 轻量触发：不满足条件就什么都不做
 *   - 相似不等于相同：词面相近但方向相反（简洁 / 详细）判冲突，不合并
 *   - 幂等：按会话 seq 推进游标，同一条消息不会被处理两次
 *
 * 修订（第二版）：
 *   - 采集门槛两步走：先看有没有长期表达，再看是不是在说「对 AI 的要求 / 想让我记住的事」
 *   - 方向判定改成集合，一句话同时涉及长短与快慢也能发现冲突
 *   - seq 必须是安全的非负整数；游标文件损坏不再静默从头来，先备份再抛错
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
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

/**
 * 第二道门槛：这句话是不是在说「跟我交互的方式」或「要我记住的事」。
 *
 * 只看触发词是不够的 ——「我以后再也不熬夜了」有时间持续性，但不是给我的要求。
 * 这里用规则白名单，不调模型：P1-A 阶段宁可漏，也不要乱采。
 */
const SCOPE_CUE = new RegExp(
  [
    // 回答方式
    '回答', '回复', '解释', '说明', '讲(解|清楚)?', '输出', '格式', '排版', '语气', '称呼', '叫我', '称我',
    '举例', '示例', '例子', '代码', '注释', '翻译', '中文', '英文', '分点', '列表', '结论', '总结', '步骤',
    '详细', '简洁', '简短', '长一点', '短一点', '直接', '口语', '正式', '专业',
    // 对我的要求 / 记忆请求
    '提醒我', '记住', '记下', '别忘了', '每次(都)?', '一律', '统一',
  ].join('|'),
)

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

/** 这句话说的是不是「跟 AI 有关的要求 / 希望被记住的事」。 */
export function hasScope(text) {
  return SCOPE_CUE.test(String(text ?? ''))
}

/** 从一条消息里挑出候选句：既命中触发、又落在采集范围内。 */
export function candidatesOf(text, limit = 3) {
  const value = String(text ?? '')
  const out = []
  for (const sentence of value.match(SENTENCE) ?? []) {
    const line = sentence.trim()
    if (line.length < 4 || line.length > 200) continue
    if (triggersOf(line).length === 0) continue
    if (!hasScope(line)) continue
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

/** 词面相似度（重叠系数），只作第一层筛选。 */
export function similarity(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  // 用重叠系数而不是 Jaccard：中文长句稍改几个字，Jaccard 掉得太快
  return shared / Math.min(left.size, right.size)
}

/**
 * 每条话在每个方向组上站哪一边：Map<组序号, 'left'|'right'>。
 * 组之间互不影响，所以一句话可以同时是「简短」和「慢」。
 */
export function directionMap(text) {
  const value = String(text ?? '')
  const map = new Map()
  DIRECTIONS.forEach(([left, right], group) => {
    const hasLeft = value.includes(left)
    const hasRight = value.includes(right)
    if (hasLeft && !hasRight) map.set(group, 'left')
    if (hasRight && !hasLeft) map.set(group, 'right')
  })
  return map
}

/** 这句话站了哪几边的方向（可能是多个维度，空集合 = 没提）。 */
export function directionsOf(text) {
  const value = String(text ?? '')
  const matched = []
  for (const [left, right] of DIRECTIONS) {
    if (value.includes(left)) matched.push(left)
    if (value.includes(right)) matched.push(right)
  }
  // 「简短」已经包含了「短」，别把同一个意思数两遍
  const kept = matched.filter((word) => !matched.some((other) => other !== word && other.includes(word)))
  return new Set(kept)
}

/** 兼容旧调用：返回第一个方向词（没提就是 null）。新代码用 directionsOf。 */
export function directionOf(text) {
  const set = directionsOf(text)
  for (const item of set) return item
  return null
}

/**
 * 两个候选该不该合并。
 * 相似 + 同向 → 合并（只合并证据，状态各归各）
 * 相似 + 反向 / 一边有一边没有 → 冲突，不许自动合并
 */
export function compareCandidate(incoming, existing) {
  const score = similarity(incoming, existing)
  if (score < 0.5) return { action: 'new', score }

  const negA = NEGATION.test(incoming)
  const negB = NEGATION.test(existing)
  const mapA = directionMap(incoming)
  const mapB = directionMap(existing)

  // 同一组上双方都表了态、且方向相反 —— 这是真冲突
  for (const [group, side] of mapA) {
    if (mapB.has(group) && mapB.get(group) !== side) return { action: 'conflict', score }
  }
  // 一边提了方向、另一边完全没提 —— 也不自动合并
  const oneSided = (mapA.size === 0) !== (mapB.size === 0)
  if (negA !== negB || oneSided) return { action: 'conflict', score }
  return { action: 'merge', score }
}

/* ------------------------------ 事件判定与提交顺序 ------------------------------ */

/**
 * 这条事件是不是「用户亲自打的字」。
 * 两个条件都要满足：事件类型是 user/message，且消息自带 source.kind === 'user'。
 * 只判其一不够 —— 注入的内容也可能走 user 通道，但 source.kind 不是 user。
 */
export function isUserAuthored(event) {
  if (event === null || typeof event !== 'object') return false
  if (event.type !== 'user/message') return false
  const kind = event.data?.source?.kind
  return kind === 'user'
}

/** 这条消息里已经有候选落在 facts 里了吗（按 会话#seq 判，重放时用来兜底去重）。 */
export function alreadyCaptured(facts, source) {
  return (facts ?? []).some((fact) => fact.source === source)
}

/**
 * 提交一次观察：先写候选，成功了才推进游标。
 *
 * 顺序不能反 —— 先推进游标再写候选，写失败就等于这条消息永久丢了。
 * 如果写成功但游标保存失败，下次会重放这一条：此时用 options.facts() 现读一遍
 * facts（不传就只能靠调用方在 write 里自己判 alreadyCaptured）。
 *
 * options.facts: () => facts[]，每次调用都现读，不要传缓存快照。
 */
export async function commitObservation(observation, write, options = {}) {
  const { sessionId, seq } = observation ?? {}
  if (!sessionId) return { ok: false, error: '缺少 sessionId' }
  // 只收真数字或纯数字字符串：Number(null) 会变 0，Number('') 也会变 0，这两种必须挡掉
  const text = typeof seq === 'number' ? String(seq) : typeof seq === 'string' ? seq.trim() : ''
  const value = text === '' || /^[0-9]+$/.test(text) === false ? NaN : Number(text)
  if (!Number.isSafeInteger(value)) {
    return { ok: false, error: 'seq 必须是非负整数：' + String(seq) }
  }

  if (alreadySeen(sessionId, value)) return { ok: true, skipped: 'cursor' }

  const source = `${sessionId}#${value}`
  if (typeof options.facts === 'function') {
    const facts = options.facts()
    if (alreadyCaptured(facts, source)) {
      await markSeenLocked(sessionId, value)
      return { ok: true, skipped: 'source' }
    }
  }

  const written = await write(observation)
  try {
    await markSeenLocked(sessionId, value)
  } catch (error) {
    return { ok: false, written, error: '候选已写入，但游标保存失败：' + String(error?.message ?? error) }
  }
  return { ok: true, skipped: null, written }
}

/* ------------------------------ 游标（幂等） ------------------------------ */

export class CursorCorruptError extends Error {
  constructor(file, backup) {
    super(`游标文件损坏，已备份到 ${backup}，请人工确认后再继续：${file}`)
    this.name = 'CursorCorruptError'
    this.file = file
    this.backup = backup
  }
}

export function cursorPath() {
  return join(memoryRoot(), 'capture-cursor.json')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function backupBrokenCursor(file) {
  const backup = `${file}.corrupt-${Date.now()}`
  try {
    renameSync(file, backup)
  } catch {
    throw new CursorCorruptError(file, '(备份失败)')
  }
  throw new CursorCorruptError(file, backup)
}

/**
 * 读游标。
 * - 文件不存在：首次运行，返回 {}
 * - 结构不对：不是普通对象、或某个会话的值不是安全非负整数 → 同样是损坏
 *   损坏一律「备份 + 抛错」，不静默从头来（重放历史比停一下更糟）
 */
export function readCursor() {
  const file = cursorPath()
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf8')

  let data = null
  try {
    data = JSON.parse(raw)
  } catch {
    backupBrokenCursor(file)
  }
  if (!isPlainObject(data)) backupBrokenCursor(file)
  for (const [key, value] of Object.entries(data)) {
    const num = typeof value === 'number' ? value : NaN
    if (!Number.isSafeInteger(num) || num < 0) backupBrokenCursor(file)
    if (key.trim() === '') backupBrokenCursor(file)
  }
  return data
}

/** 这条消息处理过了吗？用 seq 判断，不靠时间戳。 */
export function alreadySeen(sessionId, seq, cursor = readCursor()) {
  // 没记录过就是「还没处理」；用 -1 而不是 0，否则 seq=0 的第一条会被误判成已处理
  const last = cursor[sessionId] === undefined ? -1 : Number(cursor[sessionId])
  return Number(seq) <= last
}

/* ------------------------------ 两把锁 ------------------------------ */

/** 游标文件的读—改—写必须串起来，否则两个会话并发写会互相覆盖。 */
let cursorChain = Promise.resolve()

/** 会话处理链：同一会话的事件严格按到达顺序串行，不同会话互不阻塞。 */
const sessionChains = new Map()

/** 把一段任务排进「游标锁」里执行（全局串行，只保护读改写这一小段）。 */
export function withCursorLock(task) {
  const run = cursorChain.then(task, task)
  cursorChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 把一段任务排进某个会话的串行链（会话内保序，没有全局串行）。 */
export function enqueue(sessionId, task) {
  const key = String(sessionId ?? '')
  const previous = sessionChains.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  sessionChains.set(key, settled)
  settled.then(() => {
    if (sessionChains.get(key) === settled) sessionChains.delete(key)
  })
  return run
}

/**
 * 同步写游标：read → 改 → write 全在一段同步代码里，单个 tick 内不会被别的会话插进来。
 * 异步路径请用 markSeenLocked()，它会把这小段排进游标锁。
 */
export function markSeen(sessionId, seq) {
  const cursor = readCursor()
  const last = cursor[sessionId] === undefined ? -1 : Number(cursor[sessionId])
  if (Number(seq) <= last) return cursor
  cursor[sessionId] = Number(seq)
  mkdirSync(memoryRoot(), { recursive: true })
  writeJsonAtomic(cursorPath(), cursor)
  return cursor
}

/** 异步路径用的写游标：排进游标锁再写，避免跨会话并发覆盖。 */
export function markSeenLocked(sessionId, seq) {
  return withCursorLock(() => markSeen(sessionId, seq))
}
