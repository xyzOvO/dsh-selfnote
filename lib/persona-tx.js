/**
 * 保存人格的那一次跨文件写入（persona.md + corrections.jsonl + persona.evidence.json）。
 *
 * 为什么不能各写各的：persona 写成功、进程被杀、证据还没标 used ——
 * 下次启动规则已经生效，证据却还挂在「未处理」里，人会以为自己没采纳过。
 * 所以先落一份日志，日志里写的是**目标状态**（新 persona 的摘要 + 证据文件写完之后应该长什么样），
 * 恢复时只是「把文件写成目标状态」，重放多少次结果都一样。
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { selfnoteRoot } from './store.js'
import { writeAtomic, writeJsonAtomic } from './atomic.js'
import { validatePersona, renderPersona, personaPath } from './persona.js'
import { findById, markUsed } from './corrections.js'

/** 指纹算法的版本名：换算法就让旧记录失效，而不是悄悄算出另一批指纹。 */
export const RULE_ALGO = 'nfkc-wp1'

const TX_PATH = join(selfnoteRoot(), 'persona.pending.json')
const EVIDENCE_PATH = join(selfnoteRoot(), 'persona.evidence.json')
const LOCK_PATH = join(selfnoteRoot(), 'persona.lock')

export class LockedError extends Error {
  constructor(message = '另一次人格保存正在进行，稍后再试') {
    super(message)
    this.code = 'locked'
  }
}

/** 规则正文的规范化：全角折半角、去空白、去标点、小写 —— 措辞没变就不该算成两条规则。 */
export function normalizeRule(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\p{P}\p{Z}\s]/gu, '')
    .toLowerCase()
}

export function ruleFingerprint(text) {
  return createHash('sha1').update(`${RULE_ALGO}|${normalizeRule(text)}`, 'utf8').digest('hex').slice(0, 16)
}

export function readEvidence() {
  if (!existsSync(EVIDENCE_PATH)) return { v: 1, algo: RULE_ALGO, rules: {} }
  try {
    const parsed = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'))
    const rules = parsed !== null && typeof parsed.rules === 'object' && parsed.rules !== null ? parsed.rules : {}
    // 换了算法（RULE_ALGO）就等于换了一把尺子：旧指纹对新规则一文不值，宁可当空账重来
    if (String(parsed.algo ?? RULE_ALGO) !== RULE_ALGO) return { v: 1, algo: RULE_ALGO, rules: {} }
    return { v: 1, algo: RULE_ALGO, rules }
  } catch {
    return { v: 1, algo: RULE_ALGO, rules: {} }
  }
}

export function writeEvidenceAfter(evidence) {
  writeJsonAtomic(EVIDENCE_PATH, evidence)
}

/**
 * 由 base 算出「写完之后应该是什么样」。纯函数：同样的 base 算多少次都一样，
 * 恢复时直接拿日志里的快照覆盖，不需要再算一遍（也就不会因为重算而多计一次）。
 */
export function buildEvidenceAfter(base, rules, now) {
  const next = { v: 1, algo: RULE_ALGO, rules: { ...(base?.rules ?? {}) } }
  for (const text of rules) {
    const body = String(text ?? '').trim()
    if (body === '') continue
    const fp = ruleFingerprint(body)
    const old = next.rules[fp]
    next.rules[fp] = old
      ? { count: Number(old.count ?? 0) + 1, firstAt: String(old.firstAt ?? now), lastAt: now }
      : { count: 1, firstAt: now, lastAt: now }
  }
  return next
}

/** 进程内单飞：保存人格、消费证据、恢复，全排一条队 —— 交叉跑必然半新半旧。 */
let chain = Promise.resolve()
export function runSerial(job) {
  const run = chain.then(job, job)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 锁最长活多久：超过这个岁数又探不到活进程，就当是上次被任务管理器杀掉留下的。 */
const STALE_LOCK_MS = 10 * 60 * 1000

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程活着，只是不是我们能管的
    return error?.code === 'EPERM'
  }
}

/** 锁里记的是 pid：进程已经没了（或者锁老得离谱）就清掉，否则用户只能手动删文件。 */
export function lockState(now = Date.now()) {
  if (!existsSync(LOCK_PATH)) return { exists: false, stale: false, pid: 0, ageMs: 0 }
  let pid = 0
  let ageMs = 0
  try {
    pid = Number(readFileSync(LOCK_PATH, 'utf8').trim())
    ageMs = now - statSync(LOCK_PATH).mtimeMs
  } catch {
    return { exists: true, stale: true, pid: 0, ageMs: 0 }
  }
  const stale = !pidAlive(pid) || !Number.isFinite(ageMs) || ageMs > STALE_LOCK_MS
  return { exists: true, stale, pid: Number.isInteger(pid) ? pid : 0, ageMs }
}

function clearStaleLock() {
  const state = lockState()
  if (!state.exists || !state.stale) return false
  try {
    unlinkSync(LOCK_PATH)
    return true
  } catch {
    return false
  }
}

/** 跨进程互斥：O_EXCL 建锁，拿不到就是「有人正在保存」，直接报错而不是排队等死。 */
export async function withPersonaLock(job) {
  let fd
  try {
    fd = openSync(LOCK_PATH, 'wx')
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    // 上次被强杀的残留锁：清掉再试一次，否则「保存人格」会永久 409
    if (!clearStaleLock()) throw new LockedError()
    try {
      fd = openSync(LOCK_PATH, 'wx')
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') throw new LockedError()
      throw retryError
    }
  }
  try {
    try {
      writeSync(fd, String(process.pid))
    } catch {
      // 写不进去不影响互斥本身
    }
  } finally {
    closeSync(fd)
  }
  try {
    return await job()
  } finally {
    try {
      unlinkSync(LOCK_PATH)
    } catch {
      // 已经被恢复流程清掉了
    }
  }
}

