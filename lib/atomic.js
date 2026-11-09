/**
 * 原子写：先写同目录临时文件、fsync 落盘，再 rename 覆盖目标。
 * 目的是避免「写到一半进程被杀 / 断电」留下半截文件，把记忆读崩。
 *
 * 三点约束（都踩过坑）：
 *   1. 临时文件必须和目标同目录 —— rename 跨设备会退化成复制，就不再原子。
 *   2. 写完要 fsync：rename 只保证目录项原子，不保证数据块已经落到盘上。
 *   3. 失败要把临时文件删掉，否则崩一次就留一个 .tmp 在用户目录里。
 */

import { closeSync, fsyncSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Windows 没有 POSIX「覆盖正被打开的目标文件」语义：多进程硬写同一份 facts.jsonl 时，
// renameSync 偶发 EPERM / EBUSY / EACCES —— 目标只是「暂时被占用」，等几毫秒就好。
// ENOENT、EISDIR 之类是路径或权限真错了，重试只会白等，必须立刻抛。
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_BACKOFF = new Int32Array(new SharedArrayBuffer(4))

export function isTransientFsError(error) {
  return TRANSIENT_FS_CODES.has(error?.code)
}

/**
 * 只对瞬态占用做有限次重试。delays 的长度就是总尝试次数（不是「重试次数」）：
 * 第 i 次失败后等 delays[i] 毫秒再试下一次，最后一次仍冲突就把最后的错抛出去。
 * sleep 可注入，测试里用空函数省掉真实等待。
 */
export function retryOnTransient(operation, options = {}) {
  const delays = Array.isArray(options.delays) ? options.delays : [5, 10, 20, 40, 80]
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => {
    try {
      Atomics.wait(RENAME_BACKOFF, 0, 0, ms)
    } catch {
      /* 部分环境不支持 Atomics.wait 就退化成不让，重试仍会进行 */
    }
  }
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      if (!isTransientFsError(error) || attempt === delays.length - 1) throw error
      sleep(delays[attempt])
    }
  }
}

/**
 * 扫掉同一个目标留下的陈旧临时文件。
 * 被 SIGKILL 的进程没机会自己删 tmp，所以下一次写这个文件时顺手清掉「已经放了很久」的。
 * 只删同一目标、且超过 60 秒的 —— 正在写的临时文件活不过几毫秒，不会误伤。
 */
export function sweepTemps(file, maxAgeMs = 60_000) {
  try {
    const dir = dirname(file)
    const prefix = `${basename(file)}.tmp-`
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue
      const full = join(dir, name)
      try {
        if (now - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full)
      } catch {
        /* 别人刚删掉、或没有权限：都不是错误 */
      }
    }
  } catch {
    /* 目录还不存在时就没什么可扫的 */
  }
}

export function writeAtomic(file, text) {
  sweepTemps(file)
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  let fd = -1
  try {
    fd = openSync(tmp, 'w')
    // writeSync 不保证一次写完（返回的是实际写入的字节数）。小文件从来没事，
    // 但索引这种十兆的东西真被截断过一次就够难受了 —— 按返回值循环到写完为止。
    const buffer = Buffer.from(text, 'utf8')
    let offset = 0
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset)
      if (written <= 0) throw new Error('写入没有进展：' + file)
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = -1
    // Windows 上目标被别的进程短暂占用时 rename 会 EPERM/EBUSY：
    // 等几毫秒重试，而不是把「整份写回」直接判成失败（test:accept 曾偶发这个错）。
    retryOnTransient(() => renameSync(tmp, file))
  } catch (error) {
    if (fd !== -1) {
      try {
        closeSync(fd)
      } catch {
        /* 关不掉也没别的办法 */
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件可能根本没建出来 */
    }
    throw error
  }
}

export function writeJsonAtomic(file, value, options = {}) {
  if (value === undefined) throw new TypeError('writeJsonAtomic: undefined 不能写进 JSON 文件')
  // 默认缩进是为了人能读；索引本体十兆，缩进全是白占的体积，传 pretty:false
  const text = options.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  writeAtomic(file, text + '\n')
}
