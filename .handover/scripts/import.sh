#!/usr/bin/env bash
# 导入交接卡：从一份导出的 markdown 还原 .handover/。
# 用法：scripts/import.sh <包.md> [.handover 目录]
# 目标已有内容时，会先整体备份成 <目录>.bak-<时间戳>。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ $# -lt 1 ]; then
  echo "用法：scripts/import.sh <包.md> [.handover 目录]" >&2
  exit 1
fi

file="$1"
root="${2:-$(dirname "$here")}"
node "$here/bundle.cjs" import --file "$file" --root "$root"
