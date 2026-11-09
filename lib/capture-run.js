/**
 * P1-B：把「发现」接到写入层。
 *
 * 边界（评审定的）：
 *   - compareCandidate() 只做判定，不碰文件；这里才决定写什么
 *   - 冲突 = 两条 candidate + 双向 similarTo；已 approved 的一侧只被指向，不被改写
 *   - 合并 = 只加证据（occurrences / lastObserved / evidence），不动 status
 *   - 一次事件的所有候选，用一次 writeFacts 原子落盘；写失败就不推游标
 */

import { alreadyCaptured, candidatesOf, commitObservation, compareCandidate, isDelegatedSession, isUserAuthored, triggersOf } from './capture.js'
import { collectCorrections } from './corrections.js'
import { runSerial } from './persona-tx.js'

/** 从一条 UserMessage 的 content 里抽纯文本（content 可能是字符串或块数组）。 */
export function textOfEvent(event) {
  const content = event?.data?.message?.content ?? event?.data?.content ?? event?.data?.text ?? event?.content ?? ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if ((block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function newId(now, index) {
  // 加随机段：不同会话之间没有串行化，同一毫秒里两次提交会撞出同一个 id，
  // 撞了之后 setFactStatus 只改得到先找到的那条，另一条永远采纳不了。
  const salt = Math.random().toString(36).slice(2, 6)
  return `auto-${now.getTime().toString(36)}-${salt}-${index}`
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
      if (best === null || verdict.score > best.verdict.score
        || (verdict.score === best.verdict.score && fact.status === 'candidate' && best.fact.status !== 'candidate')) {
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
  // 委派会话里的一切都不是这个人说的：先按会话粒度挡掉，再谈内容判断
  if (deps?.delegated === true) return { handled: false, reason: 'delegated-session' }
  if (!isUserAuthored(event)) return { handled: false, reason: 'not-user-authored' }

  const sessionId = deps.sessionId ?? event?.sessionId ?? event?.data?.session?.id ?? 'unknown'
  const rawSeq = event?.seq ?? event?.data?.seq
  const seqText = typeof rawSeq === 'number' ? String(rawSeq) : typeof rawSeq === 'string' ? rawSeq.trim() : ''
  const seq = seqText === '' || /^[0-9]+$/.test(seqText) === false ? NaN : Number(seqText)
  if (!Number.isSafeInteger(seq) || seq < 0) return { handled: false, reason: 'no-seq' }

  const raw = textOfEvent(event)
  // 纠偏证据顺手攒一份：它跟候选事实是两条独立的账，采集失败绝不能连累主路径。
  // at 用事件自己的时间（有就取），没有就当现在 —— 水位靠它推进。
  const stamp = String(event?.at ?? event?.data?.at ?? '')
  // 采集要跟「保存人格」排同一条队：那边是「读快照 → 改内存 → 整文件覆盖」，
  // 交错跑会把刚采到的证据静默抹掉。写失败只当没采到，不连累主路径。
  try {
    await runSerial(async () =>
      collectCorrections({ session: sessionId, idx: seq, text: raw, at: stamp, isReply: event?.data?.replyTo !== undefined }),
    )
  } catch {
    // 纠偏是第二条账，坏了也不能挡住事实采集
  }

  const texts = candidatesOf(raw)
  if (texts.length === 0) {
    // 没有候选也要推进游标，否则同一条消息下次还会被重新判断
    await commitObservation({ sessionId, seq }, () => null, {})
    return { handled: false, reason: 'no-candidate' }
  }

  // 读 → 改 → 写 必须在同一段同步代码里：中间不留 await，注入时记热度那条路径就插不进来。
  // 宿主给了 mutateFacts 就用它的跨进程 CAS；老调用方只给 read/write 时，用同样的形状兜一个。
  const transact =
    typeof deps.mutateFacts === 'function'
      ? deps.mutateFacts
      : (mutate) => {
          const facts = deps.readFacts()
          const outcome = mutate(facts)
          if (outcome?.changed === true) deps.writeFacts(facts)
          return outcome
        }

  const plan = await commitObservation({ sessionId, seq, texts }, (observation) => {
    let written = null
    let repeated = false
    const source = `${sessionId}#${seq}`
    const outcome = transact((facts) => {
      // 锁外那次判重只是省事：两个进程可能同时通过，进了事务再按最新快照看一遍
      if (alreadyCaptured(facts, source)) {
        repeated = true
        return { changed: false }
      }
      const result = planWrites(observation.texts, {
        facts,
        sessionId,
        seq,
        now: deps.now,
      })
      written = result
      // 一次写入：三份文件里只有 facts 会变，写成功才算提交成功
      facts.length = 0
      facts.push(...result.nextFacts)
      return { changed: true, plan: result }
    })
    if (outcome?.error) throw new Error(outcome.error)
    if (repeated) return { created: [], merged: [], conflicts: [], source, repeated: true }
    if (written === null) throw new Error('facts 事务没有产出结果')
    return written
  }, { facts: deps.readFacts })

  if (plan.ok !== true) return { handled: false, reason: 'commit-failed', error: plan.error }
  if (plan.skipped !== null) return { handled: false, reason: plan.skipped }

  return { handled: true, plan: plan.written }
}

export { alreadyCaptured }
