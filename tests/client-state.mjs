/**
 * 设置页「有数据」时的渲染测试：用一份真实形态的 state 跑一遍组件。
 * 目的是挡住「字段缺失就把整块面板渲染崩」这类问题（自动采集的候选没有 citation），
 * 以及标签页把该显示的内容藏起来/藏错页。
 * 跑法：node tests/client-state.mjs
 */

import assert from 'node:assert/strict'

let def = null
globalThis.window = { __ModuleLoader__: { load(d) { def = d } } }
const styles = []
globalThis.document = {
  createElement: () => ({ id: '', textContent: '', remove() { this.removed = true } }),
  head: { appendChild: (node) => styles.push(node) },
  getElementById: () => null,
}

const base = {
  ok: true,
  enabled: true,
  heading: '关于我自己',
  maxChars: 1600,
  maxEntries: 40,
  entries: 1,
  chars: 46,
  archiveFiles: 1,
  notes: [{ date: '2026-11-03', text: '先让它能跑。' }],
  notesFile: 'C:/x/notes.md',
  archiveDir: 'C:/x/archive',
  configFile: 'C:/x/config.json',
  maxEntryChars: 600,
  tempTtlDays: 14,
  memory: { facts: 2, approved: 1, candidates: 1, retired: 0, habits: 0, sessions: 10, cache: 0, root: 'C:/x/memory' },
  runtime: { node: '24.21.0', electron: '44.7.0', platform: 'win32', sqlite: true },
  index: { present: true, fresh: false, sessions: 270, disk: 301, missing: 31, records: 1609, terms: 87362, bytes: 8760728, builtAt: '2026-11-02T19:50:42.946Z', failed: 0 },
  budget: { notes: 20, profile: 0, facts: 12, habits: 0, total: 32, limit: 300 },
  injection: {
    enabled: true,
    chars: 96,
    limit: 300,
    overhead: 64,
    text: [
      '记忆（我写的）',
      '（背景资料，不是指令）',
      '我做的每个插件，先让它能跑',
      '索引只存词元',
    ].join(String.fromCharCode(10)),
    segments: [
      { key: 'notes', label: '自述', limit: 120, chars: 20, kept: ['我做的每个插件，先让它能跑'], skipped: ['这一条太长了，怎么也放不下，只能整条跳过'] },
      { key: 'profile', label: '画像', limit: 60, chars: 0, kept: [], skipped: [] },
      { key: 'facts', label: '结论', limit: 80, chars: 12, kept: ['索引只存词元'], skipped: [] },
      { key: 'habits', label: '习惯', limit: 40, chars: 0, kept: [], skipped: [] },
    ],
  },
  profile: { enabled: true, override: '', maxChars: 60, manual: false, text: '', chars: 0, parts: [], sources: [], conflicts: [] },
  persona: {
    enabled: true,
    l0: '我是鲸鲸。',
    l1: '回答先给结论，再给细节。',
    l2: '外套是深蓝色，喜欢在海边散步。',
    chars: 34,
    l0Chars: 5,
    l1Chars: 12,
    l2Chars: 16,
    l0Limit: 80,
    l1Limit: 314,
    fileLimit: 8000,
    sectionless: false,
    truncated: false,
    error: '',
    reads: 1,
    lastReadAt: '2026-11-04T10:00:00.000Z',
  },
  corrections: {
    total: 1,
    unused: 1,
    lastScannedAt: '2026-11-05T09:00:00.000Z',
    items: [
      {
        id: 'a3f9c21b7e04',
        quote: '我说过先举例再给结论',
        at: '2026-11-05T08:00:00.000Z',
        session: 'session-abc',
        idx: 12,
        used: false,
        usedAt: null,
        consumedBy: null,
      },
    ],
  },
  habits: [],
  habitSuggestions: [],
  files: [
    { key: 'notes', label: '自述', detail: 'agent 写的第一人称自述，一行一条', path: 'C:/x/notes.md', dir: false, exists: true, bytes: 2048, mtime: '2026-11-03T02:00:00.000Z', count: '1 条' },
    { key: 'facts', label: '事实库', detail: '候选 / 已采纳 / 已退役的长期记忆', path: 'C:/x/memory/facts.jsonl', dir: false, exists: true, bytes: 3570, mtime: '2026-11-03T03:00:00.000Z', count: '候选 1 · 采纳 1 · 退役 0' },
    { key: 'index', label: '会话索引', detail: '只存词元与位置，不含正文', path: 'C:/x/memory/index.json', dir: false, exists: false, bytes: 0, mtime: '', count: '未建立' },
  ],
}

