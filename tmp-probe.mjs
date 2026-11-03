const base = 'http://127.0.0.1:57808'
const token = (await import('node:fs')).readFileSync(process.env.USERPROFILE + '/.dsh/selfnote/auth-token', 'utf8').trim()

async function get(path, head = {}) {
  const t0 = Date.now()
  const res = await fetch(base + path, { headers: { 'x-selfnote': token, ...head } })
  const ms = Date.now() - t0
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, ms, json, text }
}

const s = await get('/api/selfnote/state')
const j = s.json
console.log('state', s.status, s.ms + 'ms')

const inj = j.injection
console.log('\n== 注入 ==')
console.log('chars', inj.chars, '/', inj.limit, ' overhead', inj.overhead)
for (const seg of inj.segments) {
  console.log(`  ${seg.key.padEnd(8)} ${String(seg.chars).padStart(4)}/${String(seg.limit).padStart(4)}  跳过 ${seg.skipped?.length ?? 0}${seg.absorbed ? ' 吸收 ' + seg.absorbed : ''}`)
}
console.log('delegatedSkips', inj.delegatedSkips)

console.log('\n== 归属 ==')
const a = j.attribution
console.log(JSON.stringify({ total: a.total, live: a.live, stale: a.stale, never: a.never, searched: a.searched, bySegment: a.bySegment }))
for (const row of a.rows.slice(0, 6)) {
  console.log(`  [${row.state.padEnd(8)}] ${String(row.segment).padEnd(8)} 进${row.hits} 搜${row.seen}  ${row.text.slice(0, 26)}`)
}

console.log('\n== 体检 ==')
const d = await get('/api/selfnote/doctor')
console.log('level', d.json.level, 'next', JSON.stringify(d.json.next))
for (const c of d.json.checks) console.log(`  ${c.level.padEnd(5)} ${c.label}: ${String(c.detail).slice(0, 70)}`)

console.log('\n== 其它 ==')
console.log('notes.lastWrite', j.notesLastWrite, ' noteGuide', JSON.stringify(j.noteGuide))
console.log('facts', JSON.stringify(j.facts.candidates?.length !== undefined ? { c: j.facts.candidates.length, a: j.facts.approved.length, r: j.facts.retiredCount } : j.facts))
console.log('warm', JSON.stringify(j.warm), ' heartbeat', JSON.stringify(j.heartbeat))
console.log('index', JSON.stringify(j.index))

const perf = await get('/state')
console.log('\nstateOf 摘要长度', perf.text.length)
