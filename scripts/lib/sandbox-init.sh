#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared sandbox entrypoint primitives for NemoClaw agent types.
#
# Sourced by scripts/nemoclaw-start.sh (OpenClaw) and agents/hermes/start.sh
# (Hermes) to provide a single source of truth for security-sensitive
# initialisation functions. Prevents drift between entrypoints — every
# security fix applied here protects both agents automatically.
#
# Usage (from an entrypoint script):
#   SCRIPT_SOURCE="${BASH_SOURCE[0]}"
#   SCRIPT_DIR="${SCRIPT_SOURCE%/*}"
#   # shellcheck source=scripts/lib/sandbox-init.sh
#   source "${SCRIPT_DIR}/../scripts/lib/sandbox-init.sh"  # adjust path
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2277

# Guard against double-sourcing.
[ -z "${_SANDBOX_INIT_LOADED:-}" ] || return 0
_SANDBOX_INIT_LOADED=1

_SANDBOX_INIT_SOURCE="${BASH_SOURCE[0]}"
_SANDBOX_INIT_DIR="${_SANDBOX_INIT_SOURCE%/*}"
if [ "$_SANDBOX_INIT_DIR" = "$_SANDBOX_INIT_SOURCE" ]; then
  _SANDBOX_INIT_DIR="."
fi
_SANDBOX_INIT_DIR="$(cd "$_SANDBOX_INIT_DIR" && pwd)"
unset _SANDBOX_INIT_SOURCE
# shellcheck source=scripts/lib/sandbox-rlimits.sh
source "${_SANDBOX_INIT_DIR}/sandbox-rlimits.sh"

# ── /tmp trust boundary map ──────────────────────────────────────
# Files in /tmp that cross user boundaries. Every file sourced by system-wide
# shell hooks MUST be root-owned 444 in root mode.
#
# File                         Owner      Mode  Writer   Reader    Sourced?
# /tmp/nemoclaw-proxy-env.sh   root       444   root     sandbox   YES (/etc shell hooks)
# /tmp/gateway.log             gateway    644   gateway  all       no (world-readable for diagnostics)
# /tmp/auto-pair.log           root*      600   root*    inherited no
# /tmp/nemoclaw-plugin-refresh.log sandbox 600   sandbox  sandbox   no (OpenClaw refresh output)
# /tmp/.npm-cache/             sandbox    755   sandbox  sandbox   no (tool data)
# /tmp/.cache/                 sandbox    755   sandbox  sandbox   no (tool data)
# /tmp/.gnupg/                 sandbox    700   sandbox  sandbox   no (key data)
#
# * In non-root mode the sandbox user owns and opens auto-pair.log. In root
# mode PID 1 owns and opens it before the stepped-down watcher inherits the
# descriptor; PID 1 has already dropped CAP_DAC_OVERRIDE at that boundary.
#
# In non-root mode privilege separation is disabled — all files are
# owned by sandbox. chmod 444 is best-effort (owner can chmod back).
# This is an accepted limitation documented in the OpenShell security model.
#
# See also: https://github.com/NVIDIA/NemoClaw/issues/2181
# ─────────────────────────────────────────────────────────────────

# ── Secure file helpers ──────────────────────────────────────────
# Centralized primitives for creating files that cross trust boundaries
# in /tmp. Using these helpers instead of ad-hoc chmod/chown ensures
# consistent security posture and prevents the class of bug in #2181.

# Write a file that the sandbox user can SOURCE but not MODIFY.
# Reads content from stdin. Caller usage:
#   emit_sandbox_sourced_file /path <<'EOF'
#   export FOO="bar"
#   EOF
#
# Or pipe into it:
#   generate_content | emit_sandbox_sourced_file /path
#
# Root mode:  root:root 444 — sandbox cannot chmod (not owner).
# Non-root:   sandbox:sandbox 444 — best-effort (owner can chmod back;
#             accepted limitation since privilege separation is disabled).
#
# SECURITY: write to a temp file in the same directory, then atomically rename
# it into place. This closes the rm+recreate race where another user could
# recreate the destination as a symlink between unlink and open.
emit_sandbox_sourced_file() {
  local path="$1"
  local dir base tmp
  dir="$(dirname "$path")"
  base="$(basename "$path")"
  tmp="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || return 1

  if ! cat >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if [ "$(id -u)" -eq 0 ] && ! chown root:root "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! chmod 444 "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! mv -f "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
}

