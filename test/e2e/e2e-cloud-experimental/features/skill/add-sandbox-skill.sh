#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Add one skill into a target sandbox and verify it can be queried back.
#
# Usage examples (from repo root):
#   SANDBOX_NAME=e2e-cloud-experimental \
#     SKILL_ID=demo-skill \
#     SKILL_DESCRIPTION="Demo skill from e2e helper" \
#     SKILL_BODY="## Demo\nThis is a smoke skill." \
#     bash test/e2e/e2e-cloud-experimental/features/skill/add-sandbox-skill.sh
#
#   SANDBOX_NAME=e2e-cloud-experimental \
#     SKILL_ID=demo-skill \
#     SKILL_FILE=/absolute/path/to/SKILL.md \
#     bash test/e2e/e2e-cloud-experimental/features/skill/add-sandbox-skill.sh
#
# If SKILL_FILE / SKILL_BODY are omitted, script renders a template file:
#   test/e2e/e2e-cloud-experimental/fixtures/skill-smoke-template.SKILL.md
#
# After deploy, optional: run one agent turn to prove the skill is used:
#   NVIDIA_API_KEY=nvapi-... SANDBOX_NAME=... SKILL_ID=... bash test/e2e/e2e-cloud-experimental/features/skill/verify-sandbox-skill-via-agent.sh
#
# Exit code:
#   0 = add + query succeeded
#   1 = failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-}}"
SKILL_ID="${SKILL_ID:-}"
DEFAULT_SKILL_DESCRIPTION="E2E smoke skill injected into sandbox for read/write validation."
SKILL_DESCRIPTION="${SKILL_DESCRIPTION:-$DEFAULT_SKILL_DESCRIPTION}"
SKILL_BODY="${SKILL_BODY:-}"
SKILL_FILE="${SKILL_FILE:-}"
SKILL_TEMPLATE_FILE="${SKILL_TEMPLATE_FILE:-${SCRIPT_DIR}/fixtures/skill-smoke-template.SKILL.md}"
# NemoClaw state lives under /sandbox/.openclaw; OpenClaw CLI inside the sandbox uses ~/.openclaw
# (typically /home/sandbox/.openclaw). Deploy to both so `openclaw agent` can read managed skills.
SKILL_ROOT="${SKILL_ROOT:-/sandbox/.openclaw/skills}"

die() {
  printf '%s\n' "add-sandbox-skill: FAIL: $*" >&2
  exit 1
}
ok() { printf '%s\n' "add-sandbox-skill: OK: $*"; }
info() { printf '%s\n' "add-sandbox-skill: INFO: $*"; }

[ -n "$SANDBOX_NAME" ] || die "set SANDBOX_NAME (or NEMOCLAW_SANDBOX_NAME)"
[ -n "$SKILL_ID" ] || die "set SKILL_ID (e.g. demo-skill)"
case "$SKILL_ID" in
  *[!A-Za-z0-9._-]* | "") die "SKILL_ID may only contain [A-Za-z0-9._-]" ;;
esac

if [ -n "$SKILL_FILE" ] && [ -n "$SKILL_BODY" ]; then
  die "use either SKILL_FILE or SKILL_BODY, not both"
fi

if [ -n "$SKILL_FILE" ]; then
  [ -f "$SKILL_FILE" ] || die "SKILL_FILE not found: $SKILL_FILE"
  payload_source="$SKILL_FILE"
  cleanup_payload=""
else
  payload_source="$(mktemp)"
  cleanup_payload="$payload_source"
  if [ -z "$SKILL_BODY" ]; then
    [ -f "$SKILL_TEMPLATE_FILE" ] || die "SKILL_TEMPLATE_FILE not found: $SKILL_TEMPLATE_FILE"
    command -v python3 >/dev/null 2>&1 || die "python3 not on PATH (needed for template rendering)"
    SKILL_ID="$SKILL_ID" SKILL_DESCRIPTION="$SKILL_DESCRIPTION" SKILL_TEMPLATE_FILE="$SKILL_TEMPLATE_FILE" python3 -c '
from pathlib import Path
import os

tpl = Path(os.environ["SKILL_TEMPLATE_FILE"]).read_text(encoding="utf-8")
tpl = tpl.replace("__SKILL_ID__", os.environ["SKILL_ID"])
tpl = tpl.replace("__SKILL_DESCRIPTION__", os.environ["SKILL_DESCRIPTION"])
print(tpl, end="")
' >"$payload_source"
  else
    {
      printf '%s\n' "---"
      printf 'name: "%s"\n' "$SKILL_ID"
      printf 'description: "%s"\n' "$SKILL_DESCRIPTION"
      printf '%s\n' "---"
      printf '\n'
      printf '%s\n' "$SKILL_BODY"
    } >"$payload_source"
  fi
fi

ssh_config="$(mktemp)"
remote_script="$(mktemp)"
trap 'rm -f "${cleanup_payload:-}" "$ssh_config" "$remote_script"' EXIT

command -v openshell >/dev/null 2>&1 || die "openshell not on PATH"
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null \
  || die "openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"

remote_skill_dir="${SKILL_ROOT%/}/${SKILL_ID}"
remote_skill_file="${remote_skill_dir}/SKILL.md"

info "Copying skill payload to sandbox '${SANDBOX_NAME}'..."
set +e
upload_out=$(
  ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "cat > '/tmp/${SKILL_ID}.md'" <"$payload_source" 2>&1
)
upload_rc=$?
set -e
[ "$upload_rc" -eq 0 ] || die "ssh payload upload failed (exit ${upload_rc}): ${upload_out:0:300}"

cat >"$remote_script" <<'EOF'
set -e
skill_dir="$1"
skill_file="$2"
temp_file="$3"

mkdir -p "$skill_dir"
cp "$temp_file" "$skill_file"

# Mirror into $HOME/.openclaw/skills so OpenClaw tools resolve the same SKILL.md (see agent ENOENT on /home/sandbox/.openclaw/skills/...).
skill_id="$(basename "$skill_dir")"
home_root="${HOME:-/home/sandbox}"
home_skill_dir="${home_root}/.openclaw/skills/${skill_id}"
home_skill_file="${home_skill_dir}/SKILL.md"
mkdir -p "$home_skill_dir"
cp "$temp_file" "$home_skill_file"

rm -f "$temp_file"

if [ ! -f "$skill_file" ]; then
  echo "WRITE_FAILED"
  exit 2
fi

if grep -q '^name:' "$skill_file"; then
  :
else
  echo "MISSING_NAME"
  exit 3
fi

echo "QUERY_PATH=$skill_file"
echo "HOME_QUERY_PATH=$home_skill_file"
echo "QUERY_HEAD_BEGIN"
sed -n '1,20p' "$skill_file"
echo "QUERY_HEAD_END"
EOF

TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 60"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 60"

set +e
query_out=$(
  $TIMEOUT_CMD ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "sh -s -- '$remote_skill_dir' '$remote_skill_file' '/tmp/${SKILL_ID}.md'" <"$remote_script" 2>&1
)
query_rc=$?
set -e

[ "$query_rc" -eq 0 ] || die "remote add/query failed (exit ${query_rc}): ${query_out:0:300}"
echo "$query_out" | grep -q "QUERY_PATH=${remote_skill_file}" || die "did not find query path marker"
echo "$query_out" | grep -q "HOME_QUERY_PATH=" || die "did not find HOME_QUERY_PATH marker"

ok "skill added and queryable at ${remote_skill_file}"
printf '%s\n' "$query_out"
