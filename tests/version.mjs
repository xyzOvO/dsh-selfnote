/**
 * 版本号只有一个来源：package.json。
 *
 * 发版时最容易出的错不是代码坏了，是「README 写 0.14.4、npm 是 0.14.5、设置页写 0.14.3」——
 * 三处各写一个字符串，改两处漏一处没人发现。这条测试把三处钉在一起，
 * 不一致就红在发版之前，而不是红在用户嘴里。
 *
 * 跑法：node tests/version.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/* 1. package.json 自己得像个版本号 */
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json 的 version 要写成 x.y.z')

/* 2. README 徽章跟着 package.json 走 */
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const badges = [...readme.matchAll(/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-/g)].map((m) => m[1])
assert.ok(badges.length > 0, 'README 里应该有 version 徽章')
for (const badge of badges) assert.equal(badge, pkg.version, `README 徽章写的是 ${badge}，package.json 是 ${pkg.version}`)

/* 3. lib/ 里不许再手写版本号 —— 一律 import VERSION */
const libDir = new URL('../lib/', import.meta.url)
const offenders = []
for (const name of readdirSync(libDir)) {
  if (!name.endsWith('.js')) continue
  const text = readFileSync(new URL(name, libDir), 'utf8')
  // 允许出现的是模块内部的数据格式版本（INDEX_VERSION / CACHE_VERSION），不是发行版本号
  const hits = [...text.matchAll(/['"`](\d+\.\d+\.\d+)['"`]/g)].map((m) => m[1])
  for (const hit of hits) {
    // 只认「像发行版本号且等于当前版本」的那种写死；数据格式版本号不受管
    if (hit === pkg.version) offenders.push(`lib/${name} 写死了 ${hit}`)
  }
}
assert.deepEqual(offenders, [], '这些地方别手写发行版本号，改成 import { VERSION }：\n' + offenders.join('\n'))

/* 4. 运行期读出来的版本要和文件一致（readPackageVersion 的返回值就是它） */
const { VERSION } = await import('../lib/index.js')
assert.equal(VERSION, pkg.version, 'VERSION 必须等于 package.json 的 version')

console.log(`版本号一致性：package.json / README 徽章 / VERSION 三处都是 ${pkg.version}`)
console.log(`（根目录 ${root}）`)
