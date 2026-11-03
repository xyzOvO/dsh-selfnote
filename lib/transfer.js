/**
 * 迁移：把一份记忆库导出成一个 JSON，在另一台机器上导入。
 *
 * 两条硬规矩：
 * 1. **不覆盖**。同 id 已存在就跳过；正文一样的也跳过（哪怕状态不同，让人自己看着办）。
 * 2. **默认不保留状态**。导入进来的 approved 一律变回 candidate —— 采纳必须由人在这里点一次，
 *    而不是把别人机器上的结论悄悄当成自己的。想原样搬过来，得在界面上勾「保留原状态」。
 *
 * 索引不导出：它记的是磁盘路径与 mtime，搬过去必然过期，导入后重建一次就行。
 */

export const BUNDLE_VERSION = 1
export const BUNDLE_APP = 'dsh-selfnote'

const CONFIG_FIELDS = [
  'enabled',
  'heading',
  'maxChars',
  'maxEntries',
  'profileEnabled',
  'profileOverride',
  'profileMaxChars',
  'halfLifeDays',
  'noteGuide',
]

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 导出：只挑能带走的东西，配置只挑用户可调的那几项。 */
export function buildBundle({ notes = [], facts = [], habits = [], config = {}, now = new Date() } = {}) {
  const safeConfig = {}
  for (const field of CONFIG_FIELDS) {
    if (config[field] !== undefined) safeConfig[field] = config[field]
  }
  return {
    app: BUNDLE_APP,
    v: BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    counts: { notes: notes.length, facts: facts.length, habits: habits.length },
    notes: notes.map((entry) => ({ date: entry.date ?? '', text: entry.text ?? '' })),
    facts: facts.map((fact) => ({ ...fact })),
    habits: habits.map((habit) => ({ ...habit })),
    config: safeConfig,
  }
}

/** 导入前的体检：结构不对就直说，别合并一半。 */
export function validateBundle(bundle) {
  if (!isObject(bundle)) return '不是 JSON 对象'
  if (bundle.app !== BUNDLE_APP) return `不是本插件导出的文件（app=${String(bundle.app)}）`
  const v = Number(bundle.v ?? 0)
  if (!Number.isSafeInteger(v) || v < 1) return '缺少版本号'
  if (v > BUNDLE_VERSION) return `这份文件来自更新的版本（v${v}），本机只认到 v${BUNDLE_VERSION}`
  for (const key of ['notes', 'facts', 'habits']) {
    if (bundle[key] !== undefined && !Array.isArray(bundle[key])) return `${key} 不是数组`
  }
  return null
}

/**
 * 合并：返回「合并后的三份数据 + 账目」。
 * 纯函数，不写盘 —— 写盘由调用方做，失败才好回滚。
 */
export function mergeBundle(bundle, current = {}, options = {}) {
  const keepStatus = options.keepStatus === true
  const notes = (current.notes ?? []).map((entry) => ({ ...entry }))
  const facts = (current.facts ?? []).map((fact) => ({ ...fact }))
  const habits = (current.habits ?? []).map((habit) => ({ ...habit }))

  const seenNotes = new Set(notes.map((entry) => textOf(entry.text)))
  const seenFacts = new Set(facts.map((fact) => textOf(fact.text)))
  const factIds = new Set(facts.map((fact) => fact.id))
  const seenHabits = new Set(habits.map((habit) => textOf(habit.text)))

  const added = { notes: 0, facts: 0, habits: 0 }
  const skipped = { notes: 0, facts: 0, habits: 0, invalid: 0 }
  const demoted = []
  const conflicts = []

  for (const raw of bundle.facts ?? []) {
    const text = textOf(isObject(raw) ? raw.text : '')
    const id = textOf(isObject(raw) ? raw.id : '')
    if (text === '' || id === '') {
      skipped.invalid += 1
      continue
    }
    if (factIds.has(id)) {
      skipped.facts += 1
      continue
    }
    if (seenFacts.has(text)) {
      skipped.facts += 1
      conflicts.push({ text, reason: 'same-text' })
      continue
    }
    const status = textOf(raw.status) || 'candidate'
    const fact = { ...raw, text }
    if (!keepStatus && status !== 'candidate') {
      fact.status = 'candidate'
      demoted.push(id)
    }
    if (fact.status === 'candidate') {
      delete fact.reviewedAt
      delete fact.retiredAt
    }
    fact.importedFrom = textOf(raw.source) || 'import'
    facts.push(fact)
    factIds.add(id)
    seenFacts.add(text)
    added.facts += 1
  }

  for (const raw of bundle.notes ?? []) {
    const text = textOf(isObject(raw) ? raw.text : '')
    if (text === '') {
      skipped.invalid += 1
      continue
    }
    if (seenNotes.has(text)) {
      skipped.notes += 1
      continue
    }
    notes.push({ date: textOf(raw.date) || '', text })
    seenNotes.add(text)
    added.notes += 1
  }

  for (const raw of bundle.habits ?? []) {
    const text = textOf(isObject(raw) ? raw.text : '')
    if (text === '') {
      skipped.invalid += 1
      continue
    }
    if (seenHabits.has(text)) {
      skipped.habits += 1
      continue
    }
    habits.push({
      text,
      status: textOf(raw.status) === 'active' ? 'active' : 'retired',
      tag: textOf(raw.tag) || '',
    })
    seenHabits.add(text)
    added.habits += 1
  }

  return { notes, facts, habits, added, skipped, demoted, conflicts, keepStatus }
}
