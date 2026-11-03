import { buildIndexChunked, indexStats } from '../lib/index-store.js'
const started = performance.now()
let last = 0
const index = await buildIndexChunked({
  onProgress: ({ done, total }) => {
    if (done - last >= 40 || done === total) {
      console.log(`  ${done}/${total}  ${Math.round(performance.now() - started)}ms`)
      last = done
    }
  },
})
const elapsed = Math.round(performance.now() - started)
const stats = indexStats()
console.log(`重建完成 ${elapsed}ms  会话 ${stats.sessions}/${stats.disk}  记录 ${stats.records}  体积 ${(stats.bytes / 1048576).toFixed(2)}MB  fresh=${stats.fresh}  failed=${stats.failed}`)