# Verify that trust-boundary files in /tmp have the expected permissions
# BEFORE handing off to the sandbox user. Call this after all init work
# and before launching services. Defence-in-depth: catches regressions
# even if a new file is added without using the helper above.
#
# Usage:
#   validate_tmp_permissions                          # default sourced + log files
#   validate_tmp_permissions /tmp/custom-sourced.sh   # additional sourced files
#
# Positional args are additional sourced files to check (444 required).
# shellcheck disable=SC2120
validate_tmp_permissions() {
  local failed=0

  # Files sourced by sandbox (.bashrc/.profile) — must not be writable.
  local sourced_files=("/tmp/nemoclaw-proxy-env.sh")
  sourced_files+=("$@")

  for f in "${sourced_files[@]}"; do
    [ -f "$f" ] || continue
    local perms owner
    perms="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null || echo "unknown")"
    owner="$(stat -c '%U' "$f" 2>/dev/null || stat -f '%Su' "$f" 2>/dev/null || echo "unknown")"
    if [ "$(id -u)" -eq 0 ] && { [ "$owner" != "root" ] || [ "$perms" != "444" ]; }; then
      echo "[SECURITY] $f has unsafe permissions: owner=$owner mode=$perms (expected root:444)" >&2
      failed=1
    elif [ "$(id -u)" -ne 0 ] && [ "$perms" != "444" ]; then
      echo "[SECURITY] $f has unsafe permissions: mode=$perms (expected 444)" >&2
      failed=1
    fi
  done

  # Restricted log files — gateway.log may be 600 (Hermes) or 644 (OpenClaw,
  # world-readable for diagnostics). auto-pair.log is 600. The plugin-refresh
  # log is written after privilege drop as sandbox, so keep it private and
  # reject symlinks/non-regular files before launching services. OpenClaw's
  # entrypoint sets PLUGIN_REFRESH_LOG; shared tests can override it while
  # production keeps the fixed /tmp path.
  local plugin_refresh_log="${PLUGIN_REFRESH_LOG:-/tmp/nemoclaw-plugin-refresh.log}"
  for f in /tmp/gateway.log /tmp/auto-pair.log "$plugin_refresh_log"; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    if [ -L "$f" ]; then
      echo "[SECURITY] $f is a symlink (expected regular log file)" >&2
      failed=1
      continue
    fi
    if [ ! -f "$f" ]; then
      echo "[SECURITY] $f is not a regular file" >&2
      failed=1
      continue
    fi
    local perms owner
    perms="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null || echo "unknown")"
    owner="$(stat -c '%U' "$f" 2>/dev/null || stat -f '%Su' "$f" 2>/dev/null || echo "unknown")"
    case "$f" in
      */gateway.log)
        if [ "$perms" != "600" ] && [ "$perms" != "644" ]; then
          echo "[SECURITY] $f has unexpected permissions: mode=$perms (expected 600 or 644)" >&2
          failed=1
        fi
        ;;
      */nemoclaw-plugin-refresh.log)
        if [ "$perms" != "600" ]; then
          echo "[SECURITY] $f has unexpected permissions: mode=$perms (expected 600)" >&2
          failed=1
        fi
        if [ "$(id -u)" -eq 0 ] && [ "$owner" != "sandbox" ]; then
          echo "[SECURITY] $f has unsafe owner: owner=$owner (expected sandbox)" >&2
          failed=1
        fi
        ;;
      *)
        if [ "$perms" != "600" ]; then
          echo "[SECURITY] $f has unexpected permissions: mode=$perms (expected 600)" >&2
          failed=1
        fi
        ;;
    esac
  done

  return $failed
}

