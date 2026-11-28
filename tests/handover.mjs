// 交接卡指针：只注入指针，不注入状态正文
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../lib/index.js')
const { handoverPointerOf, findHandoverRoot, assembleInjection, currentConfig } = mod

const root = mkdtempSync(join(tmpdir(), 'hv-ptr-'))
const proj = join(root, 'proj')
mkdirSync(join(proj, '.handover', 'CHANGESETS'), { recursive: true })
writeFileSync(join(proj, '.handover', 'CONTEXT.md'), [
  '---',
  'project_id: demo-proj',
  'project_name: 示例项目',
  'format: handover-v3',
  '---',
  '',
  '# CONTEXT',
  '',
  '## 硬边界（每次启动必读，不可违反）',
  '- 不写 verified',
  '- 发布必须人在场',
].join('\n'), 'utf8')
writeFileSync(join(proj, '.handover', 'STATE.md'), '# STATE\n\n## 当前工作\n- 正在做：骨架\n', 'utf8')
writeFileSync(join(proj, '.handover', 'PROTOCOL.md'), '# PROTOCOL\n', 'utf8')

let pass = 0
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); pass += 1 } catch (e) { console.log('  FAIL ' + name + ' —— ' + e.message); process.exitCode = 1 }
}

check('有 CONTEXT 时给出指针', () => {
  const p = handoverPointerOf(proj)
  assert.ok(p.includes('demo-proj'), '指针要带 project_id：' + p)
  assert.ok(p.includes('.handover/') && p.includes('CONTEXT.md'), '指针要指出交接卡位置和必读文件：' + p)
  assert.ok(p.includes('STATE.md') && p.includes('PROTOCOL.md'), '三件必读都要点到')
  assert.ok(p.includes('禁止'), '要带硬边界/禁止项')
})

check('指针要短：不超过 400 字符', () => {
  const p = handoverPointerOf(proj)
  assert.ok(p.length <= 400, '指针太长：' + p.length)
})

check('没有 .handover 时返回空串', () => {
  assert.equal(handoverPointerOf(join(root, 'nothing')), '')
})

check('从子目录能向上找到 .handover', () => {
  const deep = join(proj, 'src', 'a', 'b')
  mkdirSync(deep, { recursive: true })
  assert.equal(findHandoverRoot(deep), proj)
})

check('找不到时返回空串', () => {
  assert.equal(findHandoverRoot(join(root, 'nothing', 'deep')), '')
})

check('指针不进八段预算，但出现在注入文本最前面', () => {
  const cfg = currentConfig()
  const plain = assembleInjection(cfg, {})
  const pointer = handoverPointerOf(proj)
  const withPointer = assembleInjection(cfg, { pointer })
  assert.ok(withPointer.text.startsWith('[交接卡]'), '指针要在最前面：' + withPointer.text.slice(0, 40))
  const segSum = (x) => x.segments.reduce((s, seg) => s + seg.chars, 0)
  assert.equal(segSum(withPointer), segSum(plain), '八段字数不该被指针改变')
  assert.ok(withPointer.overhead > plain.overhead, '指针要算进 overhead')
})

check('不传指针时文本与原来一致', () => {
  const cfg = currentConfig()
  assert.equal(assembleInjection(cfg, {}).text, assembleInjection(cfg, { pointer: '' }).text)
})

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} 项通过`)