// 关键：这两条是自动采集来的，没有 citation，只有 source / occurrences，而且互相冲突
const withCandidates = {
  ...base,
  facts: {
    candidates: [
      { id: 'auto-1', text: '以后回答先给结论', status: 'candidate', source: 'session-abc#12', occurrences: 4, triggers: ['standing'], conflictWith: 'auto-2', similarTo: ['auto-2'], evidence: ['session-abc#12'] },
      { id: 'auto-2', text: '以后回答先铺垫背景再给结论', status: 'candidate', source: 'session-abc#30', occurrences: 1, triggers: ['correct'], conflictWith: 'auto-1', similarTo: ['auto-1'], evidence: ['session-abc#30'] },
    ],
    approved: [
      { id: 'f1', text: '索引只存词元', status: 'approved', citation: { sessionId: 'session-abc', index: 7, date: '2026-11-02' }, heat: 1.5 },
    ],
    retired: 0,
  },
}

const noCandidates = {
  ...base,
  facts: { candidates: [], approved: withCandidates.facts.approved, retired: 0 },
}

let current = withCandidates
let useStateCall = 0
// 点页签要模拟交互；这个假 React 只能按调用顺序塞值 —— 顺序变了下面的断言会立刻炸
let forcedTab = null
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState(initial) {
    useStateCall += 1
    if (useStateCall === 1) return [current, () => {}]
    if (forcedTab !== null && useStateCall === 9) return [forcedTab, () => {}]
    if (forcedTab !== null && useStateCall === 10) return [true, () => {}]
    // 第 21 个是「临时自述保质期」：从 state 里取，好断言它真的渲染出来了
    if (useStateCall === 21) return [String(current.tempTtlDays ?? ''), () => {}]
    return [typeof initial === 'function' ? null : initial, () => {}]
  },
  useEffect() {},
  useCallback: (fn) => fn,
}

await import('../lib/client.js')
const mod = def.factory((id) => {
  if (id === 'react') return React
  throw new Error('未知模块：' + id)
})

let registered = null
mod.apply({
  effect(fn) { fn() },
  slots: { inject(name, fn) { fn() }, register(meta, C) { registered = C } },
})

const wrapper = registered({})

function render(state) {
  current = state
  useStateCall = 0
  return wrapper.type({})
}

function collect(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (node.type) out.push(node)
  for (const kid of node.children || []) collect(kid, out)
  return out
}

/* 1. 有自动采集候选：整块能渲染，且默认落在「记忆」页 */
let tree = render(withCandidates)
let json = JSON.stringify(tree)
assert.equal(tree.props.className, 'sn-root')
assert.ok(json.includes('以后回答先给结论'), '候选文本要显示出来')
assert.ok(json.includes('自动采集'), '自动采集的候选要标出来源')
assert.ok(json.includes('出现 4 次'), '要显示出现次数')
assert.ok(json.includes('session-abc'), '手动提交的仍显示 citation')
assert.ok(json.includes('两条说法对不上'), '冲突要并排显示，而不是只给一句提示')
assert.ok(json.includes('以后回答先铺垫背景再给结论'), '冲突对方的内容也要显示出来')
assert.ok(json.includes('长期约定') && json.includes('纠正'), '要显示触发原因')
assert.ok(json.includes('新候选') && json.includes('已有的'), '两侧要标出哪条是新的哪条是旧的')
assert.ok(!json.includes('undefined'), '渲染结果里不该出现 undefined')
console.log('1. 有自动采集候选时也能正常渲染（不再白板）')

