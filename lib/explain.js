import { createHash } from 'node:crypto'
import { normalizeTier } from './store.js'

export const SKIP_REASONS = Object.freeze(['budget', 'expired', 'scope', 'duplicate'])
export const SKIP_PRIORITY = Object.freeze(['scope', 'expired', 'duplicate', 'budget'])
export const CORE_PREVIEW = '素材层，不注入'
export const PREVIEW_MAX_CHARS = 60

// 六步规范（m05194）：纯函数，不含 Date / 随机 / locale。
// ① 非字符串一律转字符串 ② NFKC 兼容等价 + 全角半角 ③ CRLF / 裸 CR → LF
// ④ 去首尾空白（连带 BOM） ⑤ 连续空白折叠为一个空格 ⑥ 返回稳定文本
export function normalizeForId(text) {
  const s1 = String(text ?? '')
  const s2 = s1.normalize('NFKC')
  const s3 = s2.replace(/\r\n?/g, '\n')
  const s4 = s3.trim()
  const s5 = s4.replace(/\s+/gu, ' ')
  return s5
}

export function contentId(text) {
  return createHash('sha1').update(normalizeForId(text), 'utf8').digest('hex').slice(0, 12)
}

export function pickReason(flags = {}) {
  for (const reason of SKIP_PRIORITY) {
    if (flags[reason] === true) return reason
  }
  return null
}

export function skippedId(segmentKey, text) {
  return String(segmentKey) + ':' + contentId(text)
}

// 只用于「展示预览」：按字素簇截，不切 surrogate pair / 组合字符 / ZWJ 序列。
// 与六段预算的 countChars()（码点）是两把尺子，不许互相回灌。
const SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' })

export function previewOf(text, maxGraphemes = PREVIEW_MAX_CHARS) {
  const s = String(text ?? '')
  const parts = Array.from(SEGMENTER.segment(s), (part) => part.segment)
  if (parts.length <= maxGraphemes) return s
  return parts.slice(0, maxGraphemes).join('') + '…'
}

// 只读取已有打包结果做「事后分类」：绝不重新打包、不改候选集合 / 排序 / 预算 / 文本。
// sources 与 skipped 同源、等长、逐位平行（由 packNotes() 在构造 skipped 的同一次调用里产出）。
// 旧版这里恒给 budget:true，pickReason() 就永远有结果、下面的 if 永远进不去 else ——
// 一个不可达分支。现在按来源如实展开：认不出的（含缺失）才回落 budget。
function flagsFor(source) {
  return {
    scope: source === 'scope',
    expired: source === 'expired',
    duplicate: source === 'duplicate',
    budget: source === 'budget' || !SKIP_REASONS.includes(source),
  }
}

export function describeSkipped({ key, skipped = [], sources = [], notes = [] } = {}) {
  const list = Array.isArray(skipped) ? skipped : []
  // 来源数组必须同源等长；缺一项就整批保守降级，宁可少报原因也不报错原因。
  // 降级在这里显式做，调用方不必靠「故意传空数组触发长度不齐」这种暗号。
  const src = Array.isArray(sources) && sources.length === list.length ? sources : null
  const out = list.map((raw, i) => {
    const text = String(raw ?? '')
    return { id: skippedId(key, text), preview: previewOf(text), reason: pickReason(flagsFor(src === null ? null : (src[i] ?? null))) }
  })
  if (key === 'notes') {
    const coreNotes = Array.isArray(notes) ? notes : []
    for (const entry of coreNotes.filter((e) => normalizeTier(e?.tier) === 'core')) {
      const text = String(entry?.text ?? '')
      out.push({ id: skippedId(key, text), preview: CORE_PREVIEW, reason: 'budget' })
    }
  }
  return out
}
