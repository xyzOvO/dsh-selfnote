/**
 * /capture 诊断接口：事件类型直方图 + 落点计数 + 最近轨迹。
 *
 * 这一组断言守的是「排查时看到的数字必须是真的」—— 上一版有两个计数器
 * （userAuthored / noSeq）声明了从来没人加一，读出来永远 0，会把排查带偏。
 * 跑法：node tests/capture-debug.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'selfnote-capdbg-'))
process.env.DSH_SELFNOTE_DIR = dir
process.env.DSH_MEMORY_DIR = join(dir, 'memory')
process.env.DSH_SESSIONS_DIR = join(dir, 'sessions')
process.env.DSH_SELFNOTE_NO_OPEN = '1'
mkdirSync(join(dir, 'memory'), { recursive: true })

const { apply, currentAuthToken } = await import('../lib/index.js')
const memory = await import('../lib/memory.js')

const HOST = '127.0.0.1:56646'
let handler = null
const handlers = {}

const ctx = {
  logger: { info() {}, warn() {} },
  on(type, fn) {
    handlers[type] = fn
    return () => {}
  },
  agents: { currentInitiator: () => null },
  systemPrompt: { context: () => () => {} },
  tools: { register: () => () => {} },
  webServer: {
    register(route) {
      handler = route.handler
      return () => {}
    },
  },
}

apply(ctx, { enabled: true, profileEnabled: false })

function call(method, url) {
  return new Promise((resolve) => {
    const req = { method, url, headers: { host: HOST, 'x-selfnote': currentAuthToken() } }
    const res = {
      statusCode: 0,
      setHeader() {},
      end(body) {
        resolve({ status: this.statusCode, body: JSON.parse(String(body)) })
      },
      writeHead(code) {
        this.statusCode = code
      },
    }
    handler(req, res)
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
const session = { id: 'session-capture-debug', header: { id: 'session-capture-debug' } }
const emit = (event, sess = session) => handlers['session/event'](sess, event)

/* 1. 普通闲聊：走到「没候选」这一步就停，但事件照样计数 */
emit({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: '修一下我看看' } })
await settle()
let state = (await call('GET', '/api/selfnote/capture')).body
assert.equal(state.types['user/message'], 1, 'user/message 要计进类型直方图')
assert.equal(state.reasons['no-candidate'], 1, '闲聊要落到 no-candidate')
assert.equal(state.candidates, 0)

/* 2. 不是人说的话（工具/任务事件）：落到 not-user-authored */
emit({ type: 'job/registered', seq: 2, data: {} })
await settle()
state = (await call('GET', '/api/selfnote/capture')).body
assert.equal(state.types['job/registered'], 1)
assert.equal(state.reasons['not-user-authored'], 1, '非人类消息要落到 not-user-authored')

/* 3. 真命中了规则：写出候选，落到 written */
emit({
  type: 'user/message',
  seq: 3,
  data: { source: { kind: 'user' }, content: '以后回复都先给结论，别写一大段英文' },
})
await settle()
state = (await call('GET', '/api/selfnote/capture')).body
assert.equal(state.reasons.written, 1, '命中规则的句子要落到 written')
assert.ok(state.candidates >= 1, '要真的写出候选，实际 ' + state.candidates)
const pending = memory.listFacts('candidate')
assert.ok(pending.length >= 1, '候选要真的躺在库里')

/* 4. 没有会话 id 的事件也要留痕，不能悄悄丢掉 */
emit({ type: 'user/message', seq: 4, data: { source: { kind: 'user' }, content: 'x' } }, {})
await settle()
state = (await call('GET', '/api/selfnote/capture')).body
assert.equal(state.reasons['no-session'], 1, '没有会话 id 也要记一笔 no-session')

/* 5. 轨迹：最近几条按顺序、带落点；旧的两个死计数器不许再出现 */
assert.ok(Array.isArray(state.trace) && state.trace.length >= 4, '轨迹要有内容')
assert.ok(state.trace.every((row) => typeof row.at === 'string' && typeof row.type === 'string'), '轨迹要带时间和类型')
assert.ok(state.trace.every((row) => typeof row.reason === 'string' && row.reason !== ''), '每条轨迹都要落到某个 reason')
assert.equal('userAuthored' in state, false, '死计数器 userAuthored 不该再出现')
assert.equal('noSeq' in state, false, '死计数器 noSeq 不该再出现')
assert.ok(typeof state.since === 'string' && state.since !== '', '要能看出计数从什么时候开始')

console.log('1. 闲聊落到 no-candidate，事件照常计数')
console.log('2. 非人类消息落到 not-user-authored')
console.log('3. 命中规则写出候选，落到 written')
console.log('4. 没有会话 id 也留痕（no-session）')
console.log('5. 轨迹带时间与落点，死计数器已移除')

console.log('\n5 项全部通过')
process.exit(0)
