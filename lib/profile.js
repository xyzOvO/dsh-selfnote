/**
 * 画像层（P7）
 *
 * 定位：**已审核记忆的聚合视图**，不是新的事实库。
 *   - 只读 status === 'approved' 的 facts；candidate / retired 不参与
 *   - 不产生新事实，每一句都能回指到具体 fact id
 *   - 可重建：facts 变了就重算，画像本身从不作为事实来源
 *   - 同一标签下多条时不擅自归纳，只取最新并标注「另有 N 条」
 */

const DEFAULT_MAX_CHARS = 80
const DEFAULT_PIECE_MAX = 60

/** facts 的时间戳只有日期（YYYY-MM-DD），比大小用字符串就够。 */
function stamp(fact) {
  const value = String(fact?.updated ?? fact?.created ?? '')
  return value === '' ? '0000-00-00' : value
}

/**
 * @param {Array<object>} facts 全部事实（内部会自己筛 approved）
 * @param {{maxChars?: number}} options
 * @returns {{text: string, parts: Array<{tag: string, factId: string, text: string}>, conflicts: Array<{tag: string, count: number}>, chars: number, sources: string[]}}
 */
export function buildProfile(facts, options = {}) {
  const maxChars = Number(options.maxChars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS
  // 单句上限：画像是一句话的自我认知，不是把长决定整段落搬进来。
  // 超过这个长度的（比如「上下文快照存哪」这种操作性决定）留在结论段，别挤掉真画像。
  const pieceMax = Number(options.pieceMax ?? DEFAULT_PIECE_MAX) || DEFAULT_PIECE_MAX
  /* channel === 'env' 是环境事实（机器路径、账号、坑），不是「这个人是谁」，不进画像 */
  const approved = (Array.isArray(facts) ? facts : []).filter(
    (fact) => fact?.status === 'approved' && (fact?.channel ?? 'rel') !== 'env',
  )

  /* 按第一个标签分组；没有标签的归到「其他」 */
  const groups = new Map()
  for (const fact of approved) {
    const raw = Array.isArray(fact.tags) ? fact.tags : []
    const tag = String(raw[0] ?? '其他').trim() || '其他'
    const bucket = groups.get(tag) ?? []
    bucket.push(fact)
    groups.set(tag, bucket)
  }

  const parts = []
  const conflicts = []
  const ordered = [...groups.entries()].sort((a, b) => stamp(b[1][0]) < stamp(a[1][0]) ? -1 : 1)

  let text = ''
  for (const [tag, bucket] of ordered) {
    const latest = bucket.slice().sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0))[0]
    const body = String(latest.text ?? '').trim()
    if (body === '') continue
    if (body.length > pieceMax) continue
    const piece = `${tag}：${body}`
    const candidate = text === '' ? piece : `${text}；${piece}`
    if (candidate.length > maxChars) continue
    text = candidate
    parts.push({ tag, factId: latest.id, text: body })
    if (bucket.length > 1) conflicts.push({ tag, count: bucket.length - 1 })
  }

  return {
    text,
    parts,
    conflicts,
    chars: text.length,
    sources: parts.map((part) => part.factId),
  }
}
