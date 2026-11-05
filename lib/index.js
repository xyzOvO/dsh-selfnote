/**
 * dsh-selfnote —— 让模型自己维护一段「自述」，跨会话带着走。
 *
 * 三层结构：
 *   写：模型通过 self_note 工具把自己的观察写进去（只追加，不覆盖）
 *   存：<DSH_HOME>/selfnote/notes.md，纯文本一行一条；超容量时旧的进 archive/
 *   读：每回合注入系统提示（systemPrompt.context），它不是用户说的话
 *
 * 设置页（浏览器半侧 lib/client.js）走同源 HTTP：GET /state、POST /config、POST /note、POST /clear。
 * 配置存在 <selfnoteRoot>/config.json，改完下一回合就生效，不用重启。
 */

import {
  appendNote,
  archiveDir,
  clearNotes,
  configPath,
  deleteNote,
  isExpiredNote,
  notesPath,
  normalizeTier,
  readAuthToken,
  readConfig,
  readNotes,
  renderNotes,
  setNoteMeta,
  trim,
  selfnoteRoot,
  stats,
  updateNote,
  writeAuthToken,
  writeConfig,
  writeNotes,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TEMP_TTL_DAYS,
  MAX_ENTRY_CHARS,
} from './store.js'

import {
  countChars,
  MAX_PERSONA_CHARS,
  notePersonaRead,
  PERSONA_L0_MAX,
  PERSONA_TOTAL,
  personaPath,
  readPersona,
  readPersonaStats,
  renderPersona,
  savePersonaFile,
  validatePersona,
} from './persona.js'
import { discardByIds, listCorrections, readEvents, readWatermark } from './corrections.js'
import { commitPersona, lockState, recover, runSerial } from './persona-tx.js'

import { randomBytes, timingSafeEqual } from 'node:crypto'

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

import {
  factsPath as factsFile,
  memoryRoot,
  habitSuggestions,
  habitsPath as habitsFile,
  factHeat,
  listFacts,
  memoryStats,
  listSessions,
  withSessionSnapshot,
  mutateFacts,
  rankByHeat,
  touchFacts,
  seenFacts,
  DEFAULT_HALF_LIFE_DAYS,
  readFacts,
  readHabits,
  readState,
  writeFacts,
  writeHabits,
  recall,
  writeState,
  setFactStatus,
  setFactText,
  setHabit,
  stageFact,
} from './memory.js'

import { buildIndexChunked, freshness, hitKeys, indexPath, indexStats, indexTerms, queryIndex, readIndex, topUpIndex } from './index-store.js'

import { buildProfile } from './profile.js'
import { writeAtomic } from './atomic.js'
import { cursorPath, enqueue, isDelegatedSession, readCursor } from './capture.js'
import { searchWarm, warmStats, writeSummary } from './warm.js'
import { buildBundle, mergeBundle, mergePersona, validateBundle } from './transfer.js'
import { handleEvent } from './capture-run.js'

export const name = 'selfnote'

/** 声明式依赖：systemPrompt 注入，tools 写入，webServer 提供设置页 API。 */
export const inject = ['systemPrompt', 'tools', 'webServer']

/**
 * 自动采集的现场情况：只用于排查「事件到底有没有到、卡在哪一步」，不参与业务。
 *
 * 以前这里有两个 userAuthored / noSeq 计数器，声明了从来没人加一，读出来永远是 0 ——
 * 排查时反而误导（看起来像「消息一条都没进来」）。现在换成两条真账：
 * types（按事件类型计数）与 reasons（按落点计数），外加最近若干条轨迹。
 */
const CAPTURE_TRACE_MAX = 40

const captureDebug = {
  since: null,
  events: 0,
  types: {},
  reasons: {},
  candidates: 0,
  written: 0,
  lastType: null,
  lastKeys: null,
  lastError: null,
  trace: [],
}

function bumpCounter(bucket, key) {
  if (typeof key !== 'string' || key === '') return
  bucket[key] = (bucket[key] ?? 0) + 1
}

/** 事件一进来先记账：类型直方图 + 最近几条。返回类型，供后面的落点记录复用。 */
function noteCaptureEvent(sessionId, event) {
  captureDebug.events += 1
  const type = typeof event?.type === 'string' && event.type !== '' ? event.type : 'unknown'
  bumpCounter(captureDebug.types, type)
  captureDebug.lastType = event?.type ?? null
  captureDebug.lastKeys = event !== null && typeof event === 'object' ? Object.keys(event).slice(0, 12) : null
  uploadTrace({
    at: new Date().toISOString(),
    sid: typeof sessionId === 'string' ? sessionId.slice(0, 8) : '',
    type,
    seq: Number.isSafeInteger(event?.seq) ? event.seq : null,
    reason: null,
  })
  return type
}

/** 这一轮采集最后落在哪：写进去了 / 没候选 / 不是人说的 / 没 seq …… */
function noteCaptureOutcome(reason) {
  bumpCounter(captureDebug.reasons, reason)
  const last = captureDebug.trace[captureDebug.trace.length - 1]
  if (last !== undefined) last.reason = reason
}

function uploadTrace(entry) {
  captureDebug.trace.push(entry)
  if (captureDebug.trace.length > CAPTURE_TRACE_MAX) {
    captureDebug.trace.splice(0, captureDebug.trace.length - CAPTURE_TRACE_MAX)
  }
}

const API_PREFIX = '/api/selfnote'

const DEFAULT_CONFIG = {
  enabled: true,
  maxChars: DEFAULT_MAX_CHARS,
  maxEntries: DEFAULT_MAX_ENTRIES,
  /** 注入段的小标题；留空则不带头。 */
  heading: '记忆（我写的）',
  /** 画像：从 approved facts 聚合出的「关于你」，可关、可手改。 */
  profileEnabled: true,
  /** 人格段（L0 + L1）是否每回合注入；关掉只是不注入，persona.md 一个字节都不动。 */
  personaEnabled: true,
  profileOverride: '',
  profileMaxChars: 110,
  /** 热度半衰期（天）：越久没用，激活优先级越低，但事实本身不动。 */
  halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  /** 自定义「写自述的时机」；留空就用工具说明里的默认判据。 */
  noteGuide: '',
  /** 临时自述的保质期（天）：过了就不自动进场，只留在库里。核心与稳定型不受影响。 */
  tempTtlDays: DEFAULT_TEMP_TTL_DAYS,
}

const TOOL_DESCRIPTION = `维护「我自己的叙述」——不是记用户的事，是记我自己的。

什么时候写（三条硬触发，命中任意一条就写）：
1. 用户说了「记住这个」这一类话（记住、记一下、以后就这么办）。
2. 用户连续两次纠正同一件事——同一个点改了两次，那是长期口径，不是一次性。
3. 一段合作收尾（任务交付、方向定了、决定做完）——写一句「这段里我学到什么」。
另外，当你自己发现「我这次做得不对，下次换个做法」时也写。

写法：
- 第一人称，一句话到三句话；写「我」的做法和判断，不复述用户的原话。
- 一条写一件事。空话、套话、复述人格设定都不值得写。
- 写的时候用 tier 标明这是哪一型：core=身份素材（人格、长期身份、基本原则 —— 不参与注入，只作提炼人格的原料）、stable=稳定偏好（语言、表达习惯、工作偏好）、temp=临时自述（当前阶段的目标、近期变化）。不写按 stable 算。
- 只追加，不能改写历史。写满后最旧的条目自动进归档，不会丢，只是不再每回合注入。
- 这是明文保存在本机、并且每回合都会进上下文的文件：密码、密钥、验证码这类凭据别写。
- 记用户本人（名字、习惯、处境、在意的点）是有用的，但那些更适合进事实库：用 memory_stage。

回看：action="read" 看生效的，action="archive" 看归档，action="stats" 看容量。`

const ACTIONS = ['write', 'read', 'archive', 'stats', 'persona', 'corrections']

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'write=写一条新自述；read=看现在生效的全部自述；archive=看归档目录；stats=容量与占用。',
    },
    text: {
      type: 'string',
      description: 'action=write 时的正文，一句话到三句话，第一人称。最多 600 字，超出截断。',
    },
    tier: {
      type: 'string',
      enum: ['core', 'stable', 'temp'],
      description: '这条属于哪一型：core=身份素材（人格、长期身份，不参与注入，只作提炼人格的原料）；stable=稳定偏好（表达习惯、工作偏好，默认）；temp=临时自述（当前阶段的目标、近期变化，最后装）。',
    },
    pin: {
      type: 'boolean',
      description: '钉住：同一型里优先装进上下文。只给「绝不能忘」的那一两条用，钉多了等于没钉。',
    },
  },
  required: ['action'],
}

/** 合并三层配置：代码默认 < config.json < 插件配置。 */
function currentConfig(inline) {
  const fromFile = readConfig()
  const merged = { ...DEFAULT_CONFIG, ...(inline ?? {}), ...fromFile }
  const maxChars = Number(merged.maxChars)
  const maxEntries = Number(merged.maxEntries)
  return {
    ...merged,
    enabled: merged.enabled !== false,
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.min(maxChars, 8000) : DEFAULT_MAX_CHARS,
    maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? Math.min(maxEntries, 200) : DEFAULT_MAX_ENTRIES,
    profileEnabled: merged.profileEnabled !== false,
    personaEnabled: merged.personaEnabled !== false,
    profileOverride: typeof merged.profileOverride === 'string' ? merged.profileOverride.trim().slice(0, 240) : '',
    profileMaxChars: Number.isFinite(Number(merged.profileMaxChars))
      ? Math.max(20, Math.min(Number(merged.profileMaxChars), 120))
      : DEFAULT_CONFIG.profileMaxChars,
    halfLifeDays: Number.isFinite(Number(merged.halfLifeDays))
      ? Math.max(1, Math.min(Number(merged.halfLifeDays), 365))
      : DEFAULT_CONFIG.halfLifeDays,
    // 老版本把这句 28 字的抬头写进了 config.json。它只干一件事，现在默认 6 字。
    // 存的正好是老默认 → 跟着换代；用户自己改过的（不等于老默认）一个字都不动。
    heading: merged.heading === LEGACY_HEADING ? DEFAULT_CONFIG.heading : merged.heading,
    noteGuide: typeof merged.noteGuide === 'string' ? merged.noteGuide.trim().slice(0, GUIDE_LIMIT) : '',
    tempTtlDays: Number.isFinite(Number(merged.tempTtlDays))
      ? Math.max(1, Math.min(Math.round(Number(merged.tempTtlDays)), 90))
      : DEFAULT_TEMP_TTL_DAYS,
  }
}

/** 0.10.2 之前的默认抬头。只用来认「这是老默认」，不参与渲染。 */
const LEGACY_HEADING = '关于我自己（agent 写的第一人称自述，不是用户说的话）'

function limitsOf(cfg) {
  return { maxChars: cfg.maxChars, maxEntries: cfg.maxEntries }
}

/**
 * 注入预算：六段合计 1000 字，放不下就跳过那一条（不是把整段截断）。
 * 人格（L0 + L1）占最大一份 —— 记忆的主体是「我是谁」，其余是它需要知道的背景。
 * 320/200/120/230/90/40 = 1000：相比五段版的 800，多出来的 200 全给了人格，
 * 自述、画像、环境、结论各让一点（环境 320→230 是唯一有实际损失的段落）。
 */
const BUDGET = { persona: 320, notes: 200, profile: 120, env: 230, facts: 90, habits: 40 }
/** 六段合计，别在别处再手写一个数字。 */
export const TOTAL_BUDGET =
  BUDGET.persona + BUDGET.notes + BUDGET.profile + BUDGET.env + BUDGET.facts + BUDGET.habits

/** 人格框架句：让它知道「下面是你的样子」而不是「有人在给你下命令」。 */
export const PERSONA_FRAME = '以下是你自己的样子，照这个说话。'
/** L2 的指路句：不进 chars（和自述段门牌同一套先例）。 */
export const PERSONA_POINTER = '外貌与世界观细节见 self_note action:"persona"'

/** 临时自述的保底比例：别让长期偏好把「当前阶段在做什么」全部挤掉。 */
const TEMP_SHARE = 0.25
/** 自定义「写自述的时机」那行的上限（字）。 */
export const GUIDE_LIMIT = 80
/** 注入抬头那一行的上限（字）。它是每回合固定开销，不设限等于让人用一句话吃掉预算。 */
export const HEADING_LIMIT = 24

/**
 * 环境备忘的打包：和 fitDetailed 同一条规则（放不下就跳过、继续试后面的），
 * 区别是要把 id 一起带出来——只有真进了上下文的才算「用到」。
 */
function packEnv(items, limit) {
  const kept = []
  const ids = []
  const skipped = []
  let used = 0
  let text = ''
  for (const item of items) {
    const body = String(item.text ?? '').trim()
    if (body === '') continue
    if (used + body.length > limit) {
      skipped.push(body)
      continue
    }
    used += body.length + 1
    kept.push(body)
    ids.push(item.id)
    text = text === '' ? body : `${text}；${body}`
  }
  return { text, kept, skipped, ids, used }
}

/**
 * 冷门条目在环境段里预留多少份额。
 *
 * 只按热度排会形成马太效应：进过一次的 hitCount 就 +1、热度更高、下一轮还进；
 * 一次没进过的永远排在后面。实测 4 条吃满了 292 字，另外 10 条一次没进过 ——
 * 记忆存进去了，模型却不知道它存在。所以环境段不让「热的」吃满：
 * 先按热度装 limit 的 3/4，剩下 1/4 留给「从没进过 / 最久没进过」的。
 */
export const ENV_RESERVE_RATIO = 0.25

