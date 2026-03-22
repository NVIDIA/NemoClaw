#!/bin/bash
# Case: host-side security checks (add sections here as the suite grows).
#
# Current:
#   - VDR3 #13: NVIDIA_API_KEY must not appear in `ps` (full key or NVIDIA_API_KEY=nvapi- argv pattern).
#
# We avoid `grep "$NVIDIA_API_KEY"` on the command line (that would leak the key into ps).

set -euo pipefail

: "${NVIDIA_API_KEY:?NVIDIA_API_KEY must be set (export before running)}"

die() { printf '%s\n' "03-security-checks: FAIL: $*" >&2; exit 1; }

# ── VDR3 #13: API key not in ps ─────────────────────────────────────
ps_lines=$( (ps auxww 2>/dev/null || ps auxeww 2>/dev/null || ps aux 2>/dev/null) || true)
[ -n "$ps_lines" ] || die "api-key-in-ps: could not capture ps output"

while IFS= read -r line; do
  case "$line" in
    *"$NVIDIA_API_KEY"*) die "api-key-in-ps: full NVIDIA_API_KEY appears in ps output" ;;
  esac
done <<< "$ps_lines"

while IFS= read -r line; do
  case "$line" in
    *NVIDIA_API_KEY=nvapi-*) die "api-key-in-ps: NVIDIA_API_KEY=nvapi- pattern in ps (argv leak)" ;;
  esac
done <<< "$ps_lines"

printf '%s\n' "03-security-checks: OK (api-key-in-ps)"
exit 0
