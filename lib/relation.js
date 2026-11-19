/**
 * dsh-selfnote · 关系层（Topic / Episode）
 *
 * Topic（大主题，进全局注入）与 Episode（议题，按需检索）两份 jsonl 的
 * 读写、判重、锁、热度记账。全部镜像 lib/memory.js 对 facts.jsonl 的做法：
 * 读整份 → 改 → 整份写回，靠锁文件互斥；mutate 里绝不能有 await。
 *
 * Memory/Decision 复用 facts.jsonl（见 lib/memory.js），这里只管 Topic/Episode 两层。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { writeAtomic } from './atomic.js'
import { selfnoteRoot } from './store.js'

export const topicPath = () => join(selfnoteRoot(), 'topic.jsonl')
export const episodePath = () => join(selfnoteRoot(), 'episode.jsonl')

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 判重键：trim + 空白折叠（保留大小写差异）。宁拆勿并，只认「归一化后完全相同」。 */
const normalizeTitle = (title) => String(title ?? '').trim().replace(/\s+/g, ' ')

/* ------------------------------ 读写 ------------------------------ */

export function readTopics() {
  const file = topicPath()
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const topic = JSON.parse(text)
      if (topic !== null && typeof topic === 'object') out.push(topic)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

export function writeTopics(topics) {
  ensureDir(selfnoteRoot())
  writeAtomic(topicPath(), topics.map((topic) => JSON.stringify(topic)).join('\n') + (topics.length > 0 ? '\n' : ''))
}

export function readEpisodes() {
  const file = episodePath()
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const episode = JSON.parse(text)
      if (episode !== null && typeof episode === 'object') out.push(episode)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

export function writeEpisodes(episodes) {
  ensureDir(selfnoteRoot())
  writeAtomic(episodePath(), episodes.map((episode) => JSON.stringify(episode)).join('\n') + (episodes.length > 0 ? '\n' : ''))
}

/* ------------------------------ 锁（参数化，不共用 facts 的锁） ------------------------------ */

const BACKOFF = new Int32Array(new SharedArrayBuffer(4))

/** 同步等一会儿再重试：mutate 里不能有 await，靠这个让出窗口给别的写入。 */
function pause(ms) {
  try {
    Atomics.wait(BACKOFF, 0, 0, ms)
  } catch {
    /* 部分环境不支持就退化成不让 */
  }
}

const STALE_LOCK_MS = 2000

/** 跨进程互斥：open 'wx' 独占创建；超过 STALE_LOCK_MS 当遗留废锁接管。 */
function acquireLock(file, deadlineMs = 150) {
  ensureDir(selfnoteRoot())
  const start = Date.now()
  for (;;) {
    try {
      closeSync(openSync(file, 'wx'))
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') return false
      try {
        if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(file)
          continue
        }
      } catch {
        // 锁文件刚被别人删掉：直接重试
      }
      if (Date.now() - start >= deadlineMs) return false
      pause(1)
    }
  }
}

function releaseLock(file) {
  try {
    unlinkSync(file)
  } catch {
    /* 已经没了就算了 */
  }
}

/** 拿锁 → 读 → 改 → 写 → 放锁，全在一段同步代码里。抢不到锁重试，几次都拿不到就放弃。 */
function mutateJsonl(read, write, lockFile, mutate, attempts = 5, deadlineMs = 150) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) pause(1)
    if (!acquireLock(lockFile, deadlineMs)) continue
    try {
      const items = read()
      const outcome = mutate(items) ?? { changed: false }
      if (outcome.changed === true) write(items)
      return outcome
    } finally {
      releaseLock(lockFile)
    }
  }
  return { changed: false, error: '文件一直被别的进程占着，这次没有写入' }
}

export function mutateTopics(mutate, attempts = 5, deadlineMs = 150) {
  return mutateJsonl(readTopics, writeTopics, topicPath() + '.lock', mutate, attempts, deadlineMs)
}

export function mutateEpisodes(mutate, attempts = 5, deadlineMs = 150) {
  return mutateJsonl(readEpisodes, writeEpisodes, episodePath() + '.lock', mutate, attempts, deadlineMs)
}

/* ------------------------------ 建立 / 判重 ------------------------------ */

export function upsertTopic(input = {}) {
  const title = normalizeTitle(input.title)
  if (title === '') return { ok: false, error: 'title 不能为空' }
  let result = null
  const outcome = mutateTopics((topics) => {
    const found = topics.find((topic) => normalizeTitle(topic.title) === title)
    const at = new Date().toISOString()
    if (found) {
      const summary = String(input.summary ?? '').trim()
      if (summary !== '') found.summary = summary
      found.lastTouched = at
      found.updated = at.slice(0, 10)
      result = { ok: true, topic: found, merged: true }
      return { changed: true }
    }
    const topic = {
      id: 't' + Math.random().toString(36).slice(2, 10),
      title,
      summary: String(input.summary ?? '').trim(),
      boost: 0,
      lastTouched: at,
      useCount: 0,
      readCount: 0,
      created: at.slice(0, 10),
      updated: at.slice(0, 10),
    }
    topics.push(topic)
    result = { ok: true, topic }
    return { changed: true }
  })
  if (outcome?.error) return { ok: false, error: outcome.error }
  return result ?? { ok: false, error: '写入失败' }
}

