/**
 * 设置页「有数据」时的渲染测试：用一份真实形态的 state 跑一遍组件。
 * 目的是挡住「字段缺失就把整块面板渲染崩」这类问题（自动采集的候选没有 citation），
 * 以及标签页把该显示的内容藏起来/藏错页。
 * 跑法：node tests/client-state.mjs
 */

import assert from 'node:assert/strict'

let def = null
globalThis.window = { __ModuleLoader__: { load(d) { def = d } } }
const styles = []
globalThis.document = {
  createElement: () => ({ id: '', textContent: '', remove() { this.removed = true } }),
  head: { appendChild: (node) => styles.push(node) },
  getElementById: () => null,
}

const base = {
  ok: true,
  enabled: true,
  heading: '关于我自己',
  maxChars: 1600,
  maxEntries: 40,
  entries: 1,
  chars: 46,
  archiveFiles: 1,
  notes: [{ date: '2026-11-03', text: '先让它能跑。' }],
  notesFile: 'C:/x/notes.md',
  archiveDir: 'C:/x/archive',
  configFile: 'C:/x/config.json',
  maxEntryChars: 600,
  memory: { facts: 2, approved: 1, candidates: 1, retired: 0, habits: 0, sessions: 10, cache: 0, root: 'C:/x/memory' },
  runtime: { node: '24.21.0', electron: '44.7.0', platform: 'win32', sqlite: true },
  index: { present: false, fresh: false },
  budget: { notes: 20, profile: 0, facts: 12, habits: 0, total: 32, limit: 300 },
  profile: { enabled: true, override: '', maxChars: 60, manual: false, text: '', chars: 0, parts: [], sources: [], conflicts: [] },
  habits: [],
  habitSuggestions: [],
}

// 关键：这两条是自动采集来的，没有 citation，只有 source / occurrences，而且互相冲突
const withCandidates = {
  ...base,
  facts: {
    candidates: [
      { id: 'auto-1', text: '以后回答先给结论', status: 'candidate', source: 'session-abc#12', occurrences: 4, triggers: ['standing'], conflictWith: 'auto-2', similarTo: ['auto-2'], evidence: ['session-abc#12'] },
      { id: 'auto-2', text: '以后回答先铺垫背景再给结论', status: 'candidate', source: 'session-abc#30', occurrences: 1, triggers: ['correct'], conflictWith: 'auto-1', similarTo: ['auto-1'], evidence: ['session-abc#30'] },
    ],
    approved: [
      { id: 'f1', text: '索引只存词元', status: 'approved', citation: { sessionId: 'session-abc', index: 7, date: '2026-11-02' }, heat: 1.5 },
    ],
    retired: 0,
  },
}

const noCandidates = {
  ...base,
  facts: { candidates: [], approved: withCandidates.facts.approved, retired: 0 },
}

let current = withCandidates
let useStateCall = 0
// 点页签要模拟交互；这个假 React 只能按调用顺序塞值 —— 顺序变了下面的断言会立刻炸
let forcedTab = null
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState(initial) {
    useStateCall += 1
    if (useStateCall === 1) return [current, () => {}]
    if (forcedTab !== null && useStateCall === 9) return [forcedTab, () => {}]
    if (forcedTab !== null && useStateCall === 10) return [true, () => {}]
    return [typeof initial === 'function' ? null : initial, () => {}]
  },
  useEffect() {},
  useCallback: (fn) => fn,
}

await import('../lib/client.js')
const mod = def.factory((id) => {
  if (id === 'react') return React
  throw new Error('未知模块：' + id)
})

let registered = null
mod.apply({
  effect(fn) { fn() },
  slots: { inject(name, fn) { fn() }, register(meta, C) { registered = C } },
})

const wrapper = registered({})

function render(state) {
  current = state
  useStateCall = 0
  return wrapper.type({})
}

function collect(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (node.type) out.push(node)
  for (const kid of node.children || []) collect(kid, out)
  return out
}

