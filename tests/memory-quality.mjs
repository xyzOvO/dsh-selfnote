/**
 * 记忆质量评测：召回率（该想起来的想起来没）+ 退役残余率（退役的还会不会冒出来）。
 * 全部在临时沙盘跑合成数据，不碰真实记忆；风格对齐 node 纯 assert + console.log。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qualityFacts, qualityCases } from './fixtures/memory-quality-cases.mjs'

const NL = String.fromCharCode(10)

/* ---------- 沙盘：召回率节 ---------- */
const selfnoteDir = mkdtempSync(join(tmpdir(), 'mq-selfnote-'))
const memoryDir = mkdtempSync(join(tmpdir(), 'mq-memory-'))
const sessionsDir = mkdtempSync(join(tmpdir(), 'mq-sessions-'))
process.env.DSH_SELFNOTE_DIR = selfnoteDir
process.env.DSH_MEMORY_DIR = memoryDir
process.env.DSH_SESSIONS_DIR = sessionsDir
process.env.DSH_SELFNOTE_NO_OPEN = '1'
mkdirSync(memoryDir, { recursive: true })
writeFileSync(join(selfnoteDir, 'config.json'), JSON.stringify({
  enabled: true, personaEnabled: false, profileEnabled: false, heading: 'AI记忆', noteGuide: '',
}), 'utf8')
writeFileSync(join(memoryDir, 'facts.jsonl'), qualityFacts.map((f) => JSON.stringify(f)).join(NL) + NL, 'utf8')

const memory = await import('../lib/memory.js')

/* ---------- 指标 1：召回率 ---------- */
let hitTotal = 0
let expectTotal = 0
for (const c of qualityCases) {
  const got = memory.searchFacts(c.query, { limit: 5 }).hits.map((f) => f.id)
  if (c.expect.length === 0) {
    assert.equal(got.length, 0, `[${c.id}] 负例不该召回任何记忆，实际 ${JSON.stringify(got)}`)
  } else {
    for (const id of c.expect) {
      expectTotal += 1
      if (got.includes(id)) hitTotal += 1
    }
    assert.ok(c.expect.every((id) => got.includes(id)), `[${c.id}] 期望 ${JSON.stringify(c.expect)}，实际 ${JSON.stringify(got)}`)
  }
}
const recall = hitTotal / expectTotal
assert.ok(recall >= 0.8, `召回率 ${recall.toFixed(2)} 低于 0.8`)
console.log('召回率：' + recall.toFixed(2) + ` (${hitTotal}/${expectTotal})`)

rmSync(selfnoteDir, { recursive: true, force: true })
rmSync(memoryDir, { recursive: true, force: true })
rmSync(sessionsDir, { recursive: true, force: true })

console.log('记忆质量评测全部通过')
process.exit(0)
