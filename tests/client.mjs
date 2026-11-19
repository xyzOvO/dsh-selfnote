/**
 * 浏览器半侧的冒烟测试：在 node 里 stub 掉 window / document / React，把 bundle 跑起来，
 * 检查它注册的 slot、label、CSS，以及没连上宿主时的首屏渲染。
 * 跑法：node tests/client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let loaded = null

globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      loaded = def
    },
  },
}

const styles = []
globalThis.document = {
  createElement(tag) {
    return { tag, id: '', textContent: '', remove() { this.removed = true } }
  },
  head: {
    appendChild(node) {
      styles.push(node)
    },
  },
}

/* 一个够用的 React 替身：createElement 造普通对象，hooks 给最简实现。 */
function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat() }
}

const React = {
  createElement,
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
}

const require = (id) => {
  if (id === 'react') return React
  throw new Error('未知模块：' + id)
}

await import('../lib/client.js')

assert.ok(loaded, 'bundle 没有调用 __ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-selfnote')

const mod = loaded.factory(require)
assert.equal(mod.name, 'selfnote')
assert.deepEqual(mod.inject, ['slots', 'layout'])
assert.equal(typeof mod.apply, 'function')

/* ---------- apply：CSS + slot ---------- */

let effectFn = null
const registered = []
const injected = {}
const ctx = {
  effect(fn, label) {
    assert.match(label, /styles/)
    effectFn = fn
  },
  layout: {
    selectPanel() {},
  },
  slots: {
    inject(name, fn) {
      injected[name] = fn()
    },
    register(meta, Component) {
      registered.push({ meta, Component })
      return () => {}
    },
  },
}

mod.apply(ctx)

assert.equal(registered.length, 3)
const slot = registered.find(function (item) { return item.meta.name === 'settings.section' })
assert.ok(slot, '缺少 settings.section 注册')
assert.equal(slot.meta.id, 'selfnote')
assert.equal(slot.meta.order, 48)
assert.equal(slot.meta.label(), '人格（自述）')
assert.equal(typeof slot.Component, 'function')

const sidebar = registered.find(function (item) { return item.meta.name === 'sidebar.panellist' })
assert.ok(sidebar, '缺少 sidebar.panellist 注册')
assert.equal(sidebar.meta.id, 'selfnote-memory-confirm')
assert.equal(sidebar.meta.order, 10)
assert.equal(sidebar.meta.label(), '记忆确认')
assert.equal(typeof sidebar.Component, 'function')

const main = registered.find(function (item) { return item.meta.name === 'main' })
assert.ok(main, '缺少 main 注册')
assert.equal(main.meta.key, 'selfnote-memory-confirm')
assert.equal(main.meta.key, sidebar.meta.id)
assert.equal(typeof main.Component, 'function')

assert.equal(typeof injected['sidebar.panellist'], 'function', '侧栏注册的 disposer 未交还')
assert.equal(typeof injected['main'], 'function', '主区面板注册的 disposer 未交还')

/* ---------- CSS ---------- */

const dispose = effectFn()
assert.equal(styles.length, 1)
assert.ok(styles[0].textContent.includes('.sn-root'))
assert.ok(styles[0].textContent.includes('.sn-notice-warn'))
assert.ok(styles[0].textContent.length > 1500, 'CSS 太短，可能没加载全')
dispose()
assert.equal(styles[0].removed, true)
console.log('1. slot 注册、label、CSS 注入与清理都正常（CSS ' + styles[0].textContent.length + ' 字符）')

/* ---------- 未连上宿主时的首屏 ---------- */

const wrapper = slot.Component({})
assert.equal(typeof wrapper.type, 'function', 'slot 组件应包一层 SelfNoteSection')
const tree = wrapper.type({})
assert.equal(tree.type, 'div')
assert.equal(tree.props.className, 'sn-root')
const inner = tree.children[0]
assert.equal(inner.type, 'div')
assert.equal(inner.props.className, 'sn-loading')
assert.match(inner.children.join(''), /读取中/)
assert.doesNotMatch(inner.children.join(''), /重启 DSH/, '首帧不该先闪一句重启')
console.log('2. 没有状态时先显示「读取中…」，不闪「重启 DSH」')

/* ---------- 体检六组：默认收起 ---------- */

// 收起是用户的手，不是程序的手：docOpenOf 不许按 level 自动展开任何一组。
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const openFn = clientSrc.match(/var docOpenOf = function \(group\) \{[\s\S]*?\n      \}/)
assert.ok(openFn, '找不到 docOpenOf，折叠逻辑被改动了')
assert.doesNotMatch(openFn[0], /'warn'|'error'/, '体检六组默认全收起，不许按 level 自动展开')
console.log('3. 体检六组默认收起，只有点开才展开')

/* ---------- 侧栏确认页：Review Focus 五条 ---------- */
// 用第二个 factory 实例 + 专用 React 替身，避免污染上面设置页的首屏断言。
window.__DSH_SELFNOTE_TOKEN__ = 'test-token'

let fetchCalls = []
let fetchMode = 'ok'
let fetchState = { facts: { candidates: [] } }
let confirmInitial = [null, '']
let captured = []
let useStateIndex = 0
let effectFired = false

globalThis.fetch = async function (url, init) {
  fetchCalls.push({ url: url, init: init })
  if (fetchMode === 'readFail') {
    return { ok: false, status: 403, text: async () => JSON.stringify({ error: 'forbidden' }) }
  }
  if (fetchMode === 'writeFail' && init && init.method === 'POST') {
    return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'boom' }) }
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(fetchState) }
}

