// 冷启动复述验收：把「新会话接手交接卡」的要素变成可跑断言。
// 背景：PROTOCOL 启动序列第 6 步要求复述（目标/下一步/阻塞/待审/验证/硬边界），
// 但此前没有任何机器可判定的检查 —— review.sh 只生成视图。本文件补上验收。
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const proj = join(here, '..')
const hv = join(proj, '.handover')

let pass = 0
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); pass += 1 } catch (e) { console.log('  FAIL ' + name + ' —— ' + e.message); process.exitCode = 1 }
}
const read = (f) => readFileSync(join(hv, f), 'utf8')

check('交接卡核心文件齐备', () => {
  for (const f of ['CONTEXT.md', 'STATE.md', 'PROTOCOL.md', 'CLAIMS.md', 'TASKS.md', 'REVIEW.md', 'HISTORY.md', 'JOURNAL.md']) {
    assert.ok(existsSync(join(hv, f)), '缺文件：' + f)
  }
})

check('CONTEXT frontmatter 含 project_id / format: handover-v3', () => {
  const head = read('CONTEXT.md').slice(0, 400)
  assert.match(head, /^project_id:\s*\S+/m)
  assert.match(head, /^format:\s*handover-v3/m)
})

check('STATE 含「当前工作 / 阻塞 / 上次交接」三小节', () => {
  const s = read('STATE.md')
  for (const sec of ['## 当前工作', '## 阻塞', '## 上次交接']) assert.ok(s.includes(sec), '缺小节：' + sec)
})

check('PROTOCOL 启动序列覆盖 JOURNAL 与复述 6 要素', () => {
  const p = read('PROTOCOL.md')
  const start = p.slice(p.indexOf('## 启动序列'), p.indexOf('## 结束序列'))
  assert.ok(/JOURNAL/.test(start), '启动序列必须读 JOURNAL（最近事件/排障经验）')
  for (const kw of ['目标', '下一步', '阻塞', '待审', '验证', '硬边界']) {
    assert.ok(start.includes(kw), '启动序列复述要素缺：' + kw)
  }
})

check('REVIEW 改动文件列反映真实文件（不是提取 bug 留下的 -）', () => {
  const r = read('REVIEW.md')
  const row = r.split('\n').find((l) => l.includes('CS-dsh-selfnote-dsh-20261128-01'))
  assert.ok(row, 'REVIEW 应含变更集 01')
  const files = row.split('|').map((s) => s.trim())[5]
  assert.ok(files.includes('lib/index.js'), '改动文件列应含 lib/index.js，实际：' + files)
})

check('REVIEW 的 awaiting-review 计数与实际变更集一致', () => {
  const cdir = join(hv, 'CHANGESETS')
  const cs = readdirSync(cdir).filter((f) => f.endsWith('.md') && f !== 'TEMPLATE.md')
  let awaiting = 0
  for (const f of cs) {
    if (/^status:\s*awaiting-review/m.test(readFileSync(join(cdir, f), 'utf8').slice(0, 400))) awaiting += 1
  }
  const r = read('REVIEW.md')
  assert.match(r, new RegExp('awaiting-review\\s*\\*\\*' + awaiting + '\\*\\*'), 'REVIEW 计数应为 ' + awaiting)
})

check('CLAIMS 无冲突标记', () => {
  assert.ok(!/\|\s*冲突\s*\|/.test(read('CLAIMS.md')), 'CLAIMS 里有冲突')
})

console.log('\n' + pass + ' 项通过')