function readTxRaw() {
  if (!existsSync(TX_PATH)) return { kind: 'missing' }
  try {
    const parsed = JSON.parse(readFileSync(TX_PATH, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.txId !== 'string') return { kind: 'bad' }
    return { kind: 'ok', tx: parsed }
  } catch {
    return { kind: 'bad' }
  }
}

export function readTx() {
  const raw = readTxRaw()
  return raw.kind === 'ok' ? raw.tx : null
}

export function beginTx(tx) {
  // 已有未结日志时绝不覆盖：盖掉就等于把上一次的 evidenceAfter 永久蒸发，
  // 而那条证据的 consumedBy 已经指向旧 txId —— 计数再也补不回来，doctor 也看不到。
  if (existsSync(TX_PATH)) throw new PendingTxError()
  writeJsonAtomic(TX_PATH, tx)
}

export class PendingTxError extends Error {
  constructor(message = '上一次人格保存还没结清（有未完成的事务日志）') {
    super(message)
    this.code = 'pending'
  }
}

export function clearTx() {
  try {
    unlinkSync(TX_PATH)
  } catch {
    // 本来就没有
  }
}

export function sha256OfCurrentPersona() {
  const text = existsSync(personaPath()) ? readFileSync(personaPath(), 'utf8') : ''
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const MAX_UNUSED_DAYS = 90

/**
 * 保存人格：校验 → 写日志 → 写 persona → 消费证据 + 写证据快照 → 删日志。
 * 第 4 步出错时 persona 已经生效了，所以只能报 pending（200），
 * 让恢复流程下次启动把它补完 —— 谎报「保存失败」会让人以为规则没生效。
 */
export async function commitPersona({ l0 = '', l1 = '', l2 = '', consume = [] } = {}) {
  return runSerial(async () => {
    let locked = false
    try {
      return await withPersonaLock(async () => {
        // 上一次崩在半路的事务必须先结清，否则 beginTx 会把它盖掉
        const pending = recover()
        const verdict = validatePersona({ l0, l1, l2 })
        if (!verdict.ok) return { ok: false, code: verdict.code, error: verdict.error }

        const ids = consume.map((id) => String(id))
        const seen = new Set()
        for (const id of ids) {
          if (seen.has(id)) return { ok: false, code: 'validation', error: `证据 ${id} 重复出现在同一次提交里` }
          seen.add(id)
          const entry = findById(id)
          if (entry === undefined) return { ok: false, code: 'validation', error: `证据 ${id} 不存在` }
          if (entry.used) {
            // used 且没有 consumedBy = 用户亲手丢弃的，同样不能再当依据
            const why = entry.consumedBy === null ? '已被丢弃' : '已被另一次保存消费过'
            return { ok: false, code: 'validation', error: `证据 ${id} ${why}` }
          }
          const at = Date.parse(entry.at)
          if (Number.isFinite(at) && Date.now() - at > MAX_UNUSED_DAYS * 86400000) {
            return { ok: false, code: 'validation', error: `证据 ${id} 已超过 ${MAX_UNUSED_DAYS} 天，不再作为依据` }
          }
        }

        const now = new Date().toISOString()
        const txId = `tx-${now.replace(/[-:.TZ]/g, '').slice(0, 15)}-${randomBytes(2).toString('hex')}`
        const text = renderPersona({ l0, l1, l2 })
        const rules = String(l1 ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
        const evidenceAfter = buildEvidenceAfter(readEvidence(), rules, now)
        beginTx({ txId, at: now, personaSha256: createHash('sha256').update(text, 'utf8').digest('hex'), consume: ids, evidenceAfter })

        writeAtomic(personaPath(), text)
        try {
          markUsed(ids, txId)
          writeEvidenceAfter(evidenceAfter)
        } catch (error) {
          return { ok: true, pending: true, error: `persona 已保存，但证据记账没写完：${String(error?.message ?? error)}` }
        }
        clearTx()
        return { ok: true, consumed: ids }
      })
    } catch (error) {
      if (error instanceof LockedError) {
        locked = true
        return { ok: false, code: 'locked', error: error.message }
      }
      if (error instanceof PendingTxError) {
        return { ok: false, code: 'pending', error: error.message }
      }
      throw error
    } finally {
      // locked 分支没有任何副作用，不需要补偿
      void locked
    }
  })
}

/**
 * 启动恢复。四行决策：
 *   没日志        → 什么都不做
 *   摘要对得上    → 重放第 4 步（消费 + 写证据快照），然后删日志
 *   摘要对不上    → persona 没写成这样：不动证据，删日志
 *   日志本身坏了  → 留档改名，不动数据
 */
export function recover() {
  const raw = readTxRaw()
  if (raw.kind === 'missing') return { action: 'none' }
  if (raw.kind === 'bad') {
    try {
      renameSync(TX_PATH, join(selfnoteRoot(), `persona.pending.bad-${Date.now()}.json`))
    } catch {
      // 改名失败也别把启动卡死
    }
    return { action: 'quarantined' }
  }
  const tx = raw.tx
  if (sha256OfCurrentPersona() !== String(tx.personaSha256 ?? '')) {
    clearTx()
    return { action: 'rolled-back', detail: 'persona 与日志里的摘要不一致' }
  }
  const consume = Array.isArray(tx.consume) ? tx.consume.map((id) => String(id)) : []
  markUsed(consume, String(tx.txId))
  const evidence = tx.evidenceAfter
  if (evidence !== null && typeof evidence === 'object') writeEvidenceAfter(evidence)
  clearTx()
  return { action: 'replayed' }
}
