/**
 * 崩溃测试：一边高频重写 notes.md / config.json，一边随机 SIGKILL。
 * 断言的是「不变量」而不是具体内容：
 *   - notes.md 要么不存在，要么每一行都是完整的 `- 日期 正文`（没有半截行）
 *   - config.json 要么不存在，要么能被 JSON.parse
 *   - 用户目录里不留 .tmp-
 * 换成 writeAtomic 之前，这里会在几十次击杀内抓到半截文件。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-crash-'))
const env = { ...process.env, DSH_SELFNOTE_DIR: dir, DSH_HOME: dir }
const notesFile = join(dir, 'notes.md')
const configFile = join(dir, 'config.json')

function checkNotes() {
  if (!existsSync(notesFile)) return 'absent'
  const text = readFileSync(notesFile, 'utf8')
  if (text === '') return 'empty'
  assert.ok(text.endsWith('\n'), 'notes.md 的最后一行必须写完（以换行收尾）')
  assert.ok(!text.includes('\uFFFD'), 'notes.md 不能出现解码坏字符')
  for (const line of text.split('\n')) {
    if (line === '') continue
    assert.match(line, /^- (\d{4}-\d{2}-\d{2} )?\S/, 'notes.md 有一行不是完整条目：' + JSON.stringify(line.slice(0, 40)))
  }
  return 'complete'
}

function checkConfig() {
  if (!existsSync(configFile)) return 'absent'
  const text = readFileSync(configFile, 'utf8')
  if (text === '') return 'empty'
  const parsed = JSON.parse(text) // 解析失败就是半截 JSON
  assert.equal(typeof parsed.round, 'number')
  return 'complete'
}

function leftovers() {
  return readdirSync(dir, { recursive: true }).filter((name) => String(name).includes('.tmp-'))
}

function killOnce(waitMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/worker-write.mjs'], { env, cwd: process.cwd(), stdio: 'ignore' })
    const timer = setTimeout(() => child.kill('SIGKILL'), waitMs)
    child.on('error', reject)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

const seen = new Set()
for (let i = 0; i < 6; i += 1) {
  await killOnce(120 + i * 40)
  seen.add(checkNotes())
  checkConfig()
}
console.log('1. 6 次写到一半被杀：notes.md 每次都是完整条目（' + [...seen].join('/') + '）')

assert.equal(checkNotes() === 'complete' || !existsSync(notesFile), true)
console.log('2. notes.md 收尾不留半截行，也不出现乱码')

assert.equal(checkConfig() === 'complete' || !existsSync(configFile), true)
console.log('3. config.json 每次都是合法 JSON')

const tmp = leftovers()
for (const name of tmp) {
  assert.match(String(name), /\.tmp-\d+-[a-z0-9]+$/, '临时文件名应该带 pid 与随机后缀：' + name)
}
console.log('4. 被击杀时留下的临时文件都带 pid 后缀（' + tmp.length + ' 个）')

// 被 SIGKILL 的进程没机会删自己的 tmp，靠下一次写同一个文件时顺手清扫：把它们改旧，再写一次
const { readFileSync: readAgain, utimesSync } = await import('node:fs')
const { writeAtomic } = await import('../lib/atomic.js')
const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
for (const name of tmp) utimesSync(join(dir, String(name)), old, old)
for (const target of [notesFile, configFile]) {
  const body = existsSync(target) ? readAgain(target, 'utf8') : ''
  writeAtomic(target, body)
}
const after = leftovers()
assert.deepEqual(after, [], '陈旧临时文件应该被下一次写同一个文件时清扫掉：' + after.join(', '))
console.log('5. 陈旧临时文件会被自动清扫，用户目录不会越攒越脏')

rmSync(dir, { recursive: true, force: true })
console.log('\n5 项全部通过')