# ── Capability dropping ──────────────────────────────────────────
# OpenShell-managed entrypoints do not call this section. Direct-root
# entrypoints can still need capsh. Their retained bounding caps
# (chown, fowner, setuid, setgid, kill) support initialization and supervised
# shutdown; init_step_down_prefixes can remove them when changing user.
# NEMOCLAW_REQUIRE_CAP_DROP=1 retains fail-closed verification for unavailable
# drops. The default preserves the legacy warn-and-continue behavior.
#
# Single drop/verification list, with bit numbers from linux/capability.h.
DANGEROUS_CAPS=(
  "21:cap_sys_admin"
  "19:cap_sys_ptrace"
  "13:cap_net_raw"
  "1:cap_dac_override"
  "18:cap_sys_chroot"
  "4:cap_fsetid"
  "31:cap_setfcap"
  "27:cap_mknod"
  "29:cap_audit_write"
  "10:cap_net_bind_service"
)

# Comma-separated capability names for `capsh --drop`, derived from DANGEROUS_CAPS.
dangerous_caps_drop_list() {
  local entry out=""
  for entry in "${DANGEROUS_CAPS[@]}"; do
    out="${out:+$out,}${entry#*:}"
  done
  printf '%s' "$out"
}

# Use built-ins so verification observes the calling shell rather than an
# exec'd reader whose capability state can differ. An explicit file argument
# permits deterministic direct-root fixtures.
read_capability_bounding_set() {
  local key value rest seen=0 cap_bnd_hex=""
  while IFS=$' \t' read -r key value rest; do
    [ "$key" = CapBnd: ] || continue
    [ "$seen" -eq 0 ] || return 1
    seen=1
    cap_bnd_hex="$value"
    [ -z "$rest" ] || return 1
  done <"$1" || return 1
  [ "$seen" -eq 1 ] && [ -n "$cap_bnd_hex" ] || return 1
  printf '%s\n' "$cap_bnd_hex"
}

# The first argument is the absolute entrypoint path; remaining args are forwarded.
drop_capabilities() {
  local entrypoint="$1"
  shift

  local cap_bnd_hex present reason=""
  if ! cap_bnd_hex="$(read_capability_bounding_set /proc/self/status 2>/dev/null)"; then
    reason="could not read bounding set from /proc/self/status"
  else
    if ! present="$(dangerous_caps_in_capbnd "$cap_bnd_hex")"; then
      reason="could not parse bounding set (CapBnd=${cap_bnd_hex})"
    elif [ -n "$present" ]; then
      reason="dangerous caps remain in bounding set (CapBnd=${cap_bnd_hex}): ${present}"
    fi
  fi

  # Keep one capsh attempt for legacy entrypoints even when /proc is unreadable.
  # The sentinel prevents re-execution loops; it never proves a successful drop.
  if [ "${NEMOCLAW_CAPS_DROPPED:-}" != "1" ] \
    && command -v capsh >/dev/null 2>&1 \
    && capsh --has-p=cap_setpcap 2>/dev/null; then
    export NEMOCLAW_CAPS_DROPPED=1
    # capsh expands the positional parameters in its child shell.
    # shellcheck disable=SC2016
    exec capsh \
      --drop="$(dangerous_caps_drop_list)" \
      -- -c 'exec "$0" "$@"' "$entrypoint" "$@"
  fi

  [ -z "$reason" ] && return 0
  if [ "${NEMOCLAW_REQUIRE_CAP_DROP:-}" = "1" ]; then
    echo "[SECURITY] Refusing to start sandbox: ${reason}" >&2
    exit 1
  fi
  echo "[SECURITY WARNING] Cannot drop bounding-set capabilities with capsh: ${reason}" >&2
}

