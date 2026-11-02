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

    function apiGet(path) {
      return fetch(API + path, { headers: { accept: 'application/json' } }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
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
      var suggestions = state.habitSuggestions || []

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
          'div',
          { className: 'sn-statusbar' },
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
        ),

        h(
          'div',
          { className: 'sn-stats' },
          h('div', { className: 'sn-stat' }, h('div', { className: 'sn-stat-num' }, state.entries), h('div', { className: 'sn-stat-label' }, '条自述')),
          h('div', { className: 'sn-stat' }, h('div', { className: 'sn-stat-num' }, state.chars), h('div', { className: 'sn-stat-label' }, '字')),
          h(
            'div',
            { className: 'sn-stat' },
            h('div', { className: 'sn-stat-num' }, usage + '%'),
            h('div', { className: 'sn-stat-label' }, '容量占用'),
          ),
        ),

        h(
          'div',
          { className: 'sn-card' },
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
        ),

        h(
          'div',
          { className: 'sn-card' },
          h('div', { className: 'sn-card-title' }, '手动写一条（主语是 agent 自己，第一人称「我」指 agent）'),
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
        ),

        h(Notice, { tone: notice && notice.tone, text: notice && notice.text }),

        h(
          'div',
          { className: 'sn-card' },
          h('div', { className: 'sn-card-title' }, '历史对话索引（用户说过的话 + agent 说过的话，按角色分层）'),
          h(
            'div',
            { className: 'sn-row sn-muted' },
            '会话 ' + ((state.memory && state.memory.sessions) || 0) + ' 个 · 已缓存 ' +
              ((state.memory && state.memory.cache) || 0) + ' 个 · 已确认事实 ' +
              ((state.memory && state.memory.approved) || 0) + ' 条',
          ),
          h('div', { className: 'sn-hint' }, '查旧账用 memory_recall；原文取自 DSH 自己的会话记录，只读、不外发。'),
        ),

        h(
          'div',
          { className: 'sn-card' },
          h('div', { className: 'sn-card-title' }, '关于你（画像：从已采纳记忆聚合，不是新事实）'),
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
        ),

        h(
          'div',
          { className: 'sn-card' },
          h('div', { className: 'sn-card-title' }, '记忆条目（主语是用户：你明确说过、可以引用的结论）'),
          h(
            'div',
            { className: 'sn-hint' },
            '本回合注入 ' + ((state.budget && state.budget.total) || 0) + ' / ' + ((state.budget && state.budget.limit) || 300) +
              ' 字　·　自述 ' + ((state.budget && state.budget.notes) || 0) +
              '　结论 ' + ((state.budget && state.budget.facts) || 0) +
              '　习惯 ' + ((state.budget && state.budget.habits) || 0),
          ),

          h('div', { className: 'sn-sub' }, '待确认（' + candidates.length + '）'),
          candidates.length === 0
            ? h('div', { className: 'sn-empty' }, '没有待确认的候选。我翻到值得记的东西时会先放这儿。')
            : candidates.map(function (fact) {
                return h(
                  'div',
                  { key: fact.id, className: 'sn-fact' },
                  h('div', { className: 'sn-fact-text' }, fact.text),
                  h('div', { className: 'sn-fact-cite' }, '← ' + fact.citation.sessionId + ' 第 ' + fact.citation.index + ' 条 · ' + fact.citation.date),
                  h(
                    'div',
                    { className: 'sn-actions' },
                    h('button', { className: 'sn-btn', onClick: function () { setFact(fact.id, 'approved') }, disabled: busy !== '' }, '采纳'),
                    h('button', { className: 'sn-btn sn-btn-ghost', onClick: function () { setFact(fact.id, 'retired') }, disabled: busy !== '' }, '丢弃'),
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
        ),

        h(
          'div',
          { className: 'sn-card' },
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
        ),

        h(
          'details',
          { className: 'sn-details' },
          h('summary', null, '文件在哪'),
          h('div', { className: 'sn-mono' }, '内容：' + state.notesFile),
          h('div', { className: 'sn-mono' }, '归档：' + state.archiveDir),
          h('div', { className: 'sn-mono' }, '配置：' + state.configFile),
        ),
      )
    }

    var CSS = [
      '.sn-root{display:flex;flex-direction:column;gap:14px;font-size:13px}',
      '.sn-head{display:flex;flex-direction:column;gap:4px}',
      '.sn-title{font-size:15px;font-weight:600;color:var(--dsw-alias-text-primary,#111)}',
      '.sn-sub{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280);line-height:1.5}',
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
      '.sn-fact{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-subtle,#eef0f2);border-radius:8px}',
      '.sn-fact-text{line-height:1.5}',
      '.sn-fact-cite{font-size:11px;color:var(--dsw-alias-text-secondary,#9ca3af);font-family:ui-monospace,Menlo,Consolas,monospace}',
      '.sn-details{font-size:11px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.sn-details summary{cursor:pointer;user-select:none}',
      '.sn-mono{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;padding-top:4px}',
      '.sn-loading{padding:16px;font-size:12px;color:var(--dsw-alias-text-secondary,#9ca3af)}',
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
        ctx.slots.register(
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