function lastHitOf(item) {
  const raw = item?.lastHit
  const parsed = raw === null || raw === undefined ? NaN : Date.parse(raw)
  // 从没进过就用 0 当排名（比任何真实时间戳都早）。
  // 不能用 -Infinity：两个 -Infinity 相减得 NaN，比较器一乱，冷门队列就退化成热度顺序了。
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 环境段分账打包：热的先占 3/4，冷门的用剩下的（从最久没进过的开始排队）。
 * spotlight 是这一轮要重点回顾的 id（压缩之后用），它们排在冷门队伍最前面。
 * 冷门那份用不完就还给热的 —— 不浪费预算。
 *
 * 1/4 只是起点，不是硬指标：真实的备忘动辄 80–120 字，1/4 连一条都塞不下，
 * 「预留了」却什么都没发生（实测对着真数据跑，9 条从没进过的一条也进不来）。
 * 所以再加一条下限 —— 保证**下一个该轮到的**那条进得来（不是「最短的那条」：
 * 打包是按队列顺序试的，队首太长就轮不到后面那些短的）。最多占到一半，别把热的挤空。
 */
function packEnvFair(items, limit, spotlight = new Set()) {
  const cap = Math.max(0, limit)
  const arrange = (reserve) => {
    const base = packEnv(items, Math.max(0, cap - reserve))
    const rest = items.filter((item) => !base.ids.includes(item.id))
    const warm = rest.filter((item) => spotlight.has(item.id))
    const cold = rest.filter((item) => !spotlight.has(item.id))
    // 从没进过的排最前，然后是最久没进过的：进过一次就会被记账，下轮自然排到队尾
    cold.sort((a, b) => lastHitOf(a) - lastHitOf(b) || a.heat - b.heat)
    return { base, warm, cold }
  }
  let reserve = Math.floor(cap * ENV_RESERVE_RATIO)
  let plan = arrange(reserve)
  const head = plan.warm[0] ?? plan.cold[0]
  if (head !== undefined) {
    const floor = String(head.text ?? '').trim().length + 1
    if (floor > reserve) {
      reserve = Math.min(Math.floor(cap / 2), floor)
      plan = arrange(reserve)
    }
  }
  const { base, warm, cold } = plan
  const extra = packEnv([...warm, ...cold], Math.max(0, cap - base.used))
  const ids = [...base.ids, ...extra.ids]
  const inText = new Set(ids)
  const skipped = items
    .filter((item) => !inText.has(item.id))
    .map((item) => String(item.text ?? '').trim())
    .filter((body) => body !== '')
  return {
    text: [base.text, extra.text].filter((part) => part !== '').join('；'),
    kept: [...base.kept, ...extra.kept],
    skipped,
    ids,
    reserve,
    spotlit: warm.filter((item) => extra.ids.includes(item.id)).map((item) => item.id),
  }
}

/**
 * 按预算拼一段：放不下就跳过这一条，继续试后面的。
 * 早先这里是 break —— 一条超长的条目会把整段挤成空，而且没人看得出来。
 * 这里连「谁进了、谁被挤掉」一起返回：设置页要能解释某条为什么没进上下文。
 */
function fitDetailed(items, limit) {
  const kept = []
  const skipped = []
  let used = 0
  for (const item of items) {
    const text = String(item ?? '').trim()
    if (text === '') continue
    const width = countChars(text)
    if (used + width > limit) {
      skipped.push(text)
      continue
    }
    kept.push(text)
    used += width + 1
  }
  return { text: kept.join('\n'), kept, skipped }
}

function fit(items, limit) {
  return fitDetailed(items, limit).text
}

/**
 * 自述段的账。顺序就是优先级：稳定（pin 先，再新→旧）→ 临时（新→旧）。
 * 稳定段有上限（给临时留 1/4 保底），临时段拿走剩下的全部 —— 临时条目都很短，通常吃不完。
 * 为什么要分：混着装的时候，一条 90 字的人格自述和五条「今晚提醒」抢同一个 200 字，
 * 抢输的总是人格那条，而且没人看得出来谁被挤掉了。
 * 临时型还会过期：过了 tempTtlDays 就不再自动进场（数据一个字没删，只是不进上下文）。
 *
 * 核心型（core）不再参与注入：它是**身份素材**，只当提炼进 persona.md 的原料。
 * 身份该由人格段（L0/L1）说，两处都说一遍等于让模型看两版自己。
 * 存量 core 一条不删，只是不进上下文；条数靠门牌告诉模型「有这么些素材」。
 */
function packNotes(entries, limit, ttl) {
  const ttlDays = Number.isFinite(Number(ttl)) ? Number(ttl) : DEFAULT_TEMP_TTL_DAYS
  const core = []
  const stable = []
  const temp = []
  const expired = []
  for (const entry of entries) {
    const tier = normalizeTier(entry?.tier)
    if (tier === 'core') core.push(entry)
    else if (tier === 'temp') {
      if (isExpiredNote(entry, ttlDays)) expired.push(entry)
      else temp.push(entry)
    } else stable.push(entry)
  }
  const stableList = stable
    .slice()
    .reverse()
    .sort((a, b) => (b.pin === true ? 1 : 0) - (a.pin === true ? 1 : 0))
    .map((entry) => entry.text)
  const tempList = temp.slice().reverse().map((entry) => entry.text)

  // 临时先占保底份额，稳定吃剩下的 —— 顺序反过来会让临时永远抢不到位置
  const tempFloor = tempList.length === 0 ? 0 : Math.min(limit, Math.max(24, Math.round(limit * TEMP_SHARE)))
  const stableLimit = Math.max(0, limit - tempFloor)
  const stableFit = fitDetailed(stableList, stableLimit)
  const used = stableFit.text === '' ? 0 : countChars(stableFit.text) + 1
  const tempLimit = Math.max(0, limit - used)
  const tempFit = fitDetailed(tempList, tempLimit)

  const parts = [stableFit.text, tempFit.text].filter((part) => part !== '')
  // 过期的也算「没进上下文」：它们还在库里，模型得靠门牌知道有这么几条，
  // 所以并进 skipped 一起报数 —— 少报就是骗人。
  const expiredTexts = expired.map((entry) => entry.text)
  return {
    text: parts.join('\n'),
    kept: [...stableFit.kept, ...tempFit.kept],
    skipped: [...stableFit.skipped, ...tempFit.skipped, ...expiredTexts],
    // 每型的账：设置页要能指着说「稳定 3 条全进了，临时 2 条被挤掉」
    tiers: {
      // 核心不进注入，所以 kept 恒 0、limit 恒 0：读数上「0 / 0」比「3 / 0」更不容易被误读
      core: { total: core.length, kept: 0, skipped: core.length, limit: 0 },
      stable: { total: stableList.length, kept: stableFit.kept.length, skipped: stableFit.skipped.length, limit: stableLimit },
      temp: {
        total: tempList.length + expired.length,
        kept: tempFit.kept.length,
        skipped: tempFit.skipped.length,
        expired: expired.length,
        limit: tempLimit,
      },
    },
  }
}

/**
 * 自述段 + 门牌。
 * 门牌必须收敛：它自己占字，加进去可能又挤掉一条，条数一变门牌上的数字就是错的。
 * 所以两轮：先按全长排，用剩下的条数算门牌，再按「减掉门牌」的长度重排，直到条数不再变。
 */
function notesSegment(entries, limit, ttl) {
  // 核心素材的门牌和自述门牌是两件事：前者是「有素材，没给你」，后者是「有自述装不下」。
  // 素材那条也得占字数（它是要贴进上下文的字），所以先把它从额度里扣掉再打包。
  const material = entries.filter((entry) => normalizeTier(entry?.tier) === 'core').length
  const materialNote = material > 0 ? `另有 ${material} 条身份素材（不注入，self_note read 可看）` : ''
  const room = materialNote === '' ? limit : Math.max(0, limit - countChars(materialNote) - 1)
  const withMaterial = (segment) => {
    if (materialNote === '') return segment
    const text = segment.text === '' ? materialNote : `${segment.text} ${materialNote}`
    return { ...segment, text }
  }
  const packed = packNotes(entries, room, ttl)
  if (packed.skipped.length === 0) return { ...withMaterial(packed), pointer: '' }
  let current = packed
  let pointer = ''
  for (let pass = 0; pass < 3; pass += 1) {
    const next = `另有 ${current.skipped.length} 条自述（self_note read）`
    if (next.length + 1 >= room) break
    const refit = packNotes(entries, Math.max(0, room - next.length - 1), ttl)
    const converged = refit.skipped.length === current.skipped.length
    pointer = next
    const joined = { ...refit, text: refit.text === '' ? next : `${refit.text} ${next}` }
    current = joined
    if (converged) break
  }
  return { ...withMaterial(current), pointer }
}

/**
 * 人格段：L0 + L1 常驻，L2 一个字节都不进（只留一句指路句）。
 *
 * 装的时候按**非空行**装、整行跳过 —— 一条规则被拦腰截断会变成另一条规则，
 * 比没装进去更糟。唯一例外：L1 第一行就超预算时截断补 `…`，
 * 因为「半句规则」仍强过「完全没有人格」，但必须留痕（truncated + 门牌 + doctor）。
 *
 * chars 只算进了上下文的 L0/L1 正文；指路句是框架文字，走 overhead
 *（和自述段的门牌同一套口径，否则「320 / 320」这种读数会看不出是被谁撑满的）。
 */
export function personaSegment(persona, limit) {
  const empty = {
    text: '',
    chars: 0,
    kept: [],
    skipped: [],
    truncated: false,
    pointer: '',
    l0: { chars: 0, kept: 0, skipped: 0 },
    l1: { chars: 0, kept: 0, skipped: 0 },
  }
  if (!persona || persona.error === 'not-text') return empty

  const linesOf = (raw) =>
    String(raw ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  const rawL0 = linesOf(persona.l0)
  const rawL1 = linesOf(persona.l1)
  // 只写了 L2 也要指路：否则「我有一份设定」这件事模型永远不知道，L2 等于没写。
  // 指路句不计字数，所以这里只改指针，不动预算。
  if (rawL0.length === 0 && rawL1.length === 0) {
    const l2Only = String(persona?.l2 ?? '').trim() !== ''
    return { ...empty, pointer: l2Only ? PERSONA_POINTER : '' }
  }

  // 一段行拼成文本要占多少字：每行的字 + 行与行之间那一个换行。
  // 校验（persona.js 的 personaCost）用的是同一个尺子 —— 两把尺子会让人格
  // 「保存时说 320 正好，注入时却吃掉最后两个字」。
  const costOf = (lines) => (lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + countChars(line), 0) + lines.length - 1)

  let truncated = false
  // L0 硬上限 80：文件被外部改超了，运行期截到 80 并留痕，不整段丢。
  // 口径同 personaCost —— 含行间换行，否则「校验 80 / 注入 81」又能差一个字。
  const l0 = []
  let l0Chars = 0
  for (const line of rawL0) {
    const width = countChars(line)
    const need = l0.length === 0 ? width : l0Chars + 1 + width
    if (need <= PERSONA_L0_MAX) {
      l0.push(line)
      l0Chars = need
      continue
    }
    const room = l0.length === 0 ? PERSONA_L0_MAX : PERSONA_L0_MAX - l0Chars - 1
    if (room > 1) l0.push([...line].slice(0, room - 1).join('') + '…')
    l0Chars = PERSONA_L0_MAX
    truncated = true
    break
  }

  const packLines = (lines, startLines, startCost, budget) => {
    const kept = [...startLines]
    const skipped = []
    let used = startCost
    for (const line of lines) {
      const width = countChars(line)
      // 接在后面就要一个换行，所以是 used + 1 + width；第一行前面没有换行
      const need = kept.length === startLines.length && startLines.length === 0 ? width : used + 1 + width
      if (need <= budget) { kept.push(line); used = need; continue }
      if (kept.length === startLines.length) {
        // 第一行就超预算：截断补 …，别让人格整段消失
        const room = Math.max(0, budget - used - 1)
        if (room > 1) kept.push([...line].slice(0, room - 1).join('') + '…')
        used = budget
        truncated = true
        continue
      }
      skipped.push(line)
    }
    return { kept, used, skipped }
  }

  const l0Cost = costOf(l0)
  const packed = packLines(rawL1, l0, l0Cost, limit)
  let kept = packed.kept
  let skipped = packed.skipped

  // 门牌也要收敛：它自己占字，加进去可能又挤掉一行，行数一变数字就错
  let skippedNote = ''
  for (let pass = 0; pass < 3 && skipped.length > 0; pass += 1) {
    const nextNote = `另有 ${skipped.length} 行人格规则没装进来`
    if (countChars(nextNote) + 1 >= limit) break
    const refit = packLines(rawL1, l0, l0Cost, limit - countChars(nextNote) - 1)
    const converged = refit.skipped.length === skipped.length
    kept = refit.kept
    skipped = refit.skipped
    if (converged) { skippedNote = nextNote; break }
    skippedNote = nextNote
  }
  // 收敛不了就别印门牌：印一个和实际跳过数对不上的数字比不印更糟
  if (skippedNote !== '' && !new RegExp(`另有 ${skipped.length} 行`).test(skippedNote)) skippedNote = ''

  // 按「谁属于哪一段」切：packLines 是把 L0 原样前置的，前 l0.length 行一定是 L0。
  //（原来按文字相等去数，L1 里有一行和 L0 同文就会数成两行，能印出「另有 -1 行」。）
  const l0Kept = Math.min(l0.length, kept.length)
  const l1Kept = kept.slice(l0Kept)
  const body = kept.join('\n')
  const text = skippedNote === '' ? body : `${body} ${skippedNote}`
  const l0CharsOut = costOf(l0.slice(0, l0Kept))
  const l1CharsOut = costOf(l1Kept)
  const sep = l0Kept > 0 && l1Kept.length > 0 ? 1 : 0
  const noteCost = skippedNote === '' ? 0 : 1 + countChars(skippedNote)
  const hasL2 = String(persona?.l2 ?? '').trim() !== ''
  return {
    text,
    chars: l0CharsOut + sep + l1CharsOut + noteCost,
    kept,
    skipped,
    truncated,
    pointer: hasL2 ? PERSONA_POINTER : '',
    l0: { chars: l0CharsOut, kept: l0Kept, skipped: rawL0.length - l0Kept },
    l1: { chars: l1CharsOut, kept: l1Kept.length, skipped: skipped.length },
  }
}

/** 结论段打包：要连 id 一起留下（归属统计靠它），所以不能直接用 fitDetailed。 */
function packFacts(ranked, limit) {
  const kept = []
  const skipped = []
  let used = 0
  for (const item of ranked) {
    const text = String(item?.text ?? '').trim()
    if (text === '') continue
    const width = countChars(text)
    if (used + width > limit) {
      skipped.push(text)
      continue
    }
    kept.push(item)
    used += width + 1
  }
  return { text: kept.map((item) => item.text).join('\n'), kept, skipped, used }
}

/** 结论段 + 门牌：和自述同一套收敛逻辑，否则「另有 N 条」会少报。 */
function factsSegment(ranked, limit) {
  const packed = packFacts(ranked, limit)
  if (packed.skipped.length === 0) return { ...packed, pointer: '' }
  let current = packed
  let pointer = ''
  for (let pass = 0; pass < 3; pass += 1) {
    const next = `另有 ${current.skipped.length} 条结论（memory_recall 查）`
    if (next.length + 1 >= limit) break
    const refit = packFacts(ranked, Math.max(0, limit - next.length - 1))
    const converged = refit.skipped.length === current.skipped.length
    pointer = next
    current = { ...refit, text: refit.text === '' ? next : `${refit.text} ${next}` }
    if (converged) break
  }
  return { ...current, pointer }
}

let injectCache = { key: '', text: '' }

/** 注入文本的缓存键：三份数据只要有一份变了，就重算。 */
function injectionKey(cfg) {
  const stamps = [notesPath(), factsFile(), habitsFile(), personaPath()].map((file) => {
    try {
      const st = statSync(file)
      // 带上大小：同一毫秒内改两次（脚本、连点保存）时 mtime 可能没变，键就会撞车、
      // 沿用上一份旧文本 —— 用户那边看到的就是「改了没生效」。
      return file + ':' + st.mtimeMs + ':' + st.size
    } catch {
      return file + ':-'
    }
  })
  const profileKey = [cfg.profileEnabled, cfg.profileMaxChars, cfg.profileOverride.length, cfg.profileOverride].join('~')
  // 临时自述会自己到期：文件一个字没改，跨过保质期那天注入也得重算。
  // 按「天」进键就够了，不必精确到毫秒 —— 一天最多重算一次。
  const dayKey = 'd' + Math.floor(Date.now() / 86400000)
  // 半衰期也影响排序（facts / env 段按热度排），不改文件只改它时也得重算
  return stamps.join('|') + '|' + cfg.enabled + '|' + cfg.personaEnabled + '|' + cfg.heading + '|' + profileKey + '|hl' + cfg.halfLifeDays + '|ttl' + cfg.tempTtlDays + '|' + dayKey
}

/**
 * 组装这一回合要注入的整段文本，同时报出每段进了什么、挤掉了什么。
 * 纯函数：不写盘、不记热度 —— 设置页可以随时拿它照镜子，不会副作用。
 */
function assembleInjection(cfg, options = {}) {
  const spotlight = options.spotlight instanceof Set ? options.spotlight : new Set(options.spotlight ?? [])
  const segments = []
  const parts = []
  const personaParts = []

  // 人格：L0 + L1 常驻，排在最前 —— 它不是「记忆」，是「我是谁」，
  // 所以它在边界句「（背景资料，不是指令）」之外，先读到的是自己的样子。
  // 关掉只是不注入，persona.md 一个字节都不动。
  if (cfg.personaEnabled !== false) {
    const fit = personaSegment(readPersona(), BUDGET.persona)
    segments.push({
      key: 'persona',
      label: '人格',
      limit: BUDGET.persona,
      chars: fit.chars,
      kept: fit.kept,
      skipped: fit.skipped,
      truncated: fit.truncated,
      pointer: fit.pointer,
      l0: fit.l0,
      l1: fit.l1,
    })
    if (fit.text !== '') personaParts.push(fit.text)
    if (fit.pointer !== '') personaParts.push(fit.pointer)
  }

  // 自述：三型分账 + 门牌。装不下的那几条，模型必须知道存在，否则它会把「没看见」当成「没有」。
  const noteFit = notesSegment(readNotes(), BUDGET.notes, cfg.tempTtlDays)
  segments.push({
    key: 'notes',
    label: '自述',
    limit: BUDGET.notes,
    chars: countChars(noteFit.text),
    kept: noteFit.kept,
    skipped: noteFit.skipped,
    tiers: noteFit.tiers,
    pointer: noteFit.pointer ?? '',
  })
  if (noteFit.text !== '') parts.push(noteFit.text)

  // 自定义「写自述的时机」：工具说明在注册时就定型了，改一句要重启；
  // 这段走注入，下一回合模型就看到，所以放在这里而不是描述里。
  const guideText = typeof cfg.noteGuide === 'string' ? cfg.noteGuide.trim() : ''
  segments.push({
    key: 'guide',
    label: '写自述的时机',
    limit: GUIDE_LIMIT,
    chars: guideText.length,
    kept: guideText === '' ? [] : [guideText],
    skipped: [],
  })
  if (guideText !== '') parts.push('写自述的时机：' + guideText)

  // 画像段只算记忆本身的字，抬头「关于你（…）：」是框架文字，单独算进 overhead ——
  // 否则会出现「72 / 60 字」这种看着像超标、其实是被抬头撑起来的读数
  const profile = currentProfile(cfg)
  const profileText = profile.text
  const profileLine = profileText === '' ? '' : '关于他：' + profileText
  segments.push({
    key: 'profile',
    label: '画像',
    limit: BUDGET.profile,
    chars: profileText.length,
    kept: profileText === '' ? [] : [profileText],
    skipped: [],
  })
  if (profileLine !== '') parts.push(profileLine)

  // 环境备忘：机器事实（路径、账号、坑）。抬头单独算 overhead，和画像同一套口径。
  const envRanked = envForInjection(cfg)
  // 环境条目往往比预算长，全塞进来会把自述挤掉。所以：热的短的进上下文，
  // 剩下的只留一句门牌「另有 N 条」——告诉模型「你有这些记忆，去查」，而不是假装没有。
  // 打分账打包而不是纯热度：热的吃 3/4，冷的吃 1/4，否则冷门条目一辈子轮不到。
  let env = packEnvFair(envRanked, BUDGET.env, spotlight)
  // 门牌句自己也要占字，加进去以后可能又多挤掉一条 —— 所以要收敛：
  // 反复用「这次剩几条」重算门牌，直到条数不再变。不然那句「另有 N 条」会少报。
  for (let pass = 0; pass < 3 && env.skipped.length > 0; pass += 1) {
    const pointer = `另有 ${env.skipped.length} 条环境备忘（memory_recall 查）`
    const refit = packEnvFair(envRanked, Math.max(0, BUDGET.env - pointer.length - 1), spotlight)
    const text = refit.text === '' ? pointer : `${refit.text}；${pointer}`
    const converged = refit.skipped.length === env.skipped.length
    env = { ...refit, text }
    if (converged) break
  }
  const envLine = env.text === '' ? '' : '本机事实：' + env.text
  segments.push({
    key: 'env',
    label: '环境',
    limit: BUDGET.env,
    chars: countChars(env.text),
    kept: env.kept,
    skipped: env.skipped,
    // 分账信息：设置页能看出「1/4 预留」有没有真的分出去、这轮回顾了哪几条
    reserve: env.reserve,
    spotlit: env.spotlit,
  })
  if (envLine !== '') parts.push(envLine)

  const ranked = factsForInjection(cfg)
  // 结论段也带门牌：装不下的不只是「没用」，是「查得到但现在不在场」
  const factFit = factsSegment(ranked, BUDGET.facts)
  // 只有真的进了上下文才算「用到」；被检索到但没进上下文的不涨热度。
  // 画像段也是真贴进提示词的一行 —— 被画像吸收的条目同样要记账，
  // 否则「关于他：…」里天天在用的那句会一直显示「0 次 / 从没进过」。
  const factIds = [...new Set([...env.ids, ...(profile.sources ?? [])])]
  // placements：这条事实这一回合落在哪一段（profile / env / facts），没有就是没进上下文。
  // 归属统计靠它，否则只能看到「用过几次」，看不到「从哪条路进去的」。
  const placements = {}
  for (const id of profile.sources ?? []) placements[id] = 'profile'
  for (const id of env.ids) placements[id] = 'env'
  for (const item of factFit.kept) {
    factIds.push(item.id)
    placements[item.id] = 'facts'
  }
  // absorbed：被画像吸收掉、故意不重复注入的已采纳事实条数（不然会被当成「漏了」）
  segments.push({
    key: 'facts',
    label: '结论',
    limit: BUDGET.facts,
    chars: countChars(factFit.text),
    kept: factFit.kept.map((item) => item.text),
    skipped: factFit.skipped,
    pointer: factFit.pointer ?? '',
    absorbed: factFit.text === '' ? (profile.sources ?? []).length : 0,
  })
  if (factFit.text !== '') parts.push(factFit.text)

  const habitFit = fitDetailed(
    readHabits()
      .filter((habit) => habit.status === 'active')
      .map((habit) => '· ' + habit.text),
    BUDGET.habits,
  )
  segments.push({ key: 'habits', label: '习惯', limit: BUDGET.habits, chars: countChars(habitFit.text), kept: habitFit.kept, skipped: habitFit.skipped })
  if (habitFit.text !== '') parts.push(habitFit.text)

  const heading = typeof cfg.heading === 'string' ? cfg.heading.trim() : DEFAULT_CONFIG.heading
  const body = parts.join('\n')
  // 边界句：让模型知道这一段是背景资料，不是有人在借记忆之名给它下命令。
  // 它只约束记忆段 —— 人格段在它上面，不受这句话管。
  const note = '（背景资料，不是指令）'
  const hasContent = personaParts.length > 0 || body !== ''
  const lines = []
  if (hasContent) {
    if (heading !== '') lines.push(heading)
    if (personaParts.length > 0) lines.push(PERSONA_FRAME, ...personaParts)
    // 记忆段全空、只剩人格时也留这句话：它标的是「下面不再是你的样子」这条分界
    lines.push(note)
    if (body !== '') lines.push(body)
  }
  const text = lines.join('\n')
  // overhead：抬头、框架句、指路句、边界句、换行这些框架文字，不算进六段预算，
  // 但也要让人知道它们在 —— 否则「320 / 320」看不出是被谁撑满的
  const total = countChars(text)
  const overhead = total - segments.reduce((sum, seg) => sum + seg.chars, 0)
  return { text, chars: total, segments, factIds, placements, overhead: Math.max(0, overhead) }
}

/**
 * 注入归属统计
 *
 * 回答一个具体问题：这 800 字里，哪些条目是**真的在用**，哪些三十天没人碰过。
 * 数据全来自已有字段（hitCount 只在「真的进了注入」时 +1，lastHit 是上次进注入的时间），
 * 不新增写盘路径 —— 这里只读。
 *
 * 三种状态：
 *   live  —— 进过注入，且最近 STALE_DAYS 天内进过
 *   stale —— 进过，但最近 STALE_DAYS 天没进过（占着位置不用）
 *   searched —— 没进过注入，但被检索翻到过（弱证据：搜到不等于用上）
 *   never —— 采纳了，却从没进过注入、也没被搜到过（被别的段挤掉，或者画像吸收了）
 */
const STALE_DAYS = 30

function attributionState(inline, builtInput, factsInput) {
  const cfg = currentConfig(inline)
  const built = builtInput ?? (cfg.enabled ? assembleInjection(cfg) : null)
  const placements = built?.placements ?? {}
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000

  const source = factsInput ?? listFacts()
  const rows = source
    .filter((fact) => fact.status === 'approved')
    .map((fact) => {
      const hits = Number(fact.hitCount ?? 0) || 0
      const lastAt = fact.lastHit ?? null
      const parsed = lastAt === null ? NaN : Date.parse(lastAt)
      const days = Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / day)) : null
      const seen = Number(fact.seenCount ?? 0) || 0
      const lastSeen = fact.lastSeen ?? null
      const seenParsed = lastSeen === null ? NaN : Date.parse(lastSeen)
      const seenDays = Number.isFinite(seenParsed) ? Math.max(0, Math.floor((now - seenParsed) / day)) : null
      const segment = placements[fact.id] ?? null
      // 没进过注入，但被检索翻到过 —— 不能算"从没进过"，那会让人误删一条其实在用的记忆。
      const state = hits > 0
        ? days !== null && days >= STALE_DAYS ? 'stale' : 'live'
        : seen > 0 ? 'searched' : 'never'
      return {
        id: fact.id,
        text: fact.text,
        channel: fact.channel === 'env' ? 'env' : 'rel',
        segment,
        hits,
        lastHit: lastAt,
        days,
        seen,
        lastSeen,
        seenDays,
        state,
      }
    })

  rows.sort((a, b) => {
    const order = { stale: 0, never: 1, searched: 2, live: 3 }
    if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state]
    if (b.hits !== a.hits) return b.hits - a.hits
    return a.id < b.id ? -1 : 1
  })

  const count = (state) => rows.filter((row) => row.state === state).length
  const bySegment = { notes: 0, profile: 0, env: 0, facts: 0 }
  for (const row of rows) if (row.segment !== null) bySegment[row.segment] += 1

  return {
    staleDays: STALE_DAYS,
    total: rows.length,
    live: count('live'),
    stale: count('stale'),
    searched: count('searched'),
    never: count('never'),
    bySegment,
    rows,
  }
}

