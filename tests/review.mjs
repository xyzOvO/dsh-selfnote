/**
 * 复盘第一版：证据包 → 待批候选 → 审批入口。
 * 跑法：node tests/review.mjs
 *
 * 这里不测「自动生效」：候选文件、facts 候选区、自述、skill 目录是四件事。
 * 自动只到「提议 / 草案 / 报告」，真正落盘永远要人点。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-review-'))
const sessionsDir = join(dir, 'sessions')
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = sessionsDir
process.env.DSH_SELFNOTE_NO_OPEN = '1'
mkdirSync(process.env.DSH_MEMORY_DIR, { recursive: true })
mkdirSync(sessionsDir, { recursive: true })

const review = await import('../lib/review.js')
const corrections = await import('../lib/corrections.js')
const memory = await import('../lib/memory.js')
const { apply, currentAuthToken } = await import('../lib/index.js')

const HOST = '127.0.0.1:56645'
const AT = '2026-11-14T08:00:00.000Z'
const MARKER = '整份会话里不该被复制的无关记录'

function userMessage(seq, time, text) {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      content: [{ type: 'text', text }],
      role: 'user',
      source: { kind: 'user' },
    },
  }
}

function writeSession(id, records) {
  const folder = join(sessionsDir, 'demo', id)
  mkdirSync(folder, { recursive: true })
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  writeFileSync(join(folder, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
}

function evidenceEvent(id, session, idx, quote, extra = {}) {
  return {
    id,
    at: AT,
    session,
    idx,
    quote,
    used: false,
    usedAt: null,
    consumedBy: null,
    strength: 'strong',
    ...extra,
  }
}

writeSession('s1', [
  userMessage(0, Date.parse(AT), '批量改文件名前先 dry-run 把命中数打出来，别直接 rename'),
  userMessage(1, Date.parse(AT) + 1000, MARKER),
])
writeSession('s2', [userMessage(0, Date.parse(AT) + 2000, '先 dry-run，命中数不对就停')])
writeSession('s3', [userMessage(0, Date.parse(AT) + 3000, '这套先 dry-run 再落盘的步骤记一下')])
writeSession('s4', [userMessage(0, Date.parse(AT) + 4000, '以后别自动改配置文件')])

const events = [
  evidenceEvent('e1', 's1', 0, '批量改文件名前先 dry-run 把命中数打出来，别直接 rename'),
  evidenceEvent('e2', 's2', 0, '先 dry-run，命中数不对就停'),
  evidenceEvent('e3', 's3', 0, '这套先 dry-run 再落盘的步骤记一下'),
  evidenceEvent('e4', 's1', 0, '批量改文件名前先 dry-run 把命中数打出来，别直接 rename'),
  evidenceEvent('e5', 's2', 0, '这条已经处理过，不该再进证据包', { used: true }),
  evidenceEvent('e6', 'missing', 0, '找不到会话的孤证'),
  evidenceEvent('e7', 's4', 0, '以后别自动改配置文件'),
]
corrections.writeEvents(events)

/* 1. 路径分家：候选、证据包、报告、草案都在独立 review 目录下 */
assert.equal(review.candidatesPath(), join(dir, 'review', 'candidates', 'candidates.jsonl'))
assert.equal(review.evidenceDir(), join(dir, 'review', 'evidence'))
assert.equal(review.reportsDir(), join(dir, 'review', 'reports'))
assert.equal(review.skillDraftDir(), join(dir, 'review', 'skill-drafts'))
assert.equal(existsSync(join(dir, 'notes.md')), false, '复盘模块不许碰自述文件')
console.log('1. review 四类产物分目录，且没有碰自述')

/* 2. 证据包：核回原文、跳过孤证与已处理证据、去重，不复制整份会话 */
const collected = review.collectEvidence({ now: new Date(AT) })
assert.equal(collected.ok, true)
assert.equal(collected.scanned, 7)
assert.equal(collected.evidence.length, 4, 'e1/e2/e3/e7 有效，e4 重复、e5 已用、e6 找不到会话')
assert.equal(collected.duplicate, 1)
assert.equal(collected.rejected.length, 1)
assert.equal(collected.rejected[0].id, 'e6')
assert.equal(collected.evidence[0].sessionId, 's1')
assert.equal(collected.evidence[0].index, 0)
assert.match(collected.evidence[0].quote, /dry-run/)
assert.equal(collected.evidence[0].date, '2026-11-14')
assert.ok(existsSync(collected.path), 'collectEvidence 要真的落一份证据包')
const evidenceText = readFileSync(collected.path, 'utf8')
assert.equal(evidenceText.includes(MARKER), false, '证据包不许复制整份会话')
assert.equal(corrections.readEvents().length, 7, '收集证据不该删/改原始纠偏记录')
console.log('2. 证据包核回原文、去重、跳过孤证，不复制整份会话')

