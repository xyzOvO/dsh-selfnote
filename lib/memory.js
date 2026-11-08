/**
 * dsh-selfnote · 记忆层（P1）
 *
 * 只做两件事：
 *   1. 把 DSH 自己的会话记录（session.v4.jsonl.zstd）解出来，按需缓存，供检索；
 *   2. 提供一个带出处的检索：返回原文片段 + citation（会话 id / 日期 / 第几条）。
 *
 * 不写会话文件，不改会话文件，只读。
 * facts.jsonl 是给 P2 的提炼结果留的位子，本版只读不写。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { writeAtomic, writeJsonAtomic } from './atomic.js'

const SESSION_FILE = 'session.v4.jsonl.zstd'
/** 缓存格式版本：解析规则变了就 +1，旧缓存自动作废。 */
const CACHE_VERSION = 6
const SNIPPET_CHARS = 180
// 缓存一个会话是十 KB 左右，300 个会话也就三兆多。原来只留 60 个，
// 结果全量扫描时「读一个 → 写一个 → 淘汰掉下一个」，300 次 fsync 换几乎零命中。
const CACHE_LIMIT = 400

export function dshHome() {
  const env = String(process.env.DSH_HOME ?? '').trim()
  return env === '' ? join(homedir(), '.dsh') : env
}

export function memoryRoot() {
  const env = String(process.env.DSH_MEMORY_DIR ?? '').trim()
  return env === '' ? join(dshHome(), 'memory') : env
}

export const factsPath = () => join(memoryRoot(), 'facts.jsonl')
export const statePath = () => join(memoryRoot(), 'state.json')
export const cacheDir = () => join(memoryRoot(), 'cache')

export function sessionsRoot() {
  const env = String(process.env.DSH_SESSIONS_DIR ?? '').trim()
  return env === '' ? join(dshHome(), 'sessions') : env
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/* ------------------------------ 状态 ------------------------------ */

export function readState() {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const data = JSON.parse(raw)
    return data !== null && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

export function writeState(next) {
  ensureDir(memoryRoot())
  writeJsonAtomic(statePath(), next)
}

/* ------------------------------ 会话索引 ------------------------------ */

/**
 * 一次 stat 三百多个会话文件要 80ms 左右。
 * 设置页刷一次会问好几遍（检索统计、索引覆盖、文件区），
 * 所以在这层做一个「本次调用栈内共用一份」的快照：
 * 只在 withSessionSnapshot() 里面生效，出了这个门就恢复每次现扫，
 * 免得测试改了文件却读到旧列表。
 */
let snapshot = null

export function listSessions() {
  if (snapshot !== null) return snapshot
  return scanSessions()
}

/** 在这段同步代码里，listSessions() 只扫一次。 */
export function withSessionSnapshot(fn) {
  const previous = snapshot
  snapshot = scanSessions()
  try {
    return fn()
  } finally {
    snapshot = previous
  }
}

function scanSessions() {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const out = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const file = join(projectDir, session.name, SESSION_FILE)
      if (!existsSync(file)) continue
      const info = statSync(file)
      out.push({ id: session.name, project: project.name, file, mtime: info.mtimeMs })
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    // 只取正文：reasoning 和 tool-call 不进记忆，避免把思考噪声当事实
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 解压一个会话，抽出可检索的轮次。失败返回空数组（格式变了解不开就跳过，不报错）。 */
/**
 * 解 zstd。Electron 自带的 zlib 只解**第一个 frame**（真机实测：881KB 的会话只出来 189 字节），
 * 而 DSH 的会话文件是逐条追加的多 frame。所以这里先按 magic 切帧逐帧解，
 * 切分失败（magic 出现在压缩数据里）就退回整块解。
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 从 from（必须是帧边界）开始往后解，返回解出来的文本和「最后一帧的结束偏移」。
 *
 * 增量解析的关键：**只解新追加的那段字节**。`end` 让下次知道从哪继续；
 * 尾部那帧还没写完（写会话时被打断）时不报错，就地停下，下次接着解 ——
 * 这样「半个会话突然解不开」就不会再变成「整个会话从检索里消失」。
 */
function decodeFrom(buf, from = 0) {
  const cuts = []
  let at = buf.indexOf(ZSTD_MAGIC, Math.max(0, from))
  while (at !== -1) {
    cuts.push(at)
    at = buf.indexOf(ZSTD_MAGIC, at + 4)
  }
  if (cuts.length === 0) return { text: '', end: buf.length, frames: 0 }
  // 单帧文件（或整块能解）：老路径，不切
  if (from === 0 && cuts.length < 2) {
    return { text: zstdDecompressSync(buf).toString('utf8'), end: buf.length, frames: 1 }
  }
  const parts = []
  let start = from === 0 ? cuts[0] : from
  let end = start
  let frames = 0
  for (let i = 0; i < cuts.length; i += 1) {
    const segmentEnd = i + 1 < cuts.length ? cuts[i + 1] : buf.length
    if (segmentEnd <= start) continue
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, segmentEnd)))
      start = segmentEnd
      end = segmentEnd
      frames += 1
    } catch {
      // 这一刀切错了（magic 落在压缩数据里），或者尾巴那帧还没写完 —— 停在上一帧结尾
      break
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), end, frames }
}