/* 1. 有自动采集候选：整块能渲染，且默认落在「记忆」页 */
let tree = render(withCandidates)
let json = JSON.stringify(tree)
assert.equal(tree.props.className, 'sn-root')
assert.ok(json.includes('以后回答先给结论'), '候选文本要显示出来')
assert.ok(json.includes('自动采集'), '自动采集的候选要标出来源')
assert.ok(json.includes('出现 4 次'), '要显示出现次数')
assert.ok(json.includes('session-abc'), '手动提交的仍显示 citation')
assert.ok(json.includes('两条说法对不上'), '冲突要并排显示，而不是只给一句提示')
assert.ok(json.includes('以后回答先铺垫背景再给结论'), '冲突对方的内容也要显示出来')
assert.ok(json.includes('长期约定') && json.includes('纠正'), '要显示触发原因')
assert.ok(json.includes('新候选') && json.includes('已有的'), '两侧要标出哪条是新的哪条是旧的')
assert.ok(!json.includes('undefined'), '渲染结果里不该出现 undefined')
console.log('1. 有自动采集候选时也能正常渲染（不再白板）')

/* 2. 标签页：四个页签、一个页签被选中、panel 与页签对得上 */
let nodes = collect(tree)
let tabs = nodes.filter((node) => node.props && node.props.role === 'tab')
assert.equal(tabs.length, 4, '应该有四个页签：概览 / 自述 / 记忆 / 画像')
assert.deepEqual(
  tabs.map((node) => node.children[0]),
  ['概览', '自述', '记忆', '画像'],
)
assert.ok(nodes.some((node) => node.props && node.props.role === 'tablist'), '页签要有 tablist 容器')
const activeTab = tabs.filter((node) => node.props['aria-selected'] === true)
assert.equal(activeTab.length, 1, '同一时刻只能有一个页签被选中')
assert.equal(activeTab[0].props.id, 'sn-tab-memory', '有待审候选时默认开「记忆」')
assert.match(activeTab[0].props.className, /sn-tab-on/)
const panelNodes = nodes.filter((node) => node.props && node.props.role === 'tabpanel')
assert.equal(panelNodes.length, 1, '只渲染当前页签的面板')
assert.equal(panelNodes[0].props.id, 'sn-panel-memory')
assert.equal(panelNodes[0].props['aria-labelledby'], 'sn-tab-memory')
assert.ok(tabs.every((node) => typeof node.props['aria-controls'] === 'string'), '每个页签要指明控制哪个面板')
console.log('2. 四个页签、单选状态与面板 aria 关系都对')

/* 3. 没有待审候选：停在「概览」 */
tree = render(noCandidates)
json = JSON.stringify(tree)
nodes = collect(tree)
tabs = nodes.filter((node) => node.props && node.props.role === 'tab')
const overviewTab = tabs.find((node) => node.props.id === 'sn-tab-overview')
assert.equal(overviewTab.props['aria-selected'], true, '没有待审时默认停在「概览」')
assert.match(json, /sn-panel-overview/)
assert.ok(!json.includes('两条说法对不上'), '没候选时不该渲染候选区')
assert.ok(json.includes('注入与容量'), '概览页要有注入开关与上限')
console.log('3. 没有待审候选时停在概览页，且不渲染空候选区')

/* 4. 每个页签带自己的摘要 badge */
tabs = collect(render(withCandidates)).filter((node) => node.props && node.props.role === 'tab')
const badges = tabs.map((node) => (node.children[1] ? node.children[1].children[0] : ''))
assert.deepEqual(badges, ['', '1 条', '待审 2', '0 字'])
console.log('4. 页签 badge 分别是自述条数、待审条数、画像字数')

console.log('\n5 项全部通过')
/* 5. 画像页：手改覆盖、来源 chip、冲突提示都要在该页里 */
const withProfile = {
  ...withCandidates,
  facts: { candidates: [], approved: withCandidates.facts.approved, retired: 0 },
  profile: {
    enabled: true,
    override: '',
    maxChars: 60,
    manual: false,
    text: '索引：只存词元',
    chars: 40,
    parts: [{ tag: '索引', factId: 'f1' }],
    sources: ['f1'],
    conflicts: [{ tag: '沟通', count: 2 }],
  },
}
forcedTab = 'profile'
tree = render(withProfile)
json = JSON.stringify(tree)
assert.match(json, /sn-panel-profile/, '切到画像页后要渲染画像面板')
assert.ok(json.includes('关于你'), '画像页要有「关于你」那张卡')
assert.ok(json.includes('← f1'), '画像每句要能回溯到来源 id')
assert.ok(json.includes('同标签还有未合并的条目'), '冲突提示要显示')
assert.ok(json.includes('沟通 ×2'))
assert.ok(!json.includes('undefined'), '画像页也不该出现 undefined')
forcedTab = null
console.log('5. 画像页显示来源与冲突，且没有 undefined')

process.exit(0)
