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
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   # shellcheck source=scripts/lib/sandbox-init.sh
#   source "${SCRIPT_DIR}/../scripts/lib/sandbox-init.sh"  # adjust path
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2277

# Guard against double-sourcing.
[ -z "${_SANDBOX_INIT_LOADED:-}" ] || return 0
_SANDBOX_INIT_LOADED=1

# ── /tmp trust boundary map ──────────────────────────────────────
# Files in /tmp that cross user boundaries. Every file sourced by system-wide
# shell hooks MUST be root-owned 444 in root mode.
#
# File                         Owner      Mode  Writer   Reader    Sourced?
# /tmp/nemoclaw-proxy-env.sh   root       444   root     sandbox   YES (/etc shell hooks)
# /tmp/gateway.log             gateway    644   gateway  all       no (world-readable for diagnostics)
# /tmp/auto-pair.log           sandbox    600   sandbox  sandbox   no
# /tmp/nemoclaw-plugin-refresh.log sandbox 600   sandbox  sandbox   no (OpenClaw refresh output)
# /tmp/.npm-cache/             sandbox    755   sandbox  sandbox   no (tool data)
# /tmp/.cache/                 sandbox    755   sandbox  sandbox   no (tool data)
# /tmp/.config/                sandbox    755   sandbox  sandbox   no (tool data)
# /tmp/.gnupg/                 sandbox    700   sandbox  sandbox   no (key data)
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

# ── Config file permission helpers ────────────────────────────────
# After drop_capabilities() strips CAP_DAC_OVERRIDE, root can no longer write
# files it does not own. These helpers temporarily make config files root-owned
# and 644 for writing, then re-lock to 444 afterward.
#
# CAP_FOWNER is retained (by design in PR #917), so root can still chmod
# files it doesn't own. The helpers include symlink guards to prevent
# symlink-following attacks on the config path.
#
# Usage:
#   relax_config_for_write /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
#   # ... perform writes ...
#   lock_config_after_write /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2653

relax_config_for_write() {
  local f
  for f in "$@"; do
    if [ -L "$f" ]; then
      printf '[SECURITY] Refusing to relax permissions — %s is a symlink\n' "$f" >&2
      return 1
    fi
    [ -f "$f" ] || continue
    if [ "$(id -u)" -eq 0 ] && ! chown root:root "$f"; then
      printf '[SECURITY] Failed to take ownership of %s for write\n' "$f" >&2
      return 1
    fi
    if ! chmod 644 "$f"; then
      printf '[SECURITY] Failed to relax permissions on %s\n' "$f" >&2
      return 1
    fi
  done
}

lock_config_after_write() {
  local f
  for f in "$@"; do
    if [ -L "$f" ]; then
      printf '[SECURITY] Refusing to lock permissions — %s is a symlink\n' "$f" >&2
      return 1
    fi
    [ -f "$f" ] || continue
    if ! chmod 444 "$f"; then
      printf '[SECURITY] Failed to lock permissions on %s\n' "$f" >&2
      return 1
    fi
  done
}

# ── Resource limits (RLIMITs) ────────────────────────────────────
# Harden RLIMITs at PID 1 (root) so the caps are inherited by every descendant
# and cannot be raised after the privilege step-down. nproc (#809) prevents
# fork bombs; nofile (#4527) caps open file descriptors so the sandbox no
# longer inherits the Docker daemon default (~1048576), which can exceed the
# host runtime limit. Best-effort: some container runtimes (e.g. brev, Docker
# Desktop, WSL) reject ulimit changes with "Invalid argument"; warn but do not
# block startup. Set the soft limit before the hard limit (ordering matters;
# see #951). Hard==soft makes the cap unraisable: raising the hard RLIMIT
# requires CAP_SYS_RESOURCE, which the unprivileged stepped-down agent never
# holds. NOTE: this only covers the PID 1 entrypoint process tree (gateway +
# agent); 'openshell sandbox connect' shells are spawned outside this tree and
# still inherit the runtime default (NVIDIA/OpenShell#1452).
harden_resource_limits() {
  if ! ulimit -Su 512 2>/dev/null; then
    echo "[SECURITY] Could not set soft nproc limit (container runtime may restrict ulimit)" >&2
  fi
  if ! ulimit -Hu 512 2>/dev/null; then
    echo "[SECURITY] Could not set hard nproc limit (container runtime may restrict ulimit)" >&2
  fi
  if ! ulimit -Sn 65536 2>/dev/null; then
    echo "[SECURITY] Could not set soft nofile limit (container runtime may restrict ulimit)" >&2
  fi
  if ! ulimit -Hn 65536 2>/dev/null; then
    echo "[SECURITY] Could not set hard nofile limit (container runtime may restrict ulimit)" >&2
  fi
}

