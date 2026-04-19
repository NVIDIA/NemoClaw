#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# SPDX header check (and optional auto-insert), similar in spirit to DOCA's check_doca_license.py --fix.
#
# Usage:
#   check-spdx-headers.sh FILE...           # fail if header missing
#   check-spdx-headers.sh --fix FILE...     # insert NVIDIA Apache-2.0 SPDX block after shebang (if any)

set -euo pipefail

COPYRIGHT_SUBSTR="SPDX-FileCopyrightText: Copyright (c)"
LICENSE_SUBSTR="SPDX-License-Identifier: Apache-2.0"

usage() {
  echo "Usage: $0 [--fix] FILE..." >&2
  exit 2
}

FIX=false
if [[ "${1:-}" == "--fix" ]]; then
  FIX=true
  shift
fi

[[ $# -gt 0 ]] || usage

has_spdx() {
  local file=$1
  local head
  head=$(head -n 16 -- "$file" 2>/dev/null) || return 1
  grep -Fq "$COPYRIGHT_SUBSTR" <<<"$head" || return 1
  grep -Fq "$LICENSE_SUBSTR" <<<"$head" || return 1
  return 0
}

comment_style_for() {
  local base
  base=$(basename "$1")
  case "$base" in
    Dockerfile | *.dockerfile | *.Dockerfile) echo "#" ;;
    *.ts | *.tsx | *.js | *.mjs | *.cjs) echo "//" ;;
    *) echo "#" ;;
  esac
}

spdx_block() {
  local style=$1
  local year
  year=$(date +%Y)
  if [[ "$style" == "//" ]]; then
    printf '// SPDX-FileCopyrightText: Copyright (c) %s NVIDIA CORPORATION & AFFILIATES. All rights reserved.\n' "$year"
    printf '// SPDX-License-Identifier: Apache-2.0\n'
  else
    printf '# SPDX-FileCopyrightText: Copyright (c) %s NVIDIA CORPORATION & AFFILIATES. All rights reserved.\n' "$year"
    printf '# SPDX-License-Identifier: Apache-2.0\n'
  fi
}

insert_spdx() {
  local file=$1
  local style
  style=$(comment_style_for "$file")
  local tmp
  local mode
  tmp="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-spdx.XXXXXX")"
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
  {
    IFS= read -r first || true
    if [[ "$first" == '#!'* ]]; then
      printf '%s\n' "$first"
      spdx_block "$style"
      printf '\n'
      cat
    else
      spdx_block "$style"
      printf '\n'
      if [[ -n "${first:-}" ]]; then
        printf '%s\n' "$first"
      fi
      cat
    fi
  } <"$file" >"$tmp" && chmod "$mode" "$tmp" && mv "$tmp" "$file"
}

failed=0
for file in "$@"; do
  [[ -f "$file" ]] || continue
  if has_spdx "$file"; then
    continue
  fi
  if [[ "$FIX" == true ]]; then
    echo "Adding SPDX header: $file"
    insert_spdx "$file"
  else
    echo "Missing SPDX-FileCopyrightText or SPDX-License-Identifier (first ~16 lines): $file"
    failed=1
  fi
done

exit "$failed"
