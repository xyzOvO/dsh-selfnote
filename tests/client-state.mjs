/**
 * 设置页「有数据」时的渲染测试：用一份真实形态的 state 跑一遍组件。
 * 目的是挡住「字段缺失就把整块面板渲染崩」这类问题（自动采集的候选没有 citation）。
 * 跑法：node tests/client-state.mjs
 */

import assert from 'node:assert/strict'

let def = null
globalThis.window = { __ModuleLoader__: { load(d) { def = d } } }
const styles = []
globalThis.document = {
  createElement: () => ({ id: '', textContent: '', remove() { this.removed = true } }),
  head: { appendChild: (node) => styles.push(node) },
}

const fixture = {
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
  // 关键：这条是自动采集来的，没有 citation，只有 source / occurrences
  facts: {
    candidates: [
      { id: 'auto-1', text: '以后回答先给结论', status: 'candidate', source: 'session-abc#12', occurrences: 4, similarTo: [], evidence: ['session-abc#12'] },
    ],
    approved: [
      { id: 'f1', text: '索引只存词元', status: 'approved', citation: { sessionId: 'session-abc', index: 7, date: '2026-11-02' }, heat: 1.5 },
    ],
    retired: 0,
  },
  habits: [],
  habitSuggestions: [],
}

let useStateCall = 0
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState(initial) {
    useStateCall += 1
    if (useStateCall === 1) return [fixture, () => {}]
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
useStateCall = 0
const tree = wrapper.type({})
const json = JSON.stringify(tree)

assert.equal(tree.props.className, 'sn-root')
assert.ok(json.includes('以后回答先给结论'), '候选文本要显示出来')
assert.ok(json.includes('自动采集'), '自动采集的候选要标出来源')
assert.ok(json.includes('出现 4 次'), '要显示出现次数')
assert.ok(json.includes('session-abc'), '手动提交的仍显示 citation')
assert.ok(!json.includes('undefined'), '渲染结果里不该出现 undefined')
console.log('1. 有自动采集候选时也能正常渲染（不再白板）')

console.log('\n1 项通过')
process.exit(0)