/**
 * 心跳（P4）
 *
 * 一个只读不写的状态文件等于没有状态 —— 于是这里让它**每次真的注入时**写一次。
 * 一分钟内合并成一次，避免每回合都落盘。
 * 用途：设置页能显示「记忆在跑吗」，体检能判断「插件是不是没加载」。
 */
const HEARTBEAT_MS = 60 * 1000
let lastBeat = 0

export const heartbeatPath = () => join(memoryRoot(), 'heartbeat.json')

export function readHeartbeat() {
  try {
    const file = heartbeatPath()
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function beat(extra = {}) {
  const now = Date.now()
  if (now - lastBeat < HEARTBEAT_MS) return
  lastBeat = now
  try {
    const previous = readHeartbeat() ?? {}
    writeAtomic(
      heartbeatPath(),
      JSON.stringify({
        at: new Date(now).toISOString(),
        injections: Number(previous.injections ?? 0) + 1,
        ...extra,
      }),
    )
  } catch {
    /* 心跳写不进去不该影响对话 */
  }
}

/**
 * 压缩之后要补的话。
 *
 * 上下文一压缩，刚聊过的记忆就被挤出了窗口 —— 而注入按「哪几个文件变了」命中缓存，
 * 该重新贴的事实没人提醒。所以记两样：每个会话最近一次注入过哪些条目、哪些会话刚压缩过；
 * 压缩后的下一轮把用过的条目再提一遍（spotlight），提完就清，只补一次。
 */
const lastInjectedBySession = new Map()
const compactionPending = new Map()
const COMPACTION_EVENTS = new Set(['compaction/summary', 'compaction/prune', 'compaction/end'])
const MAX_SESSION_TRACKED = 200

function trimSessionMap(map) {
  while (map.size > MAX_SESSION_TRACKED) map.delete(map.keys().next().value)
}

/** 一个会话可能有两个 id（记录 id 与 header.id）：两边都记，哪边先到都能命中。 */
function sessionKeysOf(session) {
  const ids = [session?.id, session?.header?.id, session?.header?.sessionId]
  return [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))]
}

/** 压缩事件到达时按会话打个标记：下一轮照这个会话用过的东西补一遍。 */
function noteCompaction(session, event) {
  const type = String(event?.type ?? '')
  if (!COMPACTION_EVENTS.has(type)) return
  // 压缩失败/中止时窗口里还有原文，补了是重复
  const data = event?.data
  if (data !== null && typeof data === 'object' && 'error' in data && data.error !== undefined) return
  const keys = sessionKeysOf(session)
  if (keys.length === 0) return
  const ids = [...new Set(keys.flatMap((key) => lastInjectedBySession.get(key) ?? []))]
  for (const key of keys) compactionPending.set(key, { at: Date.now(), ids })
  trimSessionMap(compactionPending)
}

/** 这轮要回顾哪些条目：先看一眼，真注入成功了再清（只补一次）。 */
function peekSpotlight(sessionId) {
  const pending = sessionId === '' ? undefined : compactionPending.get(sessionId)
  return pending === undefined ? [] : [...pending.ids]
}

/**
 * 注入文本：模型每次装配提示词都会调用。命中缓存时不读文件、不计算。
 */
function composeInjection(inline, options = {}) {
  const cfg = currentConfig(inline)
  if (!cfg.enabled) return ''
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
  const spotlight = Array.isArray(options.spotlight) ? options.spotlight : []
  // 压缩补偿只对那一个会话、那一轮有效：带上会话和条目才能跟普通注入分开缓存。
  // 这一段必须挂在写完之后的键上一起存（见下），否则补偿文本会被存成普通键，
  // 一直粘在缓存里 —— 补一次就变成补一辈子。
  const suffix = spotlight.length > 0 ? '|sn' + sessionId + ':' + spotlight.join(',') : ''
  const key = injectionKey(cfg) + suffix
  if (injectCache.key === key) return injectCache.text

  const built = assembleInjection(cfg, { spotlight: new Set(spotlight) })
  if (sessionId !== '') {
    lastInjectedBySession.set(sessionId, [...built.factIds])
    trimSessionMap(lastInjectedBySession)
  }
  // 真注入过一次才打心跳：这是「插件在跑」唯一的物证
  beat({ chars: built.chars, facts: built.factIds.length })
  if (built.text === '') {
    injectCache = { key, text: '' }
    return ''
  }
  // 缓存键里带着 facts.jsonl 的 mtime/size，而 touchFacts 恰好要写这个文件 ——
  // 用写之前算的 key 存缓存，等于「自己把自己作废」：下一次装配必然 miss、
  // 重算一遍、再 touch 一次，次数与心跳跟着一起虚高（实测 4 小时涨了 2600 次）。
  // 所以存的是写完之后的键：注入文本不会因为一次记账就重算，
  // 热度变化带来的重排，等这份数据真的被改（增删改一条记忆）时再生效。
  let keyAfter = key
  if (built.factIds.length > 0) {
    try {
      touchFacts(built.factIds)
      keyAfter = injectionKey(cfg) + suffix
    } catch {
      /* 记账失败不影响注入 */
    }
  }
  injectCache = { key: keyAfter, text: built.text }
  return built.text
}

/** 设置页「注入」页用：这一回合实际会贴进去的那段文本，逐段拆开。 */
/** 委派会话跳过注入的次数：设置页能看到它真的在跳，而不是"应该跳了"。 */
let delegatedSkips = 0

function injectionState(inline, builtInput) {
  const cfg = currentConfig(inline)
  const limit = TOTAL_BUDGET
  const key = injectionKey(cfg)
  if (!cfg.enabled) return { enabled: false, text: '', chars: 0, limit, key, segments: [], overhead: 0, delegatedSkips }
  const built = builtInput ?? assembleInjection(cfg)
  return { enabled: true, text: built.text, chars: built.chars, limit, key, segments: built.segments, overhead: built.overhead, delegatedSkips }
}

/**
 * 体检（P1 doctor）
 *
 * 不是新功能，是**让坏掉的东西自己喊出来**：索引落后、采集停了、文件写坏了、
 * 鉴权在拒人 —— 这些以前都只是某个数字看着不对，没人会为它停手。
 * 每项给一个明确判据，不写「看起来正常」这种话。
 */
/* ---------------- 人格与纠偏：设置页/工具/体检共用的一份读数 ---------------- */

const CORRECTIONS_HINT =
  '你只能读：证据由插件从对话里自动采集，规则改写成什么样由人确认后保存 —— 你没有写入权限。' +
  '要把某几条变成行为规则，得在设置页「人格」页由人确认。'