/**
 * 解析一段文本（全量解析和增量解析共用）。
 *
 * linesBefore：这段文本在整份会话里的起始行号。增量解析时行号必须接上，
 * 否则两批记录共用同一个 index，「会话#行号」这个出处就指错了。
 * carry：文本末尾如果是一条没写完的行，留到下次拼在前面再解析，不丢也不报错。
 */
function parseText(text, options = {}) {
  const linesBefore = options.linesBefore ?? 0
  const knownDelegated = options.delegated === true
  const complete = text === '' || text.endsWith('\n')
  const pieces = text.split('\n')
  const carry = complete ? '' : pieces.pop() ?? ''

  // 先认委派会话：子代理会话里那些「user」是委派方的任务书，不是这个人本人说的话
  let delegated = knownDelegated
  if (!delegated) {
    for (const raw of pieces) {
      if (!raw.includes('subagent/descriptor')) continue
      try {
        if (JSON.parse(raw).type === 'subagent/descriptor') {
          delegated = true
          break
        }
      } catch {
        /* 半截行，忽略 */
      }
    }
  }

  const records = []
  for (let i = 0; i < pieces.length; i += 1) {
    const line = pieces[i].trim()
    if (line === '') continue
    let record = null
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const index = linesBefore + i
    if (record.type === 'user/message') {
      // 只留真人说的话：source.kind 不是 user 的都是插件/运行时注入的
      // （mnemon 快照、系统提醒、skill 正文），那不是他的原话，进了记忆会污染出处。
      const kind = record.data?.source?.kind
      if (kind !== undefined && kind !== 'user') continue
      const body = blocksToText(record.data?.content)
      if (body !== '') {
        records.push({ index, role: delegated ? 'delegated' : 'user', text: body, time: record.time ?? 0 })
      }
    } else if (record.type === 'assistant/message') {
      const body = blocksToText(record.data?.message?.content)
      if (body !== '') records.push({ index, role: 'assistant', text: body, time: record.time ?? 0 })
    }
  }
  // 结尾那个换行不代表多了一行：不算进去，否则下一批的行号会整体错开一格
  const lineCount = complete ? Math.max(0, pieces.length - 1) : pieces.length
  return { records, delegated, lines: linesBefore + lineCount, carry }
}

function parseSession(file) {
  let decoded
  let size = 0
  try {
    size = statSync(file).size
    decoded = decodeFrom(readFileSync(file), 0)
  } catch {
    // 解不开就如实报告：别让它装作「这个会话是空的」，否则索引会以为自己收全了
    return { records: [], delegated: false, ok: false, end: 0, lines: 0, carry: '' }
  }
  // 文件有内容却一帧都没解出来 = 真的坏了，不能当成「空会话」放过去
  if (size > 0 && decoded.frames === 0) {
    return { records: [], delegated: false, ok: false, end: 0, lines: 0, carry: '' }
  }
  const parsed = parseText(decoded.text)
  return {
    records: parsed.records,
    delegated: parsed.delegated,
    lines: parsed.lines,
    carry: parsed.carry,
    end: decoded.end,
    ok: true,
  }
}

/** 文件开头 64 字节的指纹：用来判断「这份会话是被追写了，还是被重写过」。 */
function headOf(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(64)
      const n = readSync(fd, buf, 0, 64, 0)
      return buf.subarray(0, Math.max(0, n)).toString('hex')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function tailFrom(file, offset) {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const length = size - offset
    if (length <= 0) return Buffer.alloc(0)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, offset)
    return buf
  } finally {
    closeSync(fd)
  }
}

/**
 * 增量：只在「文件被追写」时走这条路 —— 前缀指纹没变、上次停在帧边界、文件变长了。
 * 只读新增的字节再解压，长会话不必每回合把整份历史重新解一遍。
 * 任何一条对不上（重写、截断、换了文件）就返回 null，退回全量解析 —— 慢一点，但不会读错。
 */
