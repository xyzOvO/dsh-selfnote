/**
 * 验证 writeAtomic：rename 后必须尝试 fsync 父目录；Windows 不支持时吞错不影响写入。
 * 行为上打开目录 fd 的 fsync 在 Windows 可能抛错，所以只要求“尝试且吞错、写入成功”。
 * 这里用源码断言把关键实现钉住，避免 fsync 调用在不同平台上不可观察。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'atomic-fsync-dir-'))
const target = join(dir, 'data.json')
const atomicPath = resolve(fileURLToPath(new URL('../lib/atomic.js', import.meta.url)))
const { writeAtomic } = await import('../lib/atomic.js')
writeAtomic(target, '{"ok":true}\n')
assert.equal(readFileSync(target, 'utf8'), '{"ok":true}\n')
const source = readFileSync(atomicPath, 'utf8')
assert.match(source, /retryOnTransient\(\(\) => renameSync\(tmp, file\)\)\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*let dirFd[\s\S]*?fsyncSync\(dirFd\)/, 'fsync 父目录必须在 rename 之后')
assert.match(source, /openSync\(dirname\(file\),\s*['"]r['"]\)/, '必须打开父目录拿 fd')
assert.match(source, /try\s*\{[\s\S]*?fsyncSync\(dirFd\)[\s\S]*?\}\s*catch/, '目录 fsync 失败必须 try/catch 兜底')
console.log('writeAtomic 在 rename 后尝试 fsync 父目录，失败被吞掉')
