/**
 * dsh-selfnote —— 浏览器半侧（手写 __ModuleLoader__ bundle，不需要构建工具）。
 *
 * 在设置页里加「人格（自述）」一节：看现在生效的自述、改容量上限、手动写一条、改一条、删一条、清空（进归档）。
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

      // 放最后：上面那些 useState 的调用序号被测试依赖，别插在中间
      var guideTuple = useState('')
      var noteGuide = guideTuple[0]
      var setNoteGuide = guideTuple[1]
      // 迁移：导出/导入的账目（加了几条、跳了几条、有没有被降级），null = 还没导过
      var transferTuple = useState(null)
      var transfer = transferTuple[0]
      var setTransfer = transferTuple[1]
      var keepStatusTuple = useState(false)
      var keepStatus = keepStatusTuple[0]
      var setKeepStatus = keepStatusTuple[1]
      // 就地改一条：editing = 正在改的那一条在 notes 里的下标（0 = 最旧），null = 没在改
      var editingTuple = useState(null)
      var editing = editingTuple[0]
      var setEditing = editingTuple[1]
      var editTextTuple = useState('')
      var editText = editTextTuple[0]
      var setEditText = editTextTuple[1]
      // 删一条要两步：只说「删」一个字，误点一下就少一条记忆
      var pendingDeleteTuple = useState(null)
      var pendingDelete = pendingDeleteTuple[0]
      var setPendingDelete = pendingDeleteTuple[1]
      // 记忆正文同理：factEdit = { id, text }
      var factEditTuple = useState(null)
      var factEdit = factEditTuple[0]
      var setFactEdit = factEditTuple[1]
      // 注入抬头（每回合那一段的第一行），可改
      var headingTuple = useState('')
      var heading = headingTuple[0]
      var setHeading = headingTuple[1]
      // 新写的那条算哪一型：核心先装、稳定默认、临时只活当下
      // 放在最后：上面那些 useState 的调用序号被测试依赖，别插在中间
      var draftTierTuple = useState('stable')
      var draftTier = draftTierTuple[0]
      var setDraftTier = draftTierTuple[1]
      // 临时自述的保质期（天）。只对 temp 型生效，核心与稳定永不过期
      // 同样放最后：新增 useState 只能往后加，别插在中间
      var tempTtlTuple = useState('')
      var tempTtl = tempTtlTuple[0]
      var setTempTtl = tempTtlTuple[1]
      // 人格三段的草稿：null = 直接显示磁盘上的，动过之后才是草稿。
      // 依旧放最后：新增 useState 只能往后加，插在中间会让测试的调用序号错位
      var personaDraftTuple = useState(null)
      var personaDraft = personaDraftTuple[0]
      var setPersonaDraft = personaDraftTuple[1]
      // 纠偏候选里勾了哪几条：只存 id，不存整条（刷新后按 id 找得到才算数）
      var pickedEvidenceTuple = useState([])
      var pickedEvidence = pickedEvidenceTuple[0]
      var setPickedEvidence = pickedEvidenceTuple[1]
      // 用选中的证据写规则时的那段草稿：预填证据原文，要人改写成规则
      var ruleDraftTuple = useState('')
      var ruleDraft = ruleDraftTuple[0]
      var setRuleDraft = ruleDraftTuple[1]
      // 退役也要两步：退役不删数据，但退役之后它就不进注入了，误点一下等于凭空少一条
      var pendingRetireTuple = useState(null)
      var pendingRetire = pendingRetireTuple[0]
      var setPendingRetire = pendingRetireTuple[1]
      // 「已退役」默认收起：正常翻记忆时不该被一堆旧结论挡路
      var showRetiredTuple = useState(false)
      var showRetired = showRetiredTuple[0]
      var setShowRetired = showRetiredTuple[1]
      // 半衰期与画像上限：以前只能在 config.json 里手改，界面上看不见也就没人调
      var halfLifeTuple = useState('')
      var halfLife = halfLifeTuple[0]
      var setHalfLife = halfLifeTuple[1]
      var profileMaxTuple = useState('')
      var profileMax = profileMaxTuple[0]
      var setProfileMax = profileMaxTuple[1]
      // 纠偏证据一页只给 30 条：后面还有就用「加载更多」翻，翻过的攒在 moreEvidence 里
      var moreEvidenceTuple = useState([])
      var moreEvidence = moreEvidenceTuple[0]
      var setMoreEvidence = moreEvidenceTuple[1]
      var moreCursorTuple = useState(null)
      var moreCursor = moreCursorTuple[0]
      var setMoreCursor = moreCursorTuple[1]

      function apply(data) {
        setState(data)
        setProfileDraft(function (current) {
          return current === null ? (data.profile ? data.profile.override : '') : current
        })
        setMaxChars(String(data.maxChars))
        setMaxEntries(String(data.maxEntries))
        setNoteGuide(typeof data.noteGuide === 'string' ? data.noteGuide : '')
        setHeading(typeof data.heading === 'string' ? data.heading : '')
        setTempTtl(String(data.tempTtlDays === undefined ? 14 : data.tempTtlDays))
        setHalfLife(String(data.halfLifeDays === undefined ? 30 : data.halfLifeDays))
        setProfileMax(String(data.profile && data.profile.maxChars !== undefined ? data.profile.maxChars : 110))
        setMoreEvidence([])
        setMoreCursor(null)
        // 每次拿到新状态，列表下标都可能整体挪位：正在改/正等确认的那条已经没意义了
        setEditing(null)
        setPendingDelete(null)
        setPendingRetire(null)
        setFactEdit(null)
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

      // 「真的清空」不该一直是待触发状态：人点了一次走开，回来再点一下就把东西清了。
      useEffect(function () {
        if (!confirming) return undefined
        var timer = setTimeout(function () {
          setConfirming(false)
        }, 5000)
        return function () {
          clearTimeout(timer)
        }
      }, [confirming])

      // 「真的删」和「真的退役」跟「真的清空」一个口径：武装 5 秒，走开就自动放下。
      // 之前只有清空带定时器，删自述是点开就永久武装 —— 点了「删」犹豫一下、切个页签回来再点同一格，就真删了。
      useEffect(function () {
        if (pendingDelete === null) return undefined
        var timer = setTimeout(function () {
          setPendingDelete(null)
        }, 5000)
        return function () {
          clearTimeout(timer)
        }
      }, [pendingDelete])

      useEffect(function () {
        if (pendingRetire === null) return undefined
        var timer = setTimeout(function () {
          setPendingRetire(null)
        }, 5000)
        return function () {
          clearTimeout(timer)
        }
      }, [pendingRetire])

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
        apiPost('/config', { maxChars: Number(maxChars), maxEntries: Number(maxEntries), noteGuide: noteGuide })
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

      // 半衰期与画像上限走 /config；服务端会校验范围，越界就 400 把原因带回来
      function saveHalfLife() {
        setBusy('config')
        apiPost('/config', { halfLifeDays: Number(halfLife), profileMaxChars: Number(profileMax) })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: '已保存：结论按 ' + data.halfLifeDays + ' 天衰减，画像上限 ' + (data.profile && data.profile.maxChars) + ' 字。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '保存失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      // 索引开关：启用前服务端会自己检查「在盘上 + 没过期」，不满足就 400，把原话显示出来
      function toggleIndex(next) {
        setBusy('index')
        apiPost('/index', { action: next ? 'enable' : 'disable' })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: next ? '索引已启用：下一回合起检索先走索引。' : '索引已关闭：检索退回完整扫描。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: next ? '启用失败：' + error.message : '关闭失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      // 翻页：服务端按 (at, id) 给游标，翻过的追加在后面，已勾选的不会因为重新渲染丢掉
      function loadMoreEvidence() {
        var cursor = moreCursor !== null ? moreCursor : state && state.corrections ? state.corrections.nextCursor : null
        if (!cursor) return
        setBusy('corrections')
        apiGet('/corrections?limit=30&cursor=' + encodeURIComponent(cursor))
          .then(function (data) {
            setMoreEvidence(moreEvidence.concat(data.items || []))
            setMoreCursor(data.nextCursor || '')
            if (!data.nextCursor) setNotice({ tone: 'ok', text: '证据已经翻到底了。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '翻页失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      // 丢弃：这些原话连规则都不是，只是记录，丢掉不该有心理负担
      function discardPicked() {
        var ids = pickedEvidence.slice()
        if (ids.length === 0) return
        setBusy('corrections')
        apiPost('/corrections/discard', { ids: ids })
          .then(function (data) {
            apply(data)
            setPickedEvidence([])
            setNotice({ tone: 'ok', text: '已丢弃 ' + ids.length + ' 条证据（它们不会再来烦你）。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '丢弃失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function saveHeading() {
        setBusy('heading')
        apiPost('/config', { heading: heading })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: heading.trim() === '' ? '抬头清空了，注入直接从内容开始。' : '抬头已保存，下一回合生效。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '保存失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function saveTempTtl() {
        var value = Number(tempTtl)
        if (!Number.isFinite(value) || value < 1 || value > 90) {
          setNotice({ tone: 'warn', text: '保质期要在 1–90 天之间。' })
          return
        }
        setBusy('ttl')
        apiPost('/config', { tempTtlDays: value })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: '保质期改成 ' + Math.round(value) + ' 天，下一回合生效。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '保存失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      // ---- 人格三段 ----
      // 字数按 Unicode 码点算，和服务端、注入预算同一把尺子。
      // 注意：视觉上的一个 emoji 可能由多个码点组成（ZWJ 序列），这里如实算多个。
      function pinCount(text) {
        return Array.from(String(text === undefined || text === null ? '' : text)).length
      }

      function personaValues() {        var persona = state.persona || {}
        if (personaDraft === null) {
          return { l0: persona.l0 || '', l1: persona.l1 || '', l2: persona.l2 || '' }
        }
        return personaDraft
      }

      function editPersona(key, value) {
        var next = { l0: personaValues().l0, l1: personaValues().l1, l2: personaValues().l2 }
        next[key] = value
        setPersonaDraft(next)
      }

      function sectionlessHint(info) {
        if (!info) return ''
        if (info.error === 'missing') return 'persona.md 还没建，保存一次就有了。'
        if (info.error === 'not-text') return 'persona.md 不像文本（或超过 1MB），先看一眼再改。'
        if (info.sectionless) return '整篇没写标题，暂时全部当作 L1。'
        return 'persona.md · 上次取用 ' + (info.lastReadAt ? String(info.lastReadAt).slice(0, 10) : '从没取过')
      }

      function personaField(key, label, hint, value, max, rows) {
        var used = pinCount(value)
        var over = max > 0 && used > max
        return h(
          'div',
          { className: 'sn-field sn-field-wide', key: key },
          h(
            'span',
            { className: 'sn-field-label' },
            label,
            h('span', { className: 'sn-count' + (over ? ' sn-count-over' : '') }, '　' + used + ' / ' + max + ' 字'),
          ),
          h('textarea', {
            className: 'sn-input',
            rows: rows,
            // 不用 maxLength：HTML 的 maxLength 按 UTF-16 单元计，一个 emoji 算 2，
            // 会和按码点算的预算打架（emoji 多的段落会提前两个字符被拦住）。
            // 这里只给计数与超限提示，真正拦的是保存时那一次整份校验。
            value: value,
            'data-field': key,
            onChange: function (e) { editPersona(key, e.target.value) },
          }),
          h('div', { className: 'sn-hint' }, hint),
        )
      }

      function savePersona() {
        var values = personaValues()
        setBusy('persona')
        apiPost('/persona', {
          l0: values.l0,
          l1: values.l1,
          l2: values.l2,
          consume: pickedEvidence,
        })
          .then(function (data) {
            apply(data)
            setPersonaDraft(null)
            setPickedEvidence([])
            setRuleDraft('')
            if (data.pending === true) {
              setNotice({ tone: 'warn', text: '人格已保存，但证据记账没写完：' + (data.error || '') + '（下次启动会自动补）' })
            } else {
              setNotice({ tone: 'ok', text: '人格已保存，下一回合生效。' })
            }
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '保存失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function importPersona() {
        setBusy('import')
        apiPost('/persona/import', {})
          .then(function (data) {
            // 导入≠采纳：只把结果填进三个框，人自己看、自己改、自己点保存
            setPersonaDraft({ l0: data.l0 || '', l1: data.l1 || '', l2: data.l2 || '' })
            if (!data.exists) setNotice({ tone: 'warn', text: '没找到可导入的 AGENT.md。' })
            else setNotice({ tone: 'ok', text: '已从 AGENT.md 填进来（还没保存，改完再点「保存人格」）。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '导入失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function toggleEvidence(id) {
        var next = pickedEvidence.slice()
        var at = next.indexOf(id)
        if (at >= 0) next.splice(at, 1)
        else next.push(id)
        setPickedEvidence(next)
      }

      function draftRuleFromPicked() {
        var picked = (correctionItems || []).filter(function (item) { return pickedEvidence.indexOf(item.id) >= 0 })
        var lines = picked.map(function (item) { return '· ' + item.quote })
        setRuleDraft(lines.length > 0 ? lines.join('\n') : '')
        setNotice({ tone: 'ok', text: '把上面几句改写成一条规则，再点「保存人格」。' })
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
        apiPost('/note', { text: text, tier: draftTier })
          .then(function (data) {
            apply(data)
            setDraft('')
            var add = data.noteAdd || {}
            setNotice(add.warning ? { tone: 'warn', text: '写好了，但' + add.warning } : { tone: 'ok', text: '写好了。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '写入失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function startEditNote(index, text) {
        setEditing(index)
        setEditText(text)
        setPendingDelete(null)
        setNotice(null)
      }

      function cancelEditNote() {
        setEditing(null)
        setEditText('')
      }

      function saveNote(index) {
        var text = editText.trim()
        if (text === '') {
          setNotice({ tone: 'warn', text: '内容不能为空；不想留这条就点「删」。' })
          return
        }
        setBusy('note-edit')
        apiPost('/note/update', { index: index, text: text })
          .then(function (data) {
            apply(data)
            var update = data.noteUpdate || {}
            setNotice({
              tone: 'ok',
              text: update.unchanged
                ? '没改动。'
                : '改好了，下一回合生效。' + (update.archived > 0 ? '（改长后有 ' + update.archived + ' 条挪进归档）' : ''),
            })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '没改成：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      // 改类型 / pin：正文一个字不动，只换这条排在哪一队
      function setNoteTier(index, patch) {
        setBusy('note-meta')
        apiPost('/note/meta', { index: index, tier: patch.tier, pin: patch.pin })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: '改好了，下一回合按新的位置装。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '没改成：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function removeNote(index) {
        if (pendingDelete !== index) {
          setPendingDelete(index)
          setNotice({ tone: 'info', text: '再点一次「真的删」——这条会先进归档，找得回来。' })
          return
        }
        setBusy('note-delete')
        apiPost('/note/delete', { index: index })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: '已删掉，剩下 ' + ((data.noteDelete && data.noteDelete.kept) || 0) + ' 条；删掉的在归档里。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '没删成：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function saveFactText(id, text) {
        var clean = text.trim()
        if (clean === '') {
          setNotice({ tone: 'warn', text: '内容不能为空。' })
          return
        }
        setBusy('fact-edit')
        apiPost('/fact', { id: id, text: clean })
          .then(function (data) {
            apply(data)
            setNotice({ tone: 'ok', text: '记忆正文改好了，下一回合生效；画像会跟着重算。' })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '没改成：' + error.message })
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
            setNotice({
              tone: 'ok',
              text:
                status === 'approved'
                  ? '已采纳（原来的退役也一并恢复），下一回合进注入。'
                  : status === 'retired'
                    ? '已退役：不再进注入，要它回来去「已退役」里点恢复。'
                    : '已处理。',
            })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '没改成：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      // 退役两步：第一次只武装，第二次才发请求。数据留在 facts.jsonl 里，随时能恢复。
      function retireFact(id) {
        if (pendingRetire !== id) {
          setPendingRetire(id)
          setNotice({ tone: 'info', text: '再点一次「真的退役」——它不进注入了，但还在「已退役」里，随时能恢复。' })
          return
        }
        setPendingRetire(null)
        setFact(id, 'retired')
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
        // 三态：正在读 / 读失败 / 刚进来还没读。读失败时把 refresh 里 catch 到的真实原因端出来，
        // 别用「重启 DSH 试试」这种猜测盖掉它 —— 重启治不了 403（凭据），也治不了 404（路由）。
        var loadFailed = busy !== 'load' && notice !== null
        return h(
          'div',
          { className: 'sn-root' },
          h(
            'div',
            {
              className: 'sn-loading' + (loadFailed ? ' sn-loading-error' : ''),
              role: loadFailed ? 'alert' : 'status',
            },
            loadFailed ? notice.text : '读取中…',
          ),
          loadFailed
            ? h(
                'div',
                { className: 'sn-actions' },
                h(
                  'button',
                  { type: 'button', className: 'sn-btn', onClick: function () { refresh() }, disabled: busy !== '' },
                  '重试',
                ),
              )
            : null,
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
        var isEditing = factEdit !== null && factEdit.id === fact.id
        return [
          isEditing
            ? h(
                'div',
                { key: 'text', className: 'sn-fact-edit' },
                h('textarea', {
                  className: 'sn-input',
                  rows: 2,
                  // 一条事实硬上限 240 字（服务端同一条）
                  maxLength: 240,
                  value: factEdit.text,
                  onChange: function (e) { setFactEdit({ id: fact.id, text: e.target.value }) },
                }),
                h(
                  'span',
                  { className: 'sn-actions' },
                  h('button', { className: 'sn-btn', onClick: function () { saveFactText(fact.id, factEdit.text) }, disabled: busy !== '' }, '保存'),
                  h('button', { className: 'sn-btn sn-btn-ghost', onClick: function () { setFactEdit(null) }, disabled: busy !== '' }, '取消'),
                ),
              )
            : h('div', { key: 'text', className: 'sn-fact-text' }, fact.text),
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
                h(
                  'button',
                  { className: 'sn-btn sn-btn-ghost' + (pendingRetire === fact.id ? ' sn-btn-danger' : ''), onClick: function () { retireFact(fact.id) }, disabled: busy !== '' },
                  pendingRetire === fact.id ? '真的退役' : '退役',
                ),
                h('button', { className: 'sn-btn sn-btn-ghost', onClick: function () { setFactEdit({ id: fact.id, text: fact.text }) }, disabled: busy !== '' }, '改'),
              )
            : h('div', { key: 'state', className: 'sn-fact-cite' }, '状态：' + statusLabel(fact.status)),
        ]
      }

      var suggestions = state.habitSuggestions || []

      var tabs = [
        { key: 'overview', label: '概览' },
        { key: 'notes', label: '自述', badge: notes.length + ' 条' },
        { key: 'persona', label: '人格', badge: ((state.persona && state.persona.chars) || 0) + ' 字' },
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
      var limit = budget.limit || 1000
      var caps = budget.caps || { persona: 320, notes: 200, profile: 120, env: 230, facts: 90, habits: 40 }
      var segments = [
        { key: 'persona', label: '人格', value: budget.persona || 0, color: '#f97316' },
        { key: 'notes', label: '自述', value: budget.notes || 0, color: '#60a5fa' },
        { key: 'profile', label: '画像', value: budget.profile || 0, color: '#a78bfa' },
        // 环境段是最大的一块（上限 320 字），漏了它进度条就画不满：
        // total 里算进去了，条子上却没有对应的格子，看着像「只用了三成」。
        { key: 'env', label: '环境', value: budget.env || 0, color: '#f472b6' },
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
            ? '注入已开启 · 每回合实际注入 ' + (budget.total || 0) + ' 字（约 ' + Math.round((budget.total || 0) / 1.6) + ' token）· 上限 ' + limit
            : '注入已关闭 · 内容还在，只是不进上下文',
        ),
        h('span', { className: 'sn-grow' }),
        h('span', { className: 'sn-muted' }, '归档 ' + state.archiveFiles + ' 个文件'),
      )

      var statsRow = h(
        'div',
        { className: 'sn-stats', key: 'stats' },
        h('div', { className: 'sn-stat' }, h('div', { className: 'sn-stat-num' }, state.entries), h('div', { className: 'sn-stat-label' }, '条自述')),
        h('div', { className: 'sn-stat' }, h('div', { className: 'sn-stat-num' }, state.chars), h('div', { className: 'sn-stat-label' }, '存储字数')),
        h('div', { className: 'sn-stat' }, h('div', { className: 'sn-stat-num' }, usage + '%'), h('div', { className: 'sn-stat-label' }, '存储占用')),
      )

      function lastWriteText(iso) {
        if (typeof iso !== 'string' || iso === '') return '还没写过'
        var at = Date.parse(iso)
        if (!Number.isFinite(at)) return '还没写过'
        var mins = Math.max(0, Math.round((Date.now() - at) / 60000))
        if (mins < 1) return '刚刚'
        if (mins < 60) return mins + ' 分钟前'
        var hours = Math.round(mins / 60)
        if (hours < 24) return hours + ' 小时前'
        return Math.round(hours / 24) + ' 天前'
      }

      // 没调过 apply 时（或被外部刷新打断）也显示服务端的真值，别显示空白
      var halfLifeShown = halfLife === '' ? String(state.halfLifeDays === undefined ? 30 : state.halfLifeDays) : halfLife
      var profileMaxShown = profileMax === '' ? String((state.profile && state.profile.maxChars) || 110) : profileMax

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
          h('label', { className: 'sn-field' }, h('span', null, '存储上限（字）'), h('input', { type: 'number', min: 100, max: 8000, value: maxChars, onChange: function (e) { setMaxChars(e.target.value) } })),
          h('label', { className: 'sn-field' }, h('span', null, '存储上限（条）'), h('input', { type: 'number', min: 1, max: 200, value: maxEntries, onChange: function (e) { setMaxEntries(e.target.value) } })),
          h('button', { className: 'sn-btn', onClick: saveConfig, disabled: busy !== '' }, '保存上限'),
        ),
        h('div', { className: 'sn-hint' }, '这两个数是 notes.md 能存多少：超出的从最旧开始挪进 archive，不会丢。'),
        h(
          'div',
          { className: 'sn-hint' },
          '它们不影响每回合注入多少 —— 注入只取最新的、合计 ≤ ' + caps.notes + ' 字（这个数写死在插件里，改不了）。想看真正贴进去的字，去「注入」页。',
        ),
        h(
          'div',
          { className: 'sn-field sn-field-wide' },
          h('span', null, '注入抬头（每回合那段的第一行）'),
          h('input', {
            type: 'text',
            maxLength: 24,
            'aria-label': '注入抬头，最多 24 个字，留空就不加抬头',
            value: heading,
            placeholder: '例：AI记忆',
            onChange: function (e) { setHeading(e.target.value) },
          }),
        ),
        h(
          'div',
          { className: 'sn-row' },
          h('span', { className: 'sn-hint' }, '留空就不加抬头，注入直接从内容开始。'),
          h('span', { className: 'sn-grow' }),
          h('button', { className: 'sn-btn sn-btn-ghost', onClick: saveHeading, disabled: busy !== '' }, '保存抬头'),
        ),
        h('div', { className: 'sn-hint' }, '上次写入：' + lastWriteText(state.notesLastWrite)),
        h(
          'div',
          { className: 'sn-limits' },
          h('label', { className: 'sn-field' }, h('span', null, '临时自述保质期（天）'), h('input', { type: 'number', min: 1, max: 90, value: tempTtl, onChange: function (e) { setTempTtl(e.target.value) } })),
          h('button', { className: 'sn-btn', onClick: saveTempTtl, disabled: busy !== '' }, '保存保质期'),
        ),
        h('div', { className: 'sn-hint' }, '只对「临时」型自述生效（1–90 天，默认 14）。过了期不再自动进上下文，内容一个字都没删 —— 改成「稳定」或重写一条就回来。'),
        h(
          'div',
          { className: 'sn-limits' },
          h(
            'label',
            { className: 'sn-field' },
            h('span', null, '结论半衰期（天）'),
            h('input', {
              type: 'number',
              min: 1,
              max: 365,
              'aria-label': '结论半衰期，单位天，范围 1 到 365',
              value: halfLifeShown,
              onChange: function (e) { setHalfLife(e.target.value) },
            }),
          ),
          h(
            'label',
            { className: 'sn-field' },
            h('span', null, '画像上限（字）'),
            h('input', {
              type: 'number',
              min: 20,
              max: 120,
              'aria-label': '画像上限，单位字，范围 20 到 120',
              value: profileMaxShown,
              onChange: function (e) { setProfileMax(e.target.value) },
            }),
          ),
          h('button', { className: 'sn-btn', onClick: saveHalfLife, disabled: busy !== '' }, '保存这两项'),
        ),
        h('div', { className: 'sn-hint' }, '半衰期决定旧结论多久算「半凉」：越小越偏爱最近的。画像上限是「关于他」那段最多占多少字。'),
        h(
          'div',
          { className: 'sn-field sn-field-wide' },
          h('span', null, '什么时候该写自述（留空＝用默认判据）'),
          h('textarea', {
            rows: 2,
            maxLength: 80,
            'aria-label': '什么时候该写自述，留空就用默认判据',
            value: noteGuide,
            placeholder: '例：每次改完一个插件、跑完验收之后写一条；闲聊不用写。',
            onChange: function (e) { setNoteGuide(e.target.value) },
          }),
        ),
        h(
          'div',
          { className: 'sn-row' },
          h('span', { className: 'sn-hint' }, '这段会作为「写自述的时机」进注入，下一回合生效；工具说明里的默认判据仍然有效。'),
          h('span', { className: 'sn-grow' }),
          h('button', { className: 'sn-btn sn-btn-ghost', onClick: saveConfig, disabled: busy !== '' }, '保存引导'),
        ),
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
          kv('检索开关', h('span', { className: 'sn-kv-tag ' + (idx.enabled === true ? 'sn-kv-tag-ok' : 'sn-kv-tag-missing') }, idx.enabled === true ? '已启用' : '已关闭')),
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
          h(
            'button',
            {
              className: idx.enabled === true ? 'sn-btn sn-btn-ghost' : 'sn-btn',
              onClick: function () { toggleIndex(idx.enabled !== true) },
              disabled: busy !== '' || (idx.enabled !== true && idx.present !== true),
            },
            idx.enabled === true ? '关闭索引' : '启用索引',
          ),
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
      /** 导出成一份 JSON 文件：浏览器里直接下载，不经过任何服务器。 */
      function exportAll() {
        setBusy('export')
        apiGet('/export')
          .then(function (bundle) {
            if (!bundle || bundle.app !== 'dsh-selfnote') {
              setNotice({ tone: 'warn', text: '导出失败：' + ((bundle && bundle.error) || '服务端没给出可用的包') })
              return
            }
            var name = 'selfnote-' + new Date().toISOString().slice(0, 10) + '.json'
            var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
            var url = URL.createObjectURL(blob)
            var link = document.createElement('a')
            link.href = url
            link.download = name
            document.body.appendChild(link)
            link.click()
            link.remove()
            setTimeout(function () {
              URL.revokeObjectURL(url)
            }, 1000)
            setNotice({
              tone: 'ok',
              text: '已导出 ' + name + '：' + (bundle.counts.facts || 0) + ' 条记忆 / ' + (bundle.counts.notes || 0) + ' 条自述 / ' + (bundle.counts.habits || 0) + ' 个习惯',
            })
          })
          .catch(function (error) {
            setNotice({ tone: 'warn', text: '导出失败：' + error.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      /** 导入：读文件 → 交服务端合并 → 把账目摊在卡上。 */
      function importBundle(file) {
        if (!file) return
        setBusy('import')
        setTransfer(null)
        var reader = new FileReader()
        reader.onload = function () {
          var parsed = null
          try {
            parsed = JSON.parse(String(reader.result || ''))
          } catch (error) {
            setNotice({ tone: 'warn', text: '这个文件不是 JSON：' + error.message })
            setBusy('')
            return
          }
          apiPost('/import', { bundle: parsed, keepStatus: keepStatus })
            .then(function (data) {
              if (!data || data.ok === false) {
                setNotice({ tone: 'warn', text: '导入失败：' + ((data && data.error) || '未知原因') })
                return
              }
              setTransfer(data.import || null)
              apply(data)
              setNotice({ tone: 'ok', text: '导入完成：加了 ' + (data.import.added.facts || 0) + ' 条记忆、' + (data.import.added.notes || 0) + ' 条自述' })
            })
            .catch(function (error) {
              setNotice({ tone: 'warn', text: '导入失败：' + error.message })
            })
            .then(function () {
              setBusy('')
            })
        }
        reader.onerror = function () {
          setNotice({ tone: 'warn', text: '读不了这个文件' })
          setBusy('')
        }
        reader.readAsText(file)
      }

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

      var transferCard = h(
        'div',
        { className: 'sn-card', key: 'transfer' },
        h(
          'div',
          { className: 'sn-card-head' },
          h('div', { className: 'sn-card-title' }, '迁移'),
          h('div', { className: 'sn-card-note' }, '换机器用时导出成一份 JSON，在新机器上导入'),
        ),
        h(
          'div',
          { className: 'sn-transfer' },
          h(
            'div',
            { className: 'sn-transfer-row' },
            h('button', { className: 'sn-btn sn-btn-ghost', onClick: exportAll, disabled: busy !== '' }, busy === 'export' ? '导出中…' : '导出全部记忆'),
            h(
              'label',
              { className: 'sn-btn sn-btn-ghost sn-transfer-pick' },
              busy === 'import' ? '导入中…' : '选择文件导入',
              h('input', {
                type: 'file',
                accept: 'application/json,.json',
                style: { display: 'none' },
                onChange: function (event) {
                  var picked = event.target.files && event.target.files[0]
                  event.target.value = ''
                  importBundle(picked)
                },
              }),
            ),
          ),
          h(
            'label',
            { className: 'sn-check' },
            h('input', { type: 'checkbox', checked: keepStatus, onChange: function (event) { setKeepStatus(event.target.checked) } }),
            h('span', {}, '保留原状态（导入的「已采纳」仍然是已采纳）'),
          ),
          h(
            'div',
            { className: 'sn-hint' },
            '不勾的话，导进来的结论一律变回候选 —— 采纳要你在这里点一次。同 id、同正文的条目不会被覆盖。索引不跟着搬（它记的是本机路径），导入后去「索引」卡重建一次。',
          ),
          transfer === null
            ? null
            : h(
                'div',
                { className: 'sn-transfer-report' },
                h('div', null, '加了 ' + transfer.added.facts + ' 条记忆 · ' + transfer.added.notes + ' 条自述 · ' + transfer.added.habits + ' 个习惯'),
                h('div', null, '跳过 ' + (transfer.skipped.facts + transfer.skipped.notes + transfer.skipped.habits) + ' 条重复' + (transfer.skipped.invalid > 0 ? ' · ' + transfer.skipped.invalid + ' 条无效' : '')),
                transfer.demoted > 0 ? h('div', null, '其中 ' + transfer.demoted + ' 条已采纳被降回候选（要保留就勾上面那个选项再导一次）') : null,
                transfer.droppedNotes > 0 ? h('div', null, '自述超出容量，' + transfer.droppedNotes + ' 条没放进（去「自述」页看看要不要清）') : null,
                transfer.indexStale ? h('div', { className: 'sn-transfer-warn' }, '索引已过期，重建一次再检索') : null,
              ),
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
              doctor.next
                ? h(
                    'div',
                    { className: 'sn-doc-next', key: 'doctor-next' },
                    '先做这一件：' + doctor.next.label + ' —— ' + doctor.next.detail,
                  )
                : null,
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
          h(
            'select',
            {
              className: 'sn-tier',
              value: draftTier,
              title: '核心=身份素材（不进每回合注入，只作提炼人格的原料）；稳定=表达习惯与工作偏好（先装，★ 优先）；临时=当前阶段在做什么',
              onChange: function (e) { setDraftTier(e.target.value) },
            },
            h('option', { value: 'core' }, '核心身份'),
            h('option', { value: 'stable' }, '稳定偏好'),
            h('option', { value: 'temp' }, '临时自述'),
          ),
          h('button', { className: 'sn-btn', onClick: addNote, disabled: busy !== '' }, '写进去'),
          h('span', { className: 'sn-grow' }),
          h('button', { className: 'sn-btn sn-btn-danger', onClick: clearAll, disabled: busy !== '' }, confirming ? '真的清空' : '清空当前（进归档）'),
        ),
      )

      var tierCounts = { core: 0, stable: 0, temp: 0, expired: 0 }
      notes.forEach(function (entry) {
        var key = entry.tier === 'core' || entry.tier === 'temp' ? entry.tier : 'stable'
        tierCounts[key] += 1
        if (entry.expired === true) tierCounts.expired += 1
      })

      var notesList = h(
        'div',
        { className: 'sn-card', key: 'notes' },
        h('div', { className: 'sn-card-title' }, '现在生效的内容（agent 的第一人称自述，不是用户的原话）'),
        h(
          'div',
          { className: 'sn-hint' },
          '只装「稳定（★ 钉住的先装）」和「临时」，合计 ≤ ' + caps.notes + ' 字。放不下的整条跳过、不截半句，注入里会留一句「另有 N 条」当门牌。改完/删完下一回合生效。',
        ),
        h(
          'div',
          { className: 'sn-hint' },
          '核心 ' + tierCounts.core + ' 条　稳定 ' + tierCounts.stable + ' 条　临时 ' + tierCounts.temp + ' 条' +
            (tierCounts.expired > 0 ? '（其中 ' + tierCounts.expired + ' 条已过期，不再自动进场）' : ''),
        ),
        reversed.length === 0
          ? h('div', { className: 'sn-empty' }, '还没有任何自述。模型攒到第一条时会出现在这里。')
          : h(
              'ul',
              { className: 'sn-list' },
              reversed.map(function (entry, index) {
                // 显示是最新在前，存储是最旧在前：下标得换回去，否则「改第二条」会改到别人
                var stored = notes.length - 1 - index
                var isEditing = editing === stored
                return h(
                  'li',
                  { key: 'n' + stored, className: 'sn-item' + (isEditing ? ' sn-item-editing' : '') },
                  h('span', { className: 'sn-date' }, entry.date || '—'),
                  isEditing
                    ? h(
                        'span',
                        { className: 'sn-edit' },
                        h('textarea', {
                          className: 'sn-input',
                          rows: 2,
                          // 单条硬上限 600 字（服务端同一条）——这里是提示，不是校验
                          maxLength: 600,
                          value: editText,
                          onChange: function (e) { setEditText(e.target.value) },
                        }),
                        h(
                          'span',
                          { className: 'sn-actions' },
                          h('button', { className: 'sn-btn', onClick: function () { saveNote(stored) }, disabled: busy !== '' }, '保存'),
                          h('button', { className: 'sn-btn sn-btn-ghost', onClick: cancelEditNote, disabled: busy !== '' }, '取消'),
                        ),
                      )
                    : h(
                        'span',
                        { className: 'sn-text' },
                        entry.text,
                        entry.tier === 'core'
                          ? h(
                              'span',
                              { className: 'sn-material', title: '核心身份现在是提炼人格的素材：它不再进每回合注入。要去「人格」页把要点写进 L0 / L1 才生效' },
                              '素材（不注入）',
                            )
                          : null,
                        entry.expired === true
                          ? h(
                              'span',
                              { className: 'sn-expired', title: '临时自述过了保质期，不再自动进上下文；内容还在，改成「稳定」或重写一条就回来' },
                              '已过期',
                            )
                          : null,
                      ),
                  isEditing
                    ? null
                    : h(
                        'span',
                        { className: 'sn-row-actions' },
                        h(
                          'select',
                          {
                            className: 'sn-tier',
                            value: entry.tier || 'stable',
                            title: '这条属于哪一型：核心先装（人格、长期身份）、稳定按 pin 排、临时最后',
                            onChange: function (e) { setNoteTier(stored, { tier: e.target.value }) },
                            disabled: busy !== '',
                          },
                          h('option', { value: 'core' }, '核心'),
                          h('option', { value: 'stable' }, '稳定'),
                          h('option', { value: 'temp' }, '临时'),
                        ),
                        h(
                          'button',
                          {
                            className: 'sn-btn sn-btn-ghost sn-pin' + (entry.pin === true ? ' sn-pin-on' : ''),
                            title: entry.pin === true ? '已钉住：同一型里优先装进去（再点取消）' : '钉住：同一型里优先装进去',
                            onClick: function () { setNoteTier(stored, { pin: entry.pin !== true }) },
                            disabled: busy !== '',
                          },
                          entry.pin === true ? '★' : '☆',
                        ),
                        h('button', { className: 'sn-btn sn-btn-ghost', onClick: function () { startEditNote(stored, entry.text) }, disabled: busy !== '' }, '改'),
                        h('button', { className: 'sn-btn sn-btn-danger', onClick: function () { removeNote(stored) }, disabled: busy !== '' }, pendingDelete === stored ? '真的删' : '删'),
                      ),
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
          '上限 ' + (state.profile && state.profile.maxChars ? state.profile.maxChars : 110) + ' 字 · 当前 ' + (state.profile ? state.profile.chars : 0) + ' 字' +
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

      var persona = state.persona || {}
      var personaValuesNow = personaValues()
      var p0Chars = pinCount(personaValuesNow.l0)
      var p1Chars = pinCount(personaValuesNow.l1)
      // L0 与 L1 之间那一个换行也占 320 里的字数（与保存校验同一把尺子），
      // 否则界面会绿着「320 / 320」，点保存却被拒。
      var pGap = p0Chars > 0 && p1Chars > 0 ? 1 : 0
      var pTotalChars = p0Chars + p1Chars + pGap
      var pRestChars = Math.max(0, 320 - pTotalChars)
      var pL1Max = Math.max(0, 320 - Math.min(p0Chars, 80) - (p0Chars > 0 ? 1 : 0))
      var p2Chars = pinCount(personaValuesNow.l2)
      // 超限不靠 maxLength 拦（它按 UTF-16 计，emoji 算两个），而是停掉「保存」并说明原因；
      // 磁盘那关仍由服务端整份校验兜底 —— 这里只是别让人白点一次。
      var pOver = p0Chars > 80 || pTotalChars > 320 || p0Chars + p1Chars + p2Chars > 8000
      var firstPage = (state.corrections && state.corrections.items) || []
      // 翻过页就把后面的接上；同一 id 只留第一条（翻页期间新证据插进来时会出现重复）
      var correctionItems = firstPage.concat(moreEvidence).filter(function (item, at, list) {
        return list.findIndex(function (other) { return other.id === item.id }) === at
      })
      var pickedCount = pickedEvidence.length

      var personaCard = h(
        'div',
        { className: 'sn-card', key: 'persona' },
        h('div', { className: 'sn-card-title' }, '人格三段（L0 / L1 每回合进，L2 按需取）'),
        h('div', { className: 'sn-hint' }, '这里只放「要是没人提醒，我就会忘」的那些。L0 和 L1 每回合都进上下文；L2 不进，只在 self_note 去取的时候出现。'),
        personaField('l0', 'L0 核心身份', '我是谁、和谁说话、怎么称呼。最先装；超过 80 字会被截断（并在这里标出来）。', personaValuesNow.l0, 80, 2),
        personaField('l1', 'L1 行为规则', '语气、回答骨架、情境优先级、禁忌边界。一行一条；装不下的整行跳过，不截半句。', personaValuesNow.l1, pL1Max, 6),
        h(
          'div',
          { className: 'sn-hint' },
          'L0 ' + p0Chars + ' + L1 ' + p1Chars + (pGap ? ' + 换行 1' : '') + ' = ' + pTotalChars + ' / 320 字（余 ' + pRestChars + '）',
        ),
        personaField('l2', 'L2 扩展设定', '外貌、服饰、世界观、兴趣。这一层不进每回合上下文；保存在同一个 persona.md 里，不占注入预算。', personaValuesNow.l2, (state.persona && state.persona.l2Limit) || Math.max(0, 8000 - pTotalChars), 6),
        pOver
          ? h(
              'div',
              { className: 'sn-hint-warn' },
              '超了：'
                + (p0Chars > 80 ? 'L0 超过 80 字；' : '')
                + (pTotalChars > 320 ? 'L0 + L1 超过 320 字；' : '')
                + (p0Chars + p1Chars + p2Chars > 8000 ? '整份超过 8000 字；' : '')
                + '减到上限以内再保存，否则整份会被拒绝、一个字都不写。',
            )
          : null,
        h(
          'div',
          { className: 'sn-actions' },
          h('button', { className: 'sn-btn', onClick: savePersona, disabled: busy !== '' || pOver }, '保存人格'),
          h('button', { className: 'sn-btn sn-btn-ghost', onClick: importPersona, disabled: busy !== '' }, '从 AGENT.md 导入'),
          h('span', { className: 'sn-grow' }),
          h('span', { className: 'sn-muted' }, '保存是整份校验：任一段不合格就一个字都不写。'),
        ),

        h(
          'div',
          { className: 'sn-sub' },
          '纠偏候选（' + ((state.corrections && state.corrections.total) || correctionItems.length) + ' 条，这些只是证据' +
            (correctionItems.length < ((state.corrections && state.corrections.total) || 0) ? '，这里列了 ' + correctionItems.length + ' 条' : '') +
            '）',
        ),
        h(
          'div',
          { className: 'sn-hint' },
          '模型能读到它们，但你没有写入权限 —— 采纳必须由人在这儿点。勾几条 → 改写成一条规则 → 保存人格时才算用过这些证据。',
        ),
        correctionItems.length === 0
          ? h('div', { className: 'sn-empty' }, '还没攒到纠偏证据。你纠正我之后，这里会慢慢出现原话。')
          : h(
              'ul',
              { className: 'sn-list' },
              correctionItems.map(function (item) {
                var picked = pickedEvidence.indexOf(item.id) >= 0
                return h(
                  'li',
                  { key: item.id, className: 'sn-item' },
                  h(
                    'label',
                    { className: 'sn-toggle sn-evidence' },
                    h('input', {
                      type: 'checkbox',
                      checked: picked,
                      onChange: function () { toggleEvidence(item.id) },
                    }),
                    h('span', { className: 'sn-evidence-quote' }, item.quote),
                  ),
                  h('span', { className: 'sn-evidence-meta' }, (item.at || '').slice(0, 10) + ' · ' + (item.session || '')),
                )
              }),
            ),
        h(
          'div',
          { className: 'sn-actions' },
          h('button', { className: 'sn-btn sn-btn-ghost', onClick: draftRuleFromPicked, disabled: busy !== '' }, '用选中的 ' + pickedCount + ' 条写一条规则'),
          h(
            'button',
            { className: 'sn-btn sn-btn-ghost', onClick: discardPicked, disabled: busy !== '' || pickedCount === 0 },
            '丢弃选中的证据',
          ),
          (moreCursor !== null ? moreCursor !== '' : state.corrections && state.corrections.nextCursor)
            ? h('button', { className: 'sn-btn sn-btn-ghost', onClick: loadMoreEvidence, disabled: busy !== '' }, busy === 'corrections' ? '翻页中…' : '加载更多')
            : null,
        ),
        h('textarea', {
          className: 'sn-input',
          rows: 3,
          'aria-label': '把选中的证据改写成一条规则',
          placeholder: '把上面几句改写成一条能照着做的规则，例如「回答时先举例，再给结论」。',
          value: ruleDraft,
          onChange: function (e) { setRuleDraft(e.target.value) },
        }),
        h(
          'div',
          { className: 'sn-actions' },
          h(
            'button',
            {
              className: 'sn-btn',
              disabled: busy !== '' || ruleDraft.trim() === '',
              onClick: function () {
                var body = ruleDraft.trim()
                if (body === '') return
                var nextL1 = (personaValues().l1 + String.fromCharCode(10) + body).trim()
                editPersona('l1', nextL1)
                setNotice({ tone: 'ok', text: '规则已加进 L1 草稿，还没保存 —— 确认没问题再点「保存人格」。' })
              },
            },
            '加进 L1（先不进盘）',
          ),
          h('span', { className: 'sn-grow' }),
          h('span', { className: 'sn-muted' }, sectionlessHint(persona)),
        ),
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
            '　环境 ' + (budget.env || 0) +
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
              var editingThis = factEdit !== null && factEdit.id === fact.id
              return h(
                'div',
                { key: fact.id, className: 'sn-fact' },
                editingThis
                  ? h(
                      'div',
                      { className: 'sn-fact-edit' },
                      h('textarea', {
                        className: 'sn-input',
                        rows: 2,
                        maxLength: 240,
                        value: factEdit.text,
                        onChange: function (e) { setFactEdit({ id: fact.id, text: e.target.value }) },
                      }),
                      h(
                        'span',
                        { className: 'sn-actions' },
                        h('button', { className: 'sn-btn', onClick: function () { saveFactText(fact.id, factEdit.text) }, disabled: busy !== '' }, '保存'),
                        h('button', { className: 'sn-btn sn-btn-ghost', onClick: function () { setFactEdit(null) }, disabled: busy !== '' }, '取消'),
                      ),
                    )
                  : h('div', { className: 'sn-fact-text' }, fact.text),
                h(
                  'div',
                  { className: 'sn-actions' },
                  h('span', { className: 'sn-heat', title: '热度 = 使用次数 × 时间衰减；只是排序，不改可信度' }, '热度 ' + (fact.heat ?? '—')),
                  h('span', { className: 'sn-grow' }),
                  editingThis
                    ? null
                    : h('button', { className: 'sn-btn sn-btn-ghost', onClick: function () { setFactEdit({ id: fact.id, text: fact.text }) }, disabled: busy !== '' }, '改'),
                  h(
                    'button',
                    { className: 'sn-btn sn-btn-ghost' + (pendingRetire === fact.id ? ' sn-btn-danger' : ''), onClick: function () { retireFact(fact.id) }, disabled: busy !== '' },
                    pendingRetire === fact.id ? '真的退役' : '退役',
                  ),
                ),
              )
            }),

        retiredFacts.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'sn-sub' }, '已退役（' + ((state.facts && state.facts.retiredCount) || retiredFacts.length) + '）'),
              h(
                'div',
                { className: 'sn-hint' },
                '退役只是不再进注入，条目本身还在文件里。想让它回来，点「恢复」。' +
                  (retiredFacts.length < ((state.facts && state.facts.retiredCount) || 0)
                    ? '（这里只列最近 ' + retiredFacts.length + ' 条）'
                    : ''),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sn-btn sn-btn-ghost',
                  'aria-expanded': showRetired ? 'true' : 'false',
                  onClick: function () { setShowRetired(!showRetired) },
                },
                showRetired ? '收起' : '展开这 ' + retiredFacts.length + ' 条',
              ),
              showRetired
                ? h(
                    'div',
                    { className: 'sn-retired-list' },
                    retiredFacts.map(function (fact) {
                      return h(
                        'div',
                        { key: 'r-' + fact.id, className: 'sn-fact' },
                        h('div', { className: 'sn-fact-text' }, fact.text),
                        h(
                          'div',
                          { className: 'sn-actions' },
                          h('span', { className: 'sn-heat' }, '退役于 ' + (fact.retiredAt || fact.updatedAt || '—')),
                          h('span', { className: 'sn-grow' }),
                          h(
                            'button',
                            { type: 'button', className: 'sn-btn', onClick: function () { setFact(fact.id, 'approved') }, disabled: busy !== '' },
                            '恢复',
                          ),
                        ),
                      )
                    }),
                  )
                : null,
            )
          : null,

        (state.habits || []).length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'sn-sub' }, '已生效的习惯（进注入的「习惯」段）'),
              h('div', { className: 'sn-hint' }, '不要了就撤销。撤销只是不再是习惯，标签和记忆都还在。'),
              (state.habits || []).map(function (habit) {
                return h(
                  'div',
                  { key: 'h-' + habit.text, className: 'sn-fact' },
                  h('div', { className: 'sn-fact-text' }, habit.text),
                  h(
                    'div',
                    { className: 'sn-actions' },
                    h(
                      'button',
                      {
                        className: 'sn-btn sn-btn-ghost',
                        onClick: function () { setHabitState(habit.text, 'retired', habit.tag || '') },
                        disabled: busy !== '',
                      },
                      '撤销',
                    ),
                  ),
                )
              }),
            )
          : null,
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
        if (Array.isArray(seg.skippedDetail)) {
          seg.skippedDetail.forEach(function (item) {
            skippedItems.push({
              seg: seg.label,
              text: String((item && item.preview) ?? ''),
              reason: String((item && item.reason) ?? ''),
            })
          })
        } else {
          // 兼容旧 /state：只有 skipped 字符串，没有原因，也不许白板
          ;(seg.skipped || []).forEach(function (text) {
            skippedItems.push({ seg: seg.label, text: String(text ?? ''), reason: '' })
          })
        }
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
            (inj.chars || 0) + ' / ' + (inj.limit || 1000) + ' 字' +
              (inj.overhead > 0 ? '（固定开销 ' + inj.overhead + ' 字）' : ''),
          ),
        ),
        h('div', { className: 'sn-hint' }, '下面这段每回合都贴在用户消息前面。它只改变「我」看到的背景，不会出现在你的输入框里。'),
        h('pre', { className: 'sn-pre' }, inj.text || '（现在没有可注入的内容）'),
        h(
          'div',
          { className: 'sn-seg' },
          injSegments.map(function (seg) {
            var skipped = Array.isArray(seg.skippedDetail) ? seg.skippedDetail : (seg.skipped || [])
            var stateText = seg.chars > 0 ? '全部进入' : '暂无内容'
            if (skipped.length > 0) stateText = '跳过 ' + skipped.length + ' 条'
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
          '七段只算记忆本身的字数；标题、边界句、画像抬头这些框架文字另计（' + (inj.overhead || 0) + ' 字），也算在总字数里。',
        ),
        skippedItems.length === 0
          ? null
          : h(
              'details',
              { className: 'sn-skipped' },
              h(
                'summary',
                { className: 'sn-skipped-head' },
                '被跳过的 ' + skippedItems.length + ' 条 —— 点开看每条为什么没进（每条都标了原因）',
              ),
              skippedItems.slice(0, 6).map(function (item, i) {
                // key 用下标：内容指纹派生 id，同段两条相同文本会撞 id（口径裁定 2）
                var reasonLabel = { budget: '预算不足', expired: '已过期', scope: '项目不匹配', duplicate: '重复' }
                return h(
                  'div',
                  { className: 'sn-skipped-row', key: 'sk' + i },
                  h('span', { className: 'sn-badge' }, item.seg),
                  h('span', { className: 'sn-skipped-reason' }, reasonLabel[item.reason] || item.reason || '未说明'),
                  h('span', { className: 'sn-skipped-text' }, item.text),
                )
              }),
              skippedItems.length > 6 ? h('div', { className: 'sn-hint' }, '还有 ' + (skippedItems.length - 6) + ' 条没列出来') : null,
            ),
      )

      // 注入归属：这条记忆到底有没有被用上。数据来自 hitCount / lastHit，
      // 只有「真的进了这句话」才 +1，被检索到不算 —— 所以它衡量的是占用，不是价值。
      var attr = state.attribution || {}
      var attrRows = attr.rows || []
      var attrSegLabel = { profile: '画像', env: '环境', facts: '结论' }

      function attrTime(row) {
        if (row.state === 'never') return '从没进过'
        if (row.state === 'searched') {
          if (row.seenDays === 0) return '今天搜到过'
          if (row.seenDays === null || row.seenDays === undefined) return '搜到过'
          return row.seenDays + ' 天前搜到'
        }
        if (row.days === 0) return '今天还进过'
        if (row.days === null) return '时间不明'
        return row.days + ' 天前'
      }

      var attributionCard = attrRows.length === 0
        ? null
        : h(
            'div',
            { className: 'sn-card', key: 'attribution' },
            h(
              'div',
              { className: 'sn-card-head' },
              h('div', { className: 'sn-card-title' }, '注入归属'),
              h(
                'div',
                { className: 'sn-card-note' },
                '在用 ' + (attr.live || 0) + ' · 静默 ' + (attr.stale || 0) + ' · 只搜到过 ' + (attr.searched || 0) + ' · 从没进过 ' + (attr.never || 0),
              ),
            ),
            h(
              'div',
              { className: 'sn-hint' },
              '每条已采纳记忆真的被贴进提示词几次、上次什么时候。只有进了这句话才 +1，被检索到不算；' +
                '超过 ' + (attr.staleDays || 30) + ' 天没进过的，就是占着位置没在用的。',
            ),
            h(
              'div',
              { className: 'sn-attr' },
              attrRows.slice(0, 14).map(function (row) {
                var text = row.text.length > 46 ? row.text.slice(0, 46) + '…' : row.text
                return h(
                  'div',
                  { className: 'sn-attr-row sn-attr-' + row.state, key: row.id },
                  h('span', { className: 'sn-badge' }, attrSegLabel[row.segment] || (row.state === 'searched' ? '搜到过' : '没进')),
                  h('span', { className: 'sn-attr-text' }, text),
                  h(
                    'span',
                    { className: 'sn-attr-num' },
                    row.state === 'searched' ? '翻了 ' + (row.seen || 0) + ' 次' : (row.hits || 0) + ' 次',
                  ),
                  h('span', { className: 'sn-attr-when' }, attrTime(row)),
                )
              }),
              attrRows.length > 14
                ? h('div', { className: 'sn-hint' }, '还有 ' + (attrRows.length - 14) + ' 条没列出来')
                : null,
            ),
          )

      var panels = {
        overview: [statusBar, budgetBlock, statsRow, settingsCard, doctorCard, indexCard, filesBlock, transferCard],
        notes: [writeCard, notesList],
        persona: [personaCard],
        memory: [memoryCard],
        profile: [profileCard],
        injection: [injectionCard, attributionCard],
      }
      var panelHints = {
        overview: '注入开关、容量上限，以及索引与文件位置。',
        notes: 'agent 写给自己看的话，攒多了从最旧的往 archive 挪。每一行都能改、能删。',
        persona: '三段人格：L0/L1 每回合都进上下文，L2 按需取。纠偏证据在这里变成规则，但必须人来拍板。',
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
          h('div', { className: 'sn-title' }, '人格（自述）'),
          h('div', { className: 'sn-sub' }, 'agent 写给自己看的话（「我」= agent），跨会话保留，每回合注入在对话开头。这里能改、能删，改完下一回合生效。'),
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
            h('li', { className: 'sn-intro-note' }, '每回合合计 ≤' + limit + ' 字：人格 ' + caps.persona + ' / 自述 ' + caps.notes + ' / 画像 ' + caps.profile + ' / 环境 ' + caps.env + ' / 结论 ' + caps.facts + ' / 习惯 ' + caps.habits + '。放不下的那一条会跳过、不截半句。这几段的上限写死在插件里（不是设置项）；检索工具不受这个限制。'),
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

        // 提示要贴顶：记忆页有二十多张卡，人在下半屏点「采纳 / 删除」，
        // 反馈如果留在文档流顶部，就等于没反馈 —— 会重复点。
        h(
          'div',
          { className: 'sn-notice-wrap', role: 'status', 'aria-live': 'polite' },
          h(Notice, { tone: notice && notice.tone, text: notice && notice.text }),
        ),

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
      '.sn-transfer{display:flex;flex-direction:column;gap:8px}',
      '.sn-transfer-row{display:flex;gap:8px;flex-wrap:wrap}',
      '.sn-transfer-pick{cursor:pointer}',
      '.sn-transfer-report{margin-top:4px;font-size:12px;line-height:1.7;color:var(--dsh-text-secondary)}',
      '.sn-transfer-warn{color:#b45309}',
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
      '.sn-field-wide{flex:1 1 100%}',
      '.sn-field textarea{width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-subtle,#d1d5db);border-radius:8px;background:var(--dsw-alias-bg-primary,#fff);color:inherit;resize:vertical;font:inherit}',
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
      '.sn-item{align-items:flex-start}',
      '.sn-item-editing{background:var(--dsw-alias-bg-secondary,#f8fafc);border-radius:8px;padding:6px 8px}',
      '.sn-edit{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}',
      '.sn-row-actions{display:flex;gap:6px;margin-left:auto;flex:none;opacity:.55;transition:opacity .12s ease}',
      '.sn-item:hover .sn-row-actions,.sn-item:focus-within .sn-row-actions{opacity:1}',
      '.sn-tier{font-size:11px;font-family:inherit;padding:2px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-subtle,#d1d5db);background:var(--dsw-alias-bg-primary,#fff);color:inherit;cursor:pointer}',
      '.sn-pin{padding:2px 8px;line-height:1.6}',
      '.sn-pin-on{color:#b45309;border-color:#fcd34d}',
      '.sn-expired{font-size:11px;color:#9ca3af;border:1px solid #e5e7eb;border-radius:6px;padding:0 6px;margin-left:6px;white-space:nowrap}',
      '.sn-material{font-size:11px;color:#b45309;border:1px solid #fcd34d;background:#fffbeb;border-radius:6px;padding:0 6px;margin-left:6px;white-space:nowrap}',
      '.sn-field-label{display:flex;align-items:baseline;gap:4px;font-weight:600}',
      '.sn-count{font-size:12px;font-weight:400;color:var(--dsw-alias-text-quaternary,#9ca3af);font-variant-numeric:tabular-nums}',
      '.sn-count-over{color:#dc2626;font-weight:600}',
      '.sn-evidence{align-items:flex-start;gap:8px}',
      '.sn-evidence-quote{line-height:1.6}',
      '.sn-evidence-meta{font-size:11px;color:var(--dsw-alias-text-quaternary,#9ca3af);white-space:nowrap}',
      '.sn-fact-edit{display:flex;flex-direction:column;gap:6px}',
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
      '.sn-loading-error{color:#991b1b}',
      '.sn-notice-wrap{position:sticky;top:0;z-index:2}',
      '.sn-notice-wrap>.sn-notice{box-shadow:0 1px 3px rgba(0,0,0,.08)}',
      '.sn-retired-list{display:flex;flex-direction:column;gap:6px;margin-top:6px}',
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
      ".sn-attr{display:flex;flex-direction:column;gap:6px}",
      ".sn-attr-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.5}",
      ".sn-attr-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-text-primary,#111827)}",
      ".sn-attr-num{color:var(--dsw-alias-text-secondary,#6b7280);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".sn-attr-when{min-width:72px;text-align:right;color:var(--dsw-alias-text-secondary,#6b7280);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".sn-attr-stale .sn-attr-when{color:#b45309}",
      ".sn-attr-searched .sn-attr-text{color:var(--dsw-alias-text-secondary,#6b7280)}",
      ".sn-doc-next{font-size:12px;line-height:1.6;background:#fff7ed;border:1px solid #fed7aa;color:#92400e;border-radius:8px;padding:6px 8px}",
      ".sn-attr-never .sn-attr-text{color:var(--dsw-alias-text-secondary,#9ca3af)}",
      '.sn-seg{display:flex;flex-direction:column;gap:4px}',
      '.sn-seg-row{display:flex;align-items:center;gap:10px;font-size:12px;padding:3px 0}',
      '.sn-seg-key{width:42px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-seg-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-text-primary,#111827);font-weight:600}',
      '.sn-seg-state{margin-left:auto;font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-seg-state-warn{color:#b45309}',
      '.sn-skipped{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-subtle,#e5e7eb);border-radius:8px}',
      '.sn-skipped-head{font-size:11.5px;color:#92400e;line-height:1.6;cursor:pointer}',
      '.sn-skipped-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.6;flex-wrap:wrap}',
      '.sn-skipped-reason{font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280);border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);border-radius:999px;padding:0 6px;white-space:nowrap}',
      '.sn-skipped-text{color:var(--dsw-alias-text-secondary,#4b5563)}',
      '.sn-doc-list{display:flex;flex-direction:column;gap:8px}',
      '.sn-doc-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.6;flex-wrap:wrap}',
      '.sn-doc-tag{font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px;white-space:nowrap}',
      '.sn-doc-ok{background:#ecfdf5;color:#047857}',
      '.sn-doc-warn{background:#fffbeb;color:#b45309}',
      '.sn-doc-error{background:#fef2f2;color:#b91c1c}',
      '.sn-doc-label{font-weight:600;color:var(--dsw-alias-text-primary,#111827)}',
      '.sn-doc-detail{flex:1;min-width:200px;color:var(--dsw-alias-text-secondary,#4b5563)}',
      // —— 可读性与适配（原来是 11px + #9ca3af，在浅底上几乎要贴到屏幕上看）——
      '.sn-hint{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-hint-warn{font-size:12px}',
      '.sn-date,.sn-file-meta,.sn-heat,.sn-evidence-meta,.sn-fact-cite,.sn-card-note{font-size:11.5px}',
      '.sn-muted{color:var(--dsw-alias-text-secondary,#6b7280)}',
      // 输入框以前写死 110px，抬头那种长文本被压成一条缝；宽度交给容器，只在窄屏才吃满
      '.sn-field{flex-wrap:wrap}',
      '.sn-field input,.sn-field textarea{width:auto;min-width:7em;max-width:100%}',
      '.sn-field input[type=text],.sn-field textarea{min-width:14em;flex:1}',
      // 行内操作按钮别藏到 hover 里：触屏没有 hover，键盘用户也未必摸到
      '.sn-row-actions{opacity:.8}',
      '@media (hover:none){.sn-row-actions{opacity:1}}',
      '.sn-expired{color:var(--dsw-alias-text-secondary,#6b7280);border-color:var(--dsw-alias-border-subtle,#d1d5db)}',
      '@media (max-width:520px){.sn-limits,.sn-row,.sn-actions{flex-wrap:wrap}.sn-field{width:100%}.sn-field input,.sn-field textarea{width:100%}.sn-card{padding:12px}}',
      // 深色底：插件原先把浅色写死了，宿主切深色时这些块会白得刺眼
      '@media (prefers-color-scheme:dark){.sn-notice-ok{background:#052e21;color:#a7f3d0}.sn-notice-warn{background:#3f1212;color:#fecaca}.sn-notice{background:var(--dsw-alias-bg-secondary,#1f2937)}.sn-badge,.sn-file-count,.sn-tab-on .sn-tab-badge{background:#1e1b4b;color:#c7d2fe}.sn-material,.sn-kv-tag-stale,.sn-pair-head,.sn-doc-next,.sn-skipped-head{background:#3b2a06;color:#fcd34d}.sn-kv-tag-ok{background:#052e21;color:#6ee7b7}.sn-doc-next{border-color:#92400e}.sn-fact-conflict{background:#2a2308;border-color:#92400e}.sn-doc-ok{background:#052e21;color:#6ee7b7}.sn-doc-error{background:#3f1212;color:#fecaca}.sn-doc-warn{background:#3b2a06;color:#fcd34d}}',
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
              return '人格（自述）'
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
