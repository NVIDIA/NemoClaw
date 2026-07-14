#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

# This helper is entered directly by a host-side privileged container exec, so
# it must not inherit command resolution from the container environment. Use a
# fixed interpreter and trusted system PATH before invoking any external tool.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Nonce validation below uses an explicit locale-independent character class
# ([!0123456789abcdef]) rather than the range [a-f], whose case-sensitivity
# varies by locale (macOS UTF-8 folds [a-f] case-insensitively), keeping the
# lowercase-only hex nonce check byte-exact without relying on LC_ALL.

INSTALLED_CONTROL_HELPER="/usr/local/bin/nemoclaw-gateway-control"
if [ "$0" = "$INSTALLED_CONTROL_HELPER" ]; then
  CONTROL_PROC_ROOT="/proc"
  CONTROL_MANAGED_HELPER="/usr/local/lib/nemoclaw/managed-gateway-control.py"
  CONTROL_CALLER_UID="$(id -u)"
else
  # Source-checkout behavior tests use isolated fixtures. The installed helper
  # ignores these seams and always binds to the fixed procfs and helper paths.
  CONTROL_PROC_ROOT="${NEMOCLAW_TEST_GATEWAY_CONTROL_PROC_ROOT:-/proc}"
  CONTROL_MANAGED_HELPER="${NEMOCLAW_TEST_MANAGED_GATEWAY_CONTROL_HELPER:-/usr/local/lib/nemoclaw/managed-gateway-control.py}"
  CONTROL_CALLER_UID="${NEMOCLAW_TEST_GATEWAY_CONTROL_CALLER_UID:-$(id -u)}"
fi

CONTROL_DIR="${NEMOCLAW_GATEWAY_CONTROL_DIR:-/run/nemoclaw/gateway-control}"
REQUEST_FILE="${CONTROL_DIR}/request"
STATUS_FILE="${CONTROL_DIR}/status"
LOCK_DIR="${CONTROL_DIR}/submit.lock"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail "SUPERVISOR_INVALID_REQUEST"
ACTION="$1"
NONCE="$2"
case "$ACTION" in
  restart | recover | probe) ;;
  *) fail "SUPERVISOR_INVALID_ACTION" ;;
esac
case "$NONCE" in
  *[!0123456789abcdef]* | '') fail "SUPERVISOR_INVALID_NONCE" ;;
esac
[ "${#NONCE}" -eq 64 ] || fail "SUPERVISOR_INVALID_NONCE"
[ "$CONTROL_CALLER_UID" -eq 0 ] || fail "PRIVILEGED_CONTROL_UNAVAILABLE"

PID1_CMDLINE="$(tr '\0' ' ' <"${CONTROL_PROC_ROOT}/1/cmdline" 2>/dev/null || true)"
PID1_ARGV0="$(tr '\0' '\n' <"${CONTROL_PROC_ROOT}/1/cmdline" 2>/dev/null | sed -n '1p' || true)"
if [ "$PID1_ARGV0" = "/opt/openshell/bin/openshell-sandbox" ]; then
  [ -x "$CONTROL_MANAGED_HELPER" ] || fail "SUPERVISOR_REBUILD_REQUIRED"
  # Isolated mode ignores Python startup hooks, user-site packages, and
  # PYTHON* environment variables before the root helper imports anything.
  exec python3 -I "$CONTROL_MANAGED_HELPER" "$ACTION" "$NONCE"
fi
case "$PID1_CMDLINE" in
  *nemoclaw-start*) ;;
  *) fail "SUPERVISOR_UNAVAILABLE" ;;
esac

[ -d "$CONTROL_DIR" ] || fail "SUPERVISOR_REBUILD_REQUIRED"
[ "$(stat -c '%U:%G %a' "$CONTROL_DIR" 2>/dev/null || true)" = "root:root 700" ] \
  || fail "SUPERVISOR_UNSAFE_CONTROL_DIR"
mkdir "$LOCK_DIR" 2>/dev/null || fail "SUPERVISOR_BUSY"
# shellcheck disable=SC2317,SC2329  # invoked by the trap below
cleanup() {
  [ -z "${REQUEST_TMP:-}" ] || rm -f "$REQUEST_TMP" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' INT TERM

[ ! -e "$REQUEST_FILE" ] || fail "SUPERVISOR_BUSY"
umask 077
REQUEST_TMP="${REQUEST_FILE}.tmp.$$"
printf 'v1 %s %s\n' "$NONCE" "$ACTION" >"$REQUEST_TMP"
chmod 600 "$REQUEST_TMP"
# Do not let cancellation strand an unsignalled request between publication
# and the PID 1 wake-up. Signals are ignored only across this tiny critical
# section, then normal abort handling resumes.
trap '' INT TERM
mv -f "$REQUEST_TMP" "$REQUEST_FILE"
if ! kill -USR1 1 2>/dev/null; then
  trap 'exit 1' INT TERM
  rm -f "$REQUEST_FILE"
  fail "SUPERVISOR_SIGNAL_FAILED"
fi
trap 'exit 1' INT TERM

# Hermes can legitimately need 90 seconds to become healthy and then up to 30
# seconds to restore a stopped dashboard bridge. Keep the helper above that
# combined budget; the host command applies a slightly larger outer timeout.
for _ in $(seq 1 900); do
  if [ -r "$STATUS_FILE" ]; then
    IFS=' ' read -r VERSION STATUS_NONCE STATE DETAIL OLD_PID NEW_PID <"$STATUS_FILE" || true
    if [ "$VERSION" = "v1" ] && [ "$STATUS_NONCE" = "$NONCE" ]; then
      case "$STATE" in
        accepted) ;;
        complete)
          case "$DETAIL" in
            ok | already-running)
              printf 'v1 %s complete %s %s %s\n' "$NONCE" "$DETAIL" "$OLD_PID" "$NEW_PID"
              printf 'GATEWAY_PID=%s\n' "$NEW_PID"
              exit 0
              ;;
            *) fail "SUPERVISOR_INVALID_STATUS" ;;
          esac
          ;;
        failed)
          printf 'v1 %s failed %s %s %s\n' "$NONCE" "$DETAIL" "$OLD_PID" "$NEW_PID" >&2
          case "$DETAIL" in
            validator-missing) fail "SECRET_BOUNDARY_VALIDATOR_MISSING" ;;
            secret-boundary-refusal) fail "SECRET_BOUNDARY_REFUSED" ;;
            unsafe-config) fail "GATEWAY_UNSAFE_CONFIG_PATH" ;;
            hash-mismatch) fail "GATEWAY_CONFIG_HASH_MISMATCH" ;;
            mcp-integrity | mcp-reconcile-required) fail "HERMES_MCP_CONFIG_DRIFT" ;;
            preload-missing) fail "GATEWAY_GUARDS_MISSING" ;;
            health-timeout) fail "GATEWAY_HEALTH_TIMEOUT" ;;
            *) fail "GATEWAY_FAILED" ;;
          esac
          ;;
        *) fail "SUPERVISOR_INVALID_STATUS" ;;
      esac
    fi
  fi
  sleep 0.2
done

fail "SUPERVISOR_TIMEOUT"