function appendToCache(session, cached, size) {
  try {
    if (cached.failed === true) return null
    if (typeof cached.end !== 'number' || cached.end <= 0 || cached.end > size) return null
    if (cached.head !== headOf(session.file)) return null
    const tail = tailFrom(session.file, cached.end)
    if (tail.length === 0) return null
    // 上次停的位置必须是帧边界，否则从中间切开只会解出一堆垃圾
    if (tail.length >= 4 && !tail.subarray(0, 4).equals(ZSTD_MAGIC)) return null
    const decoded = decodeFrom(tail, 0)
    if (decoded.text === '') return null
    const parsed = parseText((cached.carry ?? '') + decoded.text, {
      delegated: cached.delegated === true,
      linesBefore: cached.lines ?? 0,
    })
    return {
      ...cached,
      v: CACHE_VERSION,
      project: session.project,
      mtime: session.mtime,
      date: new Date(session.mtime).toISOString().slice(0, 10),
      delegated: parsed.delegated,
      records: cached.records.concat(parsed.records),
      failed: false,
      bytes: size,
      end: cached.end + decoded.end,
      lines: parsed.lines,
      carry: parsed.carry,
    }
  } catch {
    return null
  }
}

/** 读会话（带磁盘缓存 + 增量解析）。 */
export function readSession(session) {
  const dir = cacheDir()
  const cacheFile = join(dir, session.id + '.json')
  let cached = null
  try {
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (raw?.v === CACHE_VERSION && raw.id === session.id && Array.isArray(raw.records)) cached = raw
  } catch {
    /* 没缓存或坏了，重建 */
  }

  let size = -1
  try {
    size = statSync(session.file).size
  } catch {
    size = -1
  }

  // 没变过：直接用缓存，一次解压都不做
  if (cached !== null && cached.bytes === size && cached.mtime === session.mtime) return cached

  // 只追加：只解新加的那几帧
  let payload = null
  if (cached !== null && size > cached.bytes && cached.bytes >= 0) {
    payload = appendToCache(session, cached, size)
  }

  if (payload === null) {
    const parsed = parseSession(session.file)
    const failed = parsed.ok === false
    payload = {
      v: CACHE_VERSION,
      id: session.id,
      project: session.project,
      mtime: session.mtime,
      date: new Date(session.mtime).toISOString().slice(0, 10),
      delegated: parsed.delegated,
      records: parsed.records,
      failed,
      bytes: failed ? -1 : size,
      end: failed ? 0 : parsed.end,
      lines: parsed.lines,
      carry: parsed.carry,
      head: failed ? '' : headOf(session.file),
    }
  }
  const failed = payload.failed === true
  // 解不开的不要进缓存：缓存一写，下次就照着「空会话」返回，永久看不见问题
  if (failed === false) {
    try {
      ensureDir(dir)
      writeAtomic(cacheFile, JSON.stringify(payload))
      pruneCache()
    } catch {
      /* 写不了缓存不影响检索 */
    }
  }
  return payload
}

let lastPrune = 0
const PRUNE_MS = 30 * 1000

/**
 * 清缓存要节流：全量扫描时每读一个会话就写一次缓存，如果每次写完都 readdir + stat 一遍缓存目录，
 * 300 个会话就是 300 × 300 次 stat，而此刻缓存里大多还是「马上要读的下一个」。
 * 半分钟扫一次足够。
 */
function pruneCache() {
  const now = Date.now()
  if (now - lastPrune < PRUNE_MS) return
  lastPrune = now
  try {
    const dir = cacheDir()
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = join(dir, name)
        return { file, mtime: statSync(file).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const stale of files.slice(CACHE_LIMIT)) {
      try {
        unlinkSync(stale.file)
      } catch {
        /* Windows 上偶发占用，删不掉就留着 */
      }
    }
  } catch {
    /* 清缓存失败无所谓 */
  }
}

/* ------------------------------ 检索 ------------------------------ */

const CJK = /[\u4e00-\u9fff]/

export function tokenize(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[\s,，.。;；:：!！?？、|/\\()[\]{}"'“”‘’<>《》]+/)
    .map((term) => term.trim())
    .filter((term) => term !== '')
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    count += 1
    from = at + needle.length
    if (count > 20) break
  }
  return count
}

function snippetAround(text, terms) {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  const flat = text.replace(/\s+/g, ' ').trim()
  if (at < 0) return flat.slice(0, SNIPPET_CHARS)
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3))
  const piece = flat.slice(start, start + SNIPPET_CHARS)
  return (start > 0 ? '…' : '') + piece + (start + SNIPPET_CHARS < flat.length ? '…' : '')
}

