import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, crlf, edits) {
  const raw = readFileSync(file, 'utf8')
  let text = crlf ? raw.split('\r\n').join('\n') : raw
  for (const [oldStr, newStr, label] of edits) {
    const count = text.split(oldStr).length - 1
    if (count !== 1) throw new Error(`${file}: [${label}] 命中 ${count} 次，应为 1`)
    text = text.replace(oldStr, () => newStr)
  }
  writeFileSync(file, crlf ? text.split('\n').join('\r\n') : text, 'utf8')
  console.log(`${file}: ${edits.length} 处替换完成`)
}

patch('lib/index.js', true, [
  [
    `      const rejects = recent.filter((item) => typeof item.reason === 'string')
      const clears = recent.filter((item) => item.action === 'clear')
      const clearNote = clears.length > 0 ? \`，清空自述 \${clears.length} 次\` : ''
      if (rejects.length === 0) {
        push('auth', '设置页准入', 'ok', \`最近 24 小时没有拒绝记录\${clearNote}\`)
      } else {
        const reasons = new Map()
        for (const item of rejects) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1)
        const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]
        push('auth', '设置页准入', 'warn', \`最近 24 小时拒了 \${rejects.length} 次，主要是 \${top[0]}（\${top[1]} 次）\${clearNote}\`, '看 ~/.dsh/selfnote/auth.log')
      }`,
    `      // 只看「真的进不来」的记录：
      //  - token-length:0 是旧版本（凭据必填那阵）留下的空头记录；现在空头等于没带，直接放行；
      //  - 脚本探测（curl / node）被拒不说明页面有问题 —— 页面自己压根不带凭据；
      // 真正值得响的是「浏览器页面被拒」，那才说明设置页打不开。
      const rejects = recent.filter(
        (item) => typeof item.reason === 'string' && !item.reason.startsWith('token-length:0'),
      )
      const clears = recent.filter((item) => item.action === 'clear')
      const clearNote = clears.length > 0 ? \`，清空自述 \${clears.length} 次\` : ''
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
          \`设置页被拒了 \${fromPage.length} 次（\${authReasonText(fromPage[0].reason)}），最后一次 \${when}\${clearNote}\`,
          '看 ~/.dsh/selfnote/auth.log',
        )
      } else if (scripts > 0) {
        push(
          'auth',
          '设置页准入',
          'ok',
          \`设置页没被拒过；有 \${scripts} 次是脚本探测（curl / node）被挡，属于正常\${clearNote}\`,
        )
      } else {
        push('auth', '设置页准入', 'ok', \`最近 24 小时没有拒绝记录\${clearNote}\`)
      }`,
    'doctor: auth 只报真被拒',
  ],
  [
    `function authLogPath() {`,
    `/** 浏览器请求和脚本请求要分开看：脚本被拒是设计如此，页面被拒才是毛病。 */
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

function authLogPath() {`,
    'auth: 解释函数',
  ],
])