/* 2. 标签页：四个页签、一个页签被选中、panel 与页签对得上 */
let nodes = collect(tree)
let tabs = nodes.filter((node) => node.props && node.props.role === 'tab')
assert.equal(tabs.length, 6, '应该有六个页签：概览 / 自述 / 人格 / 记忆 / 画像 / 注入')
assert.deepEqual(
  tabs.map((node) => node.children[0]),
  ['概览', '自述', '人格', '记忆', '画像', '注入'],
)
assert.ok(nodes.some((node) => node.props && node.props.role === 'tablist'), '页签要有 tablist 容器')
const activeTab = tabs.filter((node) => node.props['aria-selected'] === true)
assert.equal(activeTab.length, 1, '同一时刻只能有一个页签被选中')
assert.equal(activeTab[0].props.id, 'sn-tab-memory', '有待审候选时默认开「记忆」')
assert.match(activeTab[0].props.className, /sn-tab-on/)
const panelNodes = nodes.filter((node) => node.props && node.props.role === 'tabpanel')
assert.equal(panelNodes.length, 1, '只渲染当前页签的面板')
assert.equal(panelNodes[0].props.id, 'sn-panel-memory')
assert.equal(panelNodes[0].props['aria-labelledby'], 'sn-tab-memory')
assert.ok(tabs.every((node) => typeof node.props['aria-controls'] === 'string'), '每个页签要指明控制哪个面板')
console.log('2. 六个页签、单选状态与面板 aria 关系都对')

/* 3. 没有待审候选：停在「概览」 */
tree = render(noCandidates)
json = JSON.stringify(tree)
nodes = collect(tree)
tabs = nodes.filter((node) => node.props && node.props.role === 'tab')
const overviewTab = tabs.find((node) => node.props.id === 'sn-tab-overview')
assert.equal(overviewTab.props['aria-selected'], true, '没有待审时默认停在「概览」')
assert.match(json, /sn-panel-overview/)
assert.ok(!json.includes('两条说法对不上'), '没候选时不该渲染候选区')
assert.ok(json.includes('注入与容量'), '概览页要有注入开关与上限')
console.log('3. 没有待审候选时停在概览页，且不渲染空候选区')

/* 4. 每个页签带自己的摘要 badge */
tabs = collect(render(withCandidates)).filter((node) => node.props && node.props.role === 'tab')
const badges = tabs.map((node) => (node.children[1] ? node.children[1].children[0] : ''))
assert.deepEqual(badges, ['', '1 条', '34 字', '待审 2', '0 字', '96 字'])
console.log('4. 页签 badge 分别是自述条数、人格字数、待审条数、画像字数、注入字数')

/* 5. 画像页：手改覆盖、来源 chip、冲突提示都要在该页里 */
const withProfile = {
  ...withCandidates,
  facts: { candidates: [], approved: withCandidates.facts.approved, retired: 0 },
  profile: {
    enabled: true,
    override: '',
    maxChars: 60,
    manual: false,
    text: '索引：只存词元',
    chars: 40,
    parts: [{ tag: '索引', factId: 'f1' }],
    sources: ['f1'],
    conflicts: [{ tag: '沟通', count: 2 }],
  },
}
forcedTab = 'profile'
tree = render(withProfile)
json = JSON.stringify(tree)
assert.match(json, /sn-panel-profile/, '切到画像页后要渲染画像面板')
assert.ok(json.includes('关于你'), '画像页要有「关于你」那张卡')
assert.ok(json.includes('← f1'), '画像每句要能回溯到来源 id')
assert.ok(json.includes('同标签还有未合并的条目'), '冲突提示要显示')
assert.ok(json.includes('沟通 ×2'))
assert.ok(!json.includes('undefined'), '画像页也不该出现 undefined')
forcedTab = null
console.log('5. 画像页显示来源与冲突，且没有 undefined')

