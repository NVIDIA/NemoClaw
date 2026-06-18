#!/usr/bin/env bash
set -euo pipefail

# Helper for structured phase execution and log capture.
# Intended for Claude Code to call when it wants consistent shell logging.

LOG_DIR="${LOG_DIR:-.hsb-skill-logs}"
mkdir -p "$LOG_DIR"

phase="${1:-}"
shift || true

if [[ -z "$phase" ]]; then
  echo "usage: $0 <phase-name> <command...>" >&2
  exit 2
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <phase-name> <command...>" >&2
  exit 2
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
log_file="$LOG_DIR/${timestamp}-${phase}.log"

echo "[HSB-SKILL] phase=$phase"
echo "[HSB-SKILL] log=$log_file"
echo "[HSB-SKILL] cmd=$*"

set +e
"$@" 2>&1 | tee "$log_file"
rc=${PIPESTATUS[0]}
set -e

echo "[HSB-SKILL] rc=$rc"
exit "$rc"