/* 3. 风险分级：操作路径 / 行为准则 / 权限边界能分开 */
assert.equal(review.classifyRisk([{ quote: '批量重命名前先 dry-run 打印命中数' }]), 'procedure')
assert.equal(review.classifyRisk([{ quote: '以后回答先给结论，中文正常说' }]), 'behavior')
assert.equal(review.classifyRisk([{ quote: '以后别自动改配置文件' }]), 'permission')
console.log('3. 风险分级能区分操作路径、行为准则、权限边界')

/* 4. 没出处的候选直接拒收 */
const emptyPlan = review.proposeCandidates({ items: [{ text: '没有出处也要记住', risk: 'procedure', evidence: [] }], now: new Date(AT) })
assert.equal(emptyPlan.ok, true)
assert.equal(emptyPlan.saved.length, 0)
assert.match(String(emptyPlan.rejected[0].reason), /出处|evidence/i)
console.log('4. 没出处的候选直接拒收')

/* 5. 行为 / 权限边界样本量 1 一律打回 */
const dryEvidence = collected.evidence.filter((item) => /dry-run/.test(item.quote)).slice(0, 3)
const lone = collected.evidence.filter((item) => /别自动改配置文件/.test(item.quote)).slice(0, 1)
const lonePlan = review.proposeCandidates({
  items: [
    { text: '以后别自动改配置文件', risk: 'behavior', target: 'review-only', evidence: lone, boundary: true },
    { text: '对外发布前必须人工点头', risk: 'permission', target: 'review-only', evidence: lone, boundary: true },
  ],
  now: new Date(AT),
})
assert.equal(lonePlan.saved.length, 0)
assert.equal(lonePlan.rejected.length, 2)
for (const row of lonePlan.rejected) assert.match(String(row.reason), /样本量|≥3|会话|边界/)
console.log('5. 行为与权限边界的孤例一律打回')

/* 6. 操作路径样本量 1 且没 verified 也打回 */
const single = dryEvidence.slice(0, 1)
const singlePlan = review.proposeCandidates({
  items: [{ text: '一次走通就固化成 skill', risk: 'procedure', target: 'skill-draft', evidence: single, verified: false }],
  now: new Date(AT),
})
assert.equal(singlePlan.saved.length, 0)
assert.match(String(singlePlan.rejected[0].reason), /verified|草案|只能/)
console.log('6. 操作路径单次样本缺「已实测验证」也打回')

/* 7. 合格候选：重复证据去重，sampleCount 不虚高，候选落盘 + 报告落盘 */
const procedureItem = {
  text: '批量重命名前先 dry-run 打印命中数；命中数为 0 或超过预期就停手，不执行',
  risk: 'procedure',
  target: 'skill-draft',
  verified: true,
  sampleCount: 99,
  evidence: [...dryEvidence, dryEvidence[0]],
}
const behaviorItem = {
  text: '中文正常说、结论先行，英文术语顺手带一句白话解释',
  risk: 'behavior',
  target: 'candidate-fact',
  verified: false,
  boundary: true,
  sampleCount: 99,
  evidence: dryEvidence,
}
const plan = review.proposeCandidates({ items: [procedureItem, behaviorItem], now: new Date(AT) })
assert.equal(plan.ok, true)
assert.equal(plan.saved.length, 2)
assert.equal(plan.rejected.length, 0)
const procedure = plan.saved.find((item) => item.risk === 'procedure')
const behavior = plan.saved.find((item) => item.risk === 'behavior')
assert.ok(procedure && behavior)
assert.equal(procedure.sampleCount, 3, '重复 evidence 去重，不能信外层虚报的 99')
assert.equal(procedure.evidence.length, 3)
assert.equal(procedure.status, 'pending')
assert.equal(procedure.target, 'skill-draft')
assert.ok(existsSync(review.candidatesPath()))
assert.ok(existsSync(plan.reportPath), '每次提议要有一份可读报告')
const report = JSON.parse(readFileSync(plan.reportPath, 'utf8'))
assert.equal(report.saved.length, 2)
assert.equal(report.rejected.length, 0)
console.log('7. 合格候选去重计数、只写待批文件与报告')

/* 8. 候选文件坏行隔离，不悄悄抹掉也不污染有效行 */
writeFileSync(review.candidatesPath(), readFileSync(review.candidatesPath(), 'utf8') + '{坏行不是 JSON}\n')
const afterBad = review.listCandidates()
assert.equal(afterBad.length, 2, '坏行不能把整个候选区读挂')
const badFiles = readdirSync(review.candidatesDir()).filter((name) => name.startsWith('candidates.bad-'))
assert.ok(badFiles.length >= 1, '坏行要进隔离文件')
assert.match(readFileSync(join(review.candidatesDir(), badFiles[0]), 'utf8'), /坏行不是 JSON/)
console.log('8. 坏候选行进隔离区，不改有效候选')