/** 在一个会话里打分。AND 语义：每个词都要出现。 */
function scoreRecords(records, terms) {
  const hits = []
  for (const record of records) {
    const lower = record.text.toLowerCase()
    let matched = 0
    let score = 0
    for (const term of terms) {
      const count = countOccurrences(lower, term)
      if (count > 0) {
        matched += 1
        // 他本人说的话权重最高；委派提示是机器写的，和我的转述同权
        score += Math.min(count, 6) * (record.role === 'user' ? 3 : 1)
      }
    }
    if (matched > 0) hits.push({ record, matched, score })
  }
  return hits
}


/** 3 = 他本人说的；2 = 我说的；1 = 委派提示（机器写的任务书）。 */
function roleTier(role) {
  if (role === 'user') return 3
  if (role === 'delegated') return 1
  return 2
}

function rankHits(hits) {
  return hits.sort(
    (a, b) =>
      roleTier(b.role) - roleTier(a.role) ||
      b.score - a.score ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0),
  )
}

/** 线性扫描的时间预算：超了就停，并如实报告没扫完。 */
export const SCAN_BUDGET_MS = 1200

function emptyResult(extra = {}) {
  return { mode: 'raw', total: 0, degraded: false, hits: [], ms: 0, ...extra }
}

/**
 * 线性扫描：从最新的会话往回扫，直到扫完或超时。
 * 关键约定：limit 只砍「返回条数」，不影响「搜索范围」；范围没扫全就标 complete:false。
 */
export function searchRaw(query, options = {}) {
  const started = Date.now()
  const budget = clampInt(options.budgetMs, SCAN_BUDGET_MS, 200, 10000)
  const terms = tokenize(query)
  const total = listSessions().length
  if (terms.length === 0) {
    return emptyResult({ complete: true, sessions_total: total, sessions_scanned: 0, sessions_failed: 0 })
  }

  const limit = clampInt(options.limit, 5, 1, 20)
  const since = String(options.since ?? '').trim()
  const pool = listSessions().filter((session) => {
    if (since === '') return true
    return new Date(session.mtime).toISOString().slice(0, 10) >= since
  })

  const strict = []
  const loose = []
  let scanned = 0
  let failed = 0
  let complete = true

  for (const session of pool) {
    if (Date.now() - started > budget) {
      complete = false
      break
    }
    scanned += 1
    let parsed = null
    try {
      parsed = readSession(session)
    } catch {
      failed += 1
      continue
    }
    for (const hit of scoreRecords(parsed.records, terms)) {
      const item = {
        session: session.id,
        project: session.project,
        date: parsed.date,
        index: hit.record.index,
        role: hit.record.role,
        matched: hit.matched,
        score: hit.score,
        snippet: snippetAround(hit.record.text, terms),
      }
      if (hit.matched === terms.length) strict.push(item)
      else loose.push(item)
    }
  }

  const degraded = strict.length === 0 && loose.length > 0
  const chosen = rankHits(degraded ? loose : strict)

  return {
    mode: 'raw',
    total: chosen.length,
    degraded,
    terms,
    hits: chosen.slice(0, limit),
    ms: Date.now() - started,
    sessions: scanned,
    complete: complete && failed === 0,
    sessions_total: pool.length,
    sessions_scanned: scanned,
    sessions_failed: failed,
    partial: !complete,
    budget_ms: budget,
  }
}

/** 索引给出的候选 id（"会话#行号"）→ 打分 + 片段。只读命中的那些会话。 */
export function searchByIds(ids, query, options = {}) {
  const started = Date.now()
  const terms = tokenize(query)
  const limit = clampInt(options.limit, 5, 1, 20)
  // 索引路径也要认 since：否则带筛选的检索会悄悄返回更早的记录。
  const since = String(options.since ?? '').trim()
  const bySession = new Map()
  for (const id of ids) {
    const cut = id.lastIndexOf('#')
    const sid = id.slice(0, cut)
    const index = Number(id.slice(cut + 1))
    if (!bySession.has(sid)) bySession.set(sid, new Set())
    bySession.get(sid).add(index)
  }
  const sessions = new Map(listSessions().map((session) => [session.id, session]))
  const hits = []
  let failed = 0
  for (const [sid, wanted] of bySession) {
    const session = sessions.get(sid)
    if (session === undefined) {
      failed += 1
      continue
    }
    let parsed = null
    try {
      parsed = readSession(session)
    } catch {
      failed += 1
      continue
    }
    if (since !== '' && parsed.date < since) continue
    for (const record of parsed.records) {
      if (!wanted.has(record.index)) continue
      const scored = scoreRecords([record], terms)[0]
      hits.push({
        session: sid,
        project: session.project,
        date: parsed.date,
        index: record.index,
        role: record.role,
        matched: scored?.matched ?? 0,
        score: scored?.score ?? 0,
        snippet: snippetAround(record.text, terms),
      })
    }
  }
  rankHits(hits)
  return {
    mode: 'raw',
    source: 'index',
    total: hits.length,
    // 索引那边没有严格命中时会退回「词的并集」并置 degraded；这个信息得透传出来，
    // 不然界面会说「没放宽词」，用户以为结果本来就该这么少。
    degraded: options.degraded === true,
    terms,
    hits: hits.slice(0, limit),
    ms: Date.now() - started,
    complete: failed === 0,
    sessions_total: sessions.size,
    sessions_scanned: bySession.size,
    sessions_failed: failed,
  }
}

