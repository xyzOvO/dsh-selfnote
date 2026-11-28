import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHandover } from '../lib/handover-init.js'

const cases = []
function check(name, fn) {
  cases.push([name, fn])
}

const root = mkdtempSync(join(tmpdir(), 'sn-handover-init-'))
const project = join(root, 'demo-proj')
mkdirSync(project, { recursive: true })
const when = new Date('2026-11-28T04:00:00Z')

check('空路径要挡住，别在进程当前目录里乱建', () => {
  const result = initHandover('')
  assert.equal(result.ok, false)
  assert.match(result.error, /项目根路径/)
})

check('不存在的目录要挡住', () => {
  const result = initHandover(join(root, 'not-there'))
  assert.equal(result.ok, false)
  assert.match(result.error, /不存在/)
})

check('首次初始化落九个文件', () => {
  const result = initHandover(project, { projectId: 'demo-proj', projectName: '演示项目', agent: 'dsh', now: when })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.dest, join(project, '.handover'))
  assert.equal(result.files.length, 9)
  for (const name of result.files) {
    assert.ok(existsSync(join(result.dest, name)), name + ' 要真的落盘')
  }
})

check('占位符全部替换掉，别把 __PROJECT_ID__ 留给用户', () => {
  const context = readFileSync(join(project, '.handover', 'CONTEXT.md'), 'utf8')
  assert.match(context, /project_id: demo-proj/)
  assert.match(context, /project_name: 演示项目/)
  const leftover = context.match(/__[A-Z_]+__/)
  assert.equal(leftover, null, 'CONTEXT 里还有没替换的占位符：' + (leftover && leftover[0]))
  const tasks = readFileSync(join(project, '.handover', 'TASKS.md'), 'utf8')
  assert.equal(/__[A-Z_]+__/.test(tasks), false, 'TASKS 里还有没替换的占位符')
})

check('日期按当天写进 STATE，不是模板里的占位', () => {
  const state = readFileSync(join(project, '.handover', 'STATE.md'), 'utf8')
  assert.match(state, /\d{4}-\d{2}-\d{2}/)
  assert.equal(state.includes('__TODAY__'), false)
})

check('已经有的不覆盖 —— 交接卡里是别人的工作状态', () => {
  const again = initHandover(project, { projectId: 'demo-proj' })
  assert.equal(again.ok, false)
  assert.match(again.error, /不覆盖/)
})

check('目录名带空格和中文时，项目 id 收敛成干净串', () => {
  const messy = join(root, 'My Proj 2')
  mkdirSync(messy, { recursive: true })
  const result = initHandover(messy)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.projectId, 'my-proj-2')
})

check('agent 名也收敛，变更集编号才不会带空格', () => {
  const other = join(root, 'other')
  mkdirSync(other, { recursive: true })
  const result = initHandover(other, { projectId: 'other', agent: 'Claude Code' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.agent, 'claude-code')
})

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log('ok - ' + name)
  } catch (err) {
    failed += 1
    console.error('not ok - ' + name)
    console.error('   ' + String(err?.message || err))
  }
}

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* 临时目录清不掉不算失败 */
}

console.log(`\n${cases.length - failed}/${cases.length} 通过`)
if (failed > 0) process.exit(1)