const ReactConfirm = {
  createElement,
  useState(initial) {
    const i = useStateIndex++
    const base = i < confirmInitial.length
      ? confirmInitial[i]
      : (typeof initial === 'function' ? initial() : initial)
    return [
      Object.prototype.hasOwnProperty.call(captured, i) ? captured[i] : base,
      function (v) { captured[i] = typeof v === 'function' ? v(captured[i]) : v },
    ]
  },
  useEffect(fn) {
    // 真实 React 里 [] 依赖只跑一次；替身同样只跑首帧。
    if (!effectFired) { effectFired = true; fn() }
  },
  useCallback(fn) { return fn },
}

const registeredConfirm = []
const modConfirm = loaded.factory((id) => {
  if (id === 'react') return ReactConfirm
  throw new Error('未知模块：' + id)
})
modConfirm.apply({
  effect() {},
  layout: { selectPanel() {} },
  slots: {
    inject(name, fn) { fn() },
    register(meta, C) { registeredConfirm.push({ meta: meta, Component: C }); return () => {} },
  },
})
const Confirm = registeredConfirm.find(function (r) { return r.meta.name === 'main' }).Component

function settle() {
  return new Promise(function (resolve) { setImmediate(function () { setImmediate(resolve) }) })
}
function rerender() {
  useStateIndex = 0
  return Confirm({})
}
async function renderConfirm(initialState, initialNotice) {
  fetchCalls = []
  confirmInitial = [initialState === undefined ? null : initialState, initialNotice || '']
  captured = []
  useStateIndex = 0
  effectFired = false
  Confirm({})
  await settle()
  return rerender()
}

function flattenTree(node, out) {
  out = out || []
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ __text: String(node) })
    return out
  }
  if (Array.isArray(node)) { node.forEach(function (n) { flattenTree(n, out) }); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  if (typeof node.type === 'function') {
    try { flattenTree(node.type(node.props || {}), out) } catch (e) {}
  }
  ;(node.children || []).forEach(function (c) { flattenTree(c, out) })
  return out
}
function treeText(tree) {
  return flattenTree(tree)
    .filter(function (n) { return '__text' in n })
    .map(function (n) { return n.__text })
    .join(' ')
}
function walkTree(root, visit) {
  function walk(n) {
    if (n === null || n === undefined || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n.type === 'function') { try { walk(n.type(n.props || {})) } catch (e) {} }
    visit(n)
    ;(n.children || []).forEach(walk)
  }
  walk(root)
}
function findButtons(root) {
  const out = []
  walkTree(root, function (n) { if (n.type === 'button') out.push(n) })
  return out
}
function findConfirmItems(root) {
  const out = []
  walkTree(root, function (n) {
    if (n.props && typeof n.props.className === 'string' &&
        n.props.className.indexOf('sn-confirm-item') >= 0) out.push(n)
  })
  return out
}

fetchMode = 'ok'
fetchState = { facts: { candidates: [] } }
let confirmTree = await renderConfirm(undefined, '')
assert.ok(treeText(confirmTree).includes('现在没有需要你确认的记忆'), '空态文案缺失')
assert.equal(findButtons(confirmTree).length, 0, '空态不该有「记住 / 不记」按钮')
console.log('4. 空候选显示空态，无操作按钮')

fetchMode = 'readFail'
confirmTree = await renderConfirm(undefined, '')
assert.ok(treeText(confirmTree).includes('读取失败'), '读失败要有提示')
assert.ok(!treeText(confirmTree).includes('读取中'), '读失败不该停在「读取中…」')
console.log('5. /state 读失败有提示，不白屏、不卡读取中')

fetchMode = 'ok'
fetchState = { facts: { candidates: [{ id: 'x', text: '文本X' }] } }
confirmTree = await renderConfirm(undefined, '')
assert.ok(treeText(confirmTree).includes('出处未知'), '出处缺失要有兜底文案')
console.log('6. 出处缺失显示「出处未知」')

fetchState = {
  facts: {
    candidates: [
      { id: 'a', text: '文本A', citation: { sessionId: 's', index: 1 }, triggers: ['prefer'] },
      { id: 'b', text: '文本B' },
    ],
  },
}
confirmTree = await renderConfirm(undefined, '')
const items = findConfirmItems(confirmTree)
assert.equal(items.length, 2, '两条候选应有两张卡')
const itemA = items.find(function (it) { return treeText(it).includes('文本A') })
const itemB = items.find(function (it) { return treeText(it).includes('文本B') })
assert.ok(itemA && itemB, '找不到 A / B 两张卡')
assert.ok(treeText(itemA).includes('← s 第 1 条'), '出处串要含 sessionId 与序号')
findButtons(itemA)[0].props.onClick()
await settle()
let last = fetchCalls[fetchCalls.length - 1]
assert.equal(last.init.method, 'POST')
assert.equal(last.init.headers['x-selfnote'], 'test-token')
assert.deepEqual(JSON.parse(last.init.body), { id: 'a', status: 'approved' })
findButtons(itemB)[1].props.onClick()
await settle()
last = fetchCalls[fetchCalls.length - 1]
assert.deepEqual(JSON.parse(last.init.body), { id: 'b', status: 'retired' })
console.log('7. 「记住 / 不记」status 映射精确，出处串带行号')

fetchMode = 'writeFail'
fetchState = { facts: { candidates: [{ id: 'x', text: '文本X' }] } }
confirmTree = await renderConfirm(undefined, '')
findButtons(findConfirmItems(confirmTree)[0])[0].props.onClick()
await settle()
assert.ok(treeText(rerender()).includes('没改成'), '写失败要有提示，不假装成功')
assert.ok(!treeText(rerender()).includes('已记住'), '写失败不该出现成功提示')
console.log('8. 写失败显示失败提示，不假装成功')

console.log('\n8 项全部通过')
process.exit(0)