/* ------------------------------ 事实（P2 的位子） ------------------------------ */

export function readFacts() {
  const file = factsPath()
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const fact = JSON.parse(text)
      if (fact !== null && typeof fact === 'object') out.push(fact)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

export function writeFacts(facts) {
  ensureDir(memoryRoot())
  writeAtomic(factsPath(), facts.map((fact) => JSON.stringify(fact)).join('\n') + (facts.length > 0 ? '\n' : ''))
}

const BACKOFF = new Int32Array(new SharedArrayBuffer(4))

/** 同步等一会儿再重试：mutate 里不能有 await，靠这个让出窗口给别的写入。 */
function pause(ms) {
  try {
    Atomics.wait(BACKOFF, 0, 0, ms)
  } catch {
    /* 部分环境不支持就退化成不让 */
  }
}

/**
 * 跨进程互斥：拿锁靠「独占创建」这一个原子动作（open 'wx'），不是先查后写 ——
 * 先查再写那一步本身就不是原子的（两个进程会同时看到"没人占"）。
 * 进程被杀会留下锁文件，超过 STALE_LOCK_MS 就当成遗留废锁接管。
 */
const STALE_LOCK_MS = 2000

function lockPath() {
  return factsPath() + '.lock'
}

function acquireLock(deadlineMs = 150) {
  ensureDir(memoryRoot())
  const file = lockPath()
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

function releaseLock() {
  try {
    unlinkSync(lockPath())
  } catch {
    /* 已经没了就算了 */
  }
}

/**
 * facts.jsonl 的唯一写入入口：拿锁 → 读 → 改 → 写 → 放锁，全在一段同步代码里。
 *
 * 为什么需要这一层：
 *   1. 注入时记热度（touchFacts）和自动采集写候选，都是「读整份 → 改 → 整份写回」。
 *      谁最后写，谁的内容就赢；先写的那次改动会被静默覆盖（热度回滚、候选丢失）。
 *   2. mutate() 里绝不能出现 await —— 整段同步执行，本进程内别的写入插不进来。
 *   3. 跨进程（比如又开了一个窗口）靠锁文件互斥；拿不到锁就重试，几次都拿不到就放弃并返回 error，
 *      绝不写半份。热度那种软数据下回合再来就行，候选这种别当成功。
 */
export function mutateFacts(mutate, attempts = 5, deadlineMs = 150) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) pause(1)
    if (!acquireLock(deadlineMs)) continue
    try {
      const facts = readFacts()
      const outcome = mutate(facts) ?? { changed: false }
      if (outcome.changed === true) writeFacts(facts)
      return outcome
    } finally {
      releaseLock()
    }
  }
  return { changed: false, error: 'facts 一直被别的进程占着，这次没有写入' }
}

/** 写一条候选事实。没有可核对的出处就不许进库。 */
export function stageFact(input = {}) {
  const text = String(input.text ?? '').trim()
  if (text === '') return { ok: false, error: 'text 不能为空' }
  if (text.length > 240) return { ok: false, error: '一条事实最多 240 字，拆成两条' }
  const check = checkCitation(input.citation)
  if (!check.ok) return { ok: false, error: check.error }

  const fact = {
    id: 'f' + Math.random().toString(36).slice(2, 10),
    text,
    kind: String(input.kind ?? 'fact').trim() || 'fact',
    // channel 决定注入到哪一段：rel=关于这个人，env=本机环境。默认 rel，老数据没有这个字段也按 rel 算。
    channel: input.channel === 'env' ? 'env' : 'rel',
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 6) : [],
    citation: {
      sessionId: check.session.id,
      index: Number(input.citation.index),
      date: check.date,
    },
    status: 'candidate',
    created: new Date().toISOString().slice(0, 10),
  }
  // 必须走事务：appendFileSync 绕开锁，而并发的「读整份 → rename 整份写」会拿没有这条的快照覆盖回去，
  // 刚提交的候选就静默消失了。判重也放进锁里 —— 锁外那次只是省事，拦不住并发。
  const outcome = mutateFacts((facts) => {
    if (facts.some((item) => String(item.text ?? '').trim() === text)) return { changed: false }
    facts.push(fact)
    return { changed: true }
  })
  if (outcome?.changed !== true) {
    return { ok: false, error: outcome?.error ?? '这条已经记过了' }
  }
  return { ok: true, fact }
}