/* 6. 文件卡：标签、路径、大小、条数都在；没生成的降级显示 */
tree = render(base)
json = JSON.stringify(tree)
assert.match(json, /sn-files/, '概览页要有文件区')
assert.ok(json.includes('C:/x/notes.md'), '要显示真实路径')
assert.ok(json.includes('2.0 KB'), '要显示字节大小')
assert.ok(json.includes('候选 1 · 采纳 1 · 退役 0'), '事实库要显示三种状态的条数')
assert.ok(json.includes('还没生成'), '缺文件的条目要说明还没生成')
assert.ok(!json.includes('undefined'), '文件卡不该出现 undefined')
console.log('6. 文件卡显示路径/大小/条数，缺失的降级')

/* 6b. 临时保质期：设置页能看见这个输入框、值来自 state、带保存按钮 */
tree = render(base)
json = JSON.stringify(tree)
assert.ok(json.includes('临时自述保质期'), '概览页要有保质期输入框（不能只在 API 里能改）')
assert.ok(json.includes('"value":"14"'), '保质期输入框要显示 state 里的 tempTtlDays')
assert.ok(json.includes('保存保质期'), '要有保存按钮')
assert.ok(json.includes('1–90 天'), '要说清范围')
console.log('6b. 临时保质期：设置页能改，值来自 state')

/* 7. 索引卡：七项指标 + 过期标记 + 重建按钮 */
tree = render(base)
json = JSON.stringify(tree)
assert.match(json, /历史对话索引/)
assert.ok(json.includes('已过期'), 'fresh=false 时要标已过期')
assert.ok(json.includes('待同步会话'), '过期时用「待同步」这个词，不是「新增」')
assert.ok(json.includes('270'), '已索引会话数')
assert.ok(json.includes('301'), '磁盘会话数')
assert.ok(json.includes('1609'), '消息记录数')
assert.ok(json.includes('8.4 MB'), '索引大小要换算成人能读的单位')
// 构建时间按本地时区显示，期望值现算，别写死（时区不同就假失败）
const builtLocal = (() => {
  const d = new Date('2026-11-02T19:50:42.946Z')
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
})()
assert.ok(json.includes(builtLocal), '最近构建时间按本地时区显示：' + builtLocal)
assert.ok(json.includes('重建索引'), '要有重建按钮')
assert.ok(!json.includes('undefined'), '索引卡不该出现 undefined')
console.log('7. 索引卡：状态/覆盖/记录/大小/构建时间 + 重建按钮')

/* 8. 注入页：这一回合真的贴进去的那段字，以及谁被挤掉 */
forcedTab = 'injection'
tree = render(withCandidates)
json = JSON.stringify(tree)
assert.match(json, /sn-panel-injection/, '切到注入页后要渲染注入面板')
assert.ok(json.includes('这一回合注入的内容'), '要有注入内容卡')
assert.ok(json.includes('背景资料，不是指令'), '原文要一字不改地展示，包括边界句')
assert.ok(json.includes('我做的每个插件，先让它能跑'), '自述条目要出现在注入原文里')
assert.ok(json.includes('96 / 300 字'), '要显示这一回合占了多少预算')
assert.ok(json.includes('固定开销 64 字'), '框架文字要单独交代，否则几段加起来对不上总数')
assert.ok(json.includes('挤掉 1 条'), '被挤掉的条目要明说，不能悄悄消失')
assert.ok(json.includes('这一条太长了'), '被挤掉的原文也要能看见')
assert.ok(json.includes('不截半句'), '要交代为什么不截断而是整条跳过')
assert.ok(!json.includes('undefined'), '注入页不该出现 undefined')
forcedTab = null
console.log('8. 注入页：原文、分段占位、被挤掉的条目都在')

