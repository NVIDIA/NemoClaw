#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared PID 1 control primitives for host-requested gateway lifecycle actions.
# The request directory is root-only. Requests are written by the host through
# the registry-scoped privileged Docker exec path; sandbox processes cannot
# submit or alter them.
# Nonce validation below uses an explicit locale-independent character class
# ([!0123456789abcdef]) rather than the range [a-f], whose case-sensitivity
# varies by locale (macOS UTF-8 folds [a-f] case-insensitively). This keeps the
# lowercase-only hex nonce check byte-exact without exporting LC_ALL from a
# sourced library into the Hermes runtime.

NEMOCLAW_GATEWAY_CONTROL_DIR="${NEMOCLAW_GATEWAY_CONTROL_DIR:-/run/nemoclaw/gateway-control}"
NEMOCLAW_GATEWAY_CONTROL_REQUEST="${NEMOCLAW_GATEWAY_CONTROL_DIR}/request"
NEMOCLAW_GATEWAY_CONTROL_STATUS="${NEMOCLAW_GATEWAY_CONTROL_DIR}/status"

GATEWAY_CONTROL_SIGNAL_PENDING=0
GATEWAY_CONTROL_NONCE=""
GATEWAY_CONTROL_ACTION=""

gateway_control_atomic_status() {
  local nonce="$1"
  shift
  local tmp="${NEMOCLAW_GATEWAY_CONTROL_STATUS}.tmp.$$"
  umask 077
  printf 'v1 %s %s\n' "$nonce" "$*" >"$tmp" || return 1
  chmod 600 "$tmp" || {
    rm -f "$tmp"
    return 1
  }
  mv -f "$tmp" "$NEMOCLAW_GATEWAY_CONTROL_STATUS"
}

gateway_control_init() {
  [ "$(id -u)" -eq 0 ] || return 1
  # Install the handler before publishing the control directory. Otherwise a
  # helper can observe the directory in the few instructions before the caller
  # installs its trap and SIGUSR1 would take PID 1's default terminate action.
  gateway_control_install_signal_trap
  install -d -o root -g root -m 700 "$NEMOCLAW_GATEWAY_CONTROL_DIR" || return 1
  rm -f "$NEMOCLAW_GATEWAY_CONTROL_REQUEST" "$NEMOCLAW_GATEWAY_CONTROL_STATUS"
}

gateway_control_mark_signal() {
  GATEWAY_CONTROL_SIGNAL_PENDING=1
}

gateway_control_install_signal_trap() {
  trap gateway_control_mark_signal USR1
}

gateway_control_take_request() {
  local version nonce action extra
  [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 1 ] || return 1
  GATEWAY_CONTROL_SIGNAL_PENDING=0

  if ! IFS=' ' read -r version nonce action extra <"$NEMOCLAW_GATEWAY_CONTROL_REQUEST"; then
    return 1
  fi
  [ "$version" = "v1" ] || return 1
  case "$nonce" in
    *[!0123456789abcdef]* | '') return 1 ;;
  esac
  [ "${#nonce}" -eq 64 ] || return 1
  case "$action" in
    restart | recover | probe) ;;
    *) return 1 ;;
  esac
  [ -z "${extra:-}" ] || return 1

  GATEWAY_CONTROL_NONCE="$nonce"
  # shellcheck disable=SC2034  # consumed by the sourcing entrypoint
  GATEWAY_CONTROL_ACTION="$action"
  gateway_control_atomic_status "$nonce" accepted
}

gateway_control_complete() {
  local result="$1"
  local old_pid="$2"
  local new_pid="$3"
  gateway_control_atomic_status "$GATEWAY_CONTROL_NONCE" "complete ${result} ${old_pid} ${new_pid}"
  rm -f "$NEMOCLAW_GATEWAY_CONTROL_REQUEST"
}

gateway_control_fail() {
  local code="$1"
  local old_pid="${2:-0}"
  case "$code" in
    validator-missing | secret-boundary-refusal | unsafe-config | hash-mismatch | preload-missing | launch-failed | health-timeout | mcp-integrity | mcp-reconcile-required | internal) ;;
    *) code=internal ;;
  esac
  gateway_control_atomic_status "$GATEWAY_CONTROL_NONCE" "failed ${code} ${old_pid} 0"
  rm -f "$NEMOCLAW_GATEWAY_CONTROL_REQUEST"
}

