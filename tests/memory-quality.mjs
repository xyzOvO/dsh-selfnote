/**
 * 记忆质量评测：召回率（该想起来的想起来没）+ 退役残余率（退役的还会不会冒出来）。
 * 全部在临时沙盘跑合成数据，不碰真实记忆；风格对齐 node 纯 assert + console.log。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qualityFacts, qualityCases } from './fixtures/memory-quality-cases.mjs'

const NL = String.fromCharCode(10)

/* ---------- 指标 1：召回率（临时沙盘 + 纯检索函数） ---------- */
{
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

  for (const dir of [selfnoteDir, memoryDir, sessionsDir]) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ---------- 指标 2：退役残余率（真注入管线） ---------- */
/** 起一套本地注入管线：三目录沙盘 + config + facts → apply() → injectionText()。 */
async function bootQualityFixture(facts) {
  const selfnoteDir = mkdtempSync(join(tmpdir(), 'mq-inj-notes-'))
  const memoryDir = mkdtempSync(join(tmpdir(), 'mq-inj-memory-'))
  const sessionsDir = mkdtempSync(join(tmpdir(), 'mq-inj-sessions-'))
  process.env.DSH_SELFNOTE_DIR = selfnoteDir
  process.env.DSH_MEMORY_DIR = memoryDir
  process.env.DSH_SESSIONS_DIR = sessionsDir
  process.env.DSH_SELFNOTE_NO_OPEN = '1'
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(selfnoteDir, 'config.json'), JSON.stringify({
    enabled: true, personaEnabled: false, profileEnabled: false, heading: 'AI记忆', noteGuide: '',
  }), 'utf8')
  writeFileSync(join(selfnoteDir, 'persona.md'), '', 'utf8')
  writeFileSync(join(selfnoteDir, 'notes.md'), '', 'utf8')
  writeFileSync(join(memoryDir, 'facts.jsonl'), facts.map((f) => JSON.stringify(f)).join(NL) + NL, 'utf8')

  const { apply } = await import('../lib/index.js')
  let injectionDef = null
  const ctx = {
    logger: { info() {}, warn() {} },
    on() {},
    agents: { currentInitiator: () => null },
    systemPrompt: { context(def) { injectionDef = def; return () => {} } },
    tools: { register() { return () => {} } },
    webServer: { register() { return () => {} } },
  }
  apply(ctx, {})
  assert.ok(injectionDef && typeof injectionDef.text === 'function', '夹具必须拿到注入 def')

  return {
    injectionText: () => injectionDef.text(),
    factsPath: () => join(memoryDir, 'facts.jsonl'),
    cleanup() {
      for (const dir of [selfnoteDir, memoryDir, sessionsDir]) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录，删不掉就算了 */ }
      }
    },
  }
}

{
  const marks = ['退役哨兵ABC987', '退役哨兵XYZ321', '退役哨兵MNO654']
  const working = marks.map((m, i) => ({ id: 'qf-res' + (i + 1), text: m, status: 'approved' }))
  const fx = await bootQualityFixture(working)

  // 区分力：退役前三条标记都要在注入文本里，否则"退役后不可见"永远为真。
  const before = fx.injectionText()
  for (const m of marks) {
    assert.ok(before.includes(m), `[前置] 退役前标记必须可见：${m}`)
  }

  // 逐条累积退役：writeFacts 覆盖整文件，每次写回全部三条（只把当前那条改 retired）。
  let residual = 0
  for (let i = 0; i < marks.length; i += 1) {
    working[i].status = 'retired'
    writeFileSync(fx.factsPath(), working.map((f) => JSON.stringify(f)).join(NL) + NL, 'utf8')
    const after = fx.injectionText()
    if (after.includes(marks[i])) residual += 1
    assert.ok(!after.includes(marks[i]), `[残余] ${marks[i]} 退役后不得进注入`)
    for (let j = i + 1; j < marks.length; j += 1) {
      assert.ok(after.includes(marks[j]), `[误伤] 未退役的 ${marks[j]} 仍应可见`)
    }
  }
  assert.equal(residual, 0, '退役残余率必须为 0')
  console.log('退役残余率：' + (residual / marks.length).toFixed(2) + ` (${residual}/${marks.length})`)

  fx.cleanup()
}

console.log('记忆质量评测全部通过')
process.exit(0)
