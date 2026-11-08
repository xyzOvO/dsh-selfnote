/**
 * 原子写的 rename 重试策略（回归 test:accept 的 Windows 抖动）。
 *
 * Windows 没有 POSIX「覆盖正被打开的文件」语义：多进程硬写同一份 facts.jsonl 时，
 * renameSync 会偶发 EPERM/EBUSY。旧版 writeAtomic 只 rename 一次直接失败，
 * 于是 36 进程压力阶段偶发 `EPERM: rename facts.jsonl.tmp-* -> facts.jsonl`。
 *
 * 这里测的是重试策略本身（生产代码在用的那个纯函数），operation 用闭包替身：
 * 只验证「瞬态错误重试、非瞬态错误立刻抛、耗尽次数后抛最后的错」这三件事。
 *
 * 跑法：node tests/atomic-retry.mjs
 */
import assert from 'node:assert/strict'
import { isTransientFsError, retryOnTransient } from '../lib/atomic.js'

const mkErr = (code) => Object.assign(new Error(code), { code })
const noSleep = () => {}

/* 1. 前两次 EPERM、第三次成功 → 返回结果，共调用 3 次 */
{
  let calls = 0
  const out = retryOnTransient(() => {
    calls += 1
    if (calls <= 2) throw mkErr('EPERM')
    return 'ok'
  }, { sleep: noSleep })
  assert.equal(out, 'ok', '瞬时冲突消化掉之后要把成功结果交回去')
  assert.equal(calls, 3, 'EPERM 应该重试而不是一次就放弃')
}
console.log('1. EPERM 连续两次 → 重试到成功')

/* 2. EBUSY 同样算瞬态 */
{
  let calls = 0
  const out = retryOnTransient(() => {
    calls += 1
    if (calls < 2) throw mkErr('EBUSY')
    return 1
  }, { sleep: noSleep })
  assert.equal(out, 1)
  assert.equal(calls, 2)
}
console.log('2. EBUSY 也重试')

/* 3. 非瞬态错误（ENOENT）不重试，立刻原样抛 */
{
  let calls = 0
  assert.throws(
    () => retryOnTransient(() => { calls += 1; throw mkErr('ENOENT') }, { sleep: noSleep }),
    /ENOENT/,
  )
  assert.equal(calls, 1, '非瞬态错误不该浪费重试次数')
}
console.log('3. ENOENT 等非瞬态错误 → 不重试，立刻抛')

/* 4. 一直冲突 → 试满次数后抛最后一个错，不留半截文件靠外层兜 */
{
  let calls = 0
  assert.throws(
    () => retryOnTransient(() => { calls += 1; throw mkErr('EPERM') }, { delays: [0, 0, 0], sleep: noSleep }),
    /EPERM/,
  )
  assert.equal(calls, 3, '次数要用尽，不能提前放弃也不能无限重试')
}
console.log('4. 冲突不消失 → 用尽次数后抛最后一个错')

/* 5. 判定表：只认 Windows 文件占用那几个码 */
assert.equal(isTransientFsError(mkErr('EPERM')), true)
assert.equal(isTransientFsError(mkErr('EBUSY')), true)
assert.equal(isTransientFsError(mkErr('EACCES')), true)
assert.equal(isTransientFsError(mkErr('ENOENT')), false)
assert.equal(isTransientFsError(new Error('boom')), false)
assert.equal(isTransientFsError(null), false)
console.log('5. 瞬态码判定表正确')

console.log('\n5 项全部通过')
