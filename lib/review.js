/**
 * 复盘第一版：证据包 → 待批候选 → 审批入口。
 *
 * 这里只做确定性的读证据、核出处、去重、风控、写待批文件。
 * 自动到此为止：不写自述、不写 AGENTS.md、不写正式 skill、不把 facts 改成 approved。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic, writeJsonAtomic } from './atomic.js'
import { readEvents } from './corrections.js'
import { checkCitation, readSession, stageFact, withSessionSnapshot } from './memory.js'
import { countChars, selfnoteRoot, truncateChars } from './store.js'

const VALID_RISKS = new Set(['procedure', 'behavior', 'permission'])
const VALID_TARGETS = new Set(['skill-draft', 'candidate-fact', 'review-only'])

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function asDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (value === undefined || value === null || value === '') return new Date()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function stampOf(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function hashOf(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 8)
}

export function reviewRoot() {
  return join(selfnoteRoot(), 'review')
}
export function candidatesDir() {
  return join(reviewRoot(), 'candidates')
}
export function evidenceDir() {
  return join(reviewRoot(), 'evidence')
}
export function reportsDir() {
  return join(reviewRoot(), 'reports')
}
export function skillDraftDir() {
  return join(reviewRoot(), 'skill-drafts')
}
export function candidatesPath() {
  return join(candidatesDir(), 'candidates.jsonl')
}

function writeCandidates(list) {
  ensureDir(candidatesDir())
  const rows = list.map((item) => JSON.stringify(item))
  writeAtomic(candidatesPath(), rows.length === 0 ? '' : rows.join('\n') + '\n')
}

/** 坏行只隔离，不把整个候选区读挂，也不悄悄把坏行抹掉。 */
export function listCandidates() {
  const file = candidatesPath()
  if (!existsSync(file)) return []
  const kept = []
  const bad = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const item = JSON.parse(text)
      if (item === null || typeof item !== 'object' || typeof item.id !== 'string') throw new Error('bad candidate')
      kept.push(item)
    } catch {
      bad.push(text)
    }
  }
  if (bad.length > 0) {
    ensureDir(candidatesDir())
    const badPath = join(candidatesDir(), `candidates.bad-${Date.now().toString(36)}-${process.pid}.jsonl`)
    writeAtomic(badPath, bad.join('\n') + '\n')
    writeAtomic(file, kept.length === 0 ? '' : kept.map((item) => JSON.stringify(item)).join('\n') + '\n')
  }
  return kept
}

function uniqueEvidence(items) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(items) ? items : []) {
    if (raw === null || typeof raw !== 'object') continue
    const sessionId = String(raw.sessionId ?? raw.session ?? '').trim()
    const index = Number(raw.index ?? raw.idx ?? NaN)
    const quote = String(raw.quote ?? raw.originalText ?? raw.text ?? '').trim()
    if (sessionId === '' || !Number.isInteger(index) || index < 0 || quote === '') continue
    const key = `${sessionId}:${index}:${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      ...raw,
      sessionId,
      index,
      quote,
      source: typeof raw.source === 'string' && raw.source !== '' ? raw.source : `${sessionId}#${index}`,
    })
  }
  return out
}

/**
 * 只读纠偏事件，逐条核回 DSH 会话原文。
 * 证据包里只放原话、出处、日期和一丁点上下文计数，不复制整份会话正文。
 */
export function collectEvidence(options = {}) {
  const now = asDate(options.now)
  const events = readEvents()
  const evidence = []
  const rejected = []
  const seen = new Set()
  let duplicate = 0
  let usedSkipped = 0

  withSessionSnapshot(() => {
    for (const event of events) {
      if (event.used === true) {
        usedSkipped += 1
        continue
      }
      const sessionId = String(event.session ?? '').trim()
      const index = Number(event.idx)
      const quote = String(event.quote ?? '').trim()
      const key = `${sessionId}:${index}:${quote}`
      if (seen.has(key)) {
        duplicate += 1
        continue
      }
      if (sessionId === '' || !Number.isInteger(index) || index < 0 || quote === '') {
        rejected.push({ id: event.id, reason: '出处不完整：需要 session + idx + quote' })
        continue
      }
      const check = checkCitation({ sessionId, index })
      if (!check.ok) {
        rejected.push({ id: event.id, reason: check.error })
        continue
      }
      seen.add(key)
      const parsed = readSession(check.session)
      const records = Array.isArray(parsed.records) ? parsed.records : []
      const context = {
        before: Math.min(1, records.filter((record) => record.index < index).length),
        after: Math.min(1, records.filter((record) => record.index > index).length),
      }
      evidence.push({
        id: String(event.id ?? ''),
        at: String(event.at ?? ''),
        sessionId,
        index,
        quote,
        originalText: truncateChars(String(check.record?.text ?? quote), 120),
        date: check.date,
        strength: event.strength === 'strong' || event.strength === 'weak' ? event.strength : null,
        context,
        source: `${sessionId}#${index}`,
      })
    }
  })

  ensureDir(evidenceDir())
  const path = join(evidenceDir(), `evidence-${stampOf(now)}.json`)
  writeJsonAtomic(path, {
    createdAt: now.toISOString(),
    scanned: events.length,
    duplicate,
    usedSkipped,
    rejected,
    evidence,
  })
  return {
    ok: true,
    path,
    scanned: events.length,
    evidence,
    duplicate,
    usedSkipped,
    rejected,
  }
}

