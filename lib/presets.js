/**
 * 协作默认（preset）：一组「怎么跟人打交道」的默认规则，由用户自己决定要不要导入。
 *
 * 为什么单独存 presets.json，不混进 notes.md：
 *   notes.md 的语义是「模型写给自己看的话」。预设是「用户还没表态之前的一段临时约定」，
 *   两者混在一起，用户手改 notes.md 时会看到一堆自己没写过的行，容量账和归档也串。
 *
 * 为什么存 text 快照、不存 key 引用：
 *   预设以后总要改文案。若只存 key，插件升级一次就把用户已经看过、点过头的句子悄悄换了。
 *   快照的代价只是「以后新增预设要重新导入一次」，这个代价付得起。
 *
 * 文件坏了怎么办：降级成空（等于没导入过），不抛错。
 *   一条记忆插件不该因为一个状态 JSON 手滑就把整段注入打挂。
 *
 * 内容边界（重要）：只放**交互规则**——怎么说话、何时验证、何时停问。
 *   不放用户属性（职业、作息、在做什么项目）。那些属于「关于他」的记忆，得用户自己说。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic.js'
import { normalizeTier, selfnoteRoot } from './store.js'

/** 状态文件版本。以后换结构时用它区分，不用猜字段形状。 */
export const PRESET_FILE_VERSION = 1

/**
 * 内置的五条。key 是稳定标识，id 语义见下：
 *   style.length      回答长度与结论位置
 *   verify.evidence   没有证据不说「完成了」
 *   plan.before_edit  改东西之前先给方案
 *   uncertain.mark    信息不足时标注假设
 *   risk.ask          有风险先停
 * 顺序就是注入顺序，也是设置页的显示顺序。
 */
export const PRESETS = [
  {
    key: 'style.length',
    tier: 'stable',
    text: '回答长度不限，该多长就多长；结论先给，不铺垫。',
  },
  {
    key: 'verify.evidence',
    tier: 'stable',
    text: '没跑过、没见过的，不说「完成了」，说「没验证」。',
  },
  {
    key: 'plan.before_edit',
    tier: 'stable',
    text: '改代码、改配置、改插件前先说清改哪几处、为什么，等点头再动手。',
  },
  {
    key: 'uncertain.mark',
    tier: 'stable',
    text: '信息不足时按合理假设做，并标出哪句是假设。',
  },
  {
    key: 'risk.ask',
    tier: 'stable',
    text: '删除、覆盖、改权限、装东西、涉及隐私，先问。',
  },
]

export const PRESET_KEYS = PRESETS.map((preset) => preset.key)

/** key 长什么样：小写字母起头，允许数字、下划线和点分段（style.length）。 */
export const PRESET_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/

export function presetsPath() {
  return join(selfnoteRoot(), 'presets.json')
}

function emptyState() {
  return { version: PRESET_FILE_VERSION, applied: {} }
}

/** 读已导入状态。文件不存在 / 坏掉 / 结构不对，一律当「没导入过」。 */
export function readPresets() {
  const file = presetsPath()
  if (!existsSync(file)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState()
    const applied = parsed.applied && typeof parsed.applied === 'object' && !Array.isArray(parsed.applied) ? parsed.applied : {}
    const clean = {}
    for (const [key, value] of Object.entries(applied)) {
      if (!PRESET_KEY_PATTERN.test(key)) continue
      if (!value || typeof value !== 'object') continue
      const text = typeof value.text === 'string' ? value.text.trim() : ''
      // 空正文等于没内容：留着它只会让注入段多一行空行，还占预算
      if (text === '') continue
      clean[key] = {
        text,
        tier: normalizeTier(value.tier),
        importedAt: typeof value.importedAt === 'string' ? value.importedAt : '',
      }
    }
    return { version: PRESET_FILE_VERSION, applied: clean }
  } catch {
    return emptyState()
  }
}

function writePresets(state) {
  writeJsonAtomic(presetsPath(), { version: PRESET_FILE_VERSION, applied: state.applied ?? {} })
  return presetsPath()
}

export function findPreset(key) {
  return PRESETS.find((preset) => preset.key === key) ?? null
}

/**
 * 设置页 / 工具返回的完整视图：每条都在，带「导没导、什么时候导的」。
 * UI 拿它画「未导入 → 有导入按钮」和「已导入 → 有移除按钮」两态，不需要自己拼。
 */
export function presetState() {
  const state = readPresets()
  const rows = PRESETS.map((preset) => {
    const applied = state.applied[preset.key]
    return {
      key: preset.key,
      // 未导入时给定义里的文案（预览用），导入后给快照（真正生效的字）
      text: applied ? applied.text : preset.text,
      tier: applied ? applied.tier : preset.tier,
      imported: Boolean(applied),
      importedAt: applied ? applied.importedAt : '',
      // 预设改过文案时，标出来让用户知道「你导入的还是旧版」
      edited: Boolean(applied) && applied.text !== preset.text,
      // 三态：没导入 / 跟当前默认一致 / 旧默认（可换新）/ 自己改过（只提示）
      kind: !applied
        ? 'none'
        : classifyPresetText(applied.text, preset.text, SUPERSEDED_PRESET_TEXTS[preset.key] ?? []),
    }
  })
  return {
    file: presetsPath(),
    version: PRESET_FILE_VERSION,
    total: rows.length,
    importedCount: rows.filter((row) => row.imported).length,
    items: rows,
  }
}

/**
 * 导入（幂等）。keys 省略 = 全部。
 * 已经导入过的不动 importedAt —— 重复点一次按钮不该看起来像「刚改过」。
 */
