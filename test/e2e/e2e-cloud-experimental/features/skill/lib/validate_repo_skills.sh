#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Validate Cursor/agent skills under .agents/skills/<id>/SKILL.md (YAML frontmatter + body).
# Bash-only counterpart to the former validate_repo_skills.py.

set -euo pipefail

usage() {
  printf 'Usage: %s [--repo DIR]\n' "$(basename "$0")" >&2
  exit 2
}

REPO=$(pwd)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || usage
      REPO=$(cd "$2" && pwd)
      shift 2
      ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done

SKILLS_ROOT="${REPO}/.agents/skills"
if [[ ! -d "$SKILLS_ROOT" ]]; then
  printf 'validate_repo_skills: FAIL: missing directory %s\n' "$SKILLS_ROOT" >&2
  exit 1
fi

paths=()
while IFS= read -r p; do
  [[ -n "$p" ]] && paths+=("$p")
done < <(find "$SKILLS_ROOT" -mindepth 2 -maxdepth 2 -name SKILL.md -print | LC_ALL=C sort)

if [[ ${#paths[@]} -eq 0 ]]; then
  printf 'validate_repo_skills: FAIL: no SKILL.md under %s\n' "$SKILLS_ROOT" >&2
  exit 1
fi

# Extract first line matching "^key:" and return the value part (trim + strip one pair of quotes).
extract_scalar() {
  local fm=$1 key=$2
  local line val
  line=$(printf '%s\n' "$fm" | grep -m1 "^${key}:" || true)
  [[ -n "$line" ]] || {
    printf ''
    return 0
  }
  val="${line#*:}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  case $val in
    \"*)
      val="${val#\"}"
      val="${val%\"}"
      ;;
    \'*)
      val="${val#\'}"
      val="${val%\'}"
      ;;
  esac
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  printf '%s' "$val"
}

# Length of body after leading/trailing whitespace (matches Python strip semantics via awk).
body_stripped_len() {
  local body=$1
  printf '%s' "$body" | awk '{ r = r $0 "\n" }
    END {
      sub(/^[[:space:]]+/, "", r)
      sub(/[[:space:]]+$/, "", r)
      print length(r)
    }'
}

validate_skill_file() {
  local path=$1
  local rel=$2
  local failed=0
  local raw fm body name desc blen state line

  if ! raw=$(cat "$path"); then
    printf '%s: FAIL\n  - cannot read file\n' "$rel" >&2
    return 1
  fi

  if [[ ! "$raw" == ---* ]]; then
    printf '%s: FAIL\n  - missing or invalid YAML frontmatter (expected --- ... ---)\n' "$rel" >&2
    return 1
  fi

  fm=""
  body=""
  state=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "---" ]]; then
      if ((state == 0)); then
        state=1
        continue
      fi
      if ((state == 1)); then
        state=2
        continue
      fi
    fi
    if ((state == 1)); then
      fm+="${line}"$'\n'
    elif ((state == 2)); then
      body+="${line}"$'\n'
    fi
  done <<<"$raw"

  if ((state != 2)); then
    printf '%s: FAIL\n  - missing or invalid YAML frontmatter (expected --- ... ---)\n' "$rel" >&2
    return 1
  fi

  name=$(extract_scalar "$fm" "name")
  desc=$(extract_scalar "$fm" "description")
  if [[ -z "$name" ]]; then
    printf '%s: FAIL\n  - frontmatter missing non-empty '\''name:'\''\n' "$rel" >&2
    failed=1
  fi
  if [[ -z "$desc" ]]; then
    printf '%s: FAIL\n  - frontmatter missing non-empty '\''description:'\''\n' "$rel" >&2
    failed=1
  fi

  blen=$(body_stripped_len "$body")
  if ((blen < 20)); then
    printf '%s: FAIL\n  - body too short after frontmatter (expected real SKILL content)\n' "$rel" >&2
    failed=1
  fi

  ((failed == 0))
}

failed_any=0
for p in "${paths[@]}"; do
  rel=${p#"${REPO}/"}
  if validate_skill_file "$p" "$rel"; then
    printf '%s: OK\n' "$rel"
  else
    failed_any=1
  fi
done

if ((failed_any)); then
  exit 1
fi

printf 'validate_repo_skills: %d skill(s) OK\n' "${#paths[@]}"
exit 0
