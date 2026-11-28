// 交接卡导入导出：打包 → 解析 → 还原，要求字节级往返一致。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../lib/handover-bundle.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-bundle-'))
const src = path.join(tmp, 'proj', '.handover')
fs.mkdirSync(path.join(src, 'CHANGESETS'), { recursive: true })

const files = {
  'CONTEXT.md': '---\nproject_id: demo-proj\nproject_name: 演示项目\n---\n\n# CONTEXT\n\n- 边界：只改 lib\n',
  'STATE.md': '---\nproject_id: demo-proj\nlast_updated: 2026-11-28T00:00Z\n---\n\n# STATE\n\n## 当前工作\n- 正在做：打包脚本\n',
  'PROTOCOL.md': '# PROTOCOL\n\n1. 不写 verified\n',
  'TASKS.md': '# TASKS\n\n| ID | 任务 | 状态 |\n|---|---|---|\n| T1 | 打包 | awaiting-review |\n',
  'HISTORY.md': '# HISTORY\n\n## v0.1.0\n- 首个版本\n',
  'JOURNAL.md': '# JOURNAL\n\n## 2026-11-28T00:00Z | dsh | - | T1 | awaiting-review\n- 一句话：打包\n',
  'CLAIMS.md': '# CLAIMS\n\n| 文件 | hash |\n|---|---|\n| lib/a.js | abc |\n',
  'CHANGESETS/TEMPLATE.md': '# 模板\n',
  'CHANGESETS/CS-demo-01.md': '---\nid: CS-demo-01\nstatus: awaiting-review\nrisk: L2\ncreated: 2026-11-28T00:00Z\n---\n\n# 变更集\n\n## 验证\n- 命令：\n  ```bash\n  npm test\n  ```\n',
}
for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(src, rel), body)

// 1. 打包：七个核心文件都在，元信息取自 CONTEXT，变更集清单只有一条（不含 TEMPLATE）
const md = mod.bundleMarkdown(src, new Date('2026-11-28T01:02:00Z'))
assert.ok(md.startsWith('---\nhandover_bundle: 1'), '要以 bundle 头开始：' + md.slice(0, 60))
assert.ok(md.includes('project_id: demo-proj'), '要带 project_id')
assert.ok(md.includes('project_name: 演示项目'), '要带 project_name')
assert.ok(md.includes('core_files: 7/7'), '七个核心文件都要在：' + (md.match(/core_files: \d+\/\d+/) || [''])[0])
assert.ok(md.includes('changesets: 1'), '变更集只算真实文件，不含 TEMPLATE')
for (const name of mod.CORE_FILES) assert.ok(md.includes(`## ${name}`), `缺少段落 ## ${name}`)
assert.ok(md.includes('## CHANGESET: CS-demo-01.md'), '要嵌入变更集正文')
assert.ok(md.includes('建议阅读顺序'), '要带阅读顺序提示')
console.log('打包：7 个核心文件 + 1 条变更集，元信息齐全')

// 2. 正文可读：代码围栏用四个反引号，避免与内容里的三反引号冲突
assert.ok(md.includes('````md'), '要用四反引号围栏')
const parsed = mod.parseBundle(md)
assert.deepEqual(Object.keys(parsed.files).sort(), mod.CORE_FILES.slice().sort(), '解析要拿到七个核心文件')
assert.equal(parsed.files.CONTEXT, files['CONTEXT.md'].replace(/\s+$/, ''), 'CONTEXT 正文要一字不差')
console.log('解析：七个核心文件 + 正文逐字一致')

// 3. 往返：还原到新目录后与源文件逐字节相同
const dst = path.join(tmp, 'dst', '.handover')
const res = mod.importBundle(md, dst)
assert.equal(res.files.length, 7, '要还原七个核心文件')
assert.equal(res.changesets.length, 1, '要还原一条变更集')
for (const name of mod.CORE_FILES) {
  const want = files[`${name}.md`]
  const got = fs.readFileSync(path.join(dst, `${name}.md`), 'utf8')
  assert.equal(got, want, `${name}.md 往返后要一致`)
}
assert.equal(
  fs.readFileSync(path.join(dst, 'CHANGESETS', 'CS-demo-01.md'), 'utf8'),
  files['CHANGESETS/CS-demo-01.md'],
  '变更集往返后要一致'
)
console.log('往返：七个核心文件 + 变更集逐字节一致')

// 4. 覆盖前先备份：目标里已有 .md 时，必须留下 .bak- 目录
const again = mod.importBundle(md, dst)
assert.ok(again.backup && fs.existsSync(again.backup), '覆盖已有目录前要备份：' + again.backup)
assert.ok(again.backup.includes('.bak-'), '备份目录名要带时间戳')
console.log('备份：覆盖前生成 ' + path.basename(again.backup))

// 5. 空内容要明确报错，不写坏文件
assert.throws(() => mod.importBundle('随便一段文字，没有任何交接卡段落', path.join(tmp, 'empty', '.handover')), /没有找到交接卡段落/)
assert.equal(fs.existsSync(path.join(tmp, 'empty', '.handover')), false, '解析失败不能创建目录')
console.log('拒绝：空内容报错且不落盘')

// 6. 文件名：优先用 project_id
const name = mod.bundleFileName(src, new Date('2026-11-28T01:02:00Z'))
assert.match(name, /^handover-demo-proj-20261128-0102\.md$/, '文件名要用 project_id + 时间戳：' + name)
console.log('文件名：' + name)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n交接卡导入导出 6 组全部通过')
