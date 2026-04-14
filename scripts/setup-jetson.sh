#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SUDO=()
((EUID != 0)) && SUDO=(sudo)

info() {
  printf "[INFO]  %s\n" "$*"
}

error() {
  printf "[ERROR] %s\n" "$*" >&2
  exit 1
}

get_jetpack_version() {
  local release_line release revision l4t_version

  release_line="$(head -n1 /etc/nv_tegra_release 2>/dev/null || true)"
  [[ -n "$release_line" ]] || return 0

  release="$(printf '%s\n' "$release_line" | sed -n 's/^# R\([0-9][0-9]*\) (release).*/\1/p')"
  revision="$(printf '%s\n' "$release_line" | sed -n 's/^.*REVISION: \([0-9][0-9]*\)\..*$/\1/p')"
  l4t_version="${release}.${revision}"

  case "$l4t_version" in
    36.*)
      printf "%s" "jp6"
      ;;
    38.*)
      printf "%s" "jp7"
      ;;
    *)
      info "Jetson detected (L4T $l4t_version) but version is not recognized — skipping host setup"
      ;;
  esac
}

configure_jetson_host() {
  local jetpack_version="$1"

  if ((EUID != 0)); then
    info "Jetson host configuration requires sudo. You may be prompted for your password."
    "${SUDO[@]}" true >/dev/null || error "Sudo is required to apply Jetson host configuration."
  fi

  case "$jetpack_version" in
    jp6)
      "${SUDO[@]}" update-alternatives --set iptables /usr/sbin/iptables-legacy
      # Patch /etc/docker/daemon.json using python3 to guarantee valid JSON.
      # The previous sed approach could leave trailing commas or strip required
      # ones depending on key order. See: #1875
      if ! "${SUDO[@]}" python3 --version >/dev/null 2>&1; then
        error "python3 is required to patch /etc/docker/daemon.json but was not found on PATH"
      fi
      "${SUDO[@]}" python3 - /etc/docker/daemon.json <<'PYEOF'
import json, os, re, sys, tempfile

path = sys.argv[1]

# --- Read & parse (with auto-repair for known corruption) ---
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except json.JSONDecodeError:
    # Attempt to repair the missing-comma pattern left by the old sed command:
    #   "default-runtime": "nvidia"
    #   "runtimes": { ... }        <-- missing comma before this line
    with open(path) as f:
        raw = f.read()
    repaired = re.sub(
        r'("default-runtime"\s*:\s*"nvidia")([\s\n]+")',
        r'\1,\2',
        raw,
    )
    try:
        cfg = json.loads(repaired)
    except json.JSONDecodeError as e:
        sys.exit(f"daemon.json is malformed and could not be repaired automatically: {e}")

if not isinstance(cfg, dict):
    sys.exit("daemon.json must contain a top-level JSON object")

# --- Remove unwanted keys ---
cfg.pop("iptables", None)
cfg.pop("bridge", None)

# --- Atomic write with permission preservation ---
dirname = os.path.dirname(os.path.abspath(path))
try:
    orig_mode = os.stat(path).st_mode & 0o777
except FileNotFoundError:
    orig_mode = 0o644

fd, tmp = tempfile.mkstemp(dir=dirname)
try:
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=4)
        f.write("\n")
    os.chmod(tmp, orig_mode)
    os.replace(tmp, path)
except Exception:
    os.unlink(tmp)
    raise
PYEOF
      ;;
    jp7)
      # JP7 (Thor) does not need iptables or Docker daemon.json changes.
      ;;
    *)
      error "Unsupported Jetson version: $jetpack_version"
      ;;
  esac

  "${SUDO[@]}" modprobe br_netfilter
  "${SUDO[@]}" sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null

  # Persist across reboots
  echo "br_netfilter" | "${SUDO[@]}" tee /etc/modules-load.d/nemoclaw.conf >/dev/null
  echo "net.bridge.bridge-nf-call-iptables=1" | "${SUDO[@]}" tee /etc/sysctl.d/99-nemoclaw.conf >/dev/null

  if [[ "$jetpack_version" == "jp6" ]]; then
    "${SUDO[@]}" systemctl restart docker
  fi
}

main() {
  local jetpack_version
  jetpack_version="$(get_jetpack_version)"
  [[ -n "$jetpack_version" ]] || exit 0

  info "Jetson detected ($jetpack_version) — applying required host configuration"
  configure_jetson_host "$jetpack_version"
}

main "$@"