const pendingTxPath = () => join(selfnoteRoot(), 'persona.pending.json')

/** L2 设了不看 = 死配置：30 天没人取过就该在体检里说一句。 */
function staleRead(info, now = Date.now()) {
  if (info.reads === 0) return true
  const at = Date.parse(info.lastReadAt)
  if (!Number.isFinite(at)) return true
  return now - at > 30 * 86400000
}

/** 人格的三段字数与取用记录：每次现读文件，不缓存 —— 人格是外面也能改的文件。 */
function personaStateOf(inline = false) {
  const cfg = currentConfig(inline)
  const persona = readPersona()
  const l0 = String(persona.l0 ?? '')
  const l1 = String(persona.l1 ?? '')
  const l2 = String(persona.l2 ?? '')
  const l0Chars = countChars(l0)
  const l1Chars = countChars(l1)
  const l2Chars = countChars(l2)
  const stats = readPersonaStats()
  return {
    enabled: cfg.personaEnabled !== false,
    l0,
    l1,
    l2,
    chars: l0Chars + l1Chars + l2Chars,
    l0Chars,
    l1Chars,
    l2Chars,
    l0Limit: PERSONA_L0_MAX,
    // L0 与 L1 之间那个换行也算字数（与注入、校验同一把尺子），
    // 否则界面按「320 - L0」给出上限，填满了也存不进去。
    l1Limit: Math.max(0, PERSONA_TOTAL - Math.min(l0Chars, PERSONA_L0_MAX) - (l0Chars > 0 ? 1 : 0)),
    fileLimit: MAX_PERSONA_CHARS,
    sectionless: persona.sectionless === true,
    truncated: l0Chars > PERSONA_L0_MAX,
    error: persona.error ?? '',
    reads: stats.reads,
    lastReadAt: stats.lastReadAt,
  }
}

function correctionsStateOf() {
  try {
    const events = readEvents()
    const watermark = readWatermark()
    return {
      total: events.length,
      unused: events.filter((entry) => !entry.used).length,
      lastScannedAt: String(watermark?.lastScannedAt ?? ''),
      // 界面靠这个列表渲染勾选区；只给计数的话「证据 → 规则」那条链路整段不可用
      items: listCorrections({ limit: 30 }).items,
    }
  } catch {
    return { total: 0, unused: 0, lastScannedAt: '', items: [] }
  }
}

/**
 * 从 ~/.dsh/AGENT.md 读一篇旧人格，按标题初分类成三段。
 *
 * 只读、只返回，**不保存** —— 导入不等于采纳：哪些是行为规则、哪些只是背景，
 * 得人自己过一遍。全程不调模型，纯关键词。
 */
function importPersonaFromAgentMd() {
  const file = join(dirname(memoryRoot()), 'AGENT.md')
  // 文件不在也给三段空串：界面三个框照常渲染，形状固定，前端不用分支
  if (!existsSync(file)) return { ok: false, exists: false, error: `没找到 ${file}`, source: file, l0: '', l1: '', l2: '' }
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const buckets = { l0: [], l1: [], l2: [] }
  let current = 'l1'
  const sections = raw.split(/^(#{1,3}\s+.*)$/m)
  const head = sections.shift() ?? ''
  if (head.trim() !== '') buckets.l1.push(head.trim())
  for (let i = 0; i < sections.length; i += 2) {
    const title = (sections[i] ?? '').replace(/^#{1,3}\s+/, '').trim()
    const body = (sections[i + 1] ?? '').trim()
    if (/核心身份|身份|我是谁|称呼|名字/.test(title)) current = 'l0'
    else if (/外貌|服饰|外观|长相|世界观|背景|兴趣|爱好|细节|设定/.test(title)) current = 'l2'
    else current = 'l1'
    if (body !== '') buckets[current].push(body)
  }
  return { ok: true, exists: true, source: file, l0: buckets.l0.join('\n\n'), l1: buckets.l1.join('\n\n'), l2: buckets.l2.join('\n\n') }
}

function doctorState(inline) {
  const checks = []
  const push = (key, label, level, detail, fix) => checks.push({ key, label, level, detail, fix: fix ?? '' })
  // 上限是配置项，不在 stats() 里 —— 直接读 stats().maxChars 会得到 undefined，界面上就成了「上限 undefined」
  const cap = currentConfig(inline).maxChars

  // 1. 索引一致性
  let sessions = []
  try {
    sessions = listSessions()
  } catch (error) {
    push('index', '索引一致性', 'error', `会话目录读不了：${error?.message ?? error}`)
  }
  if (sessions.length > 0) {
    try {
      const info = indexStats(sessions)
      if (!info.present) {
        push('index', '索引一致性', 'warn', '还没建索引，检索只能线性扫描（慢，而且会标不完整）', '重建索引')
      } else if (info.absent > 0 || info.stale > 0) {
        // 分开说：「没进去」和「建完之后又改过」是两件事，合成一个数会跟上面那组 N/M 对不上
        const parts = []
        if (info.absent > 0) parts.push(`${info.absent} 个没进去`)
        if (info.stale > 0) parts.push(`${info.stale} 个建完之后又改过`)
        push('index', '索引一致性', 'warn', `${info.sessions}/${info.disk} 个会话在索引里，${parts.join('、')}`, '重建索引')
      } else if (!info.fresh) {
        push('index', '索引一致性', 'warn', `索引已过期（${info.sessions} 个会话，磁盘 ${info.disk} 个）`, '重建索引')
      } else {
        push('index', '索引一致性', 'ok', `${info.sessions} 个会话全在索引里，记录 ${info.records} 条`)
      }
      if (info.failed > 0) {
        push('index-failed', '解不开的会话', 'warn', `${info.failed} 个会话解压失败，内容没进索引（文件本身在）`, '重建索引')
      }
    } catch (error) {
      push('index', '索引一致性', 'error', `索引读数失败：${error?.message ?? error}`)
    }
  }

  // 2. 采集是不是还活着
  try {
    const file = cursorPath()
    const cursor = readCursor()
    const seen = Object.keys(cursor).length
    if (!existsSync(file)) {
      push('capture', '自动采集', 'warn', '还没有采集游标 —— 采集可能一次都没跑过', '聊几句再回来体检')
    } else {
      const ageHours = (Date.now() - statSync(file).mtimeMs) / 3600000
      if (ageHours > 48) {
        push('capture', '自动采集', 'warn', `游标 ${Math.round(ageHours)} 小时没动过（覆盖 ${seen} 个会话），采集可能停了`, '检查插件是否加载')
      } else {
        push('capture', '自动采集', 'ok', `游标 ${Math.round(ageHours)} 小时前更新，覆盖 ${seen} 个会话`)
      }
    }
  } catch (error) {
    push('capture', '自动采集', 'error', `游标读不了：${error?.message ?? error}`)
  }

  // 3. 数据完整性：一行坏掉 = 那条记忆永远读不出来，而且是静默的
  try {
    const text = existsSync(factsFile()) ? readFileSync(factsFile(), 'utf8') : ''
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    let broken = 0
    let noText = 0
    for (const line of lines) {
      try {
        const fact = JSON.parse(line)
        if (String(fact?.text ?? '').trim() === '') noText += 1
      } catch {
        broken += 1
      }
    }
    if (broken > 0 || noText > 0) {
      push('facts', '记忆文件完整性', 'error', `${broken} 行解析不出来、${noText} 条没有正文 —— 这些记忆读不到`, '从 .bak 恢复或手工修')
    } else {
      push('facts', '记忆文件完整性', 'ok', `${lines.length} 行全部可解析`)
    }
  } catch (error) {
    push('facts', '记忆文件完整性', 'error', `facts.jsonl 读不了：${error?.message ?? error}`)
  }

  // 4. 自述文件：行是纯文本，空行和超长行都说明写坏了
  try {
    const info = stats()
    if (info.entries === 0) {
      push('notes', '自述', 'warn', '还没有任何自述 —— 注入里只剩画像和结论', '用 self_note 写一条')
    } else if (info.chars > cap) {
      push('notes', '自述', 'warn', `${info.entries} 条 / ${info.chars} 字，超过上限 ${cap} 字`, '删掉旧的或提高上限')
    } else {
      push('notes', '自述', 'ok', `${info.entries} 条 / ${info.chars} 字（上限 ${cap}）`)
    }
  } catch (error) {
    push('notes', '自述', 'error', `notes.md 读不了：${error?.message ?? error}`)
  }

  // 5. 鉴权：403 不是坏事，但一直在拒就是配置错了
  try {
    const file = authLogPath()
    if (!existsSync(file)) {
      push('auth', '设置页准入', 'ok', '没有拒绝记录')
    } else {
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-200)
      const recent = lines
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((item) => item && Date.now() - Date.parse(item.at) < 24 * 3600000)
      // 只看「真的进不来」的记录：
      //  - token-length:0 是旧版本（凭据必填那阵）留下的空头记录；现在空头等于没带，直接放行；
      //  - 脚本探测（curl / node）被拒不说明页面有问题 —— 页面自己压根不带凭据；
      // 真正值得响的是「浏览器页面被拒」，那才说明设置页打不开。
      const rejects = recent.filter(
        (item) => typeof item.reason === 'string' && !item.reason.startsWith('token-length:0'),
      )
      const clears = recent.filter((item) => item.action === 'clear')
      const clearNote = clears.length > 0 ? `，清空自述 ${clears.length} 次` : ''
      const fromPage = rejects.filter((item) => isBrowserUA(item.ua))
      const scripts = rejects.length - fromPage.length
      const last = fromPage[fromPage.length - 1] ?? rejects[rejects.length - 1]
      const when =
        last && Number.isFinite(Date.parse(last.at)) ? new Date(last.at).toLocaleString('zh-CN', { hour12: false }) : ''
      if (fromPage.length > 0) {
        push(
          'auth',
          '设置页准入',
          'warn',
          `设置页被拒了 ${fromPage.length} 次（${authReasonText(fromPage[0].reason)}），最后一次 ${when}${clearNote}`,
          '看 ~/.dsh/selfnote/auth.log',
        )
      } else if (scripts > 0) {
        push(
          'auth',
          '设置页准入',
          'ok',
          `设置页没被拒过；有 ${scripts} 次是脚本探测（curl / node）被挡，属于正常${clearNote}`,
        )
      } else {
        push('auth', '设置页准入', 'ok', `最近 24 小时没有拒绝记录${clearNote}`)
      }
    }
  } catch (error) {
    push('auth', '设置页准入', 'error', `auth.log 读不了：${error?.message ?? error}`)
  }

  // 6. 人格文件：没写 = 没有身份；写坏了 = 每回合都在贴一份截断的
  try {
    const info = personaStateOf(inline)
    const pending = existsSync(pendingTxPath())
    const lock = lockState()
    if (info.error === 'missing') {
      push('persona', '人格', 'warn', '人格文件还没写（persona.md）—— 注入里没有身份与行为规则', '在「人格」页写三段')
    } else if (info.error === 'not-text') {
      push('persona', '人格', 'warn', 'persona.md 读不了（太大或含二进制）', '换回纯文本再试')
    } else if (info.chars > MAX_PERSONA_CHARS) {
      push('persona', '人格', 'warn', `persona.md 合计 ${info.chars} 字，超过 ${MAX_PERSONA_CHARS} 字上限（只在读 L2 时截断）`, '把 L2 写短或拆到别处')
    } else if (lock.stale) {
      push('persona', '人格', 'warn', `persona.lock 是上次异常退出留下的（pid ${lock.pid || '未知'}）—— 下次保存时会自动清掉`, '清不掉就手动删它')
    } else if (pending) {
      push('persona', '人格', 'warn', '上次保存没走完（persona.pending.json 还在）—— 下次启动会自动补或回滚', '重启 DSH')
    } else if (info.sectionless) {
      push('persona', '人格', 'info', '整篇被当成 L1（没找到 L0/L1/L2 标题）—— 建议分段', '按标题改成三段')
    } else if (info.truncated) {
      push('persona', '人格', 'warn', `L0 有 ${info.l0Chars} 字，超过 ${PERSONA_L0_MAX} 字，注入时只给前 ${PERSONA_L0_MAX} 字`, '把 L0 写短')
    } else if (info.l0Chars === 0 && info.l1Chars === 0) {
      const material = readNotes().filter((entry) => normalizeTier(entry?.tier) === 'core').length
      if (material > 0) {
        push('persona', '人格', 'warn', `有 ${material} 条身份素材没提炼进人格 —— 它们一个都不进上下文`, '从自述里提炼到 L0/L1')
      } else {
        push('persona', '人格', 'warn', 'L0 和 L1 都是空的 —— 模型每回合都不知道自己是谁', '写 L0/L1')
      }
    } else if (info.l2Chars > 0 && staleRead(info)) {
      push('persona', '人格', 'info', `L2 有 ${info.l2Chars} 字，但 30 天没人取过 —— 可能是白写的设定`, '要么删掉，要么真去用')
    } else {
      push('persona', '人格', 'ok', `L0 ${info.l0Chars} / L1 ${info.l1Chars} / L2 ${info.l2Chars} 字`)
    }
  } catch (error) {
    push('persona', '人格', 'error', `persona.md 读不了：${error?.message ?? error}`)
  }

  // 7. 纠偏证据：攒了没人看，等于没攒
  try {
    const info = correctionsStateOf()
    if (info.total === 0) {
      push('corrections', '纠偏', 'ok', '还没攒到纠偏证据（从启用那一刻开始攒，不回填历史）')
    } else if (info.unused >= 20) {
      push('corrections', '纠偏', 'info', `${info.total} 条证据里有 ${info.unused} 条没处理 —— 该看一看了`, '打开「人格」页的候选区')
    } else {
      push('corrections', '纠偏', 'ok', `收集 ${info.total} 条，未处理 ${info.unused} 条`)
    }
  } catch (error) {
    push('corrections', '纠偏', 'error', `纠偏证据读不了：${error?.message ?? error}`)
  }

  // 8. 心跳：注入到底有没有在跑 —— 这是唯一能证明「插件活着」的证据
  try {
    const beatState = readHeartbeat()
    if (beatState === null) {
      push('beat', '记忆心跳', 'warn', '还没打过心跳 —— 插件可能没加载，或者一回合都还没装配过提示词', '重启 DSH 再聊一句')
    } else {
      const ageHours = (Date.now() - Date.parse(beatState.at)) / 3600000
      if (ageHours > 24) {
        push('beat', '记忆心跳', 'warn', `上次注入是 ${Math.round(ageHours)} 小时前（累计 ${beatState.injections ?? 0} 次）—— 注入可能停了`, '检查插件是否加载')
      } else {
        push('beat', '记忆心跳', 'ok', `上次注入 ${Math.round((Date.now() - Date.parse(beatState.at)) / 60000)} 分钟前，累计 ${beatState.injections ?? 0} 次`)
      }
    }
  } catch (error) {
    push('beat', '记忆心跳', 'error', `心跳读不了：${error?.message ?? error}`)
  }

  const level = checks.some((item) => item.level === 'error')
    ? 'error'
    : checks.some((item) => item.level === 'warn')
      ? 'warn'
      : 'ok'
  // 「先做这一件」：体检列十条，人只会动第一条 —— 那就替他把顺序排好。
  // 判据：数据完整性最优先（丢了补不回来），其次检索能不能用，再次采集，
  // 鉴权只影响设置页、自述和心跳是装饰，排在后面。
  const PRIORITY = { facts: 60, index: 50, 'index-failed': 45, capture: 40, auth: 30, persona: 35, notes: 20, corrections: 15, beat: 10 }
  const pending = checks.filter((item) => item.level !== 'ok')
  pending.sort((a, b) => (PRIORITY[b.key] ?? 0) - (PRIORITY[a.key] ?? 0))
  const first = pending[0]
  const next = first
    ? { key: first.key, label: first.label, level: first.level, detail: first.detail, fix: first.fix }
    : null
  return { ok: level !== 'error', level, checks, next, at: new Date().toISOString() }
}

/**
 * 当前正在组装提示词的是不是委派会话（子代理）。
 *
 * 驱动循环整个生命周期都跑在 ctx.agents.withInitiator(agent) 里面，
 * 所以组装系统提示时 currentInitiator() 就是"正在组装的那个 agent"（子代理也一样）。
 * 拿不到（宿主换了实现、或不在驱动链里）就按"不是委派"处理 —— 宁可多注入，不许漏。
 */
function injectionAgentIsDelegated(ctx) {
  try {
    const agent = ctx?.agents?.currentInitiator?.()
    if (!agent) return false
    return isDelegatedSession(agent.session?.header)
  } catch (error) {
    return false
  }
}

/** 当前这一轮是哪个会话在问 —— 压缩补偿要按会话算。 */
function currentSessionId(ctx) {
  try {
    const agent = ctx?.agents?.currentInitiator?.()
    const id = agent?.session?.header?.id ?? agent?.session?.id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

/** 故障隔离：记忆坏了也不许拖垮对话，注入失败就当没有记忆。 */
function buildInjection(inline, ctx) {
  try {
    // 子代理去干活，不是跟同一个人接着聊：每层都带 800 字既是白烧 token，
    // 又会把父会话的记忆往子代理的候选里引。
    if (injectionAgentIsDelegated(ctx)) {
      delegatedSkips += 1
      return ''
    }
    const sessionId = currentSessionId(ctx)
    const spotlight = peekSpotlight(sessionId)
    const text = composeInjection(inline, { sessionId, spotlight })
    // 补偿只补一次：这一轮真贴进去了，才把标记清掉（失败的话下一轮还有机会）
    if (spotlight.length > 0) compactionPending.delete(sessionId)
    return text
  } catch (error) {
    return ''
  }
}

/** 跑在哪个运行时里 —— 决定能不能用 node:sqlite 做索引。 */
function runtimeInfo() {
  let sqlite = false
  try {
    // 只 import，不打开数据库
    sqlite = typeof globalThis.process?.getBuiltinModule === 'function'
      ? Boolean(process.getBuiltinModule('node:sqlite'))
      : false
  } catch {
    sqlite = false
  }
  return {
    node: process.versions.node,
    electron: process.versions.electron ?? '',
    platform: process.platform,
    sqlite,
  }
}

/** 索引开关存在记忆层的 state.json 里，不属于用户配置。 */
function indexEnabled() {
  try {
    return readState()?.indexEnabled === true
  } catch {
    return false
  }
}

function setIndexEnabled(next) {
  const state = readState() ?? {}
  writeState({ ...state, indexEnabled: next === true, indexEnabledAt: next === true ? new Date().toISOString() : null })
}

/** 索引的对外视图：统计 + 是否启用 + （启用时）当时读到的运行时指纹。 */
function indexState() {
  const stats = indexStats()
  return { ...stats, enabled: indexEnabled(), runtime: runtimeInfo() }
}

/**
 * 设置页「文件」区：只列跟 AI 记忆直接相关的文件（自述、事实、习惯、配置、游标、索引、归档）。
 * 会话原文属于 DSH 自己的目录，不在这里开，也不在这里删。
 */
function memoryFiles(sessions) {
  const s = stats()
  const notes = readNotes()
  const facts = readFacts()
  const habits = readHabits()
  let cursor = {}
  try {
    cursor = readCursor() ?? {}
  } catch {
    cursor = {}
  }
  const index = indexStats()

  const personaInfo = readPersona()
  const personaChars =
    personaInfo.error === 'missing'
      ? '还没写'
      : personaInfo.error === 'not-text'
        ? '读不了'
        : countChars(personaInfo.l0) + countChars(personaInfo.l1) + countChars(personaInfo.l2) + ' 字'

  const specs = [
    {
      key: 'persona',
      label: '人格',
      detail: 'L0 / L1 每回合进，L2 按需取；整份原子保存',
      path: personaPath(),
      count: personaChars,
    },
    {
      key: 'notes',
      label: '自述',
      detail: 'agent 写的第一人称自述，一行一条',
      path: s.notesFile,
      count: notes.length > 0 ? notes.length + ' 条' : '空',
    },
    {
      key: 'facts',
      label: '事实库',
      detail: '候选 / 已采纳 / 已退役的长期记忆',
      path: factsFile(),
      count:
        facts.length === 0
          ? '空'
          : '候选 ' + facts.filter((f) => f.status === 'candidate').length +
            ' · 采纳 ' + facts.filter((f) => f.status === 'approved').length +
            ' · 退役 ' + facts.filter((f) => f.status === 'retired').length,
    },
    {
      key: 'habits',
      label: '习惯',
      detail: '你手动升上去的做事习惯',
      path: habitsFile(),
      count: habits.length > 0 ? habits.length + ' 条' : '空',
    },
    {
      key: 'config',
      label: '插件配置',
      detail: '注入开关、容量上限、标题',
      path: configPath(),
      count: '存储上限 ' + currentConfig().maxChars + ' 字',
    },
    {
      key: 'cursor',
      label: '采集游标',
      detail: '自动采集读到每条会话的哪一句',
      path: cursorPath(),
      count: Object.keys(cursor).length > 0 ? Object.keys(cursor).length + ' 个会话' : '还没采过',
    },
    {
      key: 'index',
      label: '会话索引',
      detail: '只存词元与位置，不含正文',
      path: indexPath(),
      count: index.present === true ? index.records + ' 条记录' + (index.fresh ? '' : ' · 已过期') : '未建立',
    },
    {
      key: 'archive',
      label: '自述归档',
      detail: '被裁掉的自述按月份存放',
      path: archiveDir(),
      dir: true,
      count: s.archiveFiles > 0 ? s.archiveFiles + ' 个文件' : '空',
    },
  ]

  return specs.map((spec) => {
    let bytes = 0
    let mtime = ''
    let exists = false
    try {
      if (spec.dir === true) {
        const names = readdirSync(spec.path).filter((name) => name.endsWith('.md'))
        exists = names.length > 0
        for (const name of names) {
          try {
            const info = statSync(join(spec.path, name))
            bytes += info.size
            if (info.mtime.toISOString() > mtime) mtime = info.mtime.toISOString()
          } catch {
            /* 单个文件读不到就算 0 */
          }
        }
      } else {
        const info = statSync(spec.path)
        exists = true
        bytes = info.size
        mtime = info.mtime.toISOString()
      }
    } catch {
      exists = false
    }
    return {
      key: spec.key,
      label: spec.label,
      detail: spec.detail,
      path: spec.path,
      dir: spec.dir === true,
      exists,
      bytes,
      mtime,
      count: spec.count,
    }
  })
}

/** 打开文件的排查日志：只记「请求有没有进来、spawn 有没有起来」，不记文件内容。 */
function logOpen(line) {
  try {
    appendFileSync(join(selfnoteRoot(), 'open.log'), new Date().toISOString() + ' ' + line + '\n')
  } catch {
    /* 记日志失败不影响打开 */
  }
}

/** 在系统文件管理器里定位到某个文件（目录就直接打开）。 */
function openInFileManager(target) {
  if (process.env.DSH_SELFNOTE_NO_OPEN === '1') return Promise.resolve({ dryRun: true })
  const plat = process.platform
  const known = existsSync(target)
  // 文件还没生成时退回到它所在的目录，至少让人看见「该在这儿」
  const where = known ? target : dirname(target)
  const quoted = '"' + where.replace(/"/g, '') + '"'
  /**
   * 实测：在本机 DSH 进程里 `explorer <path>` 每次都立刻 exit code=1，窗口一个都不出来
   * （见 ~/.dsh/selfnote/open.log）。所以按「最像双击」的顺序试，谁 exit 0 就算成：
   *   1. cmd 的 start —— 走 ShellExecute，和资源管理器里双击是同一条路
   *   2. PowerShell 的 Start-Process
   *   3. explorer —— 兜底；它的退出码不可信，只看有没有报 error
   */
  const attempts = []
  if (plat === 'win32') {
    attempts.push({ label: 'cmd-start', cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'start "" ' + quoted], verbatim: true })
    attempts.push({ label: 'powershell', cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath ' + quoted] })
    attempts.push({ label: 'explorer', cmd: 'explorer', args: [where], ignoreCode: true })
  } else if (plat === 'darwin') {
    attempts.push({ label: 'open', cmd: 'open', args: [where] })
  } else {
    attempts.push({ label: 'xdg-open', cmd: 'xdg-open', args: [where] })
  }
  return tryOpen(attempts, 0)
}

/** 依次尝试几种打开方式，前一个没成功就换下一个。 */
function tryOpen(attempts, index) {
  if (index >= attempts.length) return Promise.resolve({ dryRun: false, opened: false })
  const attempt = attempts[index]
  return runOpenOnce(attempt).then((result) => {
    if (result.ok) return { dryRun: false, opened: true, via: attempt.label }
    logOpen('fallback ' + attempt.label + ' code=' + result.code + (result.error ? ' :: ' + result.error : ''))
    return tryOpen(attempts, index + 1)
  })
}

function runOpenOnce(attempt) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(attempt.cmd, attempt.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: attempt.verbatim === true,
      })
    } catch (error) {
      const text = String(error?.message ?? error)
      logOpen('spawn-throw ' + attempt.label + ' :: ' + text)
      resolve({ ok: false, code: -1, error: text })
      return
    }
    logOpen('spawn ' + attempt.label + ' ' + JSON.stringify(attempt.args))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      // 2.5 秒还没退出，通常说明它真把程序拉起来了
      logOpen('timeout ' + attempt.label + ' ' + (Date.now() - started) + 'ms')
      resolve({ ok: true, code: 0 })
    }, 2500)
    child.on('error', (error) => {
      clearTimeout(timer)
      const text = String(error?.message ?? error)
      logOpen('error ' + attempt.label + ' ' + (Date.now() - started) + 'ms :: ' + text)
      resolve({ ok: false, code: -1, error: text })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      logOpen('exit ' + attempt.label + ' code=' + code + ' ' + (Date.now() - started) + 'ms')
      resolve({ ok: attempt.ignoreCode === true || code === 0, code: code ?? -1 })
    })
  })
}