/**
 * 改一条事实的正文。状态不动、id 不动、出处照旧 —— 改的是措辞，不是换了一条结论。
 * 和改状态一样走事务：并发写整份文件时不能拿旧快照覆盖回去。
 */
export function setFactText(id, text, meta = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return { ok: false, error: '内容不能为空' }
  if (clean.length > 240) return { ok: false, error: '一条事实最多 240 字，拆成两条' }
  let before = ''
  let updated = null
  const outcome = mutateFacts((facts) => {
    const fact = facts.find((item) => item.id === id)
    if (fact === undefined) return { changed: false, error: '没有这条记忆（可能刚被改过），刷新一下' }
    if (String(fact.text ?? '') === clean) return { changed: false, unchanged: true }
    before = String(fact.text ?? '')
    const at = new Date().toISOString()
    fact.text = clean
    fact.updated = at.slice(0, 10)
    // 和状态变更同一条留痕规则：谁、什么时候、从哪、改了什么
    fact.history = [...(fact.history ?? []), { at, from: 'text', to: 'text', via: meta.via ?? 'unknown', before }]
    updated = fact
    return { changed: true }
  })
  if (outcome?.error) return { ok: false, error: outcome.error }
  return { ok: true, fact: updated, unchanged: outcome?.unchanged === true }
}

/** 候选 → 采纳 / 丢弃；已采纳的还能退役。退役保留条目，只是不再注入和检索。 */
export function setFactStatus(id, status, meta = {}) {
  const wanted = String(status ?? '')
  if (!['approved', 'retired', 'candidate'].includes(wanted)) {
    return { ok: false, error: `status 只能是 approved / retired / candidate` }
  }
  let updated = null
  const outcome = mutateFacts((facts) => {
    const fact = facts.find((item) => item.id === id)
    if (fact === undefined) return { changed: false }
    const at = new Date().toISOString()
    fact.status = wanted
    fact.updated = at.slice(0, 10)
    fact.reviewedAt = at
    if (wanted === 'retired') {
      fact.retiredAt = fact.updated
    } else {
      // 从 retired 改回 approved / candidate 时，退役日期必须清掉。
      // 否则会留下「status=approved 却带 retiredAt」的自相矛盾记录，
      // 而且这个残留在后续任何一次改状态时都不会被清，属于永久脏数据。
      delete fact.retiredAt
    }
    // 审核要留痕：谁在什么时候、从哪、把状态从什么改成了什么
    fact.history = [...(fact.history ?? []), { at, from: meta.from ?? null, to: wanted, via: meta.via ?? 'unknown' }]
    updated = fact
    return { changed: true }
  })
  if (outcome?.error) return { ok: false, error: outcome.error }
  if (updated === null) return { ok: false, error: `找不到事实 ${id}` }
  return { ok: true, fact: updated }
}


/* ------------------------------ 热度（P0：遗忘曲线） ------------------------------ */

export const DEFAULT_HALF_LIFE_DAYS = 30

const TOUCH_INTERVAL_MS = 60 * 60 * 1000

/**
 * 一条事实现在还有多"热"：用得越多越高，越久没用越低。
 * 只影响激活优先级，不改可信度 —— 冷下去的记忆照样在库里，随时能被检索捞回来。
 */
export function factHeat(fact, now = Date.now(), halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  const hits = Number(fact.hitCount ?? 0) || 0
  const importance = clampInt(fact.importance, 1, 0, 3)
  const stamp = fact.lastHit ?? fact.updated ?? fact.created ?? ''
  const parsed = Date.parse(stamp)
  const base = Number.isNaN(parsed) ? now : parsed
  const ageDays = Math.max(0, (now - base) / 86400000)
  const decay = Math.pow(0.5, ageDays / Math.max(1, halfLifeDays))
  const usage = 1 + Math.log1p(hits)
  return Math.round(usage * (1 + importance * 0.5) * decay * 100) / 100
}