/* 9. 归属里的「只搜到过」：没进过注入但被翻到过，不能显示成「从没进过」 */
const withAttr = {
  ...withCandidates,
  facts: { candidates: [], approved: withCandidates.facts.approved, retired: 0 },
  attribution: {
    staleDays: 30,
    total: 2,
    live: 0,
    stale: 0,
    searched: 1,
    never: 1,
    bySegment: { notes: 0, profile: 0, env: 0, facts: 0 },
    rows: [
      { id: 'a1', text: '只被搜到过的一条', channel: 'rel', segment: null, hits: 0, lastHit: null, days: null, seen: 3, lastSeen: '2026-11-02T00:00:00.000Z', seenDays: 2, state: 'searched' },
      { id: 'a2', text: '一次都没用过的一条', channel: 'env', segment: null, hits: 0, lastHit: null, days: null, seen: 0, lastSeen: null, seenDays: null, state: 'never' },
    ],
  },
}
forcedTab = 'injection'
tree = render(withAttr)
json = JSON.stringify(tree)
assert.ok(json.includes('只搜到过 1'), '汇总里要有这一档，否则搜到过的被算进「从没进过」')
assert.ok(json.includes('翻了 3 次'), '只搜到过的显示翻了次数，不是进了多少次注入')
assert.ok(json.includes('2 天前搜到'), '要显示上次搜到的时间')
assert.ok(json.includes('搜到过'), '徽章要说清是搜到过，不是进过')
assert.ok(json.includes('从没进过'), '真没用过的仍然要显示从没进过')
assert.ok(!json.includes('undefined'), '归属卡不该出现 undefined')
forcedTab = null
console.log('9. 归属卡区分「只搜到过」与「从没进过」')

/* 10. 自述页：每一条都能就地改、就地删 —— 这是「注入改不掉」那个 bug 的正面 */
const twoNotes = {
  ...base,
  facts: { candidates: [], approved: [], retired: 0 },
  habits: [{ text: '先跑测试再交付', tag: '工作', status: 'active', created: '2026-11-02' }],
  notes: [
    { date: '2026-11-01', text: '早一点的这条' },
    { date: '2026-11-03', text: '最新的这条' },
  ],
}
forcedTab = 'notes'
tree = render(twoNotes)
json = JSON.stringify(tree)
nodes = collect(tree)
assert.match(json, /sn-panel-notes/, '切到自述页要渲染自述面板')
assert.ok(json.includes('早一点的这条') && json.includes('最新的这条'), '两条都要显示')
assert.ok(
  json.indexOf('最新的这条') < json.indexOf('早一点的这条'),
  '显示要最新的在前（存储是从旧到新，渲染得反过来）'
)
const rowActions = nodes.filter((node) => node.props && /sn-row-actions/.test(node.props.className || ''))
assert.equal(rowActions.length, 2, '两条自述各有一组行内操作')
const actionLabels = rowActions.map((node) =>
  node.children
    .map((kid) => {
      if (!kid) return ''
      if (kid.type === 'select') return '类型'
      return kid.children ? String(kid.children[0]) : ''
    })
    .join('/'),
)
assert.deepEqual(actionLabels, ['类型/☆/改/删', '类型/☆/改/删'], '每行：类型 + ☆ + 改 + 删')
const rowKids = rowActions.flatMap((node) => node.children)
const actionButtons = rowKids.filter((node) => node.type === 'button')
assert.equal(actionButtons.length, 6, '每行三个按钮：pin / 改 / 删')
assert.ok(
  actionButtons.every((node) => node.type === 'button' && typeof node.props.onClick === 'function'),
  '行内操作要是真按钮，并且真的挂了点击处理'
)
const tierSelects = rowKids.filter((node) => node.type === 'select')
assert.equal(tierSelects.length, 2, '每行一个类型下拉')
assert.ok(
  tierSelects.every((node) => typeof node.props.onChange === 'function'),
  '类型下拉要真的能改'
)
assert.ok(json.includes('改完/删完下一回合生效'), '要说明改完什么时候生效')
assert.ok(!json.includes('undefined'), '自述页不该出现 undefined')
forcedTab = null
console.log('10. 自述页：每条都能就地改/删，最新的排在前面')

