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
# Files in /tmp that cross user boundaries. Every file sourced by
# .bashrc/.profile MUST be root-owned 444 in root mode.
#
# File                         Owner      Mode  Writer   Reader    Sourced?
# /tmp/nemoclaw-proxy-env.sh   root       444   root     sandbox   YES (.bashrc/.profile)
# /tmp/gateway.log             gateway    644   gateway  all       no (world-readable for diagnostics)
# /tmp/auto-pair.log           sandbox    600   sandbox  sandbox   no
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
  # world-readable for diagnostics). auto-pair.log is 600.
  for f in /tmp/gateway.log /tmp/auto-pair.log; do
    [ -f "$f" ] || continue
    local perms
    perms="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null || echo "unknown")"
    case "$f" in
      */gateway.log)
        if [ "$perms" != "600" ] && [ "$perms" != "644" ]; then
          echo "[SECURITY] $f has unexpected permissions: mode=$perms (expected 600 or 644)" >&2
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

# ── Capability dropping ──────────────────────────────────────────
# CIS Docker Benchmark 5.3: containers should not run with default caps.
# OpenShell manages the container runtime so we cannot pass --cap-drop=ALL
# to docker run. Instead, drop dangerous capabilities from the bounding set
# at startup using capsh. The bounding set limits what caps any child process
# (gateway, sandbox, agent) can ever acquire.
#
# Kept: cap_chown, cap_setuid, cap_setgid, cap_fowner, cap_kill
#   — required by the entrypoint for gosu privilege separation and chown.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/797
#
# Usage:
#   drop_capabilities /usr/local/bin/nemoclaw-start "$@"
#
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
        --drop=cap_net_raw,cap_dac_override,cap_sys_chroot,cap_fsetid,cap_setfcap,cap_mknod,cap_audit_write,cap_net_bind_service \
        -- -c "exec $entrypoint \"\$@\"" -- "$@"
    else
      echo "[SECURITY] CAP_SETPCAP not available — runtime already restricts capabilities" >&2
    fi
  elif [ "${NEMOCLAW_CAPS_DROPPED:-}" != "1" ]; then
    echo "[SECURITY WARNING] capsh not available — running with default capabilities" >&2
  fi
}

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
      if ! chmod 444 "$rc_file" 2>/dev/null; then
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
# Channel entries are baked into the config at image build time via
# NEMOCLAW_MESSAGING_CHANNELS_B64. Placeholder tokens flow through
# to the L7 proxy for rewriting at egress. Real tokens are never
# visible inside the sandbox.
#
# This function just logs which channels are active. Runtime patching
# of config files is not possible — Landlock enforces read-only at
# the kernel level.
configure_messaging_channels() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || [ -n "${DISCORD_BOT_TOKEN:-}" ] || [ -n "${SLACK_BOT_TOKEN:-}" ] || return 0

  echo "[channels] Messaging channels active (baked at build time):" >&2
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && echo "[channels]   telegram" >&2
  [ -n "${DISCORD_BOT_TOKEN:-}" ] && echo "[channels]   discord" >&2
  [ -n "${SLACK_BOT_TOKEN:-}" ] && echo "[channels]   slack" >&2
  return 0
}
