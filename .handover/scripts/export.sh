#!/usr/bin/env bash
# 导出交接卡：把 .handover/ 打成一个 markdown 文件，可直接发给别人或别的 Agent。
# 用法：scripts/export.sh [输出文件] [.handover 目录]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${2:-$(dirname "$here")}"
out="${1:-}"

if [ -n "$out" ]; then
  node "$here/bundle.cjs" export --root "$root" --out "$out"
else
  name="$(basename "$(cd "$root/.." && pwd)")"
  out="handover-${name}-$(date +%Y%m%d-%H%M).md"
  node "$here/bundle.cjs" export --root "$root" --out "$out"
  echo "可以把这个文件整份发给接手的 Agent：$out"
fi
