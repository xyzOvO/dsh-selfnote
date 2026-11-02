/**
 * P1-B：把「发现」接到写入层。
 *
 * 边界（评审定的）：
 *   - compareCandidate() 只做判定，不碰文件；这里才决定写什么
 *   - 冲突 = 两条 candidate + 双向 similarTo；已 approved 的一侧只被指向，不被改写
 *   - 合并 = 只加证据（occurrences / lastObserved / evidence），不动 status
 *   - 一次事件的所有候选，用一次 writeFacts 原子落盘；写失败就不推游标
 */

import { alreadyCaptured, candidatesOf, commitObservation, compareCandidate, isUserAuthored, triggersOf } from './capture.js'

/** 从一条 UserMessage 的 content 里抽纯文本（content 可能是字符串或块数组）。 */
export function textOfEvent(event) {
  const content = event?.data?.content ?? event?.data?.text ?? ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function newId(now, index) {
  return `auto-${now.getTime().toString(36)}-${index}`
}

/**
 * 纯规划：给定文本与现有 facts，算出「写完之后 facts 长什么样」。
 * 不读写任何文件，方便测试。
 */
export function planWrites(texts, options = {}) {
  const facts = (options.facts ?? []).map((fact) => ({ ...fact }))
  const sessionId = options.sessionId ?? 'unknown'
  const seq = Number(options.seq ?? 0)
  const now = options.now instanceof Date ? options.now : new Date()
  const iso = now.toISOString()
  const source = `${sessionId}#${seq}`

  const created = []
  const merged = []
  const conflicts = []

  texts.forEach((text, index) => {
    let best = null
    for (const fact of facts) {
      if (typeof fact.text !== 'string') continue
      const verdict = compareCandidate(text, fact.text)
      if (best === null || verdict.score > best.verdict.score) {
        best = { fact, verdict }
      }
    }

    const action = best?.verdict.action ?? 'new'
    const target = best?.fact ?? null

    if (action === 'merge' && target !== null && target.status === 'candidate') {
      target.occurrences = Number(target.occurrences ?? 1) + 1
      target.lastObserved = iso
      target.evidence = [...(target.evidence ?? []), source]
      merged.push(target.id)
      return
    }

    const fact = {
      id: newId(now, index),
      text,
      status: 'candidate',
      tags: [],
      importance: 1,
      hitCount: 0,
      createdAt: iso,
      updated: iso,
      captureSource: 'auto',
      triggers: triggersOf(text),
      source,
      occurrences: 1,
      lastObserved: iso,
      evidence: [source],
    }

    if (action === 'merge' && target !== null) {
      // 命中已采纳的结论：不改它，只让新候选指过去
      fact.similarTo = [target.id]
      fact.mergeSuggestion = target.id
    }

    if (action === 'conflict' && target !== null) {
      fact.similarTo = [target.id]
      fact.conflictWith = target.id
      conflicts.push({ incoming: fact.id, existing: target.id })
      if (target.status === 'candidate') {
        target.similarTo = [...(target.similarTo ?? []), fact.id]
        target.conflictWith = fact.id
      }
    }

    facts.push(fact)
    created.push(fact.id)
  })

  return { nextFacts: facts, created, merged, conflicts, source }
}

/**
 * 处理一条会话事件。
 *
 * deps: { readFacts(), writeFacts(facts), now? }
 * 返回：{ handled: boolean, reason?, plan? }
 */
export async function handleEvent(event, deps) {
  if (!isUserAuthored(event)) return { handled: false, reason: 'not-user-authored' }

  const sessionId = deps.sessionId ?? event?.sessionId ?? event?.data?.session?.id ?? 'unknown'
  const seq = Number(event?.seq ?? event?.data?.seq)
  if (!Number.isSafeInteger(seq) || seq < 0) return { handled: false, reason: 'no-seq' }

  const texts = candidatesOf(textOfEvent(event))
  if (texts.length === 0) {
    // 没有候选也要推进游标，否则同一条消息下次还会被重新判断
    await commitObservation({ sessionId, seq }, () => null, { gapTolerance: 50 })
    return { handled: false, reason: 'no-candidate' }
  }

  const plan = await commitObservation({ sessionId, seq, texts }, (observation) => {
    const current = deps.readFacts()
    const result = planWrites(observation.texts, {
      facts: current,
      sessionId,
      seq,
      now: deps.now,
    })
    // 一次写入：三份文件里只有 facts 会变，写成功才算提交成功
    deps.writeFacts(result.nextFacts)
    return result
  }, { facts: deps.readFacts, gapTolerance: 50 })

  if (plan.ok !== true) return { handled: false, reason: 'commit-failed', error: plan.error }
  if (plan.skipped !== null) return { handled: false, reason: plan.skipped }

  return { handled: true, plan: plan.written }
}

export { alreadyCaptured }
