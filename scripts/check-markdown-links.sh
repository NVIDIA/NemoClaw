#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Check that relative links in markdown files point to files that exist.
#
# Usage:
#   check-markdown-links.sh                  # check all .md files in repo
#   check-markdown-links.sh FILE ...         # check specific files
#
# Exit codes:
#   0  all relative links resolve
#   1  one or more broken links found

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Directories to skip (glob patterns relative to repo root).
SKIP_DIRS="node_modules|dist|\.venv|__pycache__|nemoclaw/node_modules|docs/_build|_deps"

broken=0

check_file() {
  local file="$1"
  local dir
  dir="$(dirname "$file")"
  local line_num=0
  local in_code_block=false
  local fence_marker=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_num=$((line_num + 1))

    # Track fenced code blocks (``` or ~~~), matching opener to closer.
    # A closing fence must use the same character and be at least as long.
    if [[ "$line" =~ ^[[:space:]]*((\`\`\`+)|(\~\~\~+)) ]]; then
      local marker="${BASH_REMATCH[1]}"
      if [[ "$in_code_block" == true ]]; then
        if [[ "${marker:0:1}" == "${fence_marker:0:1}" && ${#marker} -ge ${#fence_marker} ]]; then
          in_code_block=false
          fence_marker=""
        fi
      else
        # Check for MyST include directives (```{include} path).
        if [[ "$line" =~ ^[[:space:]]*\`\`\`\{include\}[[:space:]]+(.+)$ ]]; then
          local inc_path="${BASH_REMATCH[1]}"
          # Trim trailing whitespace.
          inc_path="${inc_path%"${inc_path##*[![:space:]]}"}"
          local resolved
          if [[ "$inc_path" == /* ]]; then
            resolved="${inc_path#/}"
          else
            resolved="$dir/$inc_path"
          fi
          if [[ ! -e "$REPO_ROOT/$resolved" ]]; then
            echo "::error file=${file},line=${line_num}::Broken include: ${inc_path} (resolved: ${resolved})"
            broken=$((broken + 1))
          fi
        fi
        in_code_block=true
        fence_marker="$marker"
      fi
      continue
    fi
    [[ "$in_code_block" == false ]] || continue

    # Extract standard markdown links: [text](target)
    # Uses a loop with parameter expansion to handle multiple links per line.
    local remaining="$line"
    local link_re='\]\(([^)]+)\)'
    while [[ "$remaining" =~ $link_re ]]; do
      local target="${BASH_REMATCH[1]}"
      # Advance past this match to find subsequent links on the same line.
      remaining="${remaining#*"${BASH_REMATCH[0]}"}"

      # Skip external URLs.
      [[ ! "$target" =~ ^https?:// ]] || continue
      # Skip mailto links.
      [[ ! "$target" =~ ^mailto: ]] || continue
      # Skip anchor-only links.
      [[ ! "$target" =~ ^# ]] || continue

      # Strip anchor fragment (#section) from the target path.
      local path="${target%%#*}"
      # Skip if nothing left after stripping anchor (was "#anchor" inside a path).
      [[ -n "$path" ]] || continue

      # Resolve relative to the file's directory (handle root-relative paths).
      local resolved
      if [[ "$path" == /* ]]; then
        resolved="${path#/}"
      else
        resolved="$dir/$path"
      fi

      if [[ ! -e "$REPO_ROOT/$resolved" ]]; then
        echo "::error file=${file},line=${line_num}::Broken link: ${target} (resolved: ${resolved})"
        broken=$((broken + 1))
      fi
    done
  done <"$REPO_ROOT/$file"
}

# Collect files to check.
files=()
if [[ $# -gt 0 ]]; then
  for f in "$@"; do
    # Normalize to repo-relative path.
    f="${f#"$REPO_ROOT/"}"
    [[ -f "$REPO_ROOT/$f" ]] && files+=("$f")
  done
else
  while IFS= read -r -d '' f; do
    f="${f#"$REPO_ROOT/"}"
    files+=("$f")
  done < <(find "$REPO_ROOT" -name '*.md' -not -path '*/node_modules/*' \
    -not -path '*/.venv/*' \
    -not -path '*/dist/*' \
    -not -path '*/_build/*' \
    -not -path '*/_deps/*' \
    -print0)
fi

echo "Checking ${#files[@]} markdown file(s) for broken relative links..."

for file in "${files[@]}"; do
  # Skip files in excluded directories.
  if [[ "$file" =~ ^($SKIP_DIRS)/ ]]; then
    continue
  fi
  check_file "$file"
done

if [[ $broken -gt 0 ]]; then
  echo ""
  echo "Found $broken broken link(s)."
  exit 1
fi

echo "All relative links OK."