# ── Capability dropping ──────────────────────────────────────────
# CIS Docker Benchmark 5.3: containers should not run with default caps.
# OpenShell manages the container runtime so we cannot pass --cap-drop=ALL
# to docker run. Instead, drop dangerous capabilities from the bounding set
# at startup using capsh. The bounding set limits what caps any child process
# (gateway, sandbox, agent) can ever acquire.
#
# Dropped (issue #3280): cap_sys_admin, cap_sys_ptrace plus the historical
# set (cap_net_raw, cap_dac_override, cap_sys_chroot, cap_fsetid,
# cap_setfcap, cap_mknod, cap_audit_write, cap_net_bind_service).
# Dashboard listens on a high port (default 18789, validated >=1024 in
# nemoclaw-start.sh), so cap_net_bind_service is unconditionally unused.
#
# Kept (each load-bearing — do not drop without an entrypoint refactor):
#   cap_chown, cap_fowner — needed to chown/chmod files we did not create
#     after dropping cap_dac_override (see #2659).
#   cap_setuid, cap_setgid — required by gosu to step down from root into
#     the sandbox/gateway UIDs during entrypoint privilege separation.
#   cap_kill — sandbox user signals gateway-user processes via the UID
#     separation enforced by the entrypoint (see test 13 in
#     e2e-gateway-isolation.sh).
# When the runtime cannot drop the bounding set (no CAP_SETPCAP, or capsh
# missing), the default is to warn and continue. Set NEMOCLAW_REQUIRE_CAP_DROP=1
# to make that case fail-closed instead — see enforce_cap_drop_if_required.
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/797
#      https://github.com/NVIDIA/NemoClaw/issues/3280
#      https://github.com/NVIDIA/OpenShell/issues/1452 (connect-shell scope)
#
# Usage:
#   drop_capabilities /usr/local/bin/nemoclaw-start "$@"
#
# Single source of truth for the dangerous capabilities the entrypoint drops
# and (in strict mode) verifies are gone. "bit:name" pairs; bit numbers per
# /usr/include/linux/capability.h. Both the capsh --drop list and
# dangerous_caps_in_capbnd() derive from this array, so the drop-set and the
# strict-mode verify-set cannot drift apart (issue #3280).
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

