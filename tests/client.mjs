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
assert.equal(slot.meta.label(), 'AI 记忆')
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
{
  const rules = styles[0].textContent
  const m = rules.match(/\.sn-confirm\{[^}]*\}/)
  assert.ok(m, '确认页根容器 .sn-confirm 样式要存在')
  assert.match(m[0], /overflow-y:\s*auto/, '确认页要能滚动，否则底部按钮被裁切看不见')
  assert.match(m[0], /min-height:\s*0/, 'flex 子项要 min-height:0 才能收缩出滚动区')
  assert.match(m[0], /box-sizing:\s*border-box/, 'padding 要计入高度，避免溢出窗口')
  assert.match(m[0], /height:\s*100%|max-height:/, '要有高度约束，光有 overflow-y 也滚不起来')
}
{
  const noticeRule = styles[0].textContent.match(/\.sn-confirm \.sn-notice\{[^}]*\}/)
  assert.ok(noticeRule, '确认页提示要有独立的吸顶样式，否则在下方操作时看不见')
  assert.match(noticeRule[0], /position:\s*sticky/, '提示要吸顶，滚动到下方操作时反馈也看得见')
  assert.match(noticeRule[0], /z-index:/, '提示要浮在内容之上，不被卡片盖住')
}
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
async function renderConfirmFresh(initialState, initialNotice) {
  fetchCalls = []
  confirmInitial = [initialState === undefined ? null : initialState, initialNotice || '']
  captured = []
  useStateIndex = 0
  effectFired = false
  Confirm({})
  await settle()
  captured = []
  confirmInitial = [initialState === undefined ? null : initialState, initialNotice || '']
  useStateIndex = 0
  return Confirm({})
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
function findValidityCards(root) {
  const out = []
  walkTree(root, function (n) {
    if (n.props && typeof n.props.className === 'string' &&
        n.props.className.indexOf('sn-validity-item') >= 0) out.push(n)
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
assert.ok(treeText(confirmTree).includes('新记忆｜AI 刚想到的'), '新记忆卡要有明确标签')
assert.ok(treeText(confirmTree).includes('这些是 AI 新想到的，要不要记下来？'), '新记忆卡标题要说清是刚想到的')
assert.ok(treeText(itemA).includes('记下来'), '按钮改成「记下来」')
assert.ok(treeText(itemA).includes('不记了'), '按钮改成「不记了」')
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
assert.ok(!treeText(rerender()).includes('记下了'), '写失败不该出现成功提示')
console.log('8. 写失败显示失败提示，不假装成功')

/* ---------- 侧栏确认页：疑似作废卡 ---------- */
fetchMode = 'ok'
const validityState = {
  facts: {
    candidates: [{ id: 'normal', text: '普通候选' }],
  },
  validity: {
    cards: [
      {
        key: 'sig-1',
        quote: '别再提旧地址了',
        at: 123,
        source: 's1#7',
        candidates: [
          { id: 'old-1', text: '住在旧地址' },
          { id: 'old-2', text: '旧地址门牌号' },
        ],
      },
      {
        key: 'sig-2',
        quote: '改成新的吧',
        at: 456,
        source: 's2#9',
        candidates: [{ id: 'old-3', text: '旧偏好' }],
      },
    ],
  },
}
confirmTree = await renderConfirmFresh(validityState, '')
const validityCards = findValidityCards(confirmTree)
assert.equal(validityCards.length, 2, '两张疑似作废卡都要渲染')
assert.ok(treeText(confirmTree).includes('别再提旧地址了'), '卡上要列本人原话 quote')
assert.ok(treeText(confirmTree).includes('住在旧地址'), '卡上要列候选 text')
assert.ok(treeText(confirmTree).includes('旧地址门牌号'), '卡上要列每个候选 text')
assert.ok(treeText(confirmTree).includes('改成新的吧'), '第二张卡也要列原话')
assert.ok(treeText(confirmTree).includes('旧记忆｜还作数吗？'), '旧记忆卡要有明确标签')
assert.ok(treeText(confirmTree).includes('这些是以前记下的，现在还作数吗？'), '旧记忆卡标题要说清是旧的')
assert.ok(treeText(validityCards[0]).includes('这几条都不处理'), '卡级兜底文案缺失')

const firstCardButtons = findButtons(validityCards[0])
const retireBtn = firstCardButtons.find(function (b) { return treeText(b).includes('不当数了') })
const keepBtn = firstCardButtons.find(function (b) { return treeText(b).includes('还作数') })
const anyBtn = firstCardButtons.find(function (b) { return treeText(b).includes('这几条都不处理') })
assert.ok(retireBtn && keepBtn && anyBtn, '每个候选应有不当数了/还作数，卡上要有兜底按钮')
retireBtn.props.onClick()
await settle()
let validityPost = fetchCalls[fetchCalls.length - 1]
assert.ok(validityPost.url.endsWith('/fact'), '动作应发往 /fact')
assert.equal(validityPost.init.method, 'POST')
assert.deepEqual(JSON.parse(validityPost.init.body), {
  action: 'validity-retire', id: 'old-1', signal: 'sig-1',
})
keepBtn.props.onClick()
await settle()
validityPost = fetchCalls[fetchCalls.length - 1]
assert.deepEqual(JSON.parse(validityPost.init.body), {
  action: 'validity-keep', id: 'old-1', signal: 'sig-1',
})
anyBtn.props.onClick()
await settle()
validityPost = fetchCalls[fetchCalls.length - 1]
assert.deepEqual(JSON.parse(validityPost.init.body), {
  action: 'validity-any', signal: 'sig-1',
})

const quietNodes = []
walkTree(confirmTree, function (n) {
  if (!n || !n.props) return
  const cls = typeof n.props.className === 'string' ? n.props.className : ''
  if (n.props.role === 'alert' || n.props['aria-live'] === 'alert' ||
      n.props['aria-live'] === 'assertive' || /dot|notification|toast|modal|popup/.test(cls)) {
    quietNodes.push(n)
  }
})
assert.equal(quietNodes.length, 0, '卡只生成不提醒，不能出现红点/alert/通知节点')

confirmTree = await renderConfirmFresh({ facts: { candidates: [] }, validity: { cards: [] } }, '')
assert.equal(findValidityCards(confirmTree).length, 0, '空 cards 不该渲染作废卡区')
assert.ok(!treeText(confirmTree).includes('这几条都不处理'), '空 cards 不打扰')
console.log('13. 疑似作废卡静默渲染，三类动作与空态都正确')

/* ---------- 侧栏确认页：常驻操作折叠区 ---------- */
confirmTree = await renderConfirmFresh(
  { facts: { candidates: [], approved: [], retired: [] }, validity: { cards: [] }, injection: { segments: [] } }, '')
assert.ok(treeText(confirmTree).includes('没进注入的'), '空态也要有折叠区A')
assert.ok(treeText(confirmTree).includes('已记住的'), '空态也要有折叠区B')
assert.ok(treeText(confirmTree).includes('已退役的'), '空态也要有折叠区C')
const opsDetails = []
walkTree(confirmTree, function (n) { if (n.type === 'details') opsDetails.push(n) })
assert.ok(opsDetails.length >= 3, '三个折叠区都是原生 details')
assert.ok(opsDetails.every(function (d) { return !d.props || !d.props.open }), '折叠区默认收起')
assert.ok(!treeText(confirmTree).includes('左下角齿轮 → AI 记忆 → 记忆'), '旧空态指引已删')
console.log('14. 空态也常驻三个折叠区，默认收起，旧齿轮指引已删')

/* ---------- 侧栏确认页：折叠区内三个动作 ---------- */
function findByClass(root, cls) {
  const out = []
  walkTree(root, function (n) {
    if (n.props && typeof n.props.className === 'string' && n.props.className.indexOf(cls) >= 0) out.push(n)
  })
  return out
}
function findInputs(root) {
  const out = []
  walkTree(root, function (n) { if (n.type === 'input') out.push(n) })
  return out
}
function buttonIn(root, label) {
  return findButtons(root).find(function (b) { return treeText(b).includes(label) })
}

// A 区唯一命中：skipped preview 精确命中某 approved 事实 → 展开预填输入框 → 改正文发 POST
fetchMode = 'ok'
const opsState = {
  facts: {
    candidates: [],
    approved: [{ id: 'f1', text: '回复别太长，不硬缩' }],
    retired: [{ id: 'f3', text: '旧规则已退役' }],
  },
  validity: { cards: [] },
  injection: { segments: [{ key: 'facts', label: '结论', skippedDetail: [
    { id: 'facts:abc', preview: '回复别太长，不硬缩', reason: 'budget' },
  ] }] },
}
let opsTree = await renderConfirmFresh(opsState, '')
const aBtn = buttonIn(findByClass(opsTree, 'sn-ops-skipped')[0], '改这条')
assert.ok(aBtn, 'A 区要有「改这条」按钮')
aBtn.props.onClick()
opsTree = rerender()
const aInput = findInputs(findByClass(opsTree, 'sn-ops-skipped')[0])[0]
assert.ok(aInput, '点改这条后要展开输入框')
assert.equal(aInput.props.value, '回复别太长，不硬缩', '输入框预填命中事实原文')
aInput.props.onChange({ target: { value: '中文照常说' } })
opsTree = rerender()
assert.equal(findInputs(findByClass(opsTree, 'sn-ops-skipped')[0])[0].props.value, '中文照常说', '草稿写入后可重渲染')
buttonIn(findByClass(opsTree, 'sn-ops-skipped')[0], '改好了').props.onClick()
await settle()
let opsPost = fetchCalls[fetchCalls.length - 1]
assert.ok(opsPost.url.endsWith('/fact'), '改正文发往 /fact')
assert.deepEqual(JSON.parse(opsPost.init.body), { id: 'f1', text: '中文照常说' })

// A 区多命中：两条 approved 同文 → 列候选让人选，不自动发 POST
const dupState = {
  facts: { candidates: [], approved: [
    { id: 'd1', text: '同文规则甲乙' }, { id: 'd2', text: '同文规则甲乙' },
  ], retired: [] },
  validity: { cards: [] },
  injection: { segments: [{ key: 'facts', label: '结论', skippedDetail: [
    { id: 'facts:xyz', preview: '同文规则甲乙', reason: 'budget' },
  ] }] },
}
let dupTree = await renderConfirmFresh(dupState, '')
const beforeDup = fetchCalls.length
buttonIn(findByClass(dupTree, 'sn-ops-skipped')[0], '改这条').props.onClick()
dupTree = rerender()
assert.ok(treeText(findByClass(dupTree, 'sn-ops-skipped')[0]).includes('选一条'), '多命中要列候选让人选')
assert.equal(fetchCalls.length, beforeDup, '多命中不能自动发 POST')
// 点候选后进入编辑态、改字、提交——完整链路（复审 Minor 缺口）
const pickBtn = findButtons(findByClass(dupTree, 'sn-ops-skipped')[0]).find(function (b) { return treeText(b).includes('同文规则甲乙') })
assert.ok(pickBtn, '候选按钮要能点到')
pickBtn.props.onClick()
dupTree = rerender()
const dupInput = findInputs(findByClass(dupTree, 'sn-ops-skipped')[0])[0]
assert.ok(dupInput, '点候选后要展开输入框')
dupInput.props.onChange({ target: { value: '选定的新正文' } })
dupTree = rerender()
buttonIn(findByClass(dupTree, 'sn-ops-skipped')[0], '改好了').props.onClick()
await settle()
assert.deepEqual(JSON.parse(fetchCalls[fetchCalls.length - 1].init.body), { id: 'd1', text: '选定的新正文' }, '候选走完整链路改第一条')

// A 区零命中：提示去设置页，不发 POST
const zeroState = {
  facts: { candidates: [], approved: [{ id: 'f1', text: '完全不同的内容' }], retired: [] },
  validity: { cards: [] },
  injection: { segments: [{ key: 'facts', label: '结论', skippedDetail: [
    { id: 'facts:zzz', preview: '找不到的预览', reason: 'budget' },
  ] }] },
}
let zeroTree = await renderConfirmFresh(zeroState, '')
const beforeZero = fetchCalls.length
buttonIn(findByClass(zeroTree, 'sn-ops-skipped')[0], '改这条').props.onClick()
zeroTree = rerender()
assert.ok(treeText(zeroTree).includes('这条不在最近记录里'), '零命中要提示')
assert.equal(fetchCalls.length, beforeZero, '零命中不发 POST')

// B 区：空草稿被拦，非空才发 POST
let bTree = await renderConfirmFresh(opsState, '')
buttonIn(findByClass(bTree, 'sn-ops-approved')[0], '改文字').props.onClick()
bTree = rerender()
findInputs(findByClass(bTree, 'sn-ops-approved')[0])[0].props.onChange({ target: { value: '   ' } })
bTree = rerender()
const beforeBlank = fetchCalls.length
buttonIn(findByClass(bTree, 'sn-ops-approved')[0], '改好了').props.onClick()
await settle()
assert.equal(fetchCalls.length, beforeBlank, '空草稿不发 POST')
findInputs(findByClass(bTree, 'sn-ops-approved')[0])[0].props.onChange({ target: { value: '新正文' } })
bTree = rerender()
buttonIn(findByClass(bTree, 'sn-ops-approved')[0], '改好了').props.onClick()
await settle()
assert.deepEqual(JSON.parse(fetchCalls[fetchCalls.length - 1].init.body), { id: 'f1', text: '新正文' })

// C 区：恢复发 status:'approved'
let cTree = await renderConfirmFresh(opsState, '')
buttonIn(findByClass(cTree, 'sn-ops-retired')[0], '恢复').props.onClick()
await settle()
assert.deepEqual(JSON.parse(fetchCalls[fetchCalls.length - 1].init.body), { id: 'f3', status: 'approved' })
console.log('15. 折叠区三动作：精确改正文/多命中消歧/零命中/空草稿拦截/恢复')

/* ---------- 页签内跳过提醒 ---------- */
let sState, sTab, sIdx, sSetters
const ReactSettings = {
  createElement,
  useState(initial) {
    const i = sIdx++
    if (i === 0) return [sState, () => {}]
    if (i === 8) return [sTab, () => {}]
    if (i === 9) return [true, () => {}]
    return [typeof initial === 'function' ? initial() : initial,
            function (v) { sSetters[i] = v }]
  },
  useEffect() {},
  useCallback(fn) { return fn },
}
const registeredSettings = []
const modSettings = loaded.factory((id) => {
  if (id === 'react') return ReactSettings
  throw new Error('未知模块：' + id)
})
modSettings.apply({
  effect() {}, layout: { selectPanel() {} },
  slots: { inject(name, fn) { fn() },
           register(meta, C) { registeredSettings.push({ meta, Component: C }); return () => {} } },
})
const SettingsComp = registeredSettings.find(function (r) { return r.meta.name === 'settings.section' }).Component
function renderSettings(state, tab) {
  sState = state; sTab = tab; sIdx = 0; sSetters = {}
  const wrapper = SettingsComp({})
  return wrapper.type(wrapper.props)
}
function seg(key, label, items, legacy) {
  return { key, label, chars: 10, limit: 100,
           skippedDetail: legacy ? undefined : items,
           skipped: legacy ? items.map(function (i) { return typeof i === 'string' ? i : i.text }) : undefined }
}
const skippedState = {
  injection: { chars: 10, limit: 1000, segments: [
    seg('notes', '自述', [{ preview: '长自述文本…', reason: 'budget' }]),
    seg('facts', '结论', [{ preview: '某结论…', reason: 'scope' }]),
    seg('persona', '人格', [{ preview: '某人格行…', reason: 'budget' }]),
    seg('profile', '画像', [{ preview: '某画像行…', reason: 'duplicate' }]),
    seg('preset', '协作默认', [{ preview: '不该出现…', reason: 'budget' }]),
  ] },
  notes: [{ text: '长自述文本全文写在这里', tier: 'stable', date: '2026-01-01' }],
  facts: { candidates: [], approved: [{ id: 'f1', text: '某结论全文写在这里', status: 'approved' }] },
  persona: {}, profile: {}, attribution: {},
}
let st = renderSettings(skippedState, 'notes')
assert.ok(treeText(st).includes('本页有 1 条没进注入'), 'notes 页签缺提醒卡')
assert.ok(treeText(st).includes('预算不足'), '原因标签缺失')
assert.ok(treeText(st).includes('长自述文本…'), '预览缺失')
const goBtns = findButtons(st).filter(function (b) { return treeText(b).includes('去改') })
assert.equal(goBtns.length, 1, '命中应有「去改」')
goBtns[0].props.onClick()
assert.equal(sSetters[14], 0, '「去改」应把第 0 条自述切进编辑态')

const noSkip = JSON.parse(JSON.stringify(skippedState))
noSkip.injection.segments = []
st = renderSettings(noSkip, 'notes')
assert.ok(!treeText(st).includes('本页有'), '无跳过项不该显示卡片')

const legacy = JSON.parse(JSON.stringify(skippedState))
legacy.injection.segments = [seg('notes', '自述', ['旧格式文本'], true)]
st = renderSettings(legacy, 'notes')
assert.ok(treeText(st).includes('旧格式文本') && treeText(st).includes('未说明'), '旧格式应显示未说明')

const many = JSON.parse(JSON.stringify(skippedState))
many.injection.segments = [seg('notes', '自述', Array.from({ length: 8 }, function (_, i) {
  return { preview: '条目' + i, reason: 'budget' }
}))]
st = renderSettings(many, 'notes')
assert.ok(treeText(st).includes('还有 2 条'), '超 6 条要提示剩余')
assert.equal(findButtons(st).filter(function (b) { return treeText(b).includes('去改') }).length, 0, '模糊预览匹配不到不该给按钮')

st = renderSettings(skippedState, 'persona')
assert.ok(treeText(st).includes('某人格行…'), '人格页签缺提醒卡')
assert.equal(findButtons(st).filter(function (b) { return treeText(b).includes('去改') }).length, 0, '人格不该给定位按钮')
st = renderSettings(skippedState, 'memory')
assert.ok(!treeText(st).includes('不该出现…'), 'preset 跳过项不该出现在设置页签')

const memState = JSON.parse(JSON.stringify(skippedState))
memState.injection.segments = [seg('facts', '结论', [{ preview: '某结论全文写在这里…', reason: 'scope' }])]
st = renderSettings(memState, 'memory')
findButtons(st).filter(function (b) { return treeText(b).includes('去改') })[0].props.onClick()
assert.deepEqual(sSetters[17], { id: 'f1', text: '某结论全文写在这里' }, '记忆「去改」应进 factEdit')
console.log('9. 页签内跳过提醒：显示/原因/截断/定位/范围都正常')

/* ---------- 去改：滚动定位到下方编辑框 ---------- */
const located = []
globalThis.document.getElementById = function (id) {
  return {
    id,
    scrollIntoView(opt) { located.push({ kind: 'scroll', id, opt }) },
    classList: {
      add(c) { located.push({ kind: 'add', id, c }) },
      remove() {},
    },
  }
}
st = renderSettings(skippedState, 'notes')
findButtons(st).filter(function (b) { return treeText(b).includes('去改') })[0].props.onClick()
assert.ok(located.some(function (x) { return x.kind === 'scroll' && x.id === 'sn-note-0' }), '「去改」应滚动到下方那条自述')
assert.ok(located.some(function (x) { return x.kind === 'add' && x.id === 'sn-note-0' }), '滚动后应短暂高亮那条')

const memLocated = JSON.parse(JSON.stringify(skippedState))
memLocated.injection.segments = [seg('facts', '结论', [{ preview: '某结论全文写在这里…', reason: 'scope' }])]
st = renderSettings(memLocated, 'memory')
findButtons(st).filter(function (b) { return treeText(b).includes('去改') })[0].props.onClick()
assert.ok(located.some(function (x) { return x.kind === 'scroll' && x.id === 'sn-fact-f1' }), '记忆「去改」应滚动到对应那条')
console.log('10. 「去改」滚动到下方编辑框并短暂高亮')

/* ---------- 导入提示：added 之外的跳过/无效/降级也要报数 ---------- */
const report = {
  added: { facts: 1, notes: 2, habits: 3 },
  skipped: { facts: 4, notes: 5, habits: 6, invalid: 7 },
  demoted: 8,
  droppedNotes: 9,
  keepStatus: false,
  conflicts: 0,
  persona: { action: 'none', file: '' },
  indexStale: true,
  configApplied: 0,
  before: {},
  after: {},
}
const summary = mod.importSummary({ import: report })
assert.ok(summary.includes('加了 1 条记忆、2 条自述、3 个习惯'), '提示要报全三类 added')
assert.ok(summary.includes('跳过 22 条（重复 15 条、无效 7 条）'), '提示要报 skipped 与 invalid')
assert.ok(summary.includes('降回候选 8 条'), '提示要报 demoted')
assert.ok(summary.includes('自述超容量 9 条没放进'), '提示要报 droppedNotes')
console.log('11. 导入提示汇总 added/skipped/demoted/droppedNotes')

/* ---------- 批2 复审：同文冲突也要报数 ---------- */
const conflictSummary = mod.importSummary({ import: { ...report, conflicts: 3 } })
assert.ok(conflictSummary.includes('同文冲突 3 条'), '提示要报 conflicts')
console.log('12. 导入提示补报同文冲突')

console.log('\n12 项全部通过')
