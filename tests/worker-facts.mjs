/**
 * acceptance-runtime.mjs 的子进程：模拟另一个窗口在写同一份 facts.jsonl。
 * 用法：node worker-facts.mjs <dir> <mode> <index>
 * 约定：任何一步没真的生效就非零退出，别静默吞掉。
 */

import { join } from 'node:path'

const [dir, mode, index] = process.argv.slice(2)
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = join(dir, 'sessions')

const mem = await import('../lib/memory.js')

if (mode === 'touch') {
  const touched = mem.touchFacts(['t' + index])
  if (touched !== 1) throw new Error('热度没落下：t' + index + '（返回 ' + touched + '）')
} else if (mode === 'append') {
  const outcome = mem.mutateFacts((facts) => {
    facts.push({ id: 'c' + index, text: '并发候选' + index, status: 'candidate' })
    return { changed: true }
  })
  if (outcome.changed !== true) throw new Error('append 没写进去：' + JSON.stringify(outcome))
} else if (mode === 'approve') {
  const outcome = mem.setFactStatus('p' + index, 'approved', { from: 'candidate', via: 'settings' })
  if (outcome.ok !== true) throw new Error('approve 失败：' + JSON.stringify(outcome))
} else if (mode === 'capture') {
  const { handleEvent } = await import('../lib/capture-run.js')
  const event = {
    type: 'user/message',
    seq: 1,
    time: Date.now(),
    data: {
      content: [{ type: 'text', text: '以后说到 ' + index + ' 号话题的时候先讲背景' }],
      role: 'user',
      source: { kind: 'user' },
    },
  }
  const outcome = await handleEvent(event, {
    sessionId: 'cap-' + index,
    readFacts: mem.readFacts,
    writeFacts: mem.writeFacts,
    mutateFacts: mem.mutateFacts,
  })
  if (outcome.handled !== true) throw new Error('capture 失败：' + JSON.stringify(outcome))
} else {
  throw new Error('未知模式：' + mode)
}