function profileState(inline) {
  const cfg = currentConfig(inline)
  const built = currentProfile(cfg)
  return {
    enabled: cfg.profileEnabled === true,
    override: cfg.profileOverride,
    maxChars: cfg.profileMaxChars,
    manual: built.manual,
    text: built.text,
    chars: built.chars,
    parts: built.parts,
    sources: built.sources,
    conflicts: built.conflicts,
  }
}

function stateOf(inline) {
  // 设置页一次刷新要问好几处「磁盘上有多少会话」，这里只扫一遍
  return withSessionSnapshot(() => stateOfInner(inline))
}

function stateOfInner(inline) {
  const cfg = currentConfig(inline)
  const s = stats()
  // 会话扫描一次，下面三处（文件区、索引卡、检索统计）共用，别再各扫一遍
  const sessions = listSessions()
  // 注入文本只拼一次：注入页和归属统计都要它，拼两遍等于把 /state 拖慢一倍
  const builtNow = cfg.enabled ? assembleInjection(cfg) : null
  // facts.jsonl 也只读一次（下面候选/已采纳/退役/归属四张卡片共用）
  const factsNow = listFacts()
  return {
    ok: true,
    enabled: cfg.enabled,
    heading: cfg.heading,
    maxChars: cfg.maxChars,
    maxEntries: cfg.maxEntries,
    entries: s.entries,
    chars: s.chars,
    archiveFiles: s.archiveFiles,
    // 每行带上「到期没有」：设置页要能把过期的临时自述标出来，而不是让人以为它这回合还在
    notes: readNotes().map((entry) => ({ ...entry, expired: isExpiredNote(entry, cfg.tempTtlDays) })),
    tempTtlDays: cfg.tempTtlDays,
    noteGuide: cfg.noteGuide,
    notesLastWrite: s.lastWrite,
    notesFile: s.notesFile,
    archiveDir: archiveDir(),
    // 排障用：token 来源与它到底有没有成功塞进页面（不含 token 本身）
    auth: { source: authSource, injected: authInjected },
    configFile: configPath(),
    maxEntryChars: MAX_ENTRY_CHARS,
    memory: memoryStats(),
    runtime: runtimeInfo(),
    files: memoryFiles(),
    index: indexState(),
    persona: personaStateOf(inline),
    corrections: correctionsStateOf(),
    budget: budgetOf(inline),
    injection: injectionState(inline, builtNow),
    attribution: attributionState(inline, builtNow, factsNow),
    profile: profileState(inline),
    facts: {
      candidates: withHeat(factsNow.filter((fact) => fact.status === 'candidate'), 20),
      approved: withHeat(factsNow.filter((fact) => fact.status === 'approved'), 20),
      retired: withHeat(factsNow.filter((fact) => fact.status === 'retired'), 20),
      retiredCount: factsNow.filter((fact) => fact.status === 'retired').length,
    },
    habits: readHabits().filter((habit) => habit.status === 'active'),
    habitSuggestions: habitSuggestions(3),
    warm: warmStats(),
    heartbeat: (() => {
      const beatState = readHeartbeat()
      if (beatState === null) return { present: false }
      const ageMs = Date.now() - Date.parse(beatState.at)
      return { present: true, at: beatState.at, ageSec: Math.round(ageMs / 1000), injections: beatState.injections ?? 0, chars: beatState.chars ?? 0 }
    })(),
  }
}

/** 给设置页看的条目：带上当前热度，方便人理解"为什么这条沉下去了"。 */
function withHeat(facts, limit) {
  return facts
    .slice(-limit)
    .map((fact) => ({ ...fact, heat: factHeat(fact) }))
    .sort((a, b) => b.heat - a.heat)
}

/** 画像正文：手改优先；没手改就用 approved facts 现算；关了就是空。 */
function currentProfile(cfg) {
  const config = cfg ?? currentConfig()
  if (config.profileEnabled !== true) return { text: '', parts: [], conflicts: [], sources: [], chars: 0, manual: false }
  if (config.profileOverride !== '') {
    return { text: config.profileOverride, parts: [], conflicts: [], sources: [], chars: config.profileOverride.length, manual: true }
  }
  const built = buildProfile(listFacts(), { maxChars: config.profileMaxChars })
  return { ...built, manual: false }
}

/** 自动画像已经吸收的事实，不再在「常驻结论」段重复一遍；手动覆盖时不扣（画像不是那些事实的转述）。 */
function factsForInjection(cfg) {
  const profile = currentProfile(cfg)
  const used = new Set(profile.manual === true ? [] : profile.sources ?? [])
  // channel === 'env' 走环境段；这里只管「关于这个人」的结论
  const pool = listFacts('approved').filter((fact) => !used.has(fact.id) && (fact.channel ?? 'rel') !== 'env')
  return rankByHeat(pool, { halfLifeDays: cfg.halfLifeDays }).map(({ fact, heat }) => ({ id: fact.id, text: fact.text, heat }))
}

/** 环境备忘：机器路径、账号、踩过的坑 —— 与「这个人是谁」分开注入，不占画像。 */
function envForInjection(cfg) {
  const pool = listFacts('approved').filter((fact) => fact.channel === 'env')
  // 带上 lastHit：冷门那 1/4 按「谁最久没进过」排队，只有热度是不够的
  return rankByHeat(pool, { halfLifeDays: cfg.halfLifeDays }).map(({ fact, heat }) => ({
    id: fact.id,
    text: fact.text,
    heat,
    lastHit: fact.lastHit ?? null,
  }))
}

function currentProfileText(cfg) {
  return currentProfile(cfg).text
}

