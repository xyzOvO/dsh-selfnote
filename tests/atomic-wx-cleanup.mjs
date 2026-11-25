/**
 * 复审 Important #1 回归：writeAtomic 用 wx 独占创建 tmp；
 * 当 openSync(tmp,'wx') 因 EEXIST 失败时，**绝不能**删掉那个已存在的 tmp
 * （tmp 名含 pid+时间戳，同 pid 的 worker 同毫秒可撞名，删掉的是别人正在写的文件）。
 * 手法：源码文本断言 + 行为检查，避免 monkey patch fs。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'atomic-wx-cleanup-'))
const target = join(dir, 'data.json')
const { writeAtomic } = await import('../lib/atomic.js')
writeAtomic(target, '{"ok":true}\n')
assert.equal(readFileSync(target, 'utf8'), '{"ok":true}\n')

const source = readFileSync(resolve(fileURLToPath(new URL('../lib/atomic.js', import.meta.url))), 'utf8')
assert.match(source, /openSync\(tmp,\s*['"]wx['"]\)/, 'tmp 必须 wx 独占创建')
assert.match(
  source,
  /let\s+created\s*=\s*false[\s\S]*?fd\s*=\s*openSync\(tmp,\s*['"]wx['"]\)[\s\S]*?created\s*=\s*true[\s\S]*?if\s*\(\s*created\s*\)\s*\{[\s\S]*?unlinkSync\(tmp\)/,
  'unlinkSync(tmp) 必须只在 created=true 时执行：EEXIST 时不能删别人的 tmp',
)
console.log('writeAtomic tmp 独占 + 清理只删自己创建的 tmp')
