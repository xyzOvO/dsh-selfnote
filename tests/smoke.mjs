/**
 * 冒烟测试：不启动 DSH，用一个假 ctx 跑一遍插件的三条主路径。
 * 关键：把 DSH_SELFNOTE_DIR 指到临时目录，绝不碰真实状态。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-'))
process.env.DSH_SELFNOTE_DIR = dir

const { apply } = await import('../lib/index.js')

let pass = 0
function check(name, ok, extra = '') {
  if (!ok) throw new Error(`✗ ${name} ${extra}`)
  pass += 1
  console.log(`✓ ${name}${extra ? ` ${extra}` : ''}`)
}

const captured = { contexts: [], tools: [] }
const ctx = {
  logger: { info: () => {} },
  on: () => {},
  systemPrompt: {
    context(def) {
      captured.contexts.push(def)
      return () => {}
    },
  },
  tools: {
    register(def) {
      captured.tools.push(def)
      return () => {}
    },
  },
}

apply(ctx, { enabled: true, maxChars: 120, maxEntries: 4 })

check('注册了注入段', captured.contexts.length === 1)
check('注入段名字', captured.contexts[0].name === 'selfnote:me')
check('注册了 self_note 工具', captured.tools[0]?.name === 'self_note')

const inject = captured.contexts[0].text
check('还没写时注入为空', inject() === '')

const tool = captured.tools[0]
const w1 = await tool.execute({ action: 'write', text: '今天被问到一个我答不上来的问题，我承认了不知道，而不是编。' })
check('写入成功', w1.entries === 1 && !w1.error, `entries=${w1.entries}`)

// 写满容量，验证裁剪与归档
for (let i = 0; i < 8; i += 1) {
  await tool.execute({ action: 'write', text: `第 ${i} 条自述，用来把容量撑满，看它是否会把最旧的挤进归档。` })
}
const st = await tool.execute({ action: 'stats' })
check('条数被裁到上限内', st.entries <= 4, `entries=${st.entries}`)
check('产生了归档', st.archiveFiles >= 1, `archiveFiles=${st.archiveFiles}`)

const text = inject()
check('注入内容非空', text.startsWith('关于我自己'))
check('注入长度受控', text.length <= 120 + 40, `len=${text.length}`)

const read = await tool.execute({ action: 'read' })
check('read 返回全部生效条目', read.entries === st.entries)

const bad = await tool.execute({ action: 'write', text: '   ' })
check('空文本被拒绝', Boolean(bad.error))

const unknown = await tool.execute({ action: 'nope' })
check('未知 action 有提示', String(unknown.error).includes('未知 action'))

// 渲染必须给 ContentBlock[]（给字符串会让宿主 content.some 崩）
const blocks = tool.output.render({ action: 'stats' }, st)
check('render 返回 ContentBlock 数组', Array.isArray(blocks) && blocks[0]?.type === 'text', `type=${typeof blocks}`)
const errBlocks = tool.output.render({ action: 'write' }, bad)
check('render 错误分支也可渲染', Array.isArray(errBlocks) && String(errBlocks[0].text).includes('不能为空'))

// 关掉开关后不注入
const ctx2 = { logger: {}, on: () => {}, systemPrompt: { context: (d) => { captured.off = d; return () => {} } }, tools: { register: () => () => {} } }
apply(ctx2, { enabled: false })
check('enabled=false 时不注入', captured.off.text() === '')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} 项全部通过`)
process.exit(0)