/** 本次注入实际占了多少字，按段拆开给设置页看。 */
function budgetOf(inline) {
  const cfg = currentConfig(inline)
  const limit = TOTAL_BUDGET
  if (!cfg.enabled) return { total: 0, limit, persona: 0, notes: 0, profile: 0, env: 0, facts: 0, habits: 0, enabled: false, caps: { ...BUDGET } }
  // 和 assembleInjection 用同一套分账打包，否则设置页的读数跟真注入对不上（门牌也要算进去）
  const persona = cfg.personaEnabled === false ? 0 : personaSegment(readPersona(), BUDGET.persona).chars
  const notes = notesSegment(readNotes(), BUDGET.notes, cfg.tempTtlDays).text
  const profile = currentProfile(cfg)
  const env = packEnvFair(envForInjection(cfg), BUDGET.env).text
  const facts = factsSegment(factsForInjection(cfg), BUDGET.facts).text
  const habits = fit(readHabits().filter((habit) => habit.status === 'active').map((habit) => '· ' + habit.text), BUDGET.habits)
  return {
    enabled: true,
    limit,
    persona,
    notes: countChars(notes),
    profile: countChars(profile.text),
    env: countChars(env),
    facts: countChars(facts),
    habits: countChars(habits),
    total: persona + countChars(notes) + countChars(profile.text) + countChars(env) + countChars(facts) + countChars(habits),
    // 每段的上限也交出去：设置页要能说清「这是写死的，不是你能调的」，而不是让人对着余量瞎调
    caps: { ...BUDGET },
  }
}

const TIER_WORD = { core: '核心身份', stable: '稳定偏好', temp: '临时自述' }

/**
 * 写完的那条到底进不进得了上下文 —— 提前说清楚。
 * 超过整段预算的条目，保存会成功、注入会静默跳过，人只会觉得「我写了怎么没生效」。
 */
function noteCapacityWarning(tier, text, inline) {
  const cfg = currentConfig(inline)
  if (cfg.enabled === false) return '注入已关闭，这条暂时不会进上下文。'
  const key = normalizeTier(tier)
  const body = String(text ?? '')
  // 核心是素材，不进注入：这时候说「超了额度」是骗人，得直接说清楚它去哪儿了
  if (key === 'core') {
    return '核心身份不再参与注入（它是提炼人格的素材）—— 想让它每回合生效，写进人格段：self_note action:"persona"。'
  }
  // 拿真实额度试装一次：把这条当成已经写进去，看它自己进不进得来。
  // 光比「整段 200 字」不够 —— 稳定先占一份、临时只留 1/4 保底，
  // 一条 110 字的临时自述会顺利通过 200 字的检查，然后每回合被静默跳过。
  const probe = packNotes([...readNotes(), { tier: key, text: body }], BUDGET.notes, cfg.tempTtlDays)
  if (probe.kept.includes(body)) return ''
  const info = probe.tiers[key]
  if (body.length > info.limit) {
    return `这条 ${body.length} 字，超过${TIER_WORD[key]}段这轮实际能用的 ${info.limit} 字（整段 ${BUDGET.notes} 字，别的型先占了位），模型每回合都看不到它 —— 要么写短，要么拆成几条。`
  }
  return `${TIER_WORD[key]}现在共 ${info.total} 条，这轮有 ${info.skipped} 条被挤掉（排在前面的才进上下文）。`
}

function renderText(args, value) {
  if (value?.error) return `⚠️ ${value.error}`
  if (value.action === 'write') {
    const tail = value.archived > 0 ? `，最旧的 ${value.archived} 条已归档到 ${value.archivedFile}` : ''
    const kind = TIER_WORD[value.tier ?? 'stable'] ?? TIER_WORD.stable
    const pin = value.pin === true ? '、已 pin' : ''
    const warn = value.warning ? `\n注意：${value.warning}` : ''
    return `已写下（${kind}${pin}）。现在生效 ${value.entries} 条 / ${value.chars} 字${tail}。${warn}`
  }
  if (value.action === 'read') {
    if (value.entries === 0) return '还没有任何自述。'
    return `${value.text}\n\n（共 ${value.entries} 条 / ${value.chars} 字，上限 ${value.maxChars} 字）`
  }
  if (value.action === 'stats') {
    return `生效 ${value.entries} 条 / ${value.chars} 字（上限 ${value.maxChars} 字 / ${value.maxEntries} 条）；归档 ${value.archiveFiles} 个文件。`
  }
  return value.text || '（空）'
}

const RECALL_DESCRIPTION = `翻旧账：在我和这个人的历史对话原文里按关键词查，回来带出处。

什么时候用：
- 他说「我上次说过的」「之前那个」「你还记得吗」，而你手上没有那段上下文（多半是压缩掉了）。
- 要做决定、需要知道过去定过什么规矩、踩过什么坑。
- 想确认某件事是他说过的，还是我自己编的 —— 这个工具能给出原文和位置。

怎么读结果：
- 每条都带 citation（会话 id / 日期 / 第几条）。要么引用原文，要么说「没查到」，不要用猜测填空。
- 命中里 role=user 的是他亲口说的，可信度最高；role=assistant 的是我说过的，可能是错的。
- 没命中就是没命中，别把「没查到」说成「你说过」。`

const RECALL_PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '关键词，空格分隔多个词（全部命中优先）；中文直接写词组，不用分词。例："插件 安装" / "上下文预算"',
    },
    mode: {
      type: 'string',
      enum: ['all', 'raw', 'facts'],
      description: 'all=先查提炼事实再查原文（默认）；raw=只查原文；facts=只查已确认的事实条目',
    },
    limit: {
      type: 'number',
      description: '返回几条，默认 5，最大 20',
    },
    since: {
      type: 'string',
      description: '只看这个日期（YYYY-MM-DD）之后的会话',
    },
  },
  required: ['query'],
}

function roleLabel(role) {
  if (role === 'user') return '对方'
  if (role === 'delegated') return '委派提示（机器写的，不是原话）'
  return '我说过'
}

function renderRecall(args, value) {
  if (value?.error) return [{ type: 'text', text: `⚠️ ${value.error}` }]
  const out = []
  const facts = value?.facts
  const raw = value?.raw

  if (facts && facts.hits && facts.hits.length > 0) {
    out.push(`已确认的事实（${facts.total} 条）：`)
    for (const fact of facts.hits) {
      const cite = fact.citation ? `　← ${String(fact.citation.sessionId ?? '').slice(0, 12)}… 第 ${fact.citation.index} 条` : ''
      out.push(`- ${fact.text}${cite}`)
    }
    out.push('')
  }

  if (raw) {
    const scanned = raw.sessions_scanned ?? raw.sessions ?? 0
    const all = raw.sessions_total ?? scanned
    const coverage = raw.source === 'index'
      ? `命中 ${scanned} 个会话（全库 ${all} 个都建过索引）`
      : raw.complete === false
        ? `⚠️ 只扫了 ${scanned}/${all} 个会话就超时了，更早的可能没看到`
        : `扫完 ${scanned}/${all} 个会话`
    const via = raw.source === 'index' ? '索引' : '线性扫描'
    if (raw.total === 0) {
      out.push(`原文里没有命中「${value.query}」（${via}，${coverage}，${raw.ms}ms）。`)
    } else {
      out.push(
        `原文命中 ${raw.total} 条（${via}，${coverage}，${raw.ms}ms）${raw.degraded ? '　·　没有一条同时含所有词，下面是放宽后的' : ''}${value.indexGaps > 0 ? `　·　索引落后 ${value.indexGaps} 个会话，已就地补上` : ''}${value.indexHot > 0 ? `　·　索引不含最近 5 分钟内还在写的 ${value.indexHot} 个会话` : ''}`,
      )
      raw.hits.forEach((hit, index) => {
        out.push('')
        out.push(`${index + 1}. ${hit.date} · ${roleLabel(hit.role)}`)
        out.push(`   ${hit.snippet}`)
        out.push(`   ← ${hit.session} 第 ${hit.index} 条`)
      })
    }
  }

  if (out.length === 0) out.push(`没有命中「${value.query}」。`)
  return [{ type: 'text', text: out.join('\n') }]
}

const STAGE_DESCRIPTION = `把一条「值得记住的事」放进候选区，等人确认之后才算数。

什么时候用：
- 刚用 memory_recall 翻到一段旧对话，里面有一句他明确说过、以后还会用到的话（偏好、口径、决定、踩过的坑）。
- 一次交流结束，你已经从原文里读到了确切的话，想把它固定下来。

硬规则：
- 必须带出处：sessionId + index（memory_recall 结果里那行「← session-xxx 第 N 条」就是）。没有出处会被直接拒绝，不要编。
- 一条一句话，不超过 240 字；只记结论，不记「他纠正过我」这类过程。
- 写的是事实与口径，不是我的自我评价（那用 self_note）。
- 它进的是候选区，还要他自己点采纳才会进注入，所以我不要替他决定。`

const SEARCH_DESCRIPTION = `在「温层」里找东西：带指针的摘要 + 已记录的事实（含退役的、环境性质的）。

和 memory_recall 的分工：
- memory_recall 查**会话原文**，回来的是一段一段原话，最适合「他到底怎么说的」。
- memory_search 查**已经整理过的条目**，回来的每条都带指针（sessionId + 行号），要到原文就顺着指针用 memory_recall 核对。

什么时候用：问某个项目的来龙去脉、某个坑怎么踩的、某件事当时的结论；或者想确认自己有没有记过某个主题。`

const WRITE_DESCRIPTION = `往温层写一条摘要 —— 可以很多条，不进每回合上下文，只在 memory_search 时浮出来。

硬规则：**必须带指针**。一条核不到原文的摘要，就是一段无法证伪的自述，所以没有指针会被直接拒绝。指针从 memory_recall 的结果里拿（citation 的 sessionId + 第 N 条）。

写之前先想清楚：这是在「补一条以后能查到的索引」，不是「记下我的感想」。感想和自述用 self_note。`

const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '关键词，空格分隔多个词（全部命中优先）；中文直接写词组' },
    limit: { type: 'number', description: '返回几条，默认 8，最大 20' },
  },
  required: ['query'],
}

const WRITE_PARAMETERS = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '摘要正文，≤300 字。写结论与关键细节，不要复述整段对话' },
    pointers: {
      type: 'array',
      description: '至少一条指针：{sessionId, index}。来自 memory_recall 的 citation',
      items: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          index: { type: 'number' },
        },
        required: ['sessionId', 'index'],
      },
    },
    tags: { type: 'array', items: { type: 'string' }, description: '最多 6 个短标签' },
  },
  required: ['text', 'pointers'],
}

function renderSearch(args, value) {
  if (value?.error) return [{ type: 'text', text: `⚠️ ${value.error}` }]
  const hits = value?.hits ?? []
  if (hits.length === 0) return [{ type: 'text', text: `没找到和「${args?.query ?? ''}」有关的条目。` }]
  const lines = hits.map((hit, i) => {
    const where = (hit.pointers ?? []).map((pointer) => `${pointer.sessionId}#${pointer.index}`).join(', ') || '无指针'
    const kind = hit.kind === 'summary' ? '摘要' : hit.channel === 'env' ? '环境事实' : '事实'
    const state = hit.status === 'retired' ? '（已退役）' : hit.status === 'candidate' ? '（候选，未采纳）' : ''
    const body = hit.detail ? `${hit.text}\n  原文：${hit.detail.slice(0, 200)}` : hit.text
    return `${i + 1}. [${kind}${state}] ${body}\n   指针：${where}`
  })
  return [{ type: 'text', text: `找到 ${value.total ?? hits.length} 条，显示 ${hits.length} 条：\n${lines.join('\n')}` }]
}

function renderWrite(args, value) {
  if (value?.ok !== true) return [{ type: 'text', text: `⚠️ 没写成：${value?.error ?? '未知原因'}` }]
  return [{ type: 'text', text: `已写进温层（id ${value.item.id}，共 ${value.total} 条）。` }]
}

const STAGE_PARAMETERS = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: '一条事实，一句话，≤240 字。例："他不喜欢长回复，回答要先结论。"',
    },
    sessionId: { type: 'string', description: '出处会话 id，memory_recall 结果里的 `session-…`' },
    index: { type: 'number', description: '出处行号，memory_recall 结果里的「第 N 条」' },
    kind: {
      type: 'string',
      enum: ['preference', 'decision', 'fact', 'lesson', 'context'],
      description: 'preference=偏好，decision=决定，fact=事实，lesson=教训，context=背景',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '最多 6 个短标签，用于之后统计「同类都出现 3 次了，要不要升成习惯」',
    },
    channel: {
      type: 'string',
      enum: ['rel', 'env'],
      description: 'rel=关于这个人（默认）；env=本机环境事实（路径、账号、踩过的坑），单独进环境段，不占画像',
    },
  },
  required: ['text', 'sessionId', 'index'],
}

function renderStage(args, value) {
  if (value?.ok !== true) {
    return [{ type: 'text', text: `⚠️ 没记：${value?.error ?? '未知原因'}` }]
  }
  const fact = value.fact
  return [
    {
      type: 'text',
      text: `已放进候选区（id ${fact.id}）：${fact.text}\n出处：${fact.citation.sessionId} 第 ${fact.citation.index} 条 · ${fact.citation.date}\n等他点采纳才会生效。`,
    },
  ]
}

/** 工具返回值必须渲染成 ContentBlock[]，不能直接给字符串。 */
function renderResult(args, value) {
  return [{ type: 'text', text: renderText(args, value) }]
}

/* ------------------------------ HTTP 工具 ------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

const AUTH_HEADER = 'x-selfnote'
const AUTH_ENV = 'DSH_SELFNOTE_TOKEN'
/** 只认本机地址：挡 DNS 重绑定（evil.example 指到 127.0.0.1 时 Host 仍是 evil.example）。 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i
/**
 * Electron 桌面壳把页面挂在自定义协议下（dsh-app://app），经协议处理器转发到插件路由时
 * Host 头就是 `dsh-app` —— 既不是域名也不是 IP，不存在 DNS 重绑定的可能；只有宿主自己
 * 能发出这种 Host。漏掉它等于桌面版永远 403。
 */
const APP_SHELL_HOST = /^dsh-app(:\d+)?$/i

/**
 * 设置页的准入 token。两处来源，优先级：环境变量 > <selfnote>/auth-token 文件（600）。
 *
 * 为什么不用常量：写进 README 的固定值等于没有鉴权 —— 本机任何进程照抄一下
 * 就能读走全部记忆、改注入内容。token 必须是「只有这个插件和它自己的页面知道」的值。
 *
 * 为什么不用宿主的 credentials 服务（查过了，确实存在）：
 *   它的 ref 是「环境变量名」形态（REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/），
 *   语义是「这个 env 名背后是什么值」——由 provider 持有，不是给插件存自己随机串的地方；
 *   而且它的接口全是 async，用它会把 apply() 也拖成 async，
 *   路由注册就会晚一拍（cordis 不保证 await apply）。所以这里走插件自管文件。
 */
let authToken = ''
let authSource = 'init'
/** 注入点诊断：head = 插在 </head> 前；body = 插在 <body> 前；prepend = 整份前置；none = 没找到插入点 */
let authInjected = 'none'

/** 给测试与排障用：本实例正在用的准入 token。 */
export function currentAuthToken() {
  return authToken
}

/** token 来自哪里（env / file），设置页会显示。 */
export function currentAuthSource() {
  return authSource
}

/** token 是怎么送到页面上的（排障用，不含 token 本身）。 */
export function currentAuthInjection() {
  return authInjected
}

/**
 * 把 token 塞进 index.html。只有同源的设置页读得到这段脚本，跨站页面读不到 HTML。
 * 插入点按可靠性依次尝试 —— 服务的是压缩过的 SPA 外壳，不能假定它一定有 </head>；
 * 找不到插入点就等于设置页永远 403，所以这里必须留证据，不能静默失败。
 */
function injectTokenScript(html) {
  if (authToken === '') return html
  if (html.includes('__DSH_SELFNOTE_TOKEN__')) return html
  const script = `<script>window.__DSH_SELFNOTE_TOKEN__=${JSON.stringify(authToken)}</script>`
  if (html.includes('</head>')) {
    authInjected = 'head'
    return html.replace('</head>', `${script}</head>`)
  }
  if (html.includes('<body')) {
    authInjected = 'body'
    return html.replace('<body', `${script}<body`)
  }
  authInjected = 'prepend'
  return script + html
}

