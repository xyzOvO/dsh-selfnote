import { cpSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
const home = homedir()
const work = mkdtempSync(join(tmpdir(), 'prof-'))
process.env.DSH_MEMORY_DIR = join(work, 'memory')
process.env.DSH_SESSIONS_DIR = join(home, '.dsh', 'sessions')
cpSync(join(home, '.dsh', 'memory'), process.env.DSH_MEMORY_DIR, { recursive: true })
const mem = await import('../lib/memory.js')
const store = await import('../lib/index-store.js')
const t = (label, fn) => { const a = performance.now(); const r = fn(); console.log(label, Math.round(performance.now() - a) + 'ms'); return r }
const s1 = t('listSessions', () => mem.listSessions())
console.log(' sessions', s1.length)
t('readIndexMeta', () => store.readIndexMeta())
t('readIndex#1', () => store.readIndex())
t('readIndex#2', () => store.readIndex())
const sessions = mem.listSessions()
t('indexStats', () => store.indexStats(sessions))
t('indexStats again', () => store.indexStats(sessions))