# Pure decode: given a CapBnd hex string, echo the comma-separated list of the
# dangerous capabilities present (empty string if none). Factored out so the
# residual diagnostic, the strict-mode gate, and the unit tests all share one
# implementation instead of re-deriving the bit math.
#
# Bash arithmetic handles 64-bit ints on 64-bit platforms; CAP_LAST_CAP is ~41
# today, well within range. Avoids a gawk-strtonum dependency.
#
# Returns nonzero with no output if the hex is empty or malformed, so callers
# can treat "could not parse" the same as "could not read" instead of silently
# treating an unparseable bounding set as clean (issue #3280).
dangerous_caps_in_capbnd() {
  local cap_bnd_hex="$1" val entry bit name present=""
  case "$cap_bnd_hex" in
    "" | *[!0-9A-Fa-f]*) return 1 ;;
  esac
  val=$((16#$cap_bnd_hex))
  for entry in "${DANGEROUS_CAPS[@]}"; do
    bit="${entry%%:*}"
    name="${entry#*:}"
    if [ $(((val >> bit) & 1)) -ne 0 ]; then
      present="${present:+$present,}$name"
    fi
  done
  printf '%s' "$present"
}

# ── Privilege step-down (issue #3280 follow-up) ──────────────────
# Uses `setpriv` for every root-to-user transition. When CAP_SETPCAP is
# available, setpriv also strips the load-bearing caps (cap_setuid,
# cap_setgid, cap_fowner, cap_chown, cap_kill) from the bounding set atomically
# with the setuid transition. setpriv performs both operations in the correct
# order before exec.
#
# Two prefix arrays are populated at source time:
#   STEP_DOWN_PREFIX_SANDBOX  — step down to the 'sandbox' user
#   STEP_DOWN_PREFIX_GATEWAY  — step down to the 'gateway' user
#
# Callers use them as a command prefix:
#   exec "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}"
#   "${STEP_DOWN_PREFIX_SANDBOX[@]}" bash -c "..."
#   nohup "${STEP_DOWN_PREFIX_GATEWAY[@]}" gateway run --port "$port" &
#
# If CAP_SETPCAP is unavailable, setpriv still changes identity and initializes
# supplementary groups, but cannot remove the remaining load-bearing caps from
# the bounding set. That case is logged consistently with
# drop_capabilities. If setpriv itself is unavailable, the prefix
# invokes a fail-closed helper instead of risking execution as root.
# File-scope array declarations: bash 3.2 (macOS) does not accept `declare -g`,
# but plain assignment at file scope is global by default. Inside
# init_step_down_prefixes() we re-assign these without `local`, which targets
# the globals in both bash 3.2 and 4+.
#
# Initialize to the fail-closed helper (NOT empty) so callers cannot accidentally
# `exec "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}"` with an unset
# array — which would expand to nothing and run NEMOCLAW_CMD as root (privesc
# regression).
# shellcheck disable=SC2034  # consumed by scripts/nemoclaw-start.sh and agents/hermes/start.sh
STEP_DOWN_PREFIX_SANDBOX=(
  /bin/sh -c 'echo "[SECURITY] setpriv unavailable: refusing to execute a root privilege transition" >&2; exit 1' --
)
# shellcheck disable=SC2034  # consumed by scripts/nemoclaw-start.sh and agents/hermes/start.sh
STEP_DOWN_PREFIX_GATEWAY=(
  /bin/sh -c 'echo "[SECURITY] setpriv unavailable: refusing to execute a root privilege transition" >&2; exit 1' --
)

init_step_down_prefixes() {
  local setpriv_path
  if ! setpriv_path="$(command -v setpriv 2>/dev/null)" || [ -z "$setpriv_path" ]; then
    echo "[SECURITY WARNING] setpriv unavailable: root privilege transitions will fail closed" >&2
    # shellcheck disable=SC2034  # consumed by entrypoint scripts (cross-file)
    STEP_DOWN_PREFIX_SANDBOX=(
      /bin/sh -c 'echo "[SECURITY] setpriv unavailable: refusing to execute a root privilege transition" >&2; exit 1' --
    )
    # shellcheck disable=SC2034  # consumed by entrypoint scripts (cross-file)
    STEP_DOWN_PREFIX_GATEWAY=(
      /bin/sh -c 'echo "[SECURITY] setpriv unavailable: refusing to execute a root privilege transition" >&2; exit 1' --
    )
    return 0
  fi

  # --init-groups (NOT --clear-groups): gateway is a member of the sandbox
  # group via `usermod -aG sandbox gateway` in Dockerfile.base so it can write
  # the chmod 660 /sandbox/.openclaw/openclaw.json. --clear-groups would strip
  # that membership and break config edits with EACCES.
  local -a sandbox_prefix=(
    "$setpriv_path" "--reuid=sandbox" "--regid=sandbox" --init-groups
  )
  local -a gateway_prefix=(
    "$setpriv_path" "--reuid=gateway" "--regid=gateway" --init-groups
  )

  if command -v capsh >/dev/null 2>&1 && capsh --has-p=cap_setpcap 2>/dev/null; then
    # setpriv cap names are unprefixed (per `setpriv --list`); capsh uses cap_*.
    local drop="-setuid,-setgid,-fowner,-chown,-kill"
    sandbox_prefix+=("--bounding-set=$drop")
    gateway_prefix+=("--bounding-set=$drop")
  else
    echo "[SECURITY WARNING] CAP_SETPCAP unavailable: setpriv will change identity without dropping the remaining privilege-separation capabilities from the bounding set" >&2
  fi

  sandbox_prefix+=(--)
  gateway_prefix+=(--)
  # shellcheck disable=SC2034  # consumed by entrypoint scripts (cross-file)
  STEP_DOWN_PREFIX_SANDBOX=("${sandbox_prefix[@]}")
  # shellcheck disable=SC2034  # consumed by entrypoint scripts (cross-file)
  STEP_DOWN_PREFIX_GATEWAY=("${gateway_prefix[@]}")
}
if [ "$(id -u)" -eq 0 ]; then
  init_step_down_prefixes
fi

# ── Config integrity check ──────────────────────────────────────
# The config hash was pinned at build time. If it doesn't match,
# someone (or something) has tampered with the config.
#
# Usage:
#   verify_config_integrity /sandbox/.hermes /etc/nemoclaw/hermes.config-hash # Hermes
#
# The config_dir must contain a .config-hash file with sha256sum output unless
# an explicit hash file path is supplied. Explicit hash files are trust anchors:
# they must be root-owned and have no write bits set.
verify_config_integrity() {
  local config_dir="$1"
  local hash_file="${2:-${config_dir}/.config-hash}"

  if [ ! -f "$hash_file" ]; then
    echo "[SECURITY] Config hash file missing (${hash_file}) — refusing to start without integrity verification" >&2
    return 1
  fi
  if [ -L "$hash_file" ]; then
    echo "[SECURITY] Config hash file is a symlink (${hash_file}) — refusing to trust it" >&2
    return 1
  fi
  if [ "${2:-}" != "" ]; then
    local hash_uid hash_mode
    hash_uid="$(stat -c '%u' "$hash_file" 2>/dev/null || stat -f '%u' "$hash_file" 2>/dev/null || echo unknown)"
    hash_mode="$(stat -c '%a' "$hash_file" 2>/dev/null || stat -f '%Lp' "$hash_file" 2>/dev/null || echo unknown)"
    if [ "$hash_uid" != "0" ]; then
      echo "[SECURITY] Config hash file ${hash_file} is owned by uid ${hash_uid}, expected root (uid 0)" >&2
      return 1
    fi
    if [ "$hash_mode" = "unknown" ] || (((8#$hash_mode & 0222) != 0)); then
      echo "[SECURITY] Config hash file ${hash_file} has writable mode ${hash_mode}, expected no write bits" >&2
      return 1
    fi
  fi
  if ! (cd "$config_dir" && sha256sum -c "$hash_file" --status 2>/dev/null); then
    echo "[SECURITY] Config integrity check FAILED in ${config_dir} — config may have been tampered with" >&2
    return 1
  fi
}

# ── Cleanup / signal forwarding ──────────────────────────────────
# Forward SIGTERM/SIGINT to child processes for graceful shutdown.
# The entrypoint is PID 1 — without a trap, signals interrupt wait and
# children are orphaned until Docker sends SIGKILL after the grace period.
#
# Usage:
#   # After starting processes, register their PIDs:
#   SANDBOX_CHILD_PIDS=("$GATEWAY_PID" "$AUTO_PAIR_PID")
#   SANDBOX_WAIT_PID="$GATEWAY_PID"
#   trap cleanup_on_signal SIGTERM SIGINT
#
# SANDBOX_CHILD_PIDS: array of PIDs to kill on signal (best-effort).
# SANDBOX_WAIT_PID: the primary PID whose exit status is returned.
cleanup_on_signal() {
  echo "[gateway] received signal, forwarding to children..." >&2
  local primary_status=0

  # ${arr[@]+...} guard prevents "unbound variable" under set -u when
  # SANDBOX_CHILD_PIDS is empty or unset (bash 3.x / macOS compat).
  local _pids=()
  # shellcheck disable=SC2206
  _pids=(${SANDBOX_CHILD_PIDS[@]+"${SANDBOX_CHILD_PIDS[@]}"})

  for pid in "${_pids[@]+"${_pids[@]}"}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  if [ -n "${SANDBOX_WAIT_PID:-}" ]; then
    wait "$SANDBOX_WAIT_PID" 2>/dev/null || primary_status=$?
  fi

  # Wait for remaining children (best-effort, don't fail on already-exited)
  for pid in "${_pids[@]+"${_pids[@]}"}"; do
    [ "$pid" = "${SANDBOX_WAIT_PID:-}" ] && continue
    wait "$pid" 2>/dev/null || true
  done

  exit "$primary_status"
}

# ── Symlink validation ───────────────────────────────────────────
# Verify ALL symlinks in a config directory point to the expected
# writable data directory. Dynamic scan so future symlinks are
# covered automatically.
#
# Usage:
#   validate_config_symlinks /sandbox/.openclaw /sandbox/.openclaw-data
#   validate_config_symlinks /sandbox/.hermes /sandbox/.hermes-data
validate_config_symlinks() {
  local config_dir="$1"
  local data_dir="$2"
  local entry name target expected

  for entry in "${config_dir}"/*; do
    [ -L "$entry" ] || continue
    name="$(basename "$entry")"
    target="$(readlink -f "$entry" 2>/dev/null || true)"
    # Resolve expected path too so macOS /var → /private/var doesn't cause
    # false positives. Fall back to the unresolved path if readlink fails.
    expected="$(readlink -f "${data_dir}/${name}" 2>/dev/null || echo "${data_dir}/${name}")"
    if [ "$target" != "$expected" ]; then
      echo "[SECURITY] Symlink $entry points to unexpected target: $target (expected $expected)" >&2
      return 1
    fi
  done
}

# ── Messaging channels ──────────────────────────────────────────
# Channel entries are baked into the config at image build time via manifest
# render hooks. Placeholder tokens flow through to the L7 proxy for rewriting
# at egress. Real tokens are never visible inside the sandbox.
#
# This function just logs which channels are active. Managed runtime config
# changes use the agent-aware host transaction paths.
configure_messaging_channels() {
  local channels
  channels="$(read_messaging_plan_channels || true)"
  [ -n "$channels" ] || return 0

  echo "[channels] Messaging channels active (baked at build time):" >&2
  while IFS= read -r channel; do
    [ -n "$channel" ] || continue
    echo "[channels]   $channel" >&2
  done <<EOF
$channels
EOF
  return 0
}

read_messaging_plan_channels() {
  python3 -I - <<'PY'
import base64
import json
import os

DEFAULT_ARTIFACT_PATH = "/usr/local/share/nemoclaw/messaging-runtime-plan.json"


def read_plan():
    raw = os.environ.get("NEMOCLAW_MESSAGING_PLAN_B64", "").strip()
    if raw:
        try:
            return json.loads(base64.b64decode(raw).decode("utf-8"))
        except Exception:
            raise SystemExit(0)
    artifact_path = os.environ.get("NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH", DEFAULT_ARTIFACT_PATH)
    if not artifact_path or not os.path.isfile(artifact_path):
        raise SystemExit(0)
    try:
        with open(artifact_path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        raise SystemExit(0)


plan = read_plan()
if not isinstance(plan, dict):
    raise SystemExit(0)
seen = set()
disabled = {
    str(channel).strip().lower()
    for channel in plan.get("disabledChannels", [])
    if isinstance(channel, str)
}
for item in plan.get("channels", []):
    if not isinstance(item, dict):
        continue
    channel = str(item.get("channelId") or "").strip().lower()
    if not channel or channel in seen:
        continue
    if item.get("active") is True and item.get("disabled") is not True and channel not in disabled:
        seen.add(channel)
        print(channel)
PY
}

# Process observation helpers used for launch health and signal cleanup.

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
  local proc_root
  local port_hex listener_inodes inode fd_path target listener_inode
  if [ "$#" -ge 3 ]; then
    proc_root="$3"
  else
    proc_root="$(gateway_control_proc_root)" || return 1
  fi
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