gateway_control_pid_is_live() {
  local pid="$1"
  local state
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  # kill -0 succeeds for an unreaped zombie. Do not record or trust a process
  # that can no longer own a listener or handle a termination signal.
  if command -v ps >/dev/null 2>&1; then
    state="$(ps -o stat= -p "$pid" 2>/dev/null | awk 'NR == 1 { print $1 }')"
    [ -n "$state" ] || return 1
    case "$state" in
      Z*) return 1 ;;
    esac
  elif [ -r "/proc/${pid}/stat" ]; then
    state="$(sed -E 's/^[0-9]+ \(.*\) ([^ ]).*/\1/' "/proc/${pid}/stat" 2>/dev/null || true)"
    [ "$state" != "Z" ] || return 1
  fi
  return 0
}

gateway_control_proc_root() {
  if [ "${_NEMOCLAW_PROC_ROOT+x}" = x ]; then
    printf '%s\n' "$_NEMOCLAW_PROC_ROOT"
  elif [ "${_HERMES_PROC_ROOT+x}" = x ]; then
    printf '%s\n' "$_HERMES_PROC_ROOT"
  else
    printf '/proc\n'
  fi
}

gateway_control_proc_root_is_explicit() {
  [ "${_NEMOCLAW_PROC_ROOT+x}" = x ] || [ "${_HERMES_PROC_ROOT+x}" = x ]
}

# Print the process-start identity used by both supervisors. Linux containers
# use /proc/<pid>/stat field 22. The ps fallback only supports non-Linux
# developer hosts; an explicit proc-root seam must never inspect the host
# namespace instead.
gateway_control_pid_start_identity() {
  local pid="$1"
  local proc_root stat_line stat_suffix started
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  proc_root="$(gateway_control_proc_root)" || return 1
  if [ -r "${proc_root}/${pid}/stat" ]; then
    IFS= read -r stat_line <"${proc_root}/${pid}/stat" || return 1
    stat_suffix="${stat_line##*) }"
    [ "$stat_suffix" != "$stat_line" ] || return 1
    # shellcheck disable=SC2086  # intentional field split of proc stat suffix
    set -- $stat_suffix
    [ "$#" -ge 20 ] || return 1
    case "${20}" in
      '' | *[!0-9]*) return 1 ;;
    esac
    printf '%s\n' "${20}"
    return 0
  fi
  gateway_control_proc_root_is_explicit && return 1
  command -v ps >/dev/null 2>&1 || return 1
  started="$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | awk 'NR == 1 { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print; exit }')"
  [ -n "$started" ] || return 1
  printf 'ps:%s\n' "${started//[[:space:]]/_}"
}

gateway_control_pid_state() {
  local pid="$1"
  local proc_root stat_line stat_suffix state
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  proc_root="$(gateway_control_proc_root)" || return 1
  if [ -r "${proc_root}/${pid}/stat" ]; then
    IFS= read -r stat_line <"${proc_root}/${pid}/stat" || return 1
    stat_suffix="${stat_line##*) }"
    [ "$stat_suffix" != "$stat_line" ] || return 1
    # shellcheck disable=SC2086  # intentional field split of proc stat suffix
    set -- $stat_suffix
    [ "$#" -ge 1 ] || return 1
    state="$1"
  else
    gateway_control_proc_root_is_explicit && return 1
    command -v ps >/dev/null 2>&1 || return 1
    state="$(ps -o stat= -p "$pid" 2>/dev/null | awk 'NR == 1 { print $1; exit }')"
  fi
  [ -n "$state" ] || return 1
  printf '%s\n' "$state"
}

gateway_control_pid_matches_start_identity() {
  local pid="$1"
  local expected_start_identity="$2"
  local current_start_identity
  [ -n "$expected_start_identity" ] || return 1
  current_start_identity="$(gateway_control_pid_start_identity "$pid")" || return 1
  [ "$current_start_identity" = "$expected_start_identity" ]
}