export function upsertEpisode(input = {}) {
  // topicId 允许空：暂未挂 Topic 的议题，后续 attachFact / 人工补挂（Task 5 的 propose 语义）。
  const topicId = String(input.topicId ?? '').trim()
  const title = normalizeTitle(input.title)
  if (title === '') return { ok: false, error: 'title 不能为空' }
  let result = null
  const outcome = mutateEpisodes((episodes) => {
    // 判重键 = topicId + '\0' + 归一化 title，且仅 open 状态的 merge（closed/archived 新建）
    const found = episodes.find(
      (episode) => episode.topicId === topicId && normalizeTitle(episode.title) === title && episode.status === 'open',
    )
    const at = new Date().toISOString()
    if (found) {
      const summary = String(input.summary ?? '').trim()
      if (summary !== '') found.summary = summary
      found.lastTouched = at
      found.updated = at.slice(0, 10)
      result = { ok: true, episode: found, merged: true }
      return { changed: true }
    }
    const episode = {
      id: 'e' + Math.random().toString(36).slice(2, 10),
      topicId,
      title,
      status: 'open',
      summary: String(input.summary ?? '').trim(),
      lastTouched: at,
      nodes: [],
      created: at.slice(0, 10),
      updated: at.slice(0, 10),
    }
    episodes.push(episode)
    result = { ok: true, episode }
    return { changed: true }
  })
  if (outcome?.error) return { ok: false, error: outcome.error }
  return result ?? { ok: false, error: '写入失败' }
}

/* ------------------------------ 排序 ------------------------------ */

export function rankTopics(topics, now = Date.now()) {
  const usage = (t) => 1 + Math.log1p((Number(t.useCount) || 0) + (Number(t.readCount) || 0))
  const ageDays = (t) => {
    const at = Date.parse(t.lastTouched ?? t.updated ?? t.created ?? '')
    return Number.isFinite(at) ? Math.max(0, (now - at) / 86400000) : 365
  }
  return topics
    .filter((t) => t.archivedAt === undefined || t.archivedAt === null)
    .map((topic) => ({ topic, score: usage(topic) * Math.pow(0.5, ageDays(topic) / 7) + (Number(topic.boost) || 0) }))
    .sort((a, b) => b.score - a.score || String(b.topic.lastTouched ?? '').localeCompare(String(a.topic.lastTouched ?? '')))
    .map((x) => x.topic)
}

/* ------------------------------ 人工兜底 ------------------------------ */

export function renameTopic(id, title) {
  const clean = normalizeTitle(title)
  if (clean === '') return { ok: false, error: 'title 不能为空' }
  let result = null
  const outcome = mutateTopics((topics) => {
    const topic = topics.find((item) => item.id === id)
    if (topic === undefined) return { changed: false, error: '没有这个话题（可能刚被改过），刷新一下' }
    if (normalizeTitle(topic.title) === clean) return { changed: false, unchanged: true }
    const clash = topics.some((item) => item.id !== id && normalizeTitle(item.title) === clean)
    if (clash) return { changed: false, error: '已存在同名的另一个话题，不重命名' }
    const at = new Date().toISOString()
    topic.title = clean
    topic.updated = at.slice(0, 10)
    result = { ok: true, topic }
    return { changed: true }
  })
  if (outcome?.error) return { ok: false, error: outcome.error }
  if (result === null) return { ok: false, error: `找不到话题 ${id}` }
  return result
}

export function archiveTopic(id) {
  let result = null
  const outcome = mutateTopics((topics) => {
    const topic = topics.find((item) => item.id === id)
    if (topic === undefined) return { changed: false, error: '没有这个话题（可能刚被改过），刷新一下' }
    const at = new Date().toISOString()
    topic.archivedAt = at
    topic.updated = at.slice(0, 10)
    result = { ok: true, topic }
    return { changed: true }
  })
  if (outcome?.error) return { ok: false, error: outcome.error }
  if (result === null) return { ok: false, error: `找不到话题 ${id}` }
  return result
}

/* ------------------------------ 热度记账 ------------------------------ */

const TOUCH_INTERVAL_MS = 60 * 60 * 1000
const SEEN_INTERVAL_MS = 10 * 60 * 1000

export function touchTopics(ids, now = Date.now()) {
  const wanted = new Set(ids ?? [])
  if (wanted.size === 0) return 0
  const stamp = new Date(now).toISOString()
  const outcome = mutateTopics((topics) => {
    let changed = 0
    for (const topic of topics) {
      if (!wanted.has(topic.id)) continue
      const last = Date.parse(topic.lastHit ?? '')
      if (!Number.isNaN(last) && now - last < TOUCH_INTERVAL_MS) continue
      topic.useCount = (Number(topic.useCount ?? 0) || 0) + 1
      topic.lastHit = stamp
      topic.lastTouched = stamp
      changed += 1
    }
    return { changed: changed > 0, count: changed }
  }, 2, 150)
  return outcome.count ?? 0
}

export function seenTopics(ids, now = Date.now()) {
  const wanted = new Set(ids ?? [])
  if (wanted.size === 0) return 0
  const stamp = new Date(now).toISOString()
  const outcome = mutateTopics((topics) => {
    let changed = 0
    for (const topic of topics) {
      if (!wanted.has(topic.id)) continue
      const last = Date.parse(topic.lastSeen ?? '')
      if (!Number.isNaN(last) && now - last < SEEN_INTERVAL_MS) continue
      topic.readCount = (Number(topic.readCount ?? 0) || 0) + 1
      topic.lastSeen = stamp
      changed += 1
    }
    return { changed: changed > 0, count: changed }
  }, 2, 150)
  return outcome.count ?? 0
}
