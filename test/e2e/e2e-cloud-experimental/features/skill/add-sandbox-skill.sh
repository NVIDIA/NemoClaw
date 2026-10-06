#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Add one local skill through NemoClaw and query the selected agent's native list.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"
SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-}}"
SKILL_ID="${SKILL_ID:-}"
SKILL_DESCRIPTION="${SKILL_DESCRIPTION:-E2E smoke skill injected into sandbox for read/write validation.}"
SKILL_BODY="${SKILL_BODY:-}"
SKILL_FILE="${SKILL_FILE:-}"
SKILL_TEMPLATE_FILE="${SKILL_TEMPLATE_FILE:-${SCRIPT_DIR}/fixtures/skill-smoke-template.SKILL.md}"
NEMOCLAW_CLI_BIN="${NEMOCLAW_CLI_BIN:-${REPO_ROOT}/bin/nemoclaw.js}"

die() {
  printf '%s\n' "add-sandbox-skill: FAIL: $*" >&2
  exit 1
}
ok() { printf '%s\n' "add-sandbox-skill: OK: $*"; }

[ -n "$SANDBOX_NAME" ] || die "set SANDBOX_NAME (or NEMOCLAW_SANDBOX_NAME)"
[ -n "$SKILL_ID" ] || die "set SKILL_ID (e.g. demo-skill)"
case "$SKILL_ID" in
  *[!A-Za-z0-9._-]* | "" | "." | "..") die "SKILL_ID must be a safe skill name" ;;
esac
if [ -n "$SKILL_FILE" ] && [ -n "$SKILL_BODY" ]; then
  die "use either SKILL_FILE or SKILL_BODY, not both"
fi

skill_parent="$(mktemp -d)"
skill_dir="${skill_parent}/${SKILL_ID}"
mkdir -m 700 "$skill_dir"
trap 'rm -rf -- "$skill_parent"' EXIT

if [ -n "$SKILL_FILE" ]; then
  if [ -L "$SKILL_FILE" ] || [ ! -f "$SKILL_FILE" ]; then
    die "SKILL_FILE must be a regular file"
  fi
  cp -- "$SKILL_FILE" "$skill_dir/SKILL.md"
elif [ -n "$SKILL_BODY" ]; then
  {
    printf '%s\n' "---"
    printf 'name: "%s"\n' "$SKILL_ID"
    printf 'description: "%s"\n' "$SKILL_DESCRIPTION"
    printf '%s\n\n' "---"
    printf '%s\n' "$SKILL_BODY"
  } >"$skill_dir/SKILL.md"
else
  if [ -L "$SKILL_TEMPLATE_FILE" ] || [ ! -f "$SKILL_TEMPLATE_FILE" ]; then
    die "SKILL_TEMPLATE_FILE must be a regular file"
  fi
  command -v python3 >/dev/null 2>&1 || die "python3 not on PATH"
  SKILL_ID="$SKILL_ID" SKILL_DESCRIPTION="$SKILL_DESCRIPTION" \
    SKILL_TEMPLATE_FILE="$SKILL_TEMPLATE_FILE" python3 -c '
from pathlib import Path
import os

source = Path(os.environ["SKILL_TEMPLATE_FILE"]).read_text(encoding="utf-8")
print(source.replace("__SKILL_ID__", os.environ["SKILL_ID"]).replace("__SKILL_DESCRIPTION__", os.environ["SKILL_DESCRIPTION"]), end="")
' >"$skill_dir/SKILL.md"
fi

declared_name="$(python3 -c '
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read().splitlines()
if not text or text[0].strip() != "---":
    raise SystemExit(1)
for line in text[1:]:
    if line.strip() == "---":
        break
    match = re.match(r"^name:\s*[\"\x27]?([^\"\x27\s]+)", line)
    if match:
        print(match.group(1))
        raise SystemExit(0)
raise SystemExit(1)
' "$skill_dir/SKILL.md")" || die "SKILL.md has no readable frontmatter name"
[ "$declared_name" = "$SKILL_ID" ] \
  || die "SKILL_ID '$SKILL_ID' does not match SKILL.md name '$declared_name'"
if [ -L "$NEMOCLAW_CLI_BIN" ] || [ ! -f "$NEMOCLAW_CLI_BIN" ] || [ ! -x "$NEMOCLAW_CLI_BIN" ]; then
  die "NemoClaw CLI not found: $NEMOCLAW_CLI_BIN"
fi

"$NEMOCLAW_CLI_BIN" "$SANDBOX_NAME" skill install "$skill_dir"
list_output="$("$NEMOCLAW_CLI_BIN" "$SANDBOX_NAME" skill list)" \
  || die "selected agent's native skill list failed"
printf '%s\n' "$list_output"
printf '%s\n' "$list_output" | grep -Fq "$SKILL_ID" \
  || die "selected agent's native list did not report $SKILL_ID"

ok "skill added; selected agent's native list reports ${SKILL_ID}"
printf 'QUERY_PATH=/sandbox/.openclaw/workspace/skills/%s/SKILL.md\n' "$SKILL_ID"
