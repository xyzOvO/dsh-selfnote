/**
 * 崩溃写压测的子进程：不停地整份重写自述与配置，供父进程随时 SIGKILL。
 * 目的是验证「写到一半被杀」之后，notes.md / config.json 要么是旧的、要么是新的，
 * 不会出现半截内容。
 *
 * ⚠️ 这个脚本会不停覆盖 notes.md / config.json，所以它只许写临时目录：
 *    - 父进程（tests/crash-write.mjs）会用 DSH_SELFNOTE_DIR 指到 mkdtemp 出来的目录；
 *    - 单独跑（没人给它 env）时，这里自己建一个临时目录，绝不落到 ~/.dsh/selfnote。
 *    2026-11-05 的教训：单独执行它，把 36 条「崩溃测试用的一行自述」写进了真实 notes.md，
 *    还把真实 config.json 覆盖成 { round, payload } —— 真实数据只能靠备份找回。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.DSH_SELFNOTE_DIR) {
  process.env.DSH_SELFNOTE_DIR = mkdtempSync(join(tmpdir(), 'selfnote-worker-write-'))
  console.log(`（没有收到 DSH_SELFNOTE_DIR，自己隔离到 ${process.env.DSH_SELFNOTE_DIR}）`)
}

// 环境变量必须在 import 之前定好：store.js 一加载就会算自述目录
const { writeConfig, writeNotes } = await import('../lib/store.js')

const filler = '崩溃测试用的一行自述内容，长度要够，才能把写入窗口拉宽一点。'.repeat(6)

function entriesFor(round) {
  const list = []
  for (let i = 0; i < 40; i += 1) {
    list.push({ date: '2026-11-03', text: `第 ${round} 轮第 ${i} 条 ${filler}`.slice(0, 600) })
  }
  return list
}

let round = 0
for (;;) {
  round += 1
  writeNotes(entriesFor(round))
  writeConfig({ round, payload: filler.repeat(20) })
}