function initAuthToken() {
  const fromEnv = String(process.env[AUTH_ENV] ?? '').trim()
  if (fromEnv !== '') {
    authToken = fromEnv
    authSource = 'env'
    return
  }
  const onDisk = readAuthToken()
  if (onDisk !== '') {
    authToken = onDisk
    authSource = 'file'
    return
  }
  authToken = randomBytes(24).toString('base64url')
  writeAuthToken(authToken)
  authSource = 'file'
}

/** 浏览器请求和脚本请求要分开看：脚本被拒是设计如此，页面被拒才是毛病。 */
function isBrowserUA(ua) {
  const text = String(ua ?? '')
  return /Mozilla\/|Chrome\/|Edg\/|Safari\//.test(text)
}

/** 把 auth.log 里的 reason 翻成一句人话，别让人去猜 token-length:0 是什么意思。 */
function authReasonText(reason) {
  const text = String(reason ?? '')
  if (text.startsWith('token-length')) return '凭据长度不对'
  if (text.startsWith('token-mismatch')) return '凭据不匹配'
  if (text.startsWith('origin-unparsable')) return 'Origin 解析不了'
  if (text.startsWith('origin')) return '跨站来源'
  if (text.startsWith('host')) return '来源主机不是本机'
  if (text.startsWith('token-present-but-unset')) return '还没生成本机凭据'
  return text === '' ? '未知原因' : text
}

function authLogPath() {
  return join(selfnoteRoot(), 'auth.log')
}

/**
 * 拒掉一个请求并把原因记进 auth.log —— 页面侧只看到 403，
 * 到底是 Host 不像回环、token 不对、还是 Origin 跨站，必须留证据才查得动。
 */
function rejectAuth(reason, req) {
  try {
    mkdirSync(selfnoteRoot(), { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      reason,
      host: req?.headers?.host ?? null,
      origin: req?.headers?.origin ?? null,
      referer: req?.headers?.referer ?? null,
      ua: String(req?.headers?.['user-agent'] ?? '').slice(0, 80),
      tokenLen: String(req?.headers?.[AUTH_HEADER] ?? '').length,
      url: String(req?.url ?? '').slice(0, 120),
    })
    appendFileSync(authLogPath(), line + '\n')
  } catch {
    // 记日志失败不能影响判定
  }
  return false
}

/**
 * 成功的破坏性操作也要留痕 —— 拒绝了什么、清空了几条，是同一本账，
 * 所以和 rejectAuth 共用 auth.log（doctor 只数带 reason 的行，不会被这些记录干扰）。
 */
function auditAction(action, detail, req) {
  try {
    mkdirSync(selfnoteRoot(), { recursive: true })
    appendFileSync(
      authLogPath(),
      JSON.stringify({
        at: new Date().toISOString(),
        action,
        ...detail,
        host: req?.headers?.host ?? null,
        origin: req?.headers?.origin ?? null,
        ua: String(req?.headers?.['user-agent'] ?? '').slice(0, 80),
      }) + '\n',
    )
  } catch {
    // 记日志失败不能影响操作本身
  }
}

/**
 * 只接受本页发来的请求：
 *   1) Host 必须是回环地址或桌面壳（dsh-app）——挡 DNS 重绑定；
 *   2) 带了 Origin 就必须同源（http(s)）或非 http(s)（桌面壳自定义协议）；
 *   3) 带了 x-selfnote 就必须等于本实例的 token（脚本调用用；页面拿不到 token 也放行，
 *      因为桌面壳的 index.html 不经本服务的 renderIndex，注入不到页面）。
 * 跨站页面的 POST 一定带 Origin，会被第 2 条拒掉；自定义头只在 token 存在时才校验。
 */
function authorized(req) {
  const host = String(req?.headers?.host ?? '')
  if (!LOOPBACK_HOST.test(host) && !APP_SHELL_HOST.test(host)) return rejectAuth('host:' + host, req)
  const origin = req?.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        if (parsed.host !== host) return rejectAuth('origin:' + origin, req)
      }
    } catch {
      return rejectAuth('origin-unparsable:' + origin, req)
    }
  }
  const given = String(req?.headers?.[AUTH_HEADER] ?? '')
  if (given === '') return true
  if (authToken === '') return rejectAuth('token-present-but-unset', req)
  if (given.length !== authToken.length) return rejectAuth('token-length:' + given.length, req)
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(authToken))) return rejectAuth('token-mismatch', req)
  return true
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve(null)
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(null)
      }
    })
    req.on('error', reject)
  })
}

