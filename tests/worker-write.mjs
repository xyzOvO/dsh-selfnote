/**
 * 崩溃写压测的子进程：不停地整份重写自述与配置，供父进程随时 SIGKILL。
 * 目的是验证「写到一半被杀」之后，notes.md / config.json 要么是旧的、要么是新的，
 * 不会出现半截内容。
 */

import { writeConfig } from '../lib/store.js'
import { writeNotes } from '../lib/store.js'

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