/** 风险分级只是给候选贴标签；真正的语义归纳交给 agent，最终决定归人。 */
export function classifyRisk(evidence = []) {
  const text = (Array.isArray(evidence) ? evidence : [])
    .map((item) => String(item?.quote ?? item?.text ?? ''))
    .join(' ')
    .toLowerCase()
  if (/配置|权限|自动改|对外|发布|推送|删除|不可逆|tag|release|npm/.test(text)) return 'permission'
  if (/dry-run|命中数|重命名|脚本|步骤|流程|先跑测试|落盘|批量|命令/.test(text)) return 'procedure'
  if (/回答|中文|结论|措辞|偏好|沟通|先给/.test(text)) return 'behavior'
  return 'behavior'
}

function rejectReasonFor(item, unique, sessions, boundary) {
  const risk = VALID_RISKS.has(item.risk) ? item.risk : classifyRisk(unique)
  if (risk === 'behavior' || risk === 'permission') {
    if (unique.length < 3 || sessions < 2 || boundary !== true) {
      return `行为/权限边界样本量 ${unique.length}：需 ≥3 条同类样本、来自 ≥2 个会话，且带边界或反例样本`
    }
  }
  if (risk === 'procedure' && unique.length < 3 && item.verified !== true) {
    return 'procedure 样本量 1 只能生成草案；必须 verified=true 才能保存'
  }
  return ''
}

/**
 * 接收 agent 写好的候选建议，但只信可核对的 evidence，不信外层虚报的 sampleCount。
 * 合格候选写 candidates.jsonl，同时写一份运行报告。
 */
export function proposeCandidates(options = {}) {
  const now = asDate(options.now)
  const items = Array.isArray(options.items) ? options.items : []
  const existing = listCandidates()
  const saved = []
  const rejected = []

  withSessionSnapshot(() => {
    items.forEach((raw, position) => {
      const item = raw !== null && typeof raw === 'object' ? raw : {}
      const text = String(item.text ?? '').trim()
      const risk = VALID_RISKS.has(item.risk) ? item.risk : classifyRisk(item.evidence ?? [])
      const unique = uniqueEvidence(item.evidence)
      if (text === '') {
        rejected.push({ id: String(item.id ?? position), reason: '正文为空' })
        return
      }
      if (countChars(text) > 240) {
        rejected.push({ id: String(item.id ?? position), reason: '一条候选最多 240 字' })
        return
      }
      if (unique.length === 0) {
        rejected.push({ id: String(item.id ?? position), reason: '缺少 evidence：候选必须有可核对的出处' })
        return
      }
      let citationError = ''
      for (const row of unique) {
        const check = checkCitation({ sessionId: row.sessionId, index: row.index })
        if (!check.ok) {
          citationError = check.error
          break
        }
      }
      if (citationError !== '') {
        rejected.push({ id: String(item.id ?? position), reason: `evidence 出处核不回原文：${citationError}` })
        return
      }
      const sessions = new Set(unique.map((row) => row.sessionId)).size
      const boundary = item.boundary === true || item.counterexample === true || item.hasBoundary === true
      const reason = rejectReasonFor({ ...item, risk }, unique, sessions, boundary)
      if (reason !== '') {
        rejected.push({ id: String(item.id ?? position), reason })
        return
      }
      const target = VALID_TARGETS.has(item.target) ? item.target : risk === 'procedure' ? 'skill-draft' : 'candidate-fact'
      const id = `rv-${stampOf(now)}-${position}-${hashOf(text + risk)}`
      saved.push({
        id,
        text,
        risk,
        target,
        verified: item.verified === true,
        boundary,
        sampleCount: unique.length,
        evidence: unique,
        createdAt: now.toISOString(),
        status: 'pending',
        reviewVersion: 1,
      })
    })
  })

  writeCandidates(existing.concat(saved))
  ensureDir(reportsDir())
  const reportPath = join(reportsDir(), `report-${stampOf(now)}.json`)
  writeJsonAtomic(reportPath, {
    createdAt: now.toISOString(),
    scanned: items.length,
    saved,
    rejected,
  })
  return { ok: true, saved, rejected, reportPath }
}

