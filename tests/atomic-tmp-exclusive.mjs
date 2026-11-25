/**
 * RED：writeAtomic 的 tmp 必须独占创建（wx），不能截断/复用别人的 tmp。
 * 手法：在同一目标目录预置 tmp 名 impossible——改为验证 fs.openSync 的 'wx'
 * 语义 + writeAtomic 的源码文本包含 openSync(tmp,'wx')，防止将来把 'wx' 改回 'w'。
 * 真正的行为保证由 fs 语义本身提供，这里不做脆弱的 monkey patch。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, writeFileSync, readFileSync, closeSync, readFileSync as read } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'atomic-wx-'))
const target = join(dir, 'data.json')
const { writeAtomic } = await import('../lib/atomic.js')
writeAtomic(target, '{"ok":true}\n')
assert.equal(readFileSync(target, 'utf8'), '{"ok":true}\n')

const occupied = join(dir, 'occupied.tmp')
writeFileSync(occupied, '别人的临时文件')
assert.throws(
  () => {
    const fd = fs.openSync(occupied, 'wx')
    closeSync(fd)
  },
  (error) => error?.code === 'EEXIST',
  'wx 对已存在文件必须 EEXIST（w 会截断，这就是审计的问题）',
)
assert.equal(readFileSync(occupied, 'utf8'), '别人的临时文件')

const source = read(resolve(fileURLToPath(new URL('../lib/atomic.js', import.meta.url))), 'utf8')
assert.match(source, /openSync\(tmp,\s*['"]wx['"]\)/, 'writeAtomic 必须用 wx 独占创建 tmp')
console.log('writeAtomic 的 tmp 独占创建语义验证通过')