gateway_control_pid_owns_tcp_listener() {
  local pid="$1"
  local port="$2"
  local proc_root="${3:-/proc}"
  local port_hex listener_inodes inode fd_path target listener_inode
  case "$port" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || return 1
  gateway_control_pid_is_live "$pid" || return 1

  # Match the listener socket inode to an fd owned by the exact tracked child.
  # Callers cross a UID boundary before invoking this helper when PID 1 cannot
  # inspect the gateway/dashboard fd directory after dropping CAP_SYS_PTRACE
  # and CAP_DAC_OVERRIDE.
  port_hex="$(printf '%04X' "$port")"
  listener_inodes="$(awk -v expected_port="$port_hex" '
    {
      split($2, local_address, ":")
      if (toupper(local_address[2]) == expected_port && $4 == "0A") {
        print $10
      }
    }
  ' "${proc_root}/net/tcp" "${proc_root}/net/tcp6" 2>/dev/null || true)"
  [ -n "$listener_inodes" ] || return 1

  for fd_path in "${proc_root}/${pid}"/fd/*; do
    [ -L "$fd_path" ] || continue
    target="$(readlink "$fd_path" 2>/dev/null || true)"
    case "$target" in
      'socket:['*']')
        inode="${target#socket:[}"
        inode="${inode%]}"
        ;;
      *) continue ;;
    esac
    while IFS= read -r listener_inode; do
      [ "$inode" = "$listener_inode" ] && return 0
    done <<EOF
$listener_inodes
EOF
  done
  return 1
}

NEMOCLAW_MANAGED_EXPECTED_EXIT_DIR="/run/nemoclaw"
NEMOCLAW_MANAGED_EXPECTED_EXIT_MARKER="managed-gateway-expected-exit"
NEMOCLAW_MANAGED_CONTROLLER_PATH="/usr/local/lib/nemoclaw/managed-gateway-control.py"

gateway_control_managed_controller_argv_is_expected() {
  [ "$#" -eq 5 ] || return 1
  case "${1##*/}" in
    python3) ;;
    *) return 1 ;;
  esac
  [ "$2" = "-I" ] && [ "$3" = "$NEMOCLAW_MANAGED_CONTROLLER_PATH" ] || return 1
  case "$4" in
    restart | recover) ;;
    *) return 1 ;;
  esac
  case "$5" in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#5}" -eq 64 ]
}

# A numeric PID in the marker is never authority on its own. Prove the named
# controller is still the live root helper that published the lease, so an
# orphaned marker cannot authorize a later unrelated exit.
gateway_control_managed_controller_is_live() {
  local pid="$1"
  local expected_start_identity="$2"
  local proc_root
  local first_start second_start first_state second_state first_uids second_uids
  local -a first_argv=()
  local -a second_argv=()

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  case "$expected_start_identity" in
    '' | *[!0-9]*) return 1 ;;
  esac
  proc_root="$(gateway_control_proc_root)" || return 1
  [ -r "${proc_root}/${pid}/status" ] \
    && [ -r "${proc_root}/${pid}/cmdline" ] || return 1

  first_start="$(gateway_control_pid_start_identity "$pid")" || return 1
  first_state="$(gateway_control_pid_state "$pid")" || return 1
  first_uids="$(awk '/^Uid:/ { print $2 ":" $3 ":" $4 ":" $5; exit }' "${proc_root}/${pid}/status")" || return 1
  while IFS= read -r -d "" elem; do first_argv+=("$elem"); done <"${proc_root}/${pid}/cmdline" || return 1
  gateway_control_managed_controller_argv_is_expected "${first_argv[@]}" || return 1

  second_start="$(gateway_control_pid_start_identity "$pid")" || return 1
  second_state="$(gateway_control_pid_state "$pid")" || return 1
  second_uids="$(awk '/^Uid:/ { print $2 ":" $3 ":" $4 ":" $5; exit }' "${proc_root}/${pid}/status")" || return 1
  while IFS= read -r -d "" elem; do second_argv+=("$elem"); done <"${proc_root}/${pid}/cmdline" || return 1
  gateway_control_managed_controller_argv_is_expected "${second_argv[@]}" || return 1

  [ "$first_start" = "$expected_start_identity" ] \
    && [ "$second_start" = "$expected_start_identity" ] \
    && [ "$first_uids" = "0:0:0:0" ] \
    && [ "$second_uids" = "0:0:0:0" ] \
    && [ "$first_state" != "Z" ] \
    && [ "$second_state" != "Z" ] \
    && [ "${first_argv[*]}" = "${second_argv[*]}" ]
}