/**
 * 记录"这条事实真的进了注入"。
 * 注意：检索命中不调用它 —— 只被搜到、没进上下文的记忆不该因此保持活跃。
 * 一小时内的重复注入只算一次，避免同一天里每回合都往上涨。
 */
export function touchFacts(ids, now = Date.now()) {
  const wanted = new Set(ids ?? [])
  if (wanted.size === 0) return 0
  // 必须存完整时刻，不能只存日期：下面用 now - Date.parse(lastHit) < 1h 去重，
  // 而 'YYYY-MM-DD' 解析出来是当天 00:00 —— 过了午夜那一小时窗口就永远失效，
  // 每装配一次都会 +1（实测 25 分钟能连涨 3 次，把「进过几次」记成「算过几次」）。
  const stamp = new Date(now).toISOString()
  // 热度是软数据：抢不到锁就这回合先不记（lastHit 没变，下一回合还会再试）。
  // 机会比硬写少（2 次 vs 5 次），但每次等锁的窗口给足：20ms 在 16 并发下几乎必输，
  // test:accept 曾因此偶发「热度没落下：t2（返回 0）」。
  const outcome = mutateFacts((facts) => {
    let changed = 0
    for (const fact of facts) {
      if (!wanted.has(fact.id)) continue
      const last = Date.parse(fact.lastHit ?? '')
      if (!Number.isNaN(last) && now - last < TOUCH_INTERVAL_MS) continue
      fact.hitCount = (Number(fact.hitCount ?? 0) || 0) + 1
      fact.lastHit = stamp
      changed += 1
    }
    return { changed: changed > 0, count: changed }
  }, 2, 150)
  return outcome.count ?? 0
}

/**
 * 记录"这条事实被检索翻到过"。
 *
 * 与 touchFacts 的区别：这是**弱证据** —— 搜到不等于进了上下文，所以不动 hitCount
 * （热度是"占了多少位置"），单独记 seenCount / lastSeen。
 * 用途：归属统计不该把"被搜到过很多次"的记忆说成"从没进过"。
 */
export const SEEN_INTERVAL_MS = 10 * 60 * 1000

export function seenFacts(ids, now = Date.now()) {
  const wanted = new Set(ids ?? [])
  if (wanted.size === 0) return 0
  const stamp = new Date(now).toISOString()
  // 和 touchFacts 一样是软写入：2 次机会、每次等锁 150ms，抢不到就这次先不记。
  const outcome = mutateFacts((facts) => {
    let changed = 0
    for (const fact of facts) {
      if (!wanted.has(fact.id)) continue
      const last = Date.parse(fact.lastSeen ?? '')
      if (!Number.isNaN(last) && now - last < SEEN_INTERVAL_MS) continue
      fact.seenCount = (Number(fact.seenCount ?? 0) || 0) + 1
      fact.lastSeen = stamp
      changed += 1
    }
    return { changed: changed > 0, count: changed }
  }, 2, 150)
  return outcome.count ?? 0
}

/** 按热度排序：热在前；同热度时新的在前。 */
export function rankByHeat(facts, options = {}) {
  const now = Number(options.now ?? Date.now())
  const halfLife = Number(options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS)
  return facts
    .map((fact) => ({ fact, heat: factHeat(fact, now, halfLife) }))
    .sort((a, b) => b.heat - a.heat || String(b.fact.updated ?? '').localeCompare(String(a.fact.updated ?? '')))
}

export function listFacts(status) {
  const facts = readFacts()
  return status === undefined ? facts : facts.filter((fact) => fact.status === status)
}

/* ------------------------------ 习惯 ------------------------------ */

export const habitsPath = () => join(memoryRoot(), 'habits.jsonl')