function updateCandidate(id, patch, options = {}) {
  const key = String(id ?? '')
  const rows = listCandidates()
  const index = rows.findIndex((row) => row.id === key)
  if (index < 0) return { ok: false, error: '找不到这条复盘候选' }
  const current = rows[index]
  if (current.status !== 'pending') return { ok: false, error: '这条候选已经处理过' }
  const next = { ...current, ...patch, updatedAt: asDate(options.now).toISOString() }
  rows[index] = next
  writeCandidates(rows)
  return { ok: true, candidate: next }
}

/** 送入现有候选区：只写 status=candidate，真正生效还要人去记忆页点采纳。 */
export function stageCandidate(id, options = {}) {
  const rows = listCandidates()
  const candidate = rows.find((row) => row.id === String(id ?? ''))
  if (candidate === undefined) return { ok: false, error: '找不到这条复盘候选' }
  if (candidate.status !== 'pending') return { ok: false, error: '这条候选已经处理过' }
  const first = Array.isArray(candidate.evidence) ? candidate.evidence[0] : null
  if (first === null || typeof first !== 'object') return { ok: false, error: '候选没有可核对的出处' }
  const staged = stageFact({
    text: candidate.text,
    kind: 'review',
    channel: 'rel',
    citation: { sessionId: first.sessionId, index: first.index },
  })
  if (!staged?.ok) return { ok: false, error: staged?.error ?? '送入候选区失败' }
  const updated = updateCandidate(id, { status: 'staged', factId: staged.fact.id }, options)
  if (!updated.ok) return updated
  return { ok: true, fact: staged.fact, candidate: updated.candidate }
}

/** 丢弃候选：只改 review 状态，原始纠偏记录与原会话一字不动。 */
export function discardCandidate(id, options = {}) {
  const updated = updateCandidate(id, { status: 'discarded' }, options)
  if (!updated.ok) return updated
  return { ok: true, candidate: updated.candidate }
}

/** 低风险操作路径的草案：只落 review/skill-drafts，不建第二个 md 规矩库。 */
export function createSkillDraft(id, options = {}) {
  const now = asDate(options.now)
  const rows = listCandidates()
  const candidate = rows.find((row) => row.id === String(id ?? ''))
  if (candidate === undefined) return { ok: false, error: '找不到这条复盘候选' }
  if (candidate.status === 'discarded') return { ok: false, error: '已丢弃的候选不生成草案' }
  const first = Array.isArray(candidate.evidence) && candidate.evidence[0] ? candidate.evidence[0] : null
  const source = first === null ? '无出处' : `${String(first.sessionId ?? '')}#${String(first.index ?? '')}`
  const lines = [
    `# 复盘草案：${candidate.text}`,
    '',
    '这不是 skill，只是一份待人工确认的复盘草案；没有写进正式 skill 目录，也没有改 AGENTS.md。',
    '',
    `- 风险：${String(candidate.risk ?? '')}`,
    `- 样本数：${Number(candidate.sampleCount) || 0}`,
    `- 首个出处：${source}`,
    `- 状态：${String(candidate.status ?? '')}`,
    '',
    '要变成正式 skill，先由人核对证据、补齐边界条件，再另行创建。',
  ]
  ensureDir(skillDraftDir())
  const path = join(skillDraftDir(), `draft-${hashOf(candidate.id)}-${stampOf(now)}.md`)
  writeAtomic(path, lines.join('\n') + '\n')
  return { ok: true, path, candidateId: candidate.id }
}

/** 设置页摘要：已处理候选不再当待批。 */
export function reviewSummary() {
  const rows = listCandidates()
  const pending = rows.filter((row) => row.status === 'pending' || row.status === undefined)
  const staged = rows.filter((row) => row.status === 'staged')
  const discarded = rows.filter((row) => row.status === 'discarded')
  return {
    total: rows.length,
    pending: pending.length,
    staged: staged.length,
    discarded: discarded.length,
    candidates: pending.slice(0, 20),
    path: candidatesPath(),
  }
}

/** 工具与 /review API 共用的动作分派；故意不提供任何自动批准动作。 */
export function reviewAction(args = {}) {
  const input = args !== null && typeof args === 'object' ? args : {}
  const action = String(input.action ?? 'list').trim()
  const now = asDate(input.now)
  if (action === 'list') return { ok: true, ...reviewSummary() }
  if (action === 'collect') return collectEvidence({ ...input, now })
  if (action === 'propose') return proposeCandidates({ ...input, now, items: Array.isArray(input.items) ? input.items : [] })
  if (action === 'stage') return stageCandidate(input.id, { now })
  if (action === 'discard') return discardCandidate(input.id, { now })
  if (action === 'draft') return createSkillDraft(input.id, { now })
  return {
    ok: false,
    error: `action 不支持：${action}；只能是 collect / propose / list / stage / discard / draft，不能自动批准`,
  }
}
