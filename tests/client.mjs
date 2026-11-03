/**
 * 浏览器半侧的冒烟测试：在 node 里 stub 掉 window / document / React，把 bundle 跑起来，
 * 检查它注册的 slot、label、CSS，以及没连上宿主时的首屏渲染。
 * 跑法：node tests/client.mjs
 */

import assert from 'node:assert/strict'

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
assert.deepEqual(mod.inject, ['slots'])
assert.equal(typeof mod.apply, 'function')

/* ---------- apply：CSS + slot ---------- */

let effectFn = null
const registered = []
const ctx = {
  effect(fn, label) {
    assert.match(label, /styles/)
    effectFn = fn
  },
  slots: {
    inject(name, fn) {
      assert.equal(name, 'settings.section')
      fn()
    },
    register(meta, Component) {
      registered.push({ meta, Component })
    },
  },
}

mod.apply(ctx)

assert.equal(registered.length, 1)
const slot = registered[0]
assert.equal(slot.meta.name, 'settings.section')
assert.equal(slot.meta.id, 'selfnote')
assert.equal(slot.meta.order, 48)
assert.equal(slot.meta.label(), '人格（自述）')
assert.equal(typeof slot.Component, 'function')

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
assert.match(inner.children.join(''), /重启 DSH/)
console.log('2. 没有状态时给出「重启 DSH」提示')

console.log('\n2 项全部通过')
process.exit(0)
