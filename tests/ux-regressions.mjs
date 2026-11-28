/**
 * 批5 UX 回归（客观项 + OW 拍板的主观项）。
 * 锁以下可验证不变量：
 *   1. 新用户引导 sn-intro 默认展开（审计标 Important：默认收起等于没有）
 *   2. intro 预算行和概览预算条一致，都列话题段（批1 补了预算条，这段文案漏了）
 *   3. intro 有名词速查，消除「门牌/素材层/采纳/退役」术语墙
 *   4. 入口名统一叫「AI 记忆」（原名「人格（自述）」名不副实，点进去是六页签）
 *   5. 关系记忆卡默认折叠（三卡并排过载，OW 拍板折叠保留功能）
 *   6. 用户可见文案不含内部词（presets.json / factId / 同 key / 来源标着 preset）
 * 手法：源码结构断言——这几项本质是文案/JSX，没有「逻辑等价重构」的空间，仓库批4 已有同风格。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

assert.match(src, /className: 'sn-intro',\s*open: true/, '新用户引导 intro 要默认展开')
assert.match(src, /\/ 话题 ' \+ caps\.topic/, 'intro 预算行要列话题段，和概览预算条口径一致')
assert.match(src, /名词速查/, 'intro 要有名词速查，消除术语墙')

// 主观项：OW m02877 拍板三项全做
assert.ok(!src.includes('人格（自述）'), '入口名要统一改成「AI 记忆」，不留旧名')
assert.match(src, /h\('div',\s*\{\s*className: 'sn-title'\s*\},\s*'AI 记忆'\)/, '设置页主标题要叫 AI 记忆')
assert.match(src, /return 'AI 记忆'/, '侧栏入口 label 要叫 AI 记忆')
assert.match(src, /更多操作在下方/, '侧栏空态指引改成常驻折叠区')
// 精确切出关系卡那段 h('details', {...}, ...) 的属性对象，确认没有 open:true（默认折叠）
const relAt = src.indexOf("className: 'sn-card sn-relations'")
assert.ok(relAt > 0, '关系记忆卡要包在 details 里')
const relWindow = src.slice(relAt - 60, relAt + 120)
assert.ok(/'details'/.test(relWindow), '关系卡根节点是 details')
assert.ok(!/\bopen\s*:/.test(relWindow), '关系卡默认折叠，不能带 open 属性')
assert.match(src, /sn-relations > summary\{cursor:pointer/, '折叠关系卡要有可点击的 summary 样式')
assert.ok(!src.includes('presets.json'), '用户可见文案不说 presets.json')
assert.ok(!src.includes("' ← ' + part.factId"), '用户可见文案不说裸 factId')
assert.match(src, /记忆编号/, 'factId 翻成「记忆编号」')
assert.ok(!/来源标着 preset/.test(src), '用户可见文案不说「来源标着 preset」')
assert.ok(!/同 key/.test(src), '用户可见文案不说「同 key」')
assert.ok(!/aria-label': '勾选 ' \+ item\.key/.test(src), '勾选读屏标签不说 item.key')

// 人格页顶部必须一眼看到「哪几段真进每回合上下文、L2 不进」（OW m08444）
const personaBudgetAnchor = "每回合注入 L0 ' + p0Chars + ' + L1 ' + p1Chars"
assert.ok(src.includes(personaBudgetAnchor), '人格页要给出每回合注入的字数分配')
assert.ok(
  src.indexOf(personaBudgetAnchor) < src.indexOf("personaField('l0'"),
  '这条分配要排在 L0 字段之前，别藏在 L1 下面',
)
assert.ok(src.includes('字不进注入。'), '要写明 L2 不进注入')
assert.ok(!src.includes("'L0 ' + p0Chars + ' + L1 '"), '旧的半截读数要收掉，避免两处重复')

// 预设文案漂移：只对「旧版默认」给一键换新；自己改过的只提示，绝不给替换入口
assert.match(src, /item\.kind === 'superseded'/, '旧版默认要按 kind 判定，别用 edited 猜')
assert.ok(!src.includes('item.edited'), 'edited 分不清旧默认和自己改过，界面改用 kind')
assert.match(src, /'用新的默认'/, '旧版默认那条要给「用新的默认」按钮')
assert.match(src, /runPresetOp\('sync'/, '换新走 sync，不是重新导入')
assert.match(src, /这条你自己改过，和当前默认不一样/, '自己改过的要如实说明不会被悄悄改掉')

// 护栏必须进默认测试，否则形同虚设（batch5-reviewer 复审 Important）
assert.ok(
  String(pkg.scripts.test).includes('node tests/ux-regressions.mjs'),
  'npm test 默认脚本要接上 ux-regressions.mjs',
)
// 批1–4 新增的回归测试也必须进默认脚本，否则保护退化（final-reviewer Minor）
for (const t of [
  'atomic-dir-fsync', 'atomic-tmp-exclusive', 'atomic-wx-cleanup',
  'habit-lock', 'import-lock-read-guard', 'lock-created-cleanup', 'lock-pid',
  'preset-drift',
]) {
  assert.ok(
    String(pkg.scripts.test).includes('node tests/' + t + '.mjs'),
    'npm test 默认脚本要接上 ' + t + '.mjs',
  )
}

console.log('批5 UX：intro / 入口名 / 关系卡折叠 / 内部词 / 默认测试接线')