/* 9. 送入候选区：只写 status=candidate 的 fact，绝不 approved、绝不写自述 */
const staged = review.stageCandidate(procedure.id, { now: new Date(AT) })
assert.equal(staged.ok, true)
assert.equal(staged.fact.status, 'candidate')
assert.equal(staged.fact.citation.sessionId, 's1')
assert.equal(staged.fact.citation.index, 0)
assert.equal(memory.readFacts().filter((fact) => fact.status === 'candidate').length, 1)
assert.equal(memory.listFacts('approved').length, 0, '复盘不许自动采纳')
assert.equal(existsSync(join(dir, 'notes.md')), false, '复盘不许自动写自述')
assert.equal(review.listCandidates().find((item) => item.id === procedure.id).status, 'staged')
assert.equal(review.stageCandidate(procedure.id).ok, false, '同一条候选不许重复送入')
console.log('9. 送入候选区只产 candidate，不 approved、不写自述')

/* 10. 丢弃候选：只改 review 状态，原始纠偏记录一字不动 */
const beforeDiscard = corrections.readEvents().map((item) => JSON.stringify(item)).join('\n')
const discarded = review.discardCandidate(behavior.id, { now: new Date(AT) })
assert.equal(discarded.ok, true)
assert.equal(discarded.candidate.status, 'discarded')
const afterDiscard = corrections.readEvents().map((item) => JSON.stringify(item)).join('\n')
assert.equal(afterDiscard, beforeDiscard, '丢弃候选不许改 corrections.jsonl')
assert.equal(review.discardCandidate(behavior.id).ok, false)
console.log('10. 丢弃候选只改 review 状态，不动原始证据')

/* 11. skill 草案只落 review/skill-drafts，不进正式 skill 目录，也不写 frontmatter */
const draft = review.createSkillDraft(procedure.id, { now: new Date(AT) })
assert.equal(draft.ok, true)
assert.ok(draft.path.startsWith(review.skillDraftDir()))
assert.equal(draft.path.includes(join(dir, 'skills')), false)
const draftText = readFileSync(draft.path, 'utf8')
assert.match(draftText, /复盘草案/)
assert.match(draftText, /批量重命名前先 dry-run/)
assert.match(draftText, /不是 skill/)
assert.equal(draftText.startsWith('---'), false, '不手写 frontmatter，不建第二个 md 规矩库')
console.log('11. skill 草案只落复盘草稿区，不进正式 skill 库')

/* 12. 摘要只算状态，不把已处理候选继续当待批 */
const summary = review.reviewSummary()
assert.equal(summary.total, 2)
assert.equal(summary.pending, 0)
assert.equal(summary.staged, 1)
assert.equal(summary.discarded, 1)
assert.equal(summary.candidates.length, 0)
console.log('12. 设置页摘要如实区分待批 / 已送入 / 已丢弃')

/* 13. agent 工具接入：selfnote_review 能 list/collect/propose，且只返回待批与报告 */
let handler = null
const toolHold = []
const ctx = {
  logger: { info() {} },
  on() {},
  agents: { currentInitiator: () => null },
  systemPrompt: { context() { return () => {} } },
  tools: { register(def) { toolHold.push(def); return () => {} } },
  webServer: {
    register(route) {
      assert.equal(route.kind, 'prefix')
      assert.equal(route.path, '/api/selfnote')
      handler = route.handler
      return () => {}
    },
  },
}
apply(ctx, {})
assert.ok(handler, '没有注册 /api/selfnote 路由')
assert.ok(toolHold.map((tool) => tool.name).includes('selfnote_review'))
const reviewTool = toolHold.find((tool) => tool.name === 'selfnote_review')
const toolList = await reviewTool.execute({ action: 'list' })
assert.equal(toolList.ok, true)
assert.equal(toolList.total, 2)
assert.equal(reviewTool.output.render({}, toolList)[0].type, 'text')
console.log('13. selfnote_review 工具已注册，能返回复盘摘要')

/* 14. 设置页 API：GET /review 读摘要，POST /review draft/stage/discard 走同一套审批 */
function authHeaders(extra) {
  return { 'x-selfnote': currentAuthToken(), host: HOST, ...extra }
}
function call(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = headers ?? authHeaders()
    const res = {
      status: 0,
      headers: null,
      payload: null,
      writeHead(status, heads) { this.status = status; this.headers = heads },
      end(text) { this.payload = JSON.parse(text); resolve(this) },
    }
    handler(req, res).catch(reject)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
}
const got = await call('GET', '/api/selfnote/review')
assert.equal(got.status, 200)
assert.equal(got.payload.review.total, 2)
const drafted = await call('POST', '/api/selfnote/review', { action: 'draft', id: procedure.id })
assert.equal(drafted.status, 200)
assert.equal(drafted.payload.reviewAction.ok, true)
const badAction = await call('POST', '/api/selfnote/review', { action: 'auto-approve' })
assert.equal(badAction.status, 400)
assert.match(badAction.payload.error, /action|不支持|只能/)
console.log('14. /review API 接入审批入口，不提供自动批准动作')

console.log('14 项全部通过')
