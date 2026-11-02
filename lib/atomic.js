/**
 * 原子写：先写同目录临时文件再 rename。
 * 目的是避免「写到一半进程被杀」留下半截 JSON，把记忆读崩。
 */

import { renameSync, writeFileSync } from 'node:fs'

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

export function writeJsonAtomic(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n')
}