# True when the root control helper published a lease authorizing this exact
# gateway exit. The managed restart path terminates the gateway with SIGTERM
# and then only waits for a replacement, so the entrypoint must relaunch a
# leased exit instead of reading its clean status as an intentional shutdown.
gateway_control_exit_was_host_authorized() {
  local pid="$1"
  local start_identity="$2"
  local marker dir_metadata marker_metadata
  local version marker_pid marker_start_identity controller_pid controller_start_identity extra
  local trailing=""

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  case "$start_identity" in
    '' | *[!0-9]*) return 1 ;;
  esac

  [ -d "$NEMOCLAW_MANAGED_EXPECTED_EXIT_DIR" ] \
    && [ ! -L "$NEMOCLAW_MANAGED_EXPECTED_EXIT_DIR" ] || return 1
  dir_metadata="$(stat -c '%u:%g %a' "$NEMOCLAW_MANAGED_EXPECTED_EXIT_DIR" 2>/dev/null || true)"
  [ "$dir_metadata" = "0:0 711" ] || return 1

  marker="${NEMOCLAW_MANAGED_EXPECTED_EXIT_DIR}/${NEMOCLAW_MANAGED_EXPECTED_EXIT_MARKER}"
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  marker_metadata="$(stat -c '%u:%g %a %h' "$marker" 2>/dev/null || true)"
  [ "$marker_metadata" = "0:0 444 1" ] || return 1

  # bash 4.1+ named FDs ({var}<file) are not available on bash 3.2 (macOS).
  # Use a grouped redirect instead — variables assigned inside {} remain in scope.
  {
    if ! IFS=' ' read -r \
      version marker_pid marker_start_identity controller_pid controller_start_identity extra; then
      return 1
    fi
    if IFS= read -r trailing || [ -n "$trailing" ]; then
      return 1
    fi
  } <"$marker" || return 1

  [ "$version" = "v1" ] \
    && [ "$marker_pid" = "$pid" ] \
    && [ "$marker_start_identity" = "$start_identity" ] \
    && [ -z "${extra:-}" ] || return 1
  case "$controller_pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  case "$controller_start_identity" in
    '' | *[!0-9]*) return 1 ;;
  esac
  gateway_control_managed_controller_is_live "$controller_pid" "$controller_start_identity"
}

gateway_control_stop_tracked_pid() {
  local pid="$1"
  local expected_start_identity="${2:-}"
  local state
  local attempts=0
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 0 ;;
  esac
  [ -n "$expected_start_identity" ] || return 1

  # A missing or different identity means the tracked child is already gone.
  # Never signal or wait for the process currently occupying a reused PID.
  gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity" || return 0
  state="$(gateway_control_pid_state "$pid")" || return 0
  case "$state" in
    Z*)
      if gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity"; then
        wait "$pid" 2>/dev/null || true
      fi
      return 0
      ;;
  esac

  # Revalidate immediately before every signal. A numeric PID alone is never
  # authority to terminate a process.
  gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  while [ "$attempts" -lt 50 ]; do
    gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity" || return 0
    state="$(gateway_control_pid_state "$pid")" || return 0
    case "$state" in
      Z*)
        if gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity"; then
          wait "$pid" 2>/dev/null || true
        fi
        return 0
        ;;
    esac
    sleep 0.1
    attempts=$((attempts + 1))
  done
  gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity" || return 0
  state="$(gateway_control_pid_state "$pid")" || return 0
  case "$state" in
    Z*)
      if gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity"; then
        wait "$pid" 2>/dev/null || true
      fi
      return 0
      ;;
  esac
  gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity" || return 0
  kill -KILL "$pid" 2>/dev/null || true

  attempts=0
  while [ "$attempts" -lt 50 ]; do
    gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity" || return 0
    state="$(gateway_control_pid_state "$pid")" || return 0
    case "$state" in
      Z*)
        if gateway_control_pid_matches_start_identity "$pid" "$expected_start_identity"; then
          wait "$pid" 2>/dev/null || true
        fi
        return 0
        ;;
    esac
    sleep 0.1
    attempts=$((attempts + 1))
  done
  return 1
}
