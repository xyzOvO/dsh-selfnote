/**
 * 批5 UX 客观项回归（主观布局/命名不在此，留给 OW 拍板）。
 * 锁三个可验证不变量：
 *   1. 新用户引导 sn-intro 默认展开（审计标 Important：默认收起等于没有）
 *   2. intro 预算行和概览预算条一致，都列话题段（批1 补了预算条，这段文案漏了）
 *   3. intro 有名词速查，消除「门牌/素材层/采纳/退役」术语墙
 * 手法：源码结构断言——这几项本质是文案/JSX，没有「逻辑等价重构」的空间，仓库批4 已有同风格。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

assert.match(src, /className: 'sn-intro',\s*open: true/, '新用户引导 intro 要默认展开')
assert.match(src, /\/ 话题 ' \+ caps\.topic/, 'intro 预算行要列话题段，和概览预算条口径一致')
assert.match(src, /名词速查/, 'intro 要有名词速查，消除术语墙')

console.log('批5 UX 客观项：intro 默认展开 / 预算含话题 / 名词速查')
