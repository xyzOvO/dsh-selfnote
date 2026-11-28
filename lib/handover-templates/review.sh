#!/usr/bin/env bash
# 生成 .handover/REVIEW.md —— 待审队列视图。
# 由人维护；Agent 只读不写。用法：bash .handover/scripts/review.sh
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
cs_dir="$root/CHANGESETS"
out="$root/REVIEW.md"

status_ok() {
  case "$1" in
    todo|awaiting-review|verified|rolled-back|abandoned) return 0 ;;
    *) return 1 ;;
  esac
}

# CLAIMS 里出现 | 冲突 | 单元格才算，避免正文解释性文字误判
claims_flag='-'
if [ -f "$root/CLAIMS.md" ] && grep -Eq '\|[[:space:]]*冲突[[:space:]]*\|' "$root/CLAIMS.md"; then
  claims_flag='有冲突'
fi

rows=''
bad=''
n_awaiting=0
n_total=0

for f in "$cs_dir"/*.md; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  [ "$base" = 'TEMPLATE.md' ] && continue
  n_total=$((n_total + 1))

  fm=$(awk 'NR==1 && /^---$/ {p=1; next} p && /^---$/ {exit} p' "$f")
  field() { printf '%s\n' "$fm" | sed -n "s/^$1:[[:space:]]*//p" | head -1 | sed 's/[[:space:]]*$//'; }

  id=$(field id); pid=$(field project_id); agent=$(field agent); status=$(field status); risk=$(field risk); created=$(field created)

  files=$(sed -n 's/^- 改动文件：//p' "$f" | head -1)
  # 验证命令 = 文件里第一个围栏代码块的第一行非注释内容（模板保证「验证」块排在第一位）。
  # 只做 ASCII 判断：awk 在不同 locale 下匹配中文不可靠。
  cmd=$(awk '
    /^[[:space:]]*```/ {n++; next}
    n==1 && $0 !~ /^[[:space:]]*#/ && NF>0 {print; exit}
  ' "$f" | sed 's/^[[:space:]]*//' )

  missing=''
  [ -z "$id" ] && missing="$missing id"
  [ -z "$pid" ] && missing="$missing project_id"
  [ -z "$agent" ] && missing="$missing agent"
  [ -z "$status" ] && missing="$missing status"
  [ -z "$risk" ] && missing="$missing risk"
  [ -z "$created" ] && missing="$missing created"

  if [ -n "$missing" ]; then
    bad="${bad}| $base | 缺字段:$missing |
"
    continue
  fi
  if ! status_ok "$status"; then
    bad="${bad}| $base | status 不合法：$status |
"
    continue
  fi

  [ "$status" = 'awaiting-review' ] && n_awaiting=$((n_awaiting + 1))
  [ -z "$files" ] && files='-'
  [ -z "$cmd" ] && cmd='（缺验证命令）'
  rows="${rows}| $id | $agent | $risk | $status | $files | $cmd | $claims_flag |
"
done

{
  echo '# REVIEW'
  echo
  echo "> 由 scripts/review.sh 生成，Agent 只读。生成时间：$(date '+%Y-%m-%d %H:%M')"
  echo
  echo "共 $n_total 条变更集，其中 awaiting-review **$n_awaiting** 条。"
  if [ "$n_awaiting" -gt 3 ]; then
    echo
    echo '**待审队列已满（超过 3 条），先清队列再接新任务。**'
  fi
  echo
  echo '| 变更集 | Agent | 风险 | 状态 | 改动文件 | 验证命令 | 冲突 |'
  echo '|---|---|---|---|---|---|---|'
  if [ -n "$rows" ]; then printf '%s' "$rows"; else echo '| （暂无） | | | | | | |'; fi

  if [ -n "$bad" ]; then
    echo
    echo '## 待修（不进审核队列）'
    echo
    echo '| 文件 | 问题 |'
    echo '|---|---|'
    printf '%s' "$bad"
  fi
} > "$out"

echo "已生成 $out（$n_total 条变更集，$n_awaiting 条待审）"
