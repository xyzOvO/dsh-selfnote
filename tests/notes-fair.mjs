/**
 * 自述段公平轮换：老条目不能被新条目永久挡住。
 * 跑法：node tests/notes-fair.mjs
 *
 * 要守住的七件事：
 *   1. 久没露面的稳定条目能轮到一次
 *   2. 置顶（pin）永远在，且不靠冷门名额
 *   3. 没有历史时退化成「新的先进」，不搞乱序
 *   4. 冷门首选太长装不下就试下一条，不能堵死
 *   5. 预算极小时不能把整段变成空的
 *   6. 身份：有 key 用 key，手写的按正文哈希，改字算新条目
 *   7. 临时条的保底份额还在
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-notefair-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
mkdirSync(join(dir, 'memory'), { recursive: true })

const mod = await import('../lib/index.js')
const { packNotesFair, noteIdOf } = mod

const pad = (n) => '字'.repeat(Math.max(0, n))
/** 造一条长度恰为 len 的稳定自述 */
function mk(label, len = 20, extra = {}) {
  const head = label + '：'
  const text = (head + pad(len - head.length)).slice(0, len)
  return { date: '2026-11-01', text, tier: 'stable', pin: false, key: '', ...extra }
}

/* ---------------- 1. 久没露面的条目能轮到 ---------------- */

{
  const entries = Array.from({ length: 12 }, (_, i) => mk('N' + String(i).padStart(2, '0')))
  // 写入顺序：N00 最老 …… N11 最新。最近进过注入的是最新那 8 条。
  const recently = entries.slice(4).map((entry) => noteIdOf(entry))
  const fit = packNotesFair(entries, 200, 14, recently)
  const oldest = entries[0].text
  assert.ok(fit.kept.includes(oldest), '最久没露面的那条必须轮到一次：' + JSON.stringify(fit.kept))
  console.log('1. 最久没露面的稳定条目能进注入')
}

/* ---------------- 2. 置顶永远在，且不占冷门名额 ---------------- */

{
  const entries = Array.from({ length: 10 }, (_, i) => mk('M' + String(i).padStart(2, '0')))
  const pinned = mk('PIN', 20, { pin: true })
  const all = entries.concat([pinned])
  const fit = packNotesFair(all, 120, 14, [])
  assert.ok(fit.kept.includes(pinned.text), '置顶条目任何情况下都要在：' + JSON.stringify(fit.kept))
  console.log('2. 置顶条目永远在')
}

/* ---------------- 3. 没有历史时按「新的先进」 ---------------- */

{
  const entries = Array.from({ length: 10 }, (_, i) => mk('F' + String(i).padStart(2, '0')))
  const fit = packNotesFair(entries, 63, 14, [])
  // 没有历史时：头部给最新的，预留位给「最老且没进过」的那条 —— 老条先露脸
  assert.deepEqual(fit.kept, [entries[9].text, entries[8].text, entries[0].text], '没历史时头部新→旧、预留位给最老的一条：' + JSON.stringify(fit.kept))
  console.log('3. 没有历史时退化成新→旧')
}

/* ---------------- 4. 冷门首选超长就试下一条 ---------------- */

{
  const huge = mk('HUGE', 120)
  const small = mk('SMALL', 20)
  const fresh = Array.from({ length: 6 }, (_, i) => mk('G' + String(i).padStart(2, '0')))
  const entries = [huge, small, ...fresh]
  const fit = packNotesFair(entries, 200, 14, fresh.map((entry) => noteIdOf(entry)))
  assert.ok(fit.kept.includes(small.text), '超长的冷门条目不能把预留位堵死：' + JSON.stringify(fit.kept))
  assert.equal(fit.kept.includes(huge.text), false, '装不下的那条不该硬塞')
  console.log('4. 冷门首选超长时不会堵死预留位')
}

/* ---------------- 5. 预算极小时不能变空段 ---------------- */

{
  const entries = [mk('X1', 25), mk('X2', 25)]
  const fit = packNotesFair(entries, 30, 14, [])
  assert.ok(fit.kept.length >= 1, '预算小的时候也要装进一条，不能空段：' + JSON.stringify(fit))
  console.log('5. 预算极小时退化成正正常常的装填')
}

/* ---------------- 6. 身份口径 ---------------- */

{
  assert.equal(noteIdOf({ text: 'x', key: 'readme.update_scope' }), 'readme.update_scope', '有 key 用 key')
  const a = noteIdOf({ text: '同一句话' })
  const b = noteIdOf({ text: '同一句话' })
  const c = noteIdOf({ text: '改了一个字' })
  assert.match(a, /^sha1:[0-9a-f]{12}$/, '手写的按正文哈希：' + a)
  assert.equal(a, b, '同文同身份')
  assert.notEqual(a, c, '改字算新条目')
  console.log('6. 身份：key 优先，否则正文哈希')
}

/* ---------------- 7. 临时条保底还在 ---------------- */

{
  const stable = Array.from({ length: 8 }, (_, i) => mk('T' + String(i).padStart(2, '0')))
  const temp = { date: '2026-11-28', text: '今晚早点睡', tier: 'temp', pin: false, key: '' }
  const fit = packNotesFair(stable.concat([temp]), 200, 14, [])
  assert.ok(fit.kept.includes(temp.text), '临时条目的保底份额不能被轮换吃掉：' + JSON.stringify(fit.kept))
  console.log('7. 临时条保底仍在')
}

/* ---------------- 8. 接进装配：轮换真的在重建时换了人 ---------------- */

{
  const store = await import('../lib/store.js')
  const memory = await import('../lib/memory.js')
  const captured = { contexts: [] }
  const ctx = {
    logger: { info: () => {} },
    on: () => {},
    systemPrompt: { context(def) { captured.contexts.push(def); return () => {} } },
    tools: { register() { return () => {} } },
  }
  mod.apply(ctx, { enabled: true })
  const inject = captured.contexts[0].text
  const limits = { maxChars: 100000, maxEntries: 500 }
  const write = (label, len = 25) => {
    const head = label + '：'
    store.appendNote((head + pad(len - head.length)).slice(0, len), limits, { tier: 'stable' })
  }
  for (let i = 0; i < 12; i += 1) write('R' + String(i).padStart(2, '0'))

  inject()
  const first = memory.readState()?.injectedNoteIds ?? []
  assert.ok(first.length >= 2, '注入成功后要记下进过哪些自述：' + JSON.stringify(first))

  // 再写一条，强制缓存键变化 → 重建 → 轮换应当换进一条上次没进的
  write('R12')
  inject()
  const second = memory.readState()?.injectedNoteIds ?? []
  const rotated = second.filter((id) => !first.includes(id))
  assert.ok(rotated.length >= 1, '重建时应当轮进上次没露面的条目：' + JSON.stringify({ first, second }))
  console.log('8. 接进装配后，重建时真的轮换了条目')
}

console.log('\n8 项全部通过')
process.exit(0)