export function readHabits() {
  const file = habitsPath()
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const habit = JSON.parse(text)
      if (habit !== null && typeof habit === 'object') out.push(habit)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

function writeHabits(habits) {
  ensureDir(memoryRoot())
  writeAtomic(habitsPath(), habits.map((habit) => JSON.stringify(habit)).join('\n') + (habits.length > 0 ? '\n' : ''))
}

export { writeHabits }

/** 升一条习惯（只能由人点，模型没有这个工具）。 */
export function setHabit(text, status, tag) {
  const wanted = String(status ?? '')
  const clean = String(text ?? '').trim()
  if (clean === '') return { ok: false, error: 'text 不能为空' }
  if (clean.length > 80) return { ok: false, error: '一条习惯最多 80 字' }
  if (!['active', 'retired'].includes(wanted)) return { ok: false, error: 'status 只能是 active / retired' }

  const habits = readHabits()
  const existing = habits.find((habit) => habit.text === clean)
  if (existing !== undefined) {
    existing.status = wanted
    if (tag !== undefined) existing.tag = String(tag)
  } else {
    habits.push({ text: clean, tag: String(tag ?? ''), status: wanted, created: new Date().toISOString().slice(0, 10) })
  }
  writeHabits(habits)
  return { ok: true, habits: habits.filter((habit) => habit.status === 'active') }
}

/**
 * 习惯建议：同一个标签在已采纳事实里出现 ≥3 次，就提示可以升成习惯。
 * 不自动升 —— 模型对自己下判断这件事，得人点头。
 */
export function habitSuggestions(threshold = 3) {
  const counts = new Map()
  for (const fact of listFacts('approved')) {
    for (const tag of Array.isArray(fact.tags) ? fact.tags : []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  const active = new Set(
    readHabits()
      .filter((habit) => habit.status === 'active')
      .flatMap((habit) => [String(habit.tag ?? ''), String(habit.text ?? '')]),
  )
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count, active: active.has(tag) }))
}

/** citation 必须能落到真实的一轮上，否则这条事实不许存在。 */
export function checkCitation(citation) {
  if (citation === null || typeof citation !== 'object') return { ok: false, error: '缺少 citation' }
  const sessionId = String(citation.sessionId ?? '')
  const index = Number(citation.index)
  if (sessionId === '') return { ok: false, error: 'citation.sessionId 为空' }
  if (!Number.isInteger(index) || index < 0) return { ok: false, error: 'citation.index 不是有效行号' }
  const session = listSessions().find((item) => item.id === sessionId)
  if (session === undefined) return { ok: false, error: `找不到会话 ${sessionId}` }
  const parsed = readSession(session)
  const record = parsed.records.find((item) => item.index === index)
  if (record === undefined) return { ok: false, error: `会话 ${sessionId} 第 ${index} 条不是可检索的消息` }
  // 日期优先用这条消息自己的时间；没有就退回会话文件时间
  const date = record.time > 0 ? new Date(record.time).toISOString().slice(0, 10) : parsed.date
  return { ok: true, session, record, date }
}

export function searchFacts(query, options = {}) {
  const terms = tokenize(query)
  const facts = readFacts().filter((fact) => fact.status === 'approved')
  const scored = []
  for (const fact of facts) {
    const lower = (String(fact.text ?? '') + ' ' + String(fact.detail ?? '')).toLowerCase()
    let matched = 0
    let score = 0
    for (const term of terms) {
      const count = countOccurrences(lower, term)
      if (count > 0) {
        matched += 1
        score += Math.min(count, 6) * 3
      }
    }
    if (matched > 0) scored.push({ fact, matched, score })
  }
  const strict = scored.filter((item) => item.matched === terms.length)
  const pool = strict.length > 0 ? strict : scored
  pool.sort((a, b) => b.score - a.score)
  return {
    mode: 'facts',
    total: pool.length,
    hits: pool.slice(0, clampInt(options.limit, 5, 1, 20)).map((item) => item.fact),
  }
}

/* ------------------------------ 对外 ------------------------------ */

export function recall(query, options = {}) {
  const mode = String(options.mode ?? 'all')
  const limit = clampInt(options.limit, 5, 1, 20)
  const since = String(options.since ?? '').trim()
  const parts = {}
  if (mode === 'all' || mode === 'facts') parts.facts = searchFacts(query, { limit })
  if (mode === 'all' || mode === 'raw') {
    parts.raw = Array.isArray(options.ids)
      ? searchByIds(options.ids, query, { limit, since })
      : searchRaw(query, { limit, since })
  }
  return { query, mode, since, ...parts }
}

export function memoryStats() {
  const facts = readFacts()
  const cache = existsSync(cacheDir()) ? readdirSync(cacheDir()).filter((n) => n.endsWith('.json')).length : 0
  const sessions = listSessions().length
  const state = readState()
  return {
    facts: facts.length,
    approved: facts.filter((fact) => fact.status === 'approved').length,
    candidates: facts.filter((fact) => fact.status === 'candidate').length,
    retired: facts.filter((fact) => fact.status === 'retired').length,
    habits: readHabits().filter((habit) => habit.status === 'active').length,
    sessions,
    cache,
    lastDigest: state.lastDigest ?? null,
    root: memoryRoot(),
  }
}

function clampInt(value, fallback, lo, hi) {
  const num = Number(value ?? fallback)
  const safe = Number.isFinite(num) ? Math.trunc(num) : fallback
  return Math.max(lo, Math.min(safe, hi))
}