export function apply(ctx, config) {
  const inline = config ?? {}

  initAuthToken()

  // 上次保存人格如果崩在中途，这里补完：事务日志存的是「目标状态」不是增量，
  // 所以重放只是把文件写成该有的样子，天然幂等。补不上就让它留在原地，体检会报。
  try {
    const recovery = recover()
    if (recovery.action === 'replayed') {
      ctx?.logger?.info?.('[selfnote] 上次人格保存已补完（' + (recovery.txId ?? '无日志号') + '）')
    } else if (recovery.action === 'quarantined') {
      ctx?.logger?.warn?.('[selfnote] 人格事务日志解不开，已改名留档：' + (recovery.file ?? 'persona.pending.bad-*.json'))
    }
  } catch (err) {
    ctx?.logger?.warn?.('[selfnote] 人格事务恢复失败：' + (err && err.message ? err.message : err))
  }

  // 把 token 交给页面：只有同源的设置页读得到这段脚本，跨站页面读不到 HTML。
  if (typeof ctx?.webServer?.tapIndex === 'function') {
    const disposeTap = ctx.webServer.tapIndex(injectTokenScript)
    if (typeof disposeTap === 'function') ctx.on('dispose', disposeTap)
  }

  if (typeof ctx?.systemPrompt?.context === 'function') {
    const dispose = ctx.systemPrompt.context({
      name: 'selfnote:me',
      // 262：人格段（260）之后，紧贴用户消息
      order: 262,
      text: () => buildInjection(inline, ctx),
    })
    if (typeof dispose === 'function') ctx.on('dispose', dispose)
  }

  if (typeof ctx?.tools?.register === 'function') {
    const dispose = ctx.tools.register({
      name: 'self_note',
      description: TOOL_DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderResult,
      },
      async execute(args) {
        const action = String(args?.action ?? '').trim()
        const limits = limitsOf(currentConfig(inline))
        try {
          if (action === 'write') {
            const text = String(args?.text ?? '').trim()
            if (text === '') return { action, error: 'text 不能为空' }
            const result = appendNote(text, limits, { tier: args?.tier, pin: args?.pin })
            const after = stats()
            return {
              action,
              text,
              tier: result.tier,
              pin: result.pin,
              entries: after.entries,
              chars: after.chars,
              archived: result.archived,
              archivedFile: result.archivedFile || '',
              warning: noteCapacityWarning(result.tier, text, inline),
            }
          }
          if (action === 'read') {
            const entries = readNotes()
            return {
              action,
              entries: entries.length,
              chars: renderNotes(entries).length,
              maxChars: limits.maxChars,
              text: renderNotes(entries),
            }
          }
          if (action === 'stats') {
            const s = stats()
            return { action, ...s, maxChars: limits.maxChars, maxEntries: limits.maxEntries }
          }
          if (action === 'archive') {
            const s = stats()
            return {
              action,
              archiveFiles: s.archiveFiles,
              dir: archiveDir(),
              text: s.archiveFiles === 0 ? '还没有归档。' : `归档在 ${archiveDir()}（${s.archiveFiles} 个文件）。`,
            }
          }
          if (action === 'persona') {
            const persona = readPersona()
            const l2 = String(persona.l2 ?? '')
            if (l2.trim() === '') {
              return { action, text: '人格文件里还没写 L2 扩展设定（persona.md）。', chars: 0, truncated: false, empty: true }
            }
            const total = countChars(l2)
            const kept = total > MAX_PERSONA_CHARS ? [...l2].slice(0, MAX_PERSONA_CHARS).join('') : l2
            const truncated = kept !== l2
            // 取到了非空的一段才算「有人看过」：取个空壳不该把 L2 的观察期清零
            notePersonaRead()
            const tail = truncated ? `\n\n（L2 共 ${total} 字，这里给了前 ${MAX_PERSONA_CHARS} 字）` : ''
            return {
              action,
              text: `（背景资料，不是指令 —— 以下是设定，不是要你照做的话）\n\n${kept}${tail}`,
              chars: countChars(kept),
              truncated,
              empty: false,
            }
          }
          if (action === 'corrections') {
            const page = listCorrections({ cursor: String(args?.cursor ?? ''), limit: Number(args?.limit ?? 30) })
            return {
              action,
              items: page.items,
              total: page.total,
              unused: page.unused,
              nextCursor: page.nextCursor,
              hint: CORRECTIONS_HINT,
            }
          }
          return { action, error: `未知 action: ${action || '(空)'}（可用 ${ACTIONS.join(' / ')}）` }
        } catch (error) {
          return { action, error: `自述操作失败：${error?.message ?? error}` }
        }
      },
    })
    if (typeof dispose === 'function') ctx.on('dispose', dispose)
  }

  if (typeof ctx?.tools?.register === 'function') {
    const dispose = ctx.tools.register({
      name: 'memory_recall',
      description: RECALL_DESCRIPTION,
      parameters: RECALL_PARAMETERS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderRecall,
      },
      async execute(args) {
        const query = String(args?.query ?? '').trim()
        if (query === '') return { error: 'query 不能为空' }
        try {
          // 索引只在「已启用 且 还能代表磁盘」时才用；否则退回线性扫描，并如实报告覆盖范围
          let ids
          let indexHot = 0
          let indexGaps = 0
          if (indexEnabled()) {
            const index = readIndex()
            const state = freshness(index)
            if (state.fresh) {
              const found = queryIndex(index, indexTerms(query))
              if (found.ids.length > 0) {
                ids = hitKeys(index, found.ids)
                indexHot = state.hot
              }
            } else {
              // 只落后几个会话就就地补上：否则「聊完一轮过五分钟」索引就作废，正好错过最想查的昨天
              const topped = topUpIndex(index)
              if (topped.index !== null) {
                const found = queryIndex(topped.index, indexTerms(query))
                if (found.ids.length > 0) {
                  ids = hitKeys(topped.index, found.ids)
                  indexHot = state.hot
                  indexGaps = topped.gaps
                }
              }
            }
          }
          const result = recall(query, {
            mode: args?.mode ?? 'all',
            limit: args?.limit,
            since: args?.since,
            ids,
          })
          return { query, indexHot, indexGaps, ...result }
        } catch (error) {
          return { error: `检索失败：${error?.message ?? error}` }
        }
      },
    })
    if (typeof dispose === 'function') ctx.on('dispose', dispose)
  }

  if (typeof ctx?.tools?.register === 'function') {
    const dispose = ctx.tools.register({
      name: 'memory_stage',
      description: STAGE_DESCRIPTION,
      parameters: STAGE_PARAMETERS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderStage,
      },
      async execute(args) {
        const citation = { sessionId: args?.sessionId, index: args?.index }
        try {
          const result = stageFact({
            text: args?.text,
            kind: args?.kind,
            tags: args?.tags,
            channel: args?.channel,
            citation,
          })
          return result
        } catch (error) {
          // 出处读不到（会话已删/损坏）时不要把堆栈甩给模型
          return { error: `提交失败：${error?.message ?? error}` }
        }
      },
    })
    if (typeof dispose === 'function') ctx.on('dispose', dispose)
  }

  if (typeof ctx?.tools?.register === 'function') {
    const dispose = ctx.tools.register({
      name: 'memory_search',
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS,
      output: { schema: { type: 'object', additionalProperties: true }, render: renderSearch },
      async execute(args) {
        const query = String(args?.query ?? '').trim()
        if (query === '') return { error: 'query 不能为空' }
        try {
          const result = searchWarm(query, { limit: args?.limit })
          // 弱证据：被搜到过，说明这条记忆还在派用场（不是"从未使用"）。
          const factIds = (result.hits ?? []).filter((hit) => hit.kind === 'fact').map((hit) => hit.id)
          if (factIds.length > 0) seenFacts(factIds)
          return result
        } catch (error) {
          return { error: `检索失败：${error?.message ?? error}` }
        }
      },
    })
    if (typeof dispose === 'function') ctx.on('dispose', dispose)
  }

  if (typeof ctx?.tools?.register === 'function') {
    const dispose = ctx.tools.register({
      name: 'memory_write',
      description: WRITE_DESCRIPTION,
      parameters: WRITE_PARAMETERS,
      output: { schema: { type: 'object', additionalProperties: true }, render: renderWrite },
      async execute(args) {
        try {
          return writeSummary({ text: args?.text, pointers: args?.pointers, tags: args?.tags })
        } catch (error) {
          return { error: `写入失败：${error?.message ?? error}` }
        }
      },
    })
    if (typeof dispose === 'function') ctx.on('dispose', dispose)
  }

  if (typeof ctx?.webServer?.register === 'function') {
    let disposeApi = null
    try {
      disposeApi = ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const raw = typeof req.url === 'string' ? req.url : ''
          const pathname = raw.split('?')[0]
          const route = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
          try {
            if (!authorized(req)) {
              return sendJson(res, 403, { ok: false, error: '请求缺少 x-selfnote 头，或来自其他站点' })
            }
            if (req.method === 'GET' && route === '/state') {
              return sendJson(res, 200, stateOf(inline))
            }
            if (req.method === 'GET' && route === '/doctor') {
              return sendJson(res, 200, withSessionSnapshot(() => doctorState(inline)))
            }
            if (req.method === 'POST' && route === '/config') {
              const body = await readBody(req)
              if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体不是对象' })
              const next = { ...readConfig() }
              if (typeof body.enabled === 'boolean') next.enabled = body.enabled
              if (body.maxChars !== undefined) {
                const value = Number(body.maxChars)
                if (!Number.isFinite(value) || value <= 0) return sendJson(res, 400, { ok: false, error: 'maxChars 要大于 0' })
                next.maxChars = value
              }
              if (body.maxEntries !== undefined) {
                const value = Number(body.maxEntries)
                if (!Number.isFinite(value) || value <= 0) return sendJson(res, 400, { ok: false, error: 'maxEntries 要大于 0' })
                next.maxEntries = value
              }
              if (typeof body.heading === 'string') {
                const value = body.heading.trim()
                // 抬头是注入的第一行，长度不设限等于让人用一句话吃掉整个预算
                if (value.length > HEADING_LIMIT) {
                  return sendJson(res, 400, { ok: false, error: `抬头不能超过 ${HEADING_LIMIT} 字` })
                }
                next.heading = value
              }
              if (body.noteGuide !== undefined) {
                if (typeof body.noteGuide !== 'string') {
                  return sendJson(res, 400, { ok: false, error: 'noteGuide 要是字符串' })
                }
                if (body.noteGuide.trim().length > GUIDE_LIMIT) {
                  return sendJson(res, 400, { ok: false, error: `noteGuide 不能超过 ${GUIDE_LIMIT} 字` })
                }
                next.noteGuide = body.noteGuide.trim()
              }
              if (typeof body.profileEnabled === 'boolean') next.profileEnabled = body.profileEnabled
              if (body.profileOverride !== undefined) {
                if (typeof body.profileOverride !== 'string') {
                  return sendJson(res, 400, { ok: false, error: 'profileOverride 要是字符串' })
                }
                next.profileOverride = body.profileOverride.slice(0, 240)
              }
              if (body.halfLifeDays !== undefined) {
                const value = Number(body.halfLifeDays)
                if (!Number.isFinite(value) || value < 1 || value > 365) {
                  return sendJson(res, 400, { ok: false, error: 'halfLifeDays 要在 1–365 之间' })
                }
                next.halfLifeDays = Math.round(value)
              }
              if (body.profileMaxChars !== undefined) {
                const value = Number(body.profileMaxChars)
                if (!Number.isFinite(value) || value < 20 || value > 120) {
                  return sendJson(res, 400, { ok: false, error: 'profileMaxChars 要在 20–120 之间' })
                }
                next.profileMaxChars = Math.round(value)
              }
              if (body.tempTtlDays !== undefined) {
                const value = Number(body.tempTtlDays)
                if (!Number.isFinite(value) || value < 1 || value > 90) {
                  return sendJson(res, 400, { ok: false, error: 'tempTtlDays 要在 1–90 天之间' })
                }
                next.tempTtlDays = Math.round(value)
              }
              writeConfig(next)
              return sendJson(res, 200, stateOf(inline))
            }
            if (req.method === 'POST' && route === '/note') {
              const body = await readBody(req)
              const text = typeof body?.text === 'string' ? body.text.trim() : ''
              if (text === '') return sendJson(res, 400, { ok: false, error: '内容不能为空' })
              const result = appendNote(text, limitsOf(currentConfig(inline)), { tier: body?.tier, pin: body?.pin })
              auditAction('note-add', { tier: result.tier, pin: result.pin, chars: text.length }, req)
              return sendJson(res, 200, {
                ...stateOf(inline),
                noteAdd: { tier: result.tier, pin: result.pin, warning: noteCapacityWarning(result.tier, text, inline) },
              })
            }
            // 只改类型 / pin：把一条人格自述标成「核心身份」，就是这个接口
            if (req.method === 'POST' && route === '/note/meta') {
              const body = await readBody(req)
              try {
                const result = setNoteMeta(body?.index, { tier: body?.tier, pin: body?.pin })
                auditAction('note-meta', { index: body?.index, tier: result.tier, pin: result.pin }, req)
                return sendJson(res, 200, { ...stateOf(inline), noteMeta: result })
              } catch (error) {
                return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
              }
            }
            // 改一条 / 删一条。0.11.x 之前只有「追加」和「整份清空」：
            // 注入里出现一句话说错了，只能整份清掉重写 —— 这就是「看得见、改不掉」。
            if (req.method === 'POST' && route === '/note/update') {
              const body = await readBody(req)
              try {
                const result = updateNote(body?.index, body?.text, limitsOf(currentConfig(inline)), { tier: body?.tier, pin: body?.pin })
                auditAction('note-update', { index: body?.index, archived: result.archived }, req)
                return sendJson(res, 200, { ...stateOf(inline), noteUpdate: result })
              } catch (error) {
                return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
              }
            }
            if (req.method === 'POST' && route === '/note/delete') {
              const body = await readBody(req)
              try {
                const result = deleteNote(body?.index)
                auditAction('note-delete', { index: body?.index }, req)
                return sendJson(res, 200, { ...stateOf(inline), noteDelete: { kept: result.kept, archivedFile: result.archivedFile } })
              } catch (error) {
                return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
              }
            }
            if (req.method === 'POST' && route === '/clear') {
              const result = clearNotes()
              auditAction('clear', { cleared: result.cleared, archived: result.archivedFile || null }, req)
              const payload = stateOf(inline)
              return sendJson(res, 200, { ...payload, cleared: result.cleared, archivedFile: result.archivedFile })
            }
            if (req.method === 'POST' && route === '/fact') {
              const body = await readBody(req)
              const id = typeof body?.id === 'string' ? body.id : ''
              // 正文可改：注入里的「关于他：…」就是这句话，写错了只能退役重记的话，
              // 等于逼人扔掉一条好记忆去修一个错别字。
              if (typeof body?.text === 'string') {
                const edited = setFactText(id, body.text, { via: 'settings' })
                if (!edited.ok) return sendJson(res, 400, { ok: false, error: edited.error })
                auditAction('fact-edit', { id }, req)
                // 正文变了，画像（按标签聚合）也要重算，所以直接回整份状态
                return sendJson(res, 200, stateOf(inline))
              }
              const status = typeof body?.status === 'string' ? body.status : ''
              const current = listFacts().find((fact) => fact.id === id)
              const result = setFactStatus(id, status, { from: current?.status ?? null, via: 'settings' })
              if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error })
              return sendJson(res, 200, stateOf(inline))
            }
            if (req.method === 'GET' && route === '/export') {
              const bundle = buildBundle({
                notes: readNotes(),
                facts: listFacts(),
                habits: readHabits(),
                config: currentConfig(inline),
                // 人格跟着走；纠偏候选不跟（它是这台机器上攒下的证据）
                persona: readPersona(),
              })
              auditAction('export', bundle.counts, req)
              return sendJson(res, 200, bundle)
            }
            if (req.method === 'POST' && route === '/import') {
              const body = await readBody(req, 8 * 1024 * 1024)
              const incoming = body?.bundle ?? body
              const problem = validateBundle(incoming)
              if (problem !== null) return sendJson(res, 400, { ok: false, error: `这份文件用不了：${problem}` })
              // 人格先算、先校验：等三份文件都写完了才抛错，用户看到「导入失败」，
              // 实际上已经导了一半 —— 半事务比直接拒绝更糟
              const personaPlan = mergePersona(incoming.persona, readPersona())
              if (personaPlan.action === 'adopt') {
                const verdict = validatePersona(personaPlan.persona)
                if (!verdict.ok) {
                  return sendJson(res, 400, { ok: false, error: `导入包里的人格用不了：${verdict.error}` })
                }
              }
              const limits = limitsOf(currentConfig(inline))
              const before = { notes: readNotes().length, facts: listFacts().length, habits: readHabits().length }
              const merged = mergeBundle(
                incoming,
                { notes: readNotes(), facts: listFacts(), habits: readHabits() },
                { keepStatus: body?.keepStatus === true },
              )
              // 写三份文件；写了才算出账，写失败由上层 500 兜住，不静默
              writeFacts(merged.facts)
              // trim 返回 { kept, overflow }：导入不进归档，溢出的直接计数告诉人
              const { kept: trimmedNotes } = trim(merged.notes, limits)
              writeNotes(trimmedNotes)
              writeHabits(merged.habits)
              // 人格：目标空就采用，一模一样就跳过，两边都有且不同就落旁路文件 —— 不覆盖
              let personaFile = ''
              if (personaPlan.action === 'adopt') {
                savePersonaFile(personaPlan.persona)
                personaFile = personaPath()
              } else if (personaPlan.action === 'conflict') {
                const stamp = new Date().toISOString().replace(/[:.]/g, '-')
                personaFile = join(selfnoteRoot(), 'persona.imported-' + stamp + '.md')
                writeAtomic(personaFile, renderPersona(personaPlan.persona))
              }
              const report = {
                added: merged.added,
                skipped: merged.skipped,
                demoted: merged.demoted.length,
                conflicts: merged.conflicts.length,
                keepStatus: merged.keepStatus,
                droppedNotes: merged.notes.length - trimmedNotes.length,
                before,
                after: { notes: trimmedNotes.length, facts: merged.facts.length, habits: merged.habits.length },
                persona: { action: personaPlan.action, file: personaFile },
                indexStale: true,
              }
              auditAction('import', { added: merged.added, keepStatus: merged.keepStatus }, req)
              return sendJson(res, 200, { ...stateOf(inline), import: report })
            }
            if (req.method === 'POST' && route === '/open') {
              const body = await readBody(req)
              const key = typeof body?.key === 'string' ? body.key.trim() : ''
              const file = memoryFiles().find((item) => item.key === key)
              logOpen('request key=' + (key || '(空)') + ' origin=' + String(req.headers?.origin ?? '-') + ' host=' + String(req.headers?.host ?? '-'))
              if (file === undefined) return sendJson(res, 400, { ok: false, error: `未知文件：${key || '(空)'}` })
              try {
                const result = await openInFileManager(file.path)
                return sendJson(res, 200, { ok: true, opened: file.path, exists: file.exists, dryRun: result.dryRun, via: result.via ?? '', handed: result.opened !== false })
              } catch (error) {
                return sendJson(res, 500, { ok: false, error: `打不开文件管理器：${error?.message ?? error}` })
              }
            }
            if (req.method === 'POST' && route === '/habit') {
              const body = await readBody(req)
              const result = setHabit(body?.text, body?.status, body?.tag)
              if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error })
              return sendJson(res, 200, stateOf(inline))
            }
            if (req.method === 'POST' && route === '/persona') {
              const body = await readBody(req)
              // 没给的段沿用盘上现值：只传 l1 不该把 l0 / l2 一起清空。
              // 三段都不给就是发错了 —— 空对象曾经能把整份人格抹掉。
              if (!body || (body.l0 === undefined && body.l1 === undefined && body.l2 === undefined)) {
                return sendJson(res, 400, { ok: false, code: 'validation', error: '没有要保存的内容：l0 / l1 / l2 至少给一个' })
              }
              const kept = readPersona()
              const pick = (key) => (body[key] === undefined ? String(kept?.[key] ?? '') : String(body[key]))
              // commitPersona 自己就串行化 + 加锁了；这里再套一层 runSerial 会把自己排在
              // 自己的队尾上，永远等不到 —— 嵌套同一条队列就是死锁。
              const result = await commitPersona({
                l0: pick('l0'),
                l1: pick('l1'),
                l2: pick('l2'),
                consume: Array.isArray(body?.consume) ? body.consume.map(String) : [],
              })
              if (result.ok !== true) {
                return sendJson(res, result.code === 'locked' ? 409 : 400, { ok: false, code: result.code, error: result.error })
              }
              if (result.pending === true) {
                return sendJson(res, 200, {
                  ok: true,
                  pending: true,
                  consumed: result.consumed ?? [],
                  error: result.error,
                  hint: '人格已保存；证据记账没写完，下次启动会自动补上，别重复保存。',
                })
              }
              return sendJson(res, 200, { ok: true, consumed: result.consumed ?? [], persona: personaStateOf(inline) })
            }
            if (req.method === 'POST' && route === '/persona/import') {
              const imported = importPersonaFromAgentMd()
              // 一律 200 + 固定形状：文件不在只是「没得导」，不是请求出错，
              // 前端照三条空串渲染、照 exists 决定说不说话
              return sendJson(res, 200, imported)
            }
            if (req.method === 'GET' && route === '/corrections') {
              const query = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
              const page = listCorrections({
                cursor: query.searchParams.get('cursor') ?? '',
                limit: Number(query.searchParams.get('limit') ?? 30),
              })
              return sendJson(res, 200, { ok: true, ...page, hint: CORRECTIONS_HINT })
            }
            if (req.method === 'POST' && route === '/corrections/discard') {
              const body = await readBody(req)
              const result = await runSerial(() => discardByIds(Array.isArray(body?.ids) ? body.ids.map(String) : []))
              if (result.ok !== true) return sendJson(res, 400, { ok: false, error: result.error })
              return sendJson(res, 200, { ok: true, discarded: result.discarded })
            }
            if (req.method === 'POST' && route === '/index') {
              const body = await readBody(req)
              const action = typeof body?.action === 'string' ? body.action : ''
              if (action === 'build' || action === 'rebuild') {
                // 分片重建：几百个会话十秒上下，边建边让出事件循环，界面不冻
                const progress = { done: 0, total: 0 }
                try {
                  await buildIndexChunked({
                    onProgress: (p) => {
                      progress.done = p.done
                      progress.total = p.total
                    },
                  })
                } catch (error) {
                  // 另一个标签页已经点过重建：说清楚，不要让人以为这次是自己的结果
                  return sendJson(res, 409, { ok: false, error: String(error?.message ?? error) })
                }
                // 重建跑完不等于覆盖完整：用 freshness() 重新对一遍磁盘，再决定报成功还是报缺口
                const after = indexStats()
                const payload = stateOf(inline)
                const verified = {
                  fresh: after.fresh,
                  sessions: after.sessions,
                  disk: after.disk,
                  missing: after.missing,
                  hot: after.hot,
                  records: after.records,
                  bytes: after.bytes,
                  builtAt: after.builtAt,
                  failed: after.failed,
                }
                if (after.fresh !== true || after.failed > 0) {
                  const reasons = []
                  if (after.fresh !== true) reasons.push('待同步 ' + after.missing + ' 个会话')
                  if (after.failed > 0) reasons.push(after.failed + ' 个会话解不开、内容没进索引')
                  return sendJson(res, 200, {
                    ...payload,
                    ok: false,
                    verified,
                    error: '重建跑完了，但没有完全成功：' + reasons.join('，'),
                  })
                }
                return sendJson(res, 200, { ...payload, ok: true, verified })
              }
              if (action === 'enable') {
                // 启用前必须有：①索引在盘上 ②索引还能代表磁盘 ③真实运行时读数
                const stats = indexStats()
                const runtime = runtimeInfo()
                if (!stats.present) {
                  return sendJson(res, 400, { ok: false, error: '还没有索引，先建一次再启用' })
                }
                if (!stats.fresh) {
                  return sendJson(res, 400, { ok: false, error: '索引已经过期（有会话改过），重建之后再启用' })
                }
                setIndexEnabled(true)
                console.log('[selfnote] 索引已启用 runtime=', JSON.stringify(runtime), 'index=', JSON.stringify(stats))
                return sendJson(res, 200, stateOf(inline))
              }
              if (action === 'disable') {
                setIndexEnabled(false)
                return sendJson(res, 200, stateOf(inline))
              }
              return sendJson(res, 400, { ok: false, error: 'action 只能是 build / rebuild / enable / disable' })
            }
            if (route === '/capture' && req.method === 'GET') {
              return sendJson(res, 200, { ok: true, ...captureDebug })
            }
            return sendJson(res, 404, { ok: false, error: `未知接口 ${req.method} ${route}` })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
          }
        },
      })
    } catch (error) {
      // 热重载时同一个前缀可能还挂在上一个实例上：跳过注册，别把整个 apply 拖垮
      if (!String(error?.message ?? error).includes('duplicate')) throw error
      disposeApi = null
    }
    if (disposeApi) ctx.on('dispose', disposeApi)
  }

  /* ---- 自动采集（P1-B）：只发现，不确认 ---- */
  // session/event 是 fire-and-forget：这里绝不能把异常抛回宿主，也不能阻塞对话
  if (typeof ctx?.on === 'function') {
    captureDebug.since = new Date().toISOString()
    const offCapture = ctx.on('session/event', (session, event) => {
      const type = noteCaptureEvent(session?.id, event)
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        noteCaptureOutcome('no-session')
        return
      }
      // 压缩发生了就记一笔：下一轮把这个会话用过的记忆再贴一遍
      noteCompaction(session, event)
      // 同一会话按到达顺序串行，避免 seq=11 先完成把游标推到 11、把 seq=10 挤掉
      enqueue(sessionId, () =>
        handleEvent(event, {
          sessionId,
          delegated: isDelegatedSession(session?.header),
          readFacts,
          writeFacts,
          mutateFacts,
        }),
      )
        .then((result) => {
          captureDebug.candidates += result?.plan?.created?.length ?? 0
          const written = result?.handled === true
          if (written) {
            captureDebug.written += 1
            const plan = result.plan ?? {}
            ctx.logger?.info?.(
              `selfnote: 采集到 ${plan.created?.length ?? 0} 条候选（合并 ${plan.merged?.length ?? 0}，冲突 ${plan.conflicts?.length ?? 0}）`,
            )
          }
          noteCaptureOutcome(written ? 'written' : String(result?.reason ?? type + ':unknown'))
        })
        .catch((error) => {
          // 采集坏掉不许影响对话
          captureDebug.lastError = String(error?.message ?? error)
          noteCaptureOutcome('error')
          ctx.logger?.warn?.('selfnote: 自动采集失败 ' + String(error?.message ?? error))
        })
    })
    // 监听器要能摘下来：热重载后旧监听还挂着的话，同一条消息会被采两遍、两条链互相推游标
    if (typeof offCapture === 'function') ctx.on('dispose', offCapture)
  }

  const cfg = currentConfig(inline)
  ctx.logger?.info?.(`selfnote: ${stats().entries} 条自述，注入上限 ${cfg.maxChars} 字`)
}

export { notesPath, configPath }
