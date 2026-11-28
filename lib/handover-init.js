/**
 * 给一个项目铺交接卡骨架：在 <项目根>/.handover/ 下落八个文件 + 一个评审脚本。
 *
 * 规则只有一条：**已存在就不覆盖**。交接卡里存的是别人的工作状态，
 * 自动覆盖等于替人删记忆，宁可让用户自己备份后再来。
 * 模板在 handover-templates/ 里，占位符 __PROJECT_ID__ 之类在这里替换。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'handover-templates')
const CORE_FILES = ['CONTEXT.md', 'STATE.md', 'HISTORY.md', 'TASKS.md', 'JOURNAL.md', 'PROTOCOL.md', 'CLAIMS.md']

function pad(value) {
  return value < 10 ? '0' + value : String(value)
}

function dateParts(when) {
  const at = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date()
  const y = at.getFullYear()
  const m = pad(at.getMonth() + 1)
  const d = pad(at.getDate())
  return { compact: `${y}${m}${d}`, today: `${y}-${m}-${d}` }
}

/** 项目 id 只保留字母数字与连字符，别把空格和中文塞进文件名/变更集编号。 */
function cleanId(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const ascii = text.replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '')
  return ascii === '' ? '' : ascii.toLowerCase()
}

function fillTemplate(text, vars) {
  return text
    .split('__PROJECT_ID__').join(vars.projectId)
    .split('__PROJECT_NAME__').join(vars.projectName)
    .split('__AGENT__').join(vars.agent)
    .split('__DATE__').join(vars.date)
    .split('__TODAY__').join(vars.today)
}

/**
 * 铺骨架。成功返回 { ok:true, dest, projectId, files }；失败返回 { ok:false, error }。
 * 不抛异常 —— 出错也要让设置页把原因原样显示给人看。
 */
export function initHandover(root, options = {}) {
  const target = typeof root === 'string' ? root.trim() : ''
  if (target === '') return { ok: false, error: '先填项目根路径：要往哪个项目里装交接卡' }
  let isDir = false
  try {
    isDir = existsSync(target) && statSync(target).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) return { ok: false, error: '这个目录不存在：' + target }

  const dest = join(target, '.handover')
  if (existsSync(dest)) {
    return { ok: false, error: '这个项目已经有 .handover/ 了 —— 不覆盖。要重建请先备份好再手动删掉它。', dest }
  }

  const projectId = cleanId(options.projectId) || cleanId(basename(target)) || 'project'
  const projectName = typeof options.projectName === 'string' && options.projectName.trim() !== ''
    ? options.projectName.trim()
    : projectId
  const agent = cleanId(options.agent) || 'agent'
  const stamps = dateParts(options.now)
  const vars = { projectId, projectName, agent, date: stamps.compact, today: stamps.today }

  const files = []
  try {
    mkdirSync(join(dest, 'CHANGESETS'), { recursive: true })
    mkdirSync(join(dest, 'scripts'), { recursive: true })
    for (const name of CORE_FILES) {
      const body = fillTemplate(readFileSync(join(TEMPLATE_DIR, name), 'utf8'), vars)
      writeFileSync(join(dest, name), body, 'utf8')
      files.push(name)
    }
    const template = fillTemplate(readFileSync(join(TEMPLATE_DIR, 'CHANGESETS', 'TEMPLATE.md'), 'utf8'), vars)
    writeFileSync(join(dest, 'CHANGESETS', 'TEMPLATE.md'), template, 'utf8')
    files.push('CHANGESETS/TEMPLATE.md')
    copyFileSync(join(TEMPLATE_DIR, 'review.sh'), join(dest, 'scripts', 'review.sh'))
    try {
      chmodSync(join(dest, 'scripts', 'review.sh'), 0o755)
    } catch {
      /* Windows 上没有可执行位，忽略 */
    }
    files.push('scripts/review.sh')
  } catch (err) {
    return { ok: false, error: '写文件失败：' + String(err?.message || err), dest }
  }

  return { ok: true, dest, projectId, projectName, agent, files, today: stamps.today }
}

export const HANDOVER_CORE_FILES = CORE_FILES.slice()
