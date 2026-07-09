// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The awk condition matches three forms of the gateway argv:
//   - "openclaw-gateway"         the re-execed binary name
//   - "openclaw gateway run ..." the launcher command nemoclaw-start runs
//   - "openclaw"                 the post-startup form, accepted only when it
//                                matches /tmp/nemoclaw-gateway.pid and the
//                                /tmp/nemoclaw-gateway-local marker exists.
//                                OpenClaw rewrites its own argv via
//                                process.title, so the running gateway shows
//                                just "openclaw" with no "gateway" suffix.
//                                Matching only the first two forms made
//                                find_gateway_pids return empty, which
//                                reportStopResult misread as "not running" — so
//                                `tunnel stop` exited 0 while the gateway kept
//                                running (#4951).
//
// Source boundary / removal condition: this bare-argv compatibility branch is
// a NemoClaw-side workaround for current supported OpenClaw process-title
// rewriting. Remove it only after supported OpenClaw versions expose a stable
// gateway-specific argv/shutdown/status primitive, or after NemoClaw switches
// this path to an authenticated gateway shutdown mechanism; keep/update the
// Linux stop-script regressions when doing so.
//
// IMPORTANT: keep example argv strings (e.g. "openclaw gateway") out of the awk
// program text. awk's own argv is captured by the concurrent `ps` snapshot, so
// any such literal inside the program makes awk match itself and the scan never
// drains. The shell `sh -lc` process is exempt (excluded as $self), comments in
// the shell portion below are fine, but the awk body must stay token-clean.
export const GATEWAY_STOP_SCRIPT = String.raw`
set -eu
self="$$"
parent="$PPID"
gateway_pid_file="/tmp/nemoclaw-gateway.pid"
gateway_marker_file="/tmp/nemoclaw-gateway-local"

# Open both identity files once, then validate and read those exact file
# descriptions through /proc. This prevents a same-owner process from swapping
# a pathname in world-writable /tmp between validation and the PID read.
pidfile_owner=""
marker_owner=""
if [ -f "$gateway_pid_file" ] && [ -f "$gateway_marker_file" ] && \
   [ ! -L "$gateway_pid_file" ] && [ ! -L "$gateway_marker_file" ] && \
   exec 3<"$gateway_pid_file" 4<"$gateway_marker_file"; then
  trusted_identity_fd() {
    fd_path="$1"
    [ -f "$fd_path" ] || return 1
    mode="$(stat -Lc '%a' "$fd_path" 2>/dev/null)" || return 1
    owner="$(stat -Lc '%U' "$fd_path" 2>/dev/null)" || return 1
    case "$mode" in
      *00) ;;
      *) return 1 ;;
    esac
    case "$owner" in
      root|gateway|sandbox) ;;
      *) return 1 ;;
    esac
    printf '%s\n' "$owner"
  }
  pidfile_owner="$(trusted_identity_fd "/proc/$$/fd/3" || true)"
  marker_owner="$(trusted_identity_fd "/proc/$$/fd/4" || true)"
fi

pidfile_pid=""
identity_files_trusted=0
if [ -n "$pidfile_owner" ] && [ "$pidfile_owner" = "$marker_owner" ]; then
  IFS= read -r raw_pidfile_line <&3 || true
  raw_pidfile_pid="$(printf '%s\n' "$raw_pidfile_line" | awk '{ print $1 }')"
  raw_pidfile_starttime="$(printf '%s\n' "$raw_pidfile_line" | awk '{ print $2 }')"
  raw_pidfile_fields="$(printf '%s\n' "$raw_pidfile_line" | awk '{ print NF }')"
  case "$raw_pidfile_pid:$raw_pidfile_starttime:$raw_pidfile_fields" in
    *[!0-9:]*|''|*:|*:*:0|*:*:1) ;;
    *:*:2)
      current_starttime="$(awk '{ sub(/^[^)]*\) /, ""); split($0, fields, " "); print fields[20] }' "/proc/$raw_pidfile_pid/stat" 2>/dev/null || true)"
      if [ -n "$current_starttime" ] && [ "$current_starttime" = "$raw_pidfile_starttime" ]; then
        pidfile_pid="$raw_pidfile_pid"
        identity_files_trusted=1
      fi
      ;;
  esac
fi

# A root-owned identity file can authorize either supported gateway user. A
# gateway- or sandbox-owned identity can authorize only a process of that same
# user, enforced in the matcher below.
allowed_bare_users="gateway,sandbox"
find_gateway_pids() {
  ps -eo user=,pid=,args= 2>/dev/null | awk \
    -v self="$self" \
    -v parent="$parent" \
    -v pidfile_pid="$pidfile_pid" \
    -v identity_files_trusted="$identity_files_trusted" \
    -v identity_owner="$pidfile_owner" \
    -v allowed_bare_users="$allowed_bare_users" '
    function allowed_bare_user(user) {
      return index("," allowed_bare_users ",", "," user ",") > 0
    }
    $2 ~ /^[0-9]+$/ && $2 != self && $2 != parent {
      user = $1
      pid = $2
      cmd = $0
      sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+[0-9]+[[:space:]]+/, "", cmd)
      if (cmd ~ /(^|[[:space:]\/])openclaw-gateway([[:space:]]|$)/ || cmd ~ /(^|[[:space:]\/])openclaw[[:space:]]+gateway([[:space:]]|$)/) {
        seen[pid] = 1
      } else if (identity_files_trusted == "1" && pid == pidfile_pid && allowed_bare_user(user) && (identity_owner == "root" || identity_owner == user) && cmd ~ /(^|[[:space:]\/])openclaw[[:space:]]*$/) {
        seen[pid] = 1
      }
    }
    END { for (pid in seen) print pid }
  '
}

pids="$(find_gateway_pids)"
if [ -z "$pids" ]; then
  exit 1
fi

# Ask the gateway to shut down cleanly so its signal handler can stop channel
# pollers and other children.
kill -TERM $pids 2>/dev/null || true

for _ in 1 2 3 4 5 6 7 8 9 10; do
  remaining="$(find_gateway_pids)"
  [ -z "$remaining" ] && exit 0
  sleep 0.2
done

# If the process ignored SIGTERM, stop it anyway. The caller must not report
# success until the verification below observes that the gateway is gone.
kill -KILL $remaining 2>/dev/null || true
for _ in 1 2 3 4 5; do
  remaining="$(find_gateway_pids)"
  [ -z "$remaining" ] && exit 0
  sleep 0.2
done

printf '%s\n' "$remaining" >&2
exit 2
`;