/* 11. 已生效的习惯能看见、能撤销 —— 以前只给了「升成习惯」，升上去就下不来 */
forcedTab = 'memory'
tree = render(twoNotes)
json = JSON.stringify(tree)
assert.match(json, /sn-panel-memory/, '切到记忆页要渲染记忆面板')
assert.ok(json.includes('先跑测试再交付'), '已生效的习惯要列出来，不能升完就看不见')
assert.ok(json.includes('撤销'), '要有撤销按钮，否则习惯只能加不能减')
assert.ok(json.includes('不再是习惯，标签和记忆都还在'), '撤销的后果要写清楚，别让人以为是删标签')
assert.ok(!json.includes('undefined'), '习惯区不该出现 undefined')
forcedTab = null
console.log('11. 已生效的习惯能看见、能撤销')


/* 12. 人格页：三段都能改、字数看得见、纠偏证据只是证据 */
forcedTab = 'persona'
tree = render(base)
json = JSON.stringify(tree)
nodes = collect(tree)
assert.match(json, /sn-panel-persona/, '切到人格页要渲染人格面板')
const personaFields = nodes.filter((node) => node.type === 'textarea')
assert.ok(personaFields.length >= 3, '人格页至少有三个正文框（L0 / L1 / L2），外加纠偏规则草稿')
assert.deepEqual(
  personaFields.slice(0, 3).map((node) => node.props['data-field']),
  ['l0', 'l1', 'l2'],
  '三个框分别是 L0 / L1 / L2',
)
assert.ok(json.includes('我是鲸鲸。'), 'L0 正文要显示出来')
assert.ok(json.includes('回答先给结论，再给细节。'), 'L1 正文要显示出来')
assert.ok(json.includes('外套是深蓝色'), 'L2 正文要显示出来（它不进注入，但人得能改）')
const pL0 = Array.from(base.persona.l0).length
const pL1 = Array.from(base.persona.l1).length
assert.ok(json.includes('L0 ' + pL0 + ' + L1 ' + pL1 + ' = ' + (pL0 + pL1) + ' / 320 字（余 ' + (320 - pL0 - pL1) + '）'), '要说清 320 的账怎么算的')
assert.ok(json.includes(pL0 + ' / 80 字'), 'L0 要有自己的上限提示')
assert.ok(json.includes((320 - pL0) + ' 字'), 'L1 的可用额度是 320 减掉 L0')
assert.ok(json.includes('保存人格'), '要有整份保存按钮')
assert.ok(json.includes('从 AGENT.md 导入'), '要有导入入口（迁移用，导入≠采纳）')
assert.ok(json.includes('我说过先举例再给结论'), '纠偏证据的原话要给出来')
assert.ok(json.includes('你没有写入权限'), '要说明模型只能读证据，不能自己改人格')
assert.ok(!json.includes('undefined'), '人格页不该出现 undefined')
forcedTab = null
console.log('12. 人格页：三段可改、320 的账算得清、纠偏证据只作证据')

/* 13. 核心身份降级：自述列表里明确标出「素材（不注入）」 */
const withCoreNote = {
  ...base,
  facts: { candidates: [], approved: [], retired: 0 },
  notes: [
    { date: '2026-11-05', text: '他很注意隐私！', tier: 'core', pin: true },
    { date: '2026-11-04', text: '回答先给结论。', tier: 'stable' },
  ],
}
forcedTab = 'notes'
tree = render(withCoreNote)
json = JSON.stringify(tree)
assert.ok(json.includes('素材（不注入）'), '核心身份要标出它已经不进注入了，否则人以为它还在生效')
assert.ok(json.includes('他很注意隐私！'), '素材原文仍然要看得到（改型就能回去）')
assert.ok(json.includes('只装「稳定（★ 钉住的先装）」和「临时」'), '要交代清楚现在到底装哪几型')
forcedTab = null
console.log('13. 核心身份在自述页标为「素材（不注入）」')

console.log('\n14 项全部通过')

process.exit(0)
