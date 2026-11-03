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
    writeSync(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    fd = -1
    renameSync(tmp, file)
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

export function writeJsonAtomic(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n')
}
