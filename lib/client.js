/**
 * dsh-selfnote —— 浏览器半侧（手写 __ModuleLoader__ bundle，不需要构建工具）。
 *
 * 在设置页里加「自我叙述」一节：看现在生效的自述、改容量上限、手动写一条、清空（进归档）。
 * 与宿主只走同源 HTTP（/api/selfnote/*）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-selfnote',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState

    var API = '/api/selfnote'

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch (error) {
          data = null
        }
        if (!res.ok) {
          var message = data && data.error ? data.error : 'HTTP ' + res.status
          var failure = new Error(message)
          failure.status = res.status
          throw failure
        }
        return data
      })
    }

    // 准入 token 由宿主在 index.html 里注入：同源页面才读得到，跨站页面拿不到这段脚本。
    // 每个安装都是随机值 —— 不存在「照抄 README 就能进」的固定口令。
    // 自定义头同时是 CSRF 门槛：跨站请求带它会触发预检，服务端不回 CORS 头就发不出去。
    var authToken =
      typeof window !== 'undefined' && typeof window.__DSH_SELFNOTE_TOKEN__ === 'string'
        ? window.__DSH_SELFNOTE_TOKEN__
        : ''

    function apiGet(path) {
      return fetch(API + path, { headers: { accept: 'application/json', 'x-selfnote': authToken } }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-selfnote': authToken },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    /**
     * 一条记忆的出处：手动提交的带 citation，自动采集的只有 source。
     * 自动采集的还要标出出现次数、以及跟谁冲突 —— 否则审核时看不见证据。
     */
    function citeOf(fact) {
      const parts = []
      if (fact.citation && fact.citation.sessionId) {
        parts.push('← ' + fact.citation.sessionId + ' 第 ' + fact.citation.index + ' 条 · ' + (fact.citation.date || ''))
      } else if (fact.source) {
        parts.push('← 自动采集 · ' + fact.source)
      } else {
        parts.push('← 出处未知')
      }
      if (Number(fact.occurrences ?? 1) > 1) parts.push('出现 ' + fact.occurrences + ' 次')
      if (fact.conflictWith) parts.push('↯ 与 ' + fact.conflictWith + ' 冲突')
      else if (fact.similarTo && fact.similarTo.length > 0) parts.push('≈ ' + fact.similarTo.join('、'))
      return parts.join(' · ')
    }

    function Notice(props) {
      if (!props.text) return null
      var tone = props.tone || 'info'
      return h(
        'div',
        { className: 'sn-notice sn-notice-' + tone },
        h('span', { className: 'sn-notice-mark' }, tone === 'ok' ? '✓' : tone === 'warn' ? '!' : 'i'),
        h('span', null, props.text),
      )
    }

    function SelfNoteSection() {
      var stateTuple = useState(null)
      var state = stateTuple[0]
      var setState = stateTuple[1]
      var noticeTuple = useState(null)
      var notice = noticeTuple[0]
      var setNotice = noticeTuple[1]
      var busyTuple = useState('')
      var busy = busyTuple[0]
      var setBusy = busyTuple[1]
      var draftTuple = useState('')
      var draft = draftTuple[0]
      var setDraft = draftTuple[1]
      var maxCharsTuple = useState('')
      var maxChars = maxCharsTuple[0]
      var setMaxChars = maxCharsTuple[1]
      var maxEntriesTuple = useState('')
      var maxEntries = maxEntriesTuple[0]
      var setMaxEntries = maxEntriesTuple[1]
      var profileDraftTuple = useState(null)
      var profileDraft = profileDraftTuple[0]
      var setProfileDraft = profileDraftTuple[1]
      var confirmTuple = useState(false)
      var confirming = confirmTuple[0]
      var setConfirming = confirmTuple[1]
      // 标签页：设置页这一节东西多，摊平看太累；按「概览 / 自述 / 记忆 / 画像」分开
      var tabTuple = useState('overview')
      var tab = tabTuple[0]
      var setTab = tabTuple[1]
      // 用户还没亲手点过标签：这时按数据决定先看哪一页 —— 有待审的就开「记忆」，否则停在「概览」。
      var pickedTuple = useState(false)
      var picked = pickedTuple[0]
      var setPicked = pickedTuple[1]
      // 体检结果：手动跑，不自动跑 —— 它读的东西多，不该拖慢每次打开设置页
      var doctorTuple = useState(null)
      var doctor = doctorTuple[0]
      var setDoctor = doctorTuple[1]

      function apply(data) {
        setState(data)
        setProfileDraft(function (current) {
          return current === null ? (data.profile ? data.profile.override : '') : current
        })
        setMaxChars(String(data.maxChars))
        setMaxEntries(String(data.maxEntries))
      }

      var refresh = useCallback(function () {
        setBusy('load')
        return apiGet('/state')
          .then(function (data) {
            apply(data)
            setNotice(null)
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '读不到状态：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }, [])

      useEffect(function () {
        refresh()
      }, [refresh])

      function runDoctor() {
        setBusy('doctor')
        apiGet('/doctor')
          .then(function (data) {
            setDoctor(data)
            setNotice(null)
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '体检没跑起来：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function saveProfile(override) {
        setBusy('profile')
        apiPost('/config', { profileOverride: override })
          .then(function (data) {
            apply(data)
            setProfileDraft(data.profile ? data.profile.override : '')
            setNotice({ tone: 'ok', text: override === '' ? '已改回自动聚合。' : '画像已保存，下一回合生效。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '保存失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function toggleProfile() {
        setBusy('profile-toggle')
        apiPost('/config', { profileEnabled: !(state.profile && state.profile.enabled) })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: (data.profile && data.profile.enabled) ? '画像已开启。' : '画像已关闭，不再注入。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '切换失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function saveConfig() {
        setBusy('config')
        apiPost('/config', { maxChars: Number(maxChars), maxEntries: Number(maxEntries) })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: '已保存，下一回合生效。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '保存失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function toggleEnabled() {
        setBusy('toggle')
        apiPost('/config', { enabled: !state.enabled })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: data.enabled ? '已开启注入。' : '已关闭注入（内容还留着）。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '切换失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function addNote() {
        var text = draft.trim()
        if (text === '') {
          setNotice({ tone: 'warn', text: '先写点什么再点。' })
          return
        }
        setBusy('note')
        apiPost('/note', { text: text })
          .then(function (data) {
            apply(data)
            setDraft('')
            setNotice({ tone: 'ok', text: '写好了。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '写入失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function clearAll() {
        if (!confirming) {
          setConfirming(true)
          setNotice({ tone: 'info', text: '再点一次「真的清空」——内容会进归档，不会消失。' })
          return
        }
        setBusy('clear')
        apiPost('/clear', {})
          .then(function (data) {
            apply(data)
            setConfirming(false)
            setNotice({ tone: 'ok', text: '已清空 ' + (data.cleared || 0) + ' 条，内容已归档。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '清空失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function setFact(id, status) {
        setBusy('fact')
        apiPost('/fact', { id: id, status: status })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: status === 'approved' ? '已采纳，下一回合进注入。' : '已处理。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '没改成：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function setHabitState(text, status, tag) {
        setBusy('habit')
        apiPost('/habit', { text: text, status: status, tag: tag || '' })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: status === 'active' ? '已升成习惯。' : '已停用这条习惯。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '没改成：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      if (state === null) {
        return h(
          'div',
          { className: 'sn-root' },
          h('div', { className: 'sn-loading' }, busy === 'load' ? '读取中…' : '还没有连上宿主（重启 DSH 试试）'),
        )
      }

      var notes = state.notes || []
      var reversed = notes.slice().reverse()
      var usage = state.maxChars > 0 ? Math.min(100, Math.round((state.chars / state.maxChars) * 100)) : 0
      var candidates = (state.facts && state.facts.candidates) || []
      var approvedFacts = (state.facts && state.facts.approved) || []
      var retiredFacts = (state.facts && state.facts.retired) || []
      var factMap = {}
      candidates.concat(approvedFacts).concat(retiredFacts).forEach(function (item) {
        if (item && item.id) factMap[item.id] = item
      })

      function statusLabel(status) {
        if (status === 'approved') return '已采纳'
        if (status === 'retired') return '已退役'
        return '待确认'
      }

      function triggerLabel(fact) {
        var names = { standing: '长期约定', prohibit: '禁止', prefer: '偏好', correct: '纠正' }
        var list = (fact.triggers || []).map(function (key) { return names[key] || key })
        if (list.length > 0) return list.join(' · ')
        return fact.captureSource === 'auto' ? '自动采集' : '手动提交'
      }

      /** 一条候选/事实的卡片主体：文本、判定依据、出处、操作。 */
      function factBody(fact, withActions) {
        return [
          h('div', { key: 'text', className: 'sn-fact-text' }, fact.text),
          h(
            'div',
            { key: 'meta', className: 'sn-fact-meta' },
            h('span', { className: 'sn-badge' }, triggerLabel(fact)),
            h('span', { className: 'sn-fact-cite' }, citeOf(fact)),
          ),
          withActions
            ? h(
                'div',
                { key: 'actions', className: 'sn-actions' },
                h('button', { className: 'sn-btn', onClick: function () { setFact(fact.id, 'approved') }, disabled: busy !== '' }, '采纳'),
                h('button', { className: 'sn-btn sn-btn-ghost', onClick: function () { setFact(fact.id, 'retired') }, disabled: busy !== '' }, '退役'),
              )
            : h('div', { key: 'state', className: 'sn-fact-cite' }, '状态：' + statusLabel(fact.status)),
        ]
      }

      var suggestions = state.habitSuggestions || []

      var tabs = [
        { key: 'overview', label: '概览' },
        { key: 'notes', label: '自述', badge: notes.length + ' 条' },
        { key: 'memory', label: '记忆', badge: candidates.length > 0 ? '待审 ' + candidates.length : approvedFacts.length + ' 条' },
        { key: 'profile', label: '画像', badge: (state.profile ? state.profile.chars : 0) + ' 字' },
        { key: 'injection', label: '注入', badge: ((state.injection && state.injection.chars) || 0) + ' 字' },
      ]

      var activeTab = picked ? tab : candidates.length > 0 ? 'memory' : 'overview'

      function goTab(event) {
        var keys = tabs.map(function (item) { return item.key })
        var index = keys.indexOf(activeTab)
        var target = null
        if (event.key === 'ArrowRight') target = keys[(index + 1) % keys.length]
        else if (event.key === 'ArrowLeft') target = keys[(index - 1 + keys.length) % keys.length]
        else if (event.key === 'Home') target = keys[0]
        else if (event.key === 'End') target = keys[keys.length - 1]
        if (target === null) return
        event.preventDefault()
        setTab(target)
        setPicked(true)
        var button = document.getElementById('sn-tab-' + target)
        if (button !== null) button.focus()
      }

      var budget = state.budget || {}
      var limit = budget.limit || 460
      var segments = [
        { key: 'notes', label: '自述', value: budget.notes || 0, color: '#60a5fa' },
        { key: 'profile', label: '画像', value: budget.profile || 0, color: '#a78bfa' },
        { key: 'facts', label: '结论', value: budget.facts || 0, color: '#34d399' },
        { key: 'habits', label: '习惯', value: budget.habits || 0, color: '#fbbf24' },
      ]

      var budgetBlock = h(
        'div',
        { className: 'sn-budget', key: 'budget' },
        h(
          'div',
          { className: 'sn-budget-bar', title: '本回合注入 ' + (budget.total || 0) + ' / ' + limit + ' 字' },
          segments.map(function (item) {
            var width = limit > 0 ? Math.max(0, Math.min(100, (item.value / limit) * 100)) : 0
            return h('div', { key: item.key, className: 'sn-budget-seg', style: { width: width + '%', background: item.color } })
          }),
        ),
        h(
          'div',
          { className: 'sn-budget-legend' },
          h('span', { className: 'sn-muted' }, '本回合 ' + (budget.total || 0) + ' / ' + limit + ' 字'),
          segments.map(function (item) {
            return h(
              'span',
              { key: item.key },
              h('span', { className: 'sn-legend-dot', style: { background: item.color } }),
              item.label + ' ' + item.value,
            )
          }),
        ),
      )

      var statusBar = h(
        'div',
        { className: 'sn-statusbar', key: 'status' },
        h('span', { className: 'sn-dot' + (state.enabled ? ' sn-dot-on' : '') }),
        h(
          'span',
          null,
          state.enabled
            ? '注入已开启 · 每回合注入 ' + state.chars + ' 字（约 ' + Math.round(state.chars / 1.6) + ' token）'
            : '注入已关闭 · 内容还在，只是不进上下文',
        ),
        h('span', { className: 'sn-grow' }),
        h('span', { className: 'sn-muted' }, '归档 ' + state.archiveFiles + ' 个文件'),
      )

      var statsRow = h(
        'div',
        { className: 'sn-stats', key: 'stats' },
        h('div', { className: 'sn-stat' }, h('div', { className: 'sn-stat-num' }, state.entries), h('div', { className: 'sn-stat-label' }, '条自述')),
        h('div', { className: 'sn-stat' }, h('div', { className: 'sn-stat-num' }, state.chars), h('div', { className: 'sn-stat-label' }, '字')),
        h('div', { className: 'sn-stat' }, h('div', { className: 'sn-stat-num' }, usage + '%'), h('div', { className: 'sn-stat-label' }, '容量占用')),
      )

      var settingsCard = h(
        'div',
        { className: 'sn-card', key: 'settings' },
        h(
          'div',
          { className: 'sn-card-title' },
          '注入与容量',
        ),
        h(
          'div',
          { className: 'sn-row' },
          h('label', { className: 'sn-toggle' }, h('input', { type: 'checkbox', checked: state.enabled, onChange: toggleEnabled }), h('span', null, '每回合注入')),
          h('span', { className: 'sn-grow' }),
          h('button', { className: 'sn-btn sn-btn-ghost', onClick: refresh, disabled: busy !== '' }, '刷新'),
        ),
        h(
          'div',
          { className: 'sn-limits' },
          h('label', { className: 'sn-field' }, h('span', null, '字数上限'), h('input', { type: 'number', min: 100, max: 8000, value: maxChars, onChange: function (e) { setMaxChars(e.target.value) } })),
          h('label', { className: 'sn-field' }, h('span', null, '条数上限'), h('input', { type: 'number', min: 1, max: 200, value: maxEntries, onChange: function (e) { setMaxEntries(e.target.value) } })),
          h('button', { className: 'sn-btn', onClick: saveConfig, disabled: busy !== '' }, '保存上限'),
        ),
        h('div', { className: 'sn-hint' }, '超出的部分会从最旧的开始挪进 archive，不会丢。'),
      )

      var idx = state.index || {}
      var idxStatus = idx.present !== true ? '未建立' : idx.fresh === true ? '正常' : '已过期'
      var idxTone = idx.present !== true ? 'sn-kv-tag-missing' : idx.fresh === true ? 'sn-kv-tag-ok' : 'sn-kv-tag-stale'

      function kv(label, value) {
        return h(
          'div',
          { className: 'sn-kv-row', key: label },
          h('span', { className: 'sn-kv-key' }, label),
          h('span', { className: 'sn-kv-val' }, value),
        )
      }

      // 重建索引：跑完必须用返回的 verified 验收，HTTP 200 不等于覆盖完整
      function rebuildIndex() {
        setBusy('index')
        apiPost('/index', { action: 'build' })
          .then(function (data) {
            apply(data)
            if (data.ok === false) {
              setNotice({ tone: 'warn', text: data.error || '重建跑完了，但覆盖还没补齐' })
              return
            }
            var v = data.verified || {}
            setNotice({
              tone: 'ok',
              text:
                '索引已重建：' + (v.records ?? '?') + ' 条记录 · 覆盖 ' +
                (v.sessions ?? '?') + '/' + (v.disk ?? '?') + ' 会话 · 待同步 ' + (v.missing ?? 0) +
                (v.failed > 0 ? '（' + v.failed + ' 个解不开）' : ''),
            })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '重建失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      var indexCard = h(
        'div',
        { className: 'sn-card', key: 'index' },
        h(
          'div',
          { className: 'sn-card-head' },
          h('div', { className: 'sn-card-title' }, '历史对话索引'),
          h('div', { className: 'sn-card-note' }, '只存词元与位置，不复制正文'),
        ),
        h(
          'div',
          { className: 'sn-kv' },
          kv('索引状态', h('span', { className: 'sn-kv-tag ' + idxTone }, idxStatus)),
          kv('已索引会话', String(idx.sessions ?? 0)),
          kv('磁盘会话', String(idx.disk ?? 0)),
          kv('待同步会话', String(idx.missing ?? 0)),
          kv('消息记录', String(idx.records ?? 0)),
          kv('索引大小', idx.present === true ? sizeText(idx.bytes) : '—'),
          kv('最近构建', idx.builtAt ? timeText(idx.builtAt) : '—'),
        ),
        h(
          'div',
          { className: 'sn-actions' },
          h('button', { className: 'sn-btn', onClick: rebuildIndex, disabled: busy !== '' }, busy === 'index' ? '重建中…' : '重建索引'),
          h('span', { className: 'sn-grow' }),
          h('span', { className: 'sn-hint' }, idx.present === true && idx.fresh === false ? '过期时不会用索引查，会退回完整扫描' : '重建期间会占住几秒'),
        ),
        h('div', { className: 'sn-hint' }, '查旧账用 memory_recall；原文取自 DSH 自己的会话记录，只读、不外发。'),
      )

      function sizeText(bytes) {
        var n = Number(bytes) || 0
        if (n <= 0) return '0 B'
        if (n < 1024) return n + ' B'
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
        return (n / 1024 / 1024).toFixed(1) + ' MB'
      }

      function timeText(iso) {
        if (!iso) return '—'
        var d = new Date(iso)
        if (isNaN(d.getTime())) return '—'
        function pad(n) {
          return n < 10 ? '0' + n : String(n)
        }
        return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      }

      // 打开文件：宿主侧 spawn 系统文件管理器，浏览器自己做不了这件事
      function openFile(key) {
        setBusy('open')
        apiPost('/open', { key: key })
          .then(function (data) {
            setNotice({
              tone: 'ok',
              text:
                data.exists === false
                  ? '这个文件还没生成，已经打开它所在的目录：' + data.opened
                  : '已经交给系统打开（' + (data.via || 'shell') + '）：' + data.opened + '；窗口没出来就点一下路径复制它',
            })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '打不开：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function copyPath(path) {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          setNotice({ tone: 'warn', text: '这个浏览器不让复制，路径可以直接选中。' })
          return
        }
        navigator.clipboard
          .writeText(path)
          .then(function () {
            setNotice({ tone: 'ok', text: '路径已复制。' })
          })
          .catch(function () {
            setNotice({ tone: 'warn', text: '复制失败，路径可以直接选中。' })
          })
      }

      var files = state.files || []
      var filesBlock = h(
        'div',
        { className: 'sn-card', key: 'files' },
        h(
          'div',
          { className: 'sn-card-head' },
          h('div', { className: 'sn-card-title' }, '文件'),
          h('div', { className: 'sn-card-note' }, '只列和 AI 记忆有关的；会话原文不在这里'),
        ),
        files.length === 0
          ? h('div', { className: 'sn-empty' }, '读不到文件列表。')
          : h(
              'div',
              { className: 'sn-files' },
              files.map(function (file) {
                return h(
                  'div',
                  { key: file.key, className: 'sn-file' + (file.exists ? '' : ' sn-file-missing') },
                  h(
                    'div',
                    { className: 'sn-file-main' },
                    h(
                      'div',
                      { className: 'sn-file-head' },
                      h('span', { className: 'sn-file-label' }, file.label),
                      h('span', { className: 'sn-file-count' }, file.count || '—'),
                    ),
                    h(
                      'div',
                      { className: 'sn-file-path', title: '点一下复制路径', onClick: function () { copyPath(file.path) } },
                      file.path,
                    ),
                    h(
                      'div',
                      { className: 'sn-file-meta' },
                      file.detail + ' · ' + (file.exists ? sizeText(file.bytes) + ' · ' + timeText(file.mtime) : '还没生成'),
                    ),
                  ),
                  h(
                    'button',
                    { className: 'sn-btn sn-btn-ghost sn-file-btn', onClick: function () { openFile(file.key) }, disabled: busy !== '' },
                    '打开',
                  ),
                )
              }),
            ),
      )

      var doctorCard = h(
        'div',
        { className: 'sn-card', key: 'doctor' },
        h(
          'div',
          { className: 'sn-card-head' },
          h('div', { className: 'sn-card-title' }, '体检'),
          h('div', { className: 'sn-card-note' }, '让坏掉的东西自己喊出来，而不是等你去查'),
        ),
        doctor === null
          ? h('div', { className: 'sn-hint' }, '还没跑过。点一下：查索引是否落后、采集是否停了、文件有没有写坏、设置页是否在被拒。')
          : h(
              'div',
              { className: 'sn-doc-list' },
              (doctor.checks || []).map(function (check) {
                return h(
                  'div',
                  { key: check.key, className: 'sn-doc-row' },
                  h(
                    'span',
                    { className: 'sn-doc-tag sn-doc-' + check.level },
                    check.level === 'ok' ? '正常' : check.level === 'warn' ? '注意' : '有问题',
                  ),
                  h('span', { className: 'sn-doc-label' }, check.label),
                  h('span', { className: 'sn-doc-detail' }, check.detail + (check.fix ? '（' + check.fix + '）' : '')),
                )
              }),
            ),
        h(
          'div',
          { className: 'sn-actions' },
          h('button', { className: 'sn-btn', onClick: runDoctor, disabled: busy !== '' }, busy === 'doctor' ? '检查中…' : '跑一次体检'),
          h('span', { className: 'sn-grow' }),
          doctor === null ? null : h('span', { className: 'sn-hint' }, '检查于 ' + timeText(doctor.at)),
        ),
      )

      var writeCard = h(
        'div',
        { className: 'sn-card', key: 'write' },
        h('div', { className: 'sn-card-title' }, '手动写一条'),
        h('div', { className: 'sn-hint' }, '主语是 agent 自己，第一人称「我」指 agent；一句话到三句话，空话和套话不用写。'),
        h('textarea', {
          className: 'sn-input',
          rows: 2,
          placeholder: '第一人称，一句话到三句话；空话和套话不用写。',
          value: draft,
          onChange: function (e) { setDraft(e.target.value) },
        }),
        h(
          'div',
          { className: 'sn-actions' },
          h('button', { className: 'sn-btn', onClick: addNote, disabled: busy !== '' }, '写进去'),
          h('span', { className: 'sn-grow' }),
          h('button', { className: 'sn-btn sn-btn-danger', onClick: clearAll, disabled: busy !== '' }, confirming ? '真的清空' : '清空当前（进归档）'),
        ),
      )

      var notesList = h(
        'div',
        { className: 'sn-card', key: 'notes' },
        h('div', { className: 'sn-card-title' }, '现在生效的内容（agent 的第一人称自述，不是用户的原话）'),
        reversed.length === 0
          ? h('div', { className: 'sn-empty' }, '还没有任何自述。模型攒到第一条时会出现在这里。')
          : h(
              'ul',
              { className: 'sn-list' },
              reversed.map(function (entry, index) {
                return h(
                  'li',
                  { key: index, className: 'sn-item' },
                  h('span', { className: 'sn-date' }, entry.date || '—'),
                  h('span', { className: 'sn-text' }, entry.text),
                )
              }),
            ),
      )

      var profileCard = h(
        'div',
        { className: 'sn-card', key: 'profile' },
        h('div', { className: 'sn-card-title' }, '关于你（从已采纳记忆聚合，不是新事实）'),
        h('div', { className: 'sn-sub' }, '只读你采纳过的记忆；每句都能回溯到下面某条，关掉就不注入。'),
        h('textarea', {
          className: 'sn-input',
          rows: 3,
          placeholder: '留空 = 用自动聚合；写了就按你写的注入',
          value: profileDraft === null ? '' : profileDraft,
          onChange: function (e) { setProfileDraft(e.target.value) },
        }),
        h(
          'div',
          { className: 'sn-row' },
          h(
            'label',
            { className: 'sn-toggle' },
            h('input', { type: 'checkbox', checked: !!(state.profile && state.profile.enabled), onChange: toggleProfile }),
            h('span', null, '每回合注入画像'),
          ),
          h('span', { className: 'sn-grow' }),
          h('button', { className: 'sn-btn sn-btn-ghost', onClick: function () { saveProfile('') }, disabled: busy !== '' }, '用自动聚合'),
          h('button', { className: 'sn-btn', onClick: function () { saveProfile(profileDraft || '') }, disabled: busy !== '' }, '保存画像'),
        ),
        h(
          'div',
          { className: 'sn-hint' },
          '上限 ' + (state.profile ? state.profile.maxChars : 60) + ' 字 · 当前 ' + (state.profile ? state.profile.chars : 0) + ' 字' +
            (state.profile && state.profile.manual ? ' · 手改优先' : ' · 自动聚合'),
        ),
        state.profile && state.profile.parts && state.profile.parts.length > 0
          ? h(
              'ul',
              { className: 'sn-sources' },
              state.profile.parts.map(function (part, index) {
                return h(
                  'li',
                  { key: index, className: 'sn-source' },
                  h('span', { className: 'sn-chip' }, part.tag),
                  h('span', { className: 'sn-muted' }, ' ← ' + part.factId),
                )
              }),
            )
          : null,
        state.profile && state.profile.conflicts && state.profile.conflicts.length > 0
          ? h(
              'div',
              { className: 'sn-hint-warn' },
              '同标签还有未合并的条目：' + state.profile.conflicts.map(function (item) { return item.tag + ' ×' + item.count }).join('、'),
            )
          : null,
      )

      var memoryCard = h(
        'div',
        { className: 'sn-card', key: 'memory' },
        h('div', { className: 'sn-card-title' }, '记忆条目（主语是用户：你明确说过、可以引用的结论）'),
        h(
          'div',
          { className: 'sn-hint' },
          '本回合注入 ' + (budget.total || 0) + ' / ' + limit +
            ' 字　·　自述 ' + (budget.notes || 0) +
            '　画像 ' + (budget.profile || 0) +
            '　结论 ' + (budget.facts || 0) +
            '　习惯 ' + (budget.habits || 0),
        ),

        h('div', { className: 'sn-sub' }, '待确认（' + candidates.length + '）'),
        candidates.length === 0
          ? h('div', { className: 'sn-empty' }, '没有待确认的候选。我翻到值得记的东西时会先放这儿。')
          : candidates.map(function (fact) {
              var partner = fact.conflictWith ? factMap[fact.conflictWith] : null
              if (partner === null || partner === undefined) {
                return h('div', { key: fact.id, className: 'sn-fact' }, factBody(fact, true))
              }
              return h(
                'div',
                { key: fact.id, className: 'sn-fact sn-fact-conflict' },
                h(
                  'div',
                  { className: 'sn-pair-head' },
                  '两条说法对不上 —— 都留着，你来定哪个算数；采纳一条不会自动处理另一条。',
                ),
                h(
                  'div',
                  { className: 'sn-pair' },
                  h(
                    'div',
                    { className: 'sn-pair-side' },
                    h('div', { className: 'sn-pair-tag' }, '新候选'),
                    factBody(fact, true),
                  ),
                  h(
                    'div',
                    { className: 'sn-pair-side' },
                    h('div', { className: 'sn-pair-tag' }, '已有的（' + statusLabel(partner.status) + '）'),
                    factBody(partner, partner.status === 'candidate'),
                  ),
                ),
              )
            }),

        h('div', { className: 'sn-sub' }, '已采纳（' + approvedFacts.length + '）'),
        approvedFacts.length === 0
          ? h('div', { className: 'sn-empty' }, '还没有已采纳的结论。')
          : approvedFacts.map(function (fact) {
              return h(
                'div',
                { key: fact.id, className: 'sn-fact' },
                h('div', { className: 'sn-fact-text' }, fact.text),
                h(
                  'div',
                  { className: 'sn-actions' },
                  h('span', { className: 'sn-heat', title: '热度 = 使用次数 × 时间衰减；只是排序，不改可信度' }, '热度 ' + (fact.heat ?? '—')),
                  h('span', { className: 'sn-grow' }),
                  h('button', { className: 'sn-btn sn-btn-ghost', onClick: function () { setFact(fact.id, 'retired') }, disabled: busy !== '' }, '退役'),
                ),
              )
            }),

        suggestions.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'sn-sub' }, '可以升成习惯'),
              suggestions.map(function (item) {
                return h(
                  'div',
                  { key: item.tag, className: 'sn-fact' },
                  h('div', { className: 'sn-fact-text' }, item.tag + ' ×' + item.count),
                  item.active
                    ? h('div', { className: 'sn-hint' }, '已经是习惯了')
                    : h(
                        'div',
                        { className: 'sn-actions' },
                        h('button', { className: 'sn-btn', onClick: function () { setHabitState(item.tag, 'active', item.tag) }, disabled: busy !== '' }, '升成习惯'),
                      ),
                )
              }),
            )
          : null,
      )

      // 注入页：把「这一回合实际会贴进提示词的那段字」原样摊开，外加谁进了、谁被挤掉
      var inj = state.injection || {}
      var injSegments = inj.segments || []
      var skippedItems = []
      injSegments.forEach(function (seg) {
        ;(seg.skipped || []).forEach(function (text) {
          skippedItems.push({ seg: seg.label, text: text })
        })
      })

      var injectionCard = h(
        'div',
        { className: 'sn-card', key: 'injection' },
        h(
          'div',
          { className: 'sn-card-head' },
          h('div', { className: 'sn-card-title' }, '这一回合注入的内容'),
          h(
            'div',
            { className: 'sn-card-note' },
            (inj.chars || 0) + ' / ' + (inj.limit || 460) + ' 字' +
              (inj.overhead > 0 ? '（含抬头 ' + inj.overhead + ' 字）' : ''),
          ),
        ),
        h('div', { className: 'sn-hint' }, '下面这段每回合都贴在用户消息前面。它只改变「我」看到的背景，不会出现在你的输入框里。'),
        h('pre', { className: 'sn-pre' }, inj.text || '（现在没有可注入的内容）'),
        h(
          'div',
          { className: 'sn-seg' },
          injSegments.map(function (seg) {
            var skipped = seg.skipped || []
            var stateText = seg.chars > 0 ? '全部进入' : '暂无内容'
            if (skipped.length > 0) stateText = '挤掉 ' + skipped.length + ' 条'
            else if (seg.chars === 0 && seg.absorbed > 0) stateText = '已被画像吸收 ' + seg.absorbed + ' 条'
            return h(
              'div',
              { className: 'sn-seg-row', key: seg.key },
              h('span', { className: 'sn-seg-key' }, seg.label),
              h('span', { className: 'sn-seg-num' }, (seg.chars || 0) + ' / ' + seg.limit + ' 字'),
              h('span', { className: 'sn-seg-state' + (skipped.length > 0 ? ' sn-seg-state-warn' : '') }, stateText),
            )
          }),
        ),
        h(
          'div',
          { className: 'sn-hint' },
          '四段只算记忆本身的字数；标题、边界句、画像抬头这些框架文字另计（' + (inj.overhead || 0) + ' 字），也算在总字数里。',
        ),
        skippedItems.length === 0
          ? null
          : h(
              'div',
              { className: 'sn-skipped' },
              h(
                'div',
                { className: 'sn-skipped-head' },
                '被挤掉的 ' + skippedItems.length + ' 条 —— 超出本段预算就整条跳过，不截半句（半句话会变成错结论）',
              ),
              skippedItems.slice(0, 6).map(function (item, i) {
                var text = item.text.length > 60 ? item.text.slice(0, 60) + '…' : item.text
                return h(
                  'div',
                  { className: 'sn-skipped-row', key: 'sk' + i },
                  h('span', { className: 'sn-badge' }, item.seg),
                  h('span', { className: 'sn-skipped-text' }, text),
                )
              }),
              skippedItems.length > 6 ? h('div', { className: 'sn-hint' }, '还有 ' + (skippedItems.length - 6) + ' 条没列出来') : null,
            ),
      )

      var panels = {
        overview: [statusBar, budgetBlock, statsRow, settingsCard, doctorCard, indexCard, filesBlock],
        notes: [writeCard, notesList],
        memory: [memoryCard],
        profile: [profileCard],
        injection: [injectionCard],
      }
      var panelHints = {
        overview: '注入开关、容量上限，以及索引与文件位置。',
        notes: 'agent 写给自己看的话，攒多了从最旧的往 archive 挪。',
        memory: '候选、已采纳、可以升成习惯的标签；采纳只能人来点。',
        profile: '从已采纳记忆聚合出的「关于你」，一句一出处。',
        injection: '这一回合真的会贴进提示词的那段字，逐段拆开看谁进了、谁被挤掉。',
      }

      return h(
        'div',
        { className: 'sn-root' },
        h(
          'div',
          { className: 'sn-head' },
          h('div', { className: 'sn-title' }, '自我叙述'),
          h('div', { className: 'sn-sub' }, 'agent 写给自己看的话（「我」= agent），跨会话保留；每回合注入在人格段之后。'),
        ),

        h(
          'details',
          { className: 'sn-intro' },
          h('summary', null, '它是做什么的'),
          h(
            'ul',
            { className: 'sn-intro-list' },
            h('li', null, h('b', null, '自述'), '　模型写给自己看的第一人称短句，跨会话保留；攒多了从最旧的往 archive 挪。'),
            h('li', null, h('b', null, '关于你（画像）'), '　从「已采纳」的事实里聚合，按标签每组取最新一条，每句都能点回原句；可以手改覆盖。'),
            h('li', null, h('b', null, '常驻结论'), '　已采纳的事实里，画像没吸收到的那些。'),
            h('li', null, h('b', null, '习惯'), '　由人点出来才生效，模型自己升不了。'),
            h('li', { className: 'sn-intro-note' }, '每回合合计 ≤460 字：自述 160 / 画像 110 / 环境 80 / 结论 90 / 习惯 20。放不下的那一条会跳过、不截半句。检索工具不受这个限制。'),
          ),
        ),

        h(
          'div',
          { className: 'sn-tabs', role: 'tablist', onKeyDown: goTab },
          tabs.map(function (item) {
            var active = activeTab === item.key
            return h(
              'button',
              {
                key: item.key,
                id: 'sn-tab-' + item.key,
                type: 'button',
                role: 'tab',
                'aria-selected': active,
                'aria-controls': 'sn-panel-' + item.key,
                tabIndex: active ? 0 : -1,
                className: 'sn-tab' + (active ? ' sn-tab-on' : ''),
                onClick: function () { setTab(item.key); setPicked(true) },
              },
              item.label,
              item.badge ? h('span', { className: 'sn-tab-badge' }, item.badge) : null,
            )
          }),
        ),

        h(Notice, { tone: notice && notice.tone, text: notice && notice.text }),

        h(
          'div',
          {
            className: 'sn-panel',
            id: 'sn-panel-' + activeTab,
            role: 'tabpanel',
            'aria-labelledby': 'sn-tab-' + activeTab,
          },
          h('div', { className: 'sn-panel-head' }, h('div', { className: 'sn-hint' }, panelHints[activeTab])),
          panels[activeTab],
        ),
      )
    }

    var CSS = [
      '.sn-root{display:flex;flex-direction:column;gap:14px;font-size:13px}',
      '.sn-head{display:flex;flex-direction:column;gap:4px}',
      '.sn-title{font-size:15px;font-weight:600;color:var(--dsw-alias-text-primary,#111)}',
      '.sn-sub{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280);line-height:1.5}',
      '.sn-intro{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280);border:1px dashed var(--dsw-alias-border-subtle,#e5e7eb);border-radius:10px;padding:8px 12px}',
      '.sn-intro summary{cursor:pointer;user-select:none;color:var(--dsw-alias-text-primary,#374151)}',
      '.sn-intro-list{margin:8px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px;line-height:1.6}',
      '.sn-intro-list b{color:var(--dsw-alias-text-primary,#374151);font-weight:600}',
      '.sn-intro-note{list-style:none;margin-left:-18px;padding-top:4px;color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.sn-statusbar{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-dot{width:8px;height:8px;border-radius:50%;background:#c7c9cc;flex:none}',
      '.sn-dot-on{background:#22c55e}',
      '.sn-grow{flex:1}',
      '.sn-muted{color:var(--dsw-alias-text-secondary,#9ca3af);font-size:12px}',
      '.sn-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}',
      '.sn-stat{border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-secondary,#fafafa)}',
      '.sn-stat-num{font-size:20px;font-weight:600;line-height:1.2}',
      '.sn-stat-label{font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280);margin-top:2px}',
      '.sn-card{border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}',
      '.sn-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-text-secondary,#374151)}',
      '.sn-row{display:flex;align-items:center;gap:10px}',
      '.sn-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}',
      '.sn-toggle input{accent-color:var(--dsw-alias-accent-default,#2563eb)}',
      '.sn-limits{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}',
      '.sn-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-field input{width:110px;padding:6px 8px;border:1px solid var(--dsw-alias-border-subtle,#d1d5db);border-radius:8px;background:var(--dsw-alias-bg-primary,#fff);color:inherit}',
      '.sn-input{width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-subtle,#d1d5db);border-radius:8px;background:var(--dsw-alias-bg-primary,#fff);color:inherit;resize:vertical;font:inherit}',
      '.sn-input:focus,.sn-field input:focus{outline:none;box-shadow:0 0 0 3px rgba(37,99,235,.15)}',
      '.sn-actions{display:flex;align-items:center;gap:8px}',
      '.sn-btn{border:1px solid var(--dsw-alias-border-subtle,#d1d5db);background:var(--dsw-alias-bg-primary,#fff);color:inherit;border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer}',
      '.sn-btn:hover:not(:disabled){background:var(--dsw-alias-bg-secondary,#f3f4f6)}',
      '.sn-btn:disabled{opacity:.55;cursor:default}',
      '.sn-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-btn-danger{color:#b91c1c;border-color:#fecaca}',
      '.sn-hint{font-size:11px;color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.sn-notice{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-secondary,#f3f4f6)}',
      '.sn-notice-mark{font-weight:700}',
      '.sn-notice-ok{background:#ecfdf5;color:#065f46}',
      '.sn-notice-warn{background:#fef2f2;color:#991b1b}',
      '.sn-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;max-height:260px;overflow:auto}',
      '.sn-item{display:flex;gap:10px;line-height:1.5}',
      '.sn-date{color:var(--dsw-alias-text-secondary,#9ca3af);font-size:11px;flex:none;padding-top:1px;font-variant-numeric:tabular-nums}',
      '.sn-text{flex:1}',
      '.sn-empty{font-size:12px;color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.sn-sources{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}',
      '.sn-source{display:flex;align-items:center;gap:4px;font-size:11px}',
      '.sn-chip{background:var(--dsw-alias-bg-secondary,#f3f4f6);border-radius:999px;padding:2px 8px}',
      '.sn-hint-warn{font-size:11px;color:#b45309}',
      '.sn-sub{font-size:12px;font-weight:600;color:var(--dsw-alias-text-secondary,#374151);margin-top:4px}',
      '.sn-heat{font-size:11px;color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.sn-fact{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-subtle,#eef0f2);border-radius:8px}',
      '.sn-fact-text{line-height:1.5}',
      '.sn-fact-cite{font-size:11px;color:var(--dsw-alias-text-secondary,#9ca3af);font-family:ui-monospace,Menlo,Consolas,monospace}',
      '.sn-details{font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-details summary{cursor:pointer;user-select:none}',
      '.sn-mono{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;padding-top:4px}',
      '.sn-loading{padding:16px;font-size:12px;color:var(--dsw-alias-text-secondary,#9ca3af)}',
      ".sn-fact-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".sn-badge{font-size:11px;background:#eef2ff;color:#3730a3;border-radius:999px;padding:1px 8px}",
      ".sn-fact-conflict{border-color:#fcd34d;background:#fffdf5}",
      ".sn-pair-head{font-size:12px;line-height:1.5;color:#92400e}",
      ".sn-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".sn-pair-side{border:1px dashed var(--dsw-alias-border-subtle,#d1d5db);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}",
      ".sn-pair-tag{font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280)}",
      "@media (max-width:560px){.sn-pair{grid-template-columns:1fr}}",
      ".sn-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-subtle,#e5e7eb);flex-wrap:wrap}",
      ".sn-tab{position:relative;border:none;background:transparent;color:var(--dsw-alias-text-secondary,#6b7280);font:inherit;padding:8px 12px;cursor:pointer;border-radius:8px 8px 0 0;display:inline-flex;align-items:center;gap:6px}",
      ".sn-tab:hover:not(.sn-tab-on){background:var(--dsw-alias-bg-secondary,#f3f4f6)}",
      ".sn-tab:focus-visible{outline:2px solid var(--dsw-alias-accent-default,#2563eb);outline-offset:-2px}",
      ".sn-tab-on{color:var(--dsw-alias-text-primary,#111);font-weight:600}",
      ".sn-tab-on::after{content:\"\";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;background:var(--dsw-alias-accent-default,#2563eb);border-radius:2px}",
      ".sn-tab-badge{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-secondary,#f3f4f6);color:var(--dsw-alias-text-secondary,#6b7280);font-weight:400}",
      ".sn-tab-on .sn-tab-badge{background:#eef2ff;color:#3730a3}",
      ".sn-panel{display:flex;flex-direction:column;gap:12px}",
      ".sn-panel-head{display:flex;justify-content:space-between;align-items:center}",
      ".sn-budget{display:flex;flex-direction:column;gap:6px}",
      ".sn-budget-bar{display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-secondary,#f3f4f6)}",
      ".sn-budget-seg{height:100%;transition:width .2s ease}",
      ".sn-budget-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280)}",
      ".sn-legend-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;vertical-align:middle}",
      "@media (max-width:560px){.sn-tabs{overflow-x:auto;flex-wrap:nowrap}.sn-tab{padding:8px 10px}}",
      '.sn-card-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.sn-card-note{font-size:11px;color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.sn-files{display:flex;flex-direction:column;gap:2px}',
      '.sn-file{display:flex;align-items:center;gap:10px;padding:8px 6px;border-radius:8px;border-bottom:1px solid var(--dsw-alias-border-subtle,#f1f5f9)}',
      '.sn-file:last-child{border-bottom:none}',
      '.sn-file:hover{background:var(--dsw-alias-bg-secondary,#fafafa)}',
      '.sn-file-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.sn-file-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.sn-file-label{font-size:12px;font-weight:600;color:var(--dsw-alias-text-primary,#111827)}',
      '.sn-file-count{font-size:11px;color:#3730a3;background:#eef2ff;border-radius:999px;padding:0 7px;line-height:17px}',
      '.sn-file-path{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
      '.sn-file-path:hover{color:var(--dsw-alias-accent-default,#2563eb);text-decoration:underline}',
      '.sn-file-meta{font-size:11px;color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.sn-file-missing .sn-file-path{color:#b45309}',
      '.sn-file-missing .sn-file-count{background:#fef3c7;color:#92400e}',
      '.sn-file-btn{flex:none}',
      '.sn-root{gap:16px}',
      '.sn-card{border-radius:12px;padding:14px;box-shadow:0 1px 2px rgba(15,23,42,.05);gap:12px}',
      '.sn-card-title{letter-spacing:.01em}',
      '.sn-panel{gap:14px}',
      '.sn-stat-num{font-weight:650;letter-spacing:-.01em}',
      '.sn-btn{line-height:1.6;border-radius:8px;transition:background .15s ease,border-color .15s ease,transform .1s ease}',
      '.sn-btn:active:not(:disabled){transform:translateY(1px)}',
      '.sn-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-secondary,#f3f4f6)}',
      '@media (max-width:560px){.sn-file{align-items:flex-start;flex-wrap:wrap}.sn-file-btn{width:100%}}',
      '.sn-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:2px 16px}',
      '.sn-kv-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed var(--dsw-alias-border-subtle,#f1f5f9)}',
      '.sn-kv-key{font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280);white-space:nowrap}',
      '.sn-kv-val{font-size:12px;font-weight:600;color:var(--dsw-alias-text-primary,#111827);font-variant-numeric:tabular-nums}',
      '.sn-kv-tag{font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px}',
      '.sn-kv-tag-ok{background:#ecfdf5;color:#047857}',
      '.sn-kv-tag-stale{background:#fef3c7;color:#92400e}',
      '.sn-kv-tag-missing{background:var(--dsw-alias-bg-secondary,#f3f4f6);color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.75;background:var(--dsw-alias-bg-secondary,#f8fafc);border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);border-radius:8px;padding:10px 12px;margin:0;color:var(--dsw-alias-text-primary,#111827)}',
      '.sn-seg{display:flex;flex-direction:column;gap:4px}',
      '.sn-seg-row{display:flex;align-items:center;gap:10px;font-size:12px;padding:3px 0}',
      '.sn-seg-key{width:42px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-seg-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-text-primary,#111827);font-weight:600}',
      '.sn-seg-state{margin-left:auto;font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-seg-state-warn{color:#b45309}',
      '.sn-skipped{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-subtle,#e5e7eb);border-radius:8px}',
      '.sn-skipped-head{font-size:11px;color:#92400e;line-height:1.6}',
      '.sn-skipped-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.6}',
      '.sn-skipped-text{color:var(--dsw-alias-text-secondary,#4b5563)}',
      '.sn-doc-list{display:flex;flex-direction:column;gap:8px}',
      '.sn-doc-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.6;flex-wrap:wrap}',
      '.sn-doc-tag{font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px;white-space:nowrap}',
      '.sn-doc-ok{background:#ecfdf5;color:#047857}',
      '.sn-doc-warn{background:#fffbeb;color:#b45309}',
      '.sn-doc-error{background:#fef2f2;color:#b91c1c}',
      '.sn-doc-label{font-weight:600;color:var(--dsw-alias-text-primary,#111827)}',
      '.sn-doc-detail{flex:1;min-width:200px;color:var(--dsw-alias-text-secondary,#4b5563)}',
    ].join('\n')

    function apply(ctx) {
      ctx.effect(function () {
        var style = document.createElement('style')
        style.id = 'dsh-selfnote-styles'
        style.textContent = CSS
        document.head.appendChild(style)
        return function () {
          style.remove()
        }
      }, 'dsh-selfnote: styles')

      ctx.slots.inject('settings.section', function () {
        // register 的返回值（disposer）必须交还给注入器 —— 丢了它热重载时会
        // 重复注册旧插槽，宿主直接把整个 client 模块判为失联。
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'selfnote',
            order: 48,
            label: function () {
              return '自我叙述'
            },
          },
          function (props) {
            return h(SelfNoteSection, props !== null && props !== undefined ? props : {})
          },
        )
      })
    }

    module.exports = {
      name: 'selfnote',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