export function importPresets(keys) {
  const wanted = normalizeKeys(keys)
  const state = readPresets()
  const imported = []
  const already = []
  const unknown = []
  const now = new Date().toISOString()
  for (const key of wanted) {
    const preset = findPreset(key)
    if (!preset) {
      unknown.push(key)
      continue
    }
    if (state.applied[key]) {
      already.push(key)
      continue
    }
    state.applied[key] = { text: preset.text, tier: normalizeTier(preset.tier), importedAt: now }
    imported.push(key)
  }
  if (imported.length > 0) writePresets(state)
  return { imported, already, unknown, file: presetsPath() }
}

/** 移除（幂等）。只删 preset 状态，notes.md 里用户自己写的同 key 条目一个字都不动。 */
export function removePresets(keys) {
  const wanted = normalizeKeys(keys)
  const state = readPresets()
  const removed = []
  const missing = []
  const unknown = []
  for (const key of wanted) {
    if (!findPreset(key)) {
      unknown.push(key)
      continue
    }
    if (!state.applied[key]) {
      missing.push(key)
      continue
    }
    delete state.applied[key]
    removed.push(key)
  }
  if (removed.length > 0) writePresets(state)
  return { removed, missing, unknown, file: presetsPath() }
}

/**
 * 历史默认文案：只用来认「你导入的是旧版默认，还是你自己改过」。
 * 平时只追加不删 —— 删了以后，老用户手里的旧快照会被误判成「自己改过」。
 * 现在是空的：默认文案已回到最早那句（0.16.0 起的原文），没有第二版默认可认。
 * 以后真要改默认，把被换掉的旧句子追加进对应 key，界面才会给「用新的默认」。
 */
export const SUPERSEDED_PRESET_TEXTS = {}

/**
 * 三分归类：跟当前默认一致 / 正好等于某个历史默认 / 自己改过。
 * history 由调用方给（默认取上面那张表），留参数是为了能单测 superseded 这一支 ——
 * 现在表是空的，真跑起来不会有 superseded，但机制得留着给下次改默认用。
 */
export function classifyPresetText(appliedText, currentText, history = []) {
  if (appliedText === currentText) return 'same'
  if (history.includes(appliedText)) return 'superseded'
  return 'customized'
}

/**
 * 已导入、但和当前默认不一致的条目，并说清是哪种不一致：
 *   superseded —— 文案正好等于某个历史默认：用户没改过，只是导入得早，可以一键换新
 *   customized —— 用户自己改过：界面只摆差异，绝不给一键替换
 * 没导入的不出现：那是「还没决定」，不是「落后」。
 */
export function presetDrift() {
  const state = readPresets()
  const rows = []
  for (const preset of PRESETS) {
    const applied = state.applied[preset.key]
    if (!applied) continue
    if (applied.text === preset.text) continue
    const kind = classifyPresetText(applied.text, preset.text, SUPERSEDED_PRESET_TEXTS[preset.key] ?? [])
    rows.push({
      key: preset.key,
      kind,
      applied: applied.text,
      current: preset.text,
      importedAt: applied.importedAt,
    })
  }
  return rows
}

/**
 * 把「旧默认」那几条换成当前默认。只动 superseded，customized 一个字都不碰。
 * importedAt 保留原值 —— 那是用户当初点过头的时间，不该因为我同步一次就变。
 */
export function syncPresets(keys) {
  const wanted = normalizeKeys(keys)
  const state = readPresets()
  const synced = []
  const unchanged = []
  const customized = []
  const missing = []
  const unknown = []
  for (const key of wanted) {
    const preset = findPreset(key)
    if (!preset) {
      unknown.push(key)
      continue
    }
    const applied = state.applied[key]
    if (!applied) {
      missing.push(key)
      continue
    }
    if (applied.text === preset.text) {
      unchanged.push(key)
      continue
    }
    if (!(SUPERSEDED_PRESET_TEXTS[key] ?? []).includes(applied.text)) {
      customized.push(key)
      continue
    }
    state.applied[key] = { ...applied, text: preset.text }
    synced.push(key)
  }
  if (synced.length > 0) writePresets(state)
  return { synced, unchanged, customized, missing, unknown, file: presetsPath() }
}

/**
 * 注入用：已导入、且没有被用户同 key 自述覆盖的那些。
 * hidden 只用来解释「为什么这条没出现」，不参与注入文本。
 */
export function presetsForInjection(notes = []) {
  const state = readPresets()
  const userKeys = new Set()
  for (const entry of notes) {
    if (entry && typeof entry.key === 'string' && entry.key !== '') userKeys.add(entry.key)
  }
  const entries = []
  const hidden = []
  for (const preset of PRESETS) {
    const applied = state.applied[preset.key]
    if (!applied) continue
    if (userKeys.has(preset.key)) {
      hidden.push({ key: preset.key, text: applied.text, reason: 'user-override' })
      continue
    }
    entries.push({ key: preset.key, text: applied.text, tier: applied.tier })
  }
  return { entries, hidden }
}

/** keys 三种形态都收：省略 / 单个字符串 / 数组。认不出的原样留着，由调用方报 unknown。 */
function normalizeKeys(keys) {
  if (keys === undefined || keys === null || keys === '') return [...PRESET_KEYS]
  const list = Array.isArray(keys) ? keys : [keys]
  const out = []
  for (const item of list) {
    const key = String(item ?? '').trim()
    if (key === '') continue
    if (!out.includes(key)) out.push(key)
  }
  return out.length > 0 ? out : [...PRESET_KEYS]
}
