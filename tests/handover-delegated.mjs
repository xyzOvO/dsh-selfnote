// 交接卡指针 · 委派会话回归（审查 F3-①）
// 委派出去的子 Agent 不该继承父会话的记忆，但必须拿到交接卡指针——
// 否则子 Agent 首回合不知道卡在哪，只能靠猜（干净上下文探针实测过）。
// apply() 注入的 ctx 是最小可用 mock：只提供插件注册要用的钩子。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'hv-delegated-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = join(dir, 'sessions')
process.env.DSH_SELFNOTE_NO_OPEN = '1'

// 一条用户记忆：委派会话不该看到它
mkdirSync(join(dir, 'memory'), { recursive: true })
writeFileSync(join(dir, 'memory', 'facts.jsonl'),
  JSON.stringify({ id: 'secret-memory', text: '这条记忆只给主线会话', status: 'approved', channel: 'rel' }) + '\n')

// 临时项目交接卡
const proj = join(dir, 'proj')
mkdirSync(join(proj, '.handover'), { recursive: true })
writeFileSync(join(proj, '.handover', 'CONTEXT.md'), [
  '---', 'project_id: delegated-demo', 'format: handover-v3', '---', '', '# CONTEXT',
].join('\n'))

let currentAgent = null
let injectionDef = null
const ctx = {
  logger: { info() {}, warn() {} },
  on() {},
  agents: { currentInitiator: () => currentAgent },
  systemPrompt: { context(def) { injectionDef = def; return () => {} } },
  tools: { register() { return () => {} } },
  webServer: { register() { return () => {} } },
}
const { apply } = await import('../lib/index.js')
apply(ctx, { handoverRoot: proj })

let pass = 0
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); pass += 1 } catch (e) { console.log('  FAIL ' + name + ' —— ' + e.message); process.exitCode = 1 }
}
const delegatedAgent = (id) => ({
  session: { header: { id, origin: 'subagent', delegationDepth: 1 }, meta: { cwd: proj } },
})

check('委派会话仍收到交接卡指针（当前代码吞掉 → 应 RED）', () => {
  currentAgent = delegatedAgent('delegated-probe-1')
  const text = injectionDef.text()
  assert.ok(text.includes('[交接卡]'), '委派会话应看到交接卡指针，实际：' + JSON.stringify(text.slice(0, 120)))
  assert.ok(text.includes('delegated-demo'), '指针要带 project_id')
})

check('委派会话不注入记忆正文', () => {
  currentAgent = delegatedAgent('delegated-probe-2')
  const text = injectionDef.text()
  assert.ok(!text.includes('这条记忆只给主线会话'), '委派会话不该看到主线记忆正文')
})

check('无会话 id 的不同会话都拿到指针（不共享 nosession marker）', () => {
  currentAgent = { session: { header: { origin: 'main' }, meta: { cwd: proj } } }
  assert.ok(injectionDef.text().includes('[交接卡]'), '第一个无 id 会话应拿到指针')
  assert.ok(injectionDef.text().includes('[交接卡]'), '第二个无 id 会话也应拿到指针，不该共享 nosession marker')
})

check('同一会话第二次不再带指针（去重语义保持）', () => {
  currentAgent = { session: { header: { id: 'same-session', origin: 'main' }, meta: { cwd: proj } } }
  assert.ok(injectionDef.text().includes('[交接卡]'), '首回合带指针')
  assert.ok(!injectionDef.text().includes('[交接卡]'), '第二回合不该再带指针')
})

currentAgent = null
rmSync(dir, { recursive: true, force: true })
console.log('\n' + pass + ' 项通过')