# The first argument is the absolute path to the entrypoint script to
# re-exec via capsh. Remaining arguments are forwarded.
drop_capabilities() {
  local entrypoint="$1"
  shift

  if [ "${NEMOCLAW_CAPS_DROPPED:-}" != "1" ] && command -v capsh >/dev/null 2>&1; then
    # capsh --drop requires CAP_SETPCAP in the bounding set. OpenShell's
    # sandbox runtime may strip it, so check before attempting the drop.
    if capsh --has-p=cap_setpcap 2>/dev/null; then
      export NEMOCLAW_CAPS_DROPPED=1
      exec capsh \
        --drop="$(dangerous_caps_drop_list)" \
        -- -c "exec $entrypoint \"\$@\"" -- "$@"
    fi
    # CAP_SETPCAP missing (or the exec above failed): the drop could not run.
    # Surface the residual bounding-set caps in the log.
    report_residual_capabilities || true
  elif [ "${NEMOCLAW_CAPS_DROPPED:-}" != "1" ]; then
    echo "[SECURITY WARNING] capsh not available — running with default capabilities" >&2
  fi

  # Opt-in fail-closed gate (issue #3280). Deliberately runs on EVERY path,
  # including when NEMOCLAW_CAPS_DROPPED is already set: it verifies the actual
  # bounding set rather than trusting that sentinel, so an inherited marker
  # cannot mask a drop that never happened.
  enforce_cap_drop_if_required
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

# Opt-in fail-closed enforcement (issue #3280). When NEMOCLAW_REQUIRE_CAP_DROP=1
# the sandbox refuses to start unless the bounding set is provably free of the
# dangerous capabilities. It verifies by reading the ACTUAL CapBnd — NOT by
# trusting the NEMOCLAW_CAPS_DROPPED sentinel, which an inherited environment
# could forge to bypass the gate.
#
# DEFAULT (unset) IS WARN-AND-CONTINUE — no host loses the ability to boot. This
# is the lesson of #4266/#4341: a default-fail-closed drop broke EVERY host that
# does not grant CAP_SETPCAP (GitHub runners, Brev shadecloud, Colossus Ubuntu
# 24.04, Docker Desktop, WSL) and was reverted within hours. Inverting the
# default to opt-in keeps that regression off by default.
#
# Scope: the AGENT process tree only. A `nemoclaw connect` shell is spawned by
# the container runtime outside that tree and inherits the container's OCI
# bounding set; tightening that requires cap_drop at sandbox create, tracked
# upstream in NVIDIA/OpenShell#1452.
#
# Test seam: NEMOCLAW_PROC_STATUS overrides the status source so unit tests can
# feed a known CapBnd fixture without a real /proc.
enforce_cap_drop_if_required() {
  [ "${NEMOCLAW_REQUIRE_CAP_DROP:-}" = "1" ] || return 0

  local status_path="${NEMOCLAW_PROC_STATUS:-/proc/self/status}"
  local cap_bnd_hex present reason=""
  cap_bnd_hex=$(awk '/^CapBnd:/{print $2}' "$status_path" 2>/dev/null || true)
  if [ -z "$cap_bnd_hex" ]; then
    # Cannot verify → in strict mode, refuse rather than assume safety.
    reason="could not read bounding set from ${status_path} — cannot verify drop"
  elif ! present="$(dangerous_caps_in_capbnd "$cap_bnd_hex")"; then
    # Non-empty but unparseable CapBnd is equally unverifiable → refuse.
    reason="could not parse bounding set (CapBnd=${cap_bnd_hex}) — cannot verify drop"
  elif [ -n "$present" ]; then
    reason="dangerous caps remain in bounding set (CapBnd=${cap_bnd_hex}): ${present}"
  fi
  [ -n "$reason" ] || return 0

  cat >&2 <<'EOF'

┌─ [SECURITY] Refusing to start sandbox: bounding-set capability drop failed ──
│
│ NEMOCLAW_REQUIRE_CAP_DROP=1 is set, so NemoClaw refuses to start a sandbox
│ that still holds dangerous bounding-set capabilities. The runtime could not
│ drop them (capsh or CAP_SETPCAP unavailable on this host), so they remain.
│
│ To run anyway with the weaker (warn-only) posture, unset the variable:
│   unset NEMOCLAW_REQUIRE_CAP_DROP
│
│ Tracking: https://github.com/NVIDIA/NemoClaw/issues/3280
└──────────────────────────────────────────────────────────────────────────────
EOF
  echo "[SECURITY] ${reason}" >&2
  exit 1
}

# Emit a loud diagnostic when capsh-based dropping is unavailable so that
# residual dangerous bounding-set caps surface in logs instead of being
# silently inherited from the container runtime. Called from the
# CAP_SETPCAP-missing fallback path of drop_capabilities() (issue #3280).
report_residual_capabilities() {
  echo "[SECURITY] CAP_SETPCAP not available — cannot drop bounding-set caps via capsh" >&2

  local status_path="${NEMOCLAW_PROC_STATUS:-/proc/self/status}"
  local cap_bnd_hex present
  if ! cap_bnd_hex=$(awk '/^CapBnd:/{print $2}' "$status_path" 2>/dev/null) \
    || [ -z "$cap_bnd_hex" ]; then
    echo "[SECURITY] Could not read ${status_path} — residual caps unknown" >&2
    return 0
  fi
  echo "[SECURITY] Residual CapBnd=${cap_bnd_hex}" >&2

  if ! present="$(dangerous_caps_in_capbnd "$cap_bnd_hex")"; then
    echo "[SECURITY] Could not parse CapBnd=${cap_bnd_hex} — residual caps unknown" >&2
  elif [ -n "$present" ]; then
    echo "[SECURITY] Dangerous caps remain in bounding set: ${present}" >&2
  fi
}

# ── Privilege step-down (issue #3280 follow-up) ──────────────────
# Replaces direct `gosu <user>` invocations with `setpriv` so the load-
# bearing caps (cap_setuid, cap_setgid, cap_fowner, cap_chown, cap_kill)
# are stripped from the bounding set *atomically with* the setuid
# transition. gosu cannot do this: dropping those caps before gosu
# breaks its setuid() syscall, and after gosu we are non-root and have
# already lost CAP_SETPCAP. setpriv performs reuid + bounding-set drop
# in a single process, in the correct order, before exec.
#
# Two prefix arrays are populated at source time:
#   STEP_DOWN_PREFIX_SANDBOX  — step down to the 'sandbox' user
#   STEP_DOWN_PREFIX_GATEWAY  — step down to the 'gateway' user
#
# Callers use them like the old `gosu <user>` prefix:
#   exec "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}"
#   "${STEP_DOWN_PREFIX_SANDBOX[@]}" bash -c "..."
#   nohup "${STEP_DOWN_PREFIX_GATEWAY[@]}" gateway run --port "$port" &
#
# Fallback: if setpriv is missing or CAP_SETPCAP isn't available, the
# arrays fall back to plain `gosu <user>` and a warning is logged so the
# residual bounding-set caps surface in the entrypoint log (matches the
# residual-surface design of report_residual_capabilities).
# File-scope array declarations: bash 3.2 (macOS) does not accept `declare -g`,
# but plain assignment at file scope is global by default. Inside
# init_step_down_prefixes() we re-assign these without `local`, which targets
# the globals in both bash 3.2 and 4+.
#
# Initialize to the gosu fallback (NOT empty) so callers cannot accidentally
# `exec "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}"` with an unset
# array — which would expand to nothing and run NEMOCLAW_CMD as root (privesc
# regression). init_step_down_prefixes() below upgrades to setpriv when
# CAP_SETPCAP is available; otherwise these stay at the gosu defaults.
# shellcheck disable=SC2034  # consumed by scripts/nemoclaw-start.sh and agents/hermes/start.sh
STEP_DOWN_PREFIX_SANDBOX=(gosu sandbox)
# shellcheck disable=SC2034  # consumed by scripts/nemoclaw-start.sh and agents/hermes/start.sh
STEP_DOWN_PREFIX_GATEWAY=(gosu gateway)

init_step_down_prefixes() {
  if command -v setpriv >/dev/null 2>&1 \
    && command -v capsh >/dev/null 2>&1 \
    && capsh --has-p=cap_setpcap 2>/dev/null; then
    # setpriv cap names are unprefixed (per `setpriv --list`); capsh uses
    # cap_* names. Keep them in sync but format-distinct.
    #
    # --init-groups (NOT --clear-groups): gateway is a member of the sandbox
    # group via `usermod -aG sandbox gateway` in Dockerfile.base so it can
    # write the chmod 660 /sandbox/.openclaw/openclaw.json (setgid'd
    # config dir, see #2681). --clear-groups would strip that membership
    # and break mutateConfigFile / control-UI config edits with EACCES.
    # --init-groups matches gosu's setgroups+initgroups behavior and
    # restores exactly the groups defined in /etc/group for the target user.
    #
    # NOTE (#4538): to verify the group-write contract as the gateway UID, use
    # the image's installed step-down mechanism — `setpriv --reuid=gateway
    # --regid=gateway --init-groups` (or `gosu gateway`). Do NOT probe with
    # `su -s /bin/sh gateway ...`: su does not run init_groups the same way and
    # will not reflect the gateway's sandbox-group membership, so a group-write
    # probe can spuriously EACCES even though the mutable contract is intact.
    local drop="-setuid,-setgid,-fowner,-chown,-kill"
    # shellcheck disable=SC2034  # consumed by entrypoint scripts (cross-file)
    STEP_DOWN_PREFIX_SANDBOX=(
      setpriv "--reuid=sandbox" "--regid=sandbox" --init-groups
      "--bounding-set=$drop" --
    )
    # shellcheck disable=SC2034  # consumed by entrypoint scripts (cross-file)
    STEP_DOWN_PREFIX_GATEWAY=(
      setpriv "--reuid=gateway" "--regid=gateway" --init-groups
      "--bounding-set=$drop" --
    )
  else
    echo "[SECURITY WARNING] setpriv or CAP_SETPCAP unavailable — falling back to gosu (bounding set will retain cap_setuid/setgid/fowner/chown/kill — issue #3280)" >&2
    # shellcheck disable=SC2034  # consumed by entrypoint scripts (cross-file)
    STEP_DOWN_PREFIX_SANDBOX=(gosu sandbox)
    # shellcheck disable=SC2034  # consumed by entrypoint scripts (cross-file)
    STEP_DOWN_PREFIX_GATEWAY=(gosu gateway)
  fi
}
init_step_down_prefixes

# ── Config integrity check ──────────────────────────────────────
# The config hash was pinned at build time. If it doesn't match,
# someone (or something) has tampered with the config.
#
# Usage:
#   verify_config_integrity_if_locked /sandbox/.openclaw               # OpenClaw
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

# OpenClaw is mutable by default in PR #2227: openclaw.json and .config-hash
# are sandbox-owned until `shields up` locks them. A sandbox-writable hash is
# not a trust anchor, so fail-closed integrity enforcement would only create a
# self-DoS after legitimate runtime config writes. Enforce the strict verifier
# only once the hash is root-owned and has no write bits, which is the state
# applied by shields-up. Explicit hash files remain strict.
verify_config_integrity_if_locked() {
  local config_dir="$1"
  local hash_file="${2:-${config_dir}/.config-hash}"

  if [ "${2:-}" != "" ]; then
    verify_config_integrity "$config_dir" "$hash_file"
    return $?
  fi

  if [ ! -f "$hash_file" ]; then
    local config_uid config_mode
    config_uid="$(stat -c '%u' "$config_dir" 2>/dev/null || stat -f '%u' "$config_dir" 2>/dev/null || echo unknown)"
    config_mode="$(stat -c '%a' "$config_dir" 2>/dev/null || stat -f '%Lp' "$config_dir" 2>/dev/null || echo unknown)"
    if [ "$config_uid" = "0" ] && [ "$config_mode" != "unknown" ] && (((8#$config_mode & 0022) == 0)); then
      echo "[SECURITY] Locked config is missing hash file (${hash_file}) — refusing to start" >&2
      return 1
    fi
    echo "[config] Config integrity check skipped for mutable default (${hash_file} missing)" >&2
    return 0
  fi
  if [ -L "$hash_file" ]; then
    echo "[SECURITY] Config hash file is a symlink (${hash_file}) — refusing to trust it" >&2
    return 1
  fi

  local hash_uid hash_mode
  hash_uid="$(stat -c '%u' "$hash_file" 2>/dev/null || stat -f '%u' "$hash_file" 2>/dev/null || echo unknown)"
  hash_mode="$(stat -c '%a' "$hash_file" 2>/dev/null || stat -f '%Lp' "$hash_file" 2>/dev/null || echo unknown)"
  if [ "$hash_uid" = "0" ] && [ "$hash_mode" != "unknown" ] && (((8#$hash_mode & 0222) == 0)); then
    verify_config_integrity "$config_dir" "$hash_file"
    return $?
  fi

  echo "[config] Config integrity check skipped for mutable default (${hash_file} is not locked)" >&2
  return 0
}

# ── RC file locking ──────────────────────────────────────────────
# Lock .bashrc and .profile to 444 after startup has written dynamic shell
# state to /tmp/nemoclaw-proxy-env.sh. This prevents the sandbox user from
# injecting code that runs on every `nemoclaw connect`.
#
# SECURITY: This fixes the Hermes vulnerability where .bashrc/.profile
# were never locked (unlike OpenClaw which had this via #2125).
#
# Usage:
#   lock_rc_files /sandbox   # locks /sandbox/.bashrc and /sandbox/.profile
lock_rc_files() {
  local home_dir="$1"

  for rc_file in "${home_dir}/.bashrc" "${home_dir}/.profile"; do
    if [ -L "$rc_file" ]; then
      echo "[SECURITY] Refusing to lock symlinked rc file: ${rc_file}" >&2
      continue
    fi
    if [ -f "$rc_file" ]; then
      if ! python3 - "$rc_file" "$(id -u)" <<'PY' 2>/dev/null; then
import errno
import os
import stat
import sys

path, uid_text = sys.argv[1:3]
uid = int(uid_text)
flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
try:
    fd = os.open(path, flags)
except OSError as exc:
    if exc.errno == errno.ELOOP:
        print(f"[SECURITY] Refusing to lock symlinked rc file: {path}", file=sys.stderr)
    else:
        print(f"[SECURITY] Could not open rc file for locking: {path}: {exc}", file=sys.stderr)
    sys.exit(1)

try:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        print(f"[SECURITY] Refusing to lock non-regular rc file: {path}", file=sys.stderr)
        sys.exit(1)
    if uid == 0:
        os.fchown(fd, 0, 0)
    os.fchmod(fd, 0o444)
finally:
    os.close(fd)
PY
        echo "[SECURITY] Could not lock ${rc_file} to 444 — continuing (best-effort, Landlock may enforce)" >&2
      fi
    fi
  done
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

# Lock a config directory and its symlinks with the immutable flag so
# they cannot be swapped at runtime even if DAC or Landlock are bypassed.
# chattr requires cap_linux_immutable which the entrypoint has as root;
# the sandbox user cannot remove the flag.
#
# Usage:
#   harden_config_symlinks /sandbox/.openclaw
#   harden_config_symlinks /sandbox/.hermes
harden_config_symlinks() {
  local config_dir="$1"
  local label="${2:-$(basename "$config_dir")}"
  local entry hardened failed
  hardened=0
  failed=0

  if ! command -v chattr >/dev/null 2>&1; then
    echo "[SECURITY] chattr not available — relying on DAC + Landlock for ${label} hardening" >&2
    return 0
  fi

  if chattr +i "$config_dir" 2>/dev/null; then
    hardened=$((hardened + 1))
  else
    failed=$((failed + 1))
  fi

  for entry in "${config_dir}"/*; do
    [ -L "$entry" ] || continue
    if chattr +i "$entry" 2>/dev/null; then
      hardened=$((hardened + 1))
    else
      failed=$((failed + 1))
    fi
  done

  if [ "$failed" -gt 0 ]; then
    echo "[SECURITY] Immutable hardening applied to $hardened path(s); $failed path(s) could not be hardened — continuing with DAC + Landlock" >&2
  elif [ "$hardened" -gt 0 ]; then
    echo "[SECURITY] Immutable hardening applied to ${label} and validated symlinks" >&2
  fi
}

# ── Messaging channels ──────────────────────────────────────────
# Channel entries are baked into the config at image build time via manifest
# render hooks. Placeholder tokens flow through to the L7 proxy for rewriting
# at egress. Real tokens are never visible inside the sandbox.
#
# This function just logs which channels are active. Runtime patching
# of config files is not possible — Landlock enforces read-only at
# the kernel level.
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
  python3 - <<'PY'
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
