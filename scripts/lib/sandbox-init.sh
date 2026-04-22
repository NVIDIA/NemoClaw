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
# /tmp/gateway.log             gateway    600   gateway  gateway   no
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
emit_sandbox_sourced_file() {
  local path="$1"
  # Remove any pre-existing file/symlink to prevent symlink-following attacks.
  # rm -f works because: root can remove anything; in non-root mode the owner
  # can remove their own file in sticky-bit /tmp.
  rm -f "$path" 2>/dev/null || true
  cat >"$path"
  if [ "$(id -u)" -eq 0 ]; then
    chown root:root "$path"
  fi
  chmod 444 "$path"
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

  # Restricted log files — must be 600
  for f in /tmp/gateway.log /tmp/auto-pair.log; do
    [ -f "$f" ] || continue
    local perms
    perms="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null || echo "unknown")"
    if [ "$perms" != "600" ]; then
      echo "[SECURITY] $f has unexpected permissions: mode=$perms (expected 600)" >&2
      failed=1
    fi
  done

  return $failed
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
#   verify_config_integrity /sandbox/.openclaw    # OpenClaw
#   verify_config_integrity /sandbox/.hermes      # Hermes
#
# The config_dir must contain a .config-hash file with sha256sum output.
verify_config_integrity() {
  local config_dir="$1"
  local hash_file="${config_dir}/.config-hash"

  if [ ! -f "$hash_file" ]; then
    echo "[SECURITY] Config hash file missing (${hash_file}) — refusing to start without integrity verification" >&2
    return 1
  fi
  if ! (cd "$config_dir" && sha256sum -c "$hash_file" --status 2>/dev/null); then
    echo "[SECURITY] Config integrity check FAILED in ${config_dir} — config may have been tampered with" >&2
    return 1
  fi
}

# ── RC file locking ──────────────────────────────────────────────
# Lock .bashrc and .profile to 444 after all mutations (proxy snippets,
# configure guard, gateway token export) are complete. This prevents the
# sandbox user from injecting code that runs on every `nemoclaw connect`.
#
# SECURITY: This fixes the Hermes vulnerability where .bashrc/.profile
# were never locked (unlike OpenClaw which had this via #2125).
#
# Usage:
#   lock_rc_files /sandbox   # locks /sandbox/.bashrc and /sandbox/.profile
lock_rc_files() {
  local home_dir="$1"

  for rc_file in "${home_dir}/.bashrc" "${home_dir}/.profile"; do
    if [ -f "$rc_file" ]; then
      chmod 444 "$rc_file"
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
