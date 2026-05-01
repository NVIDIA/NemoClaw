#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Thin bootstrap for the NemoClaw installer.
# Public curl|bash installs should select a ref once, clone that ref, then
# execute installer logic from that same clone. Historical tags that predate
# the extracted payload fall back to their own root install.sh.

set -euo pipefail

if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SCRIPT_DIR=""
fi
LOCAL_PAYLOAD="${SCRIPT_DIR:+${SCRIPT_DIR}/scripts/install.sh}"
BOOTSTRAP_TMPDIR=""
PAYLOAD_MARKER="NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1"

resolve_release_tag() {
  if [[ -n "${NEMOCLAW_INSTALL_REF:-}" ]]; then
    printf "%s" "${NEMOCLAW_INSTALL_REF}"
    return
  fi
  printf "%s" "${NEMOCLAW_INSTALL_TAG:-latest}"
}

verify_downloaded_script() {
  local file="$1" label="${2:-installer}" expected_hash="${3:-}"
  if [[ ! -s "$file" ]]; then
    printf "[ERROR] %s download is empty or missing\n" "$label" >&2
    exit 1
  fi
  if ! head -1 "$file" | grep -qE '^#!.*(sh|bash)'; then
    printf "[ERROR] %s does not start with a shell shebang\n" "$label" >&2
    exit 1
  fi
  if [[ -n "$expected_hash" ]]; then
    local actual_hash=""
    if command -v sha256sum >/dev/null 2>&1; then
      actual_hash="$(sha256sum "$file" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      actual_hash="$(shasum -a 256 "$file" | awk '{print $1}')"
    fi
    if [[ -z "$actual_hash" ]]; then
      printf "[ERROR] No SHA-256 tool available — cannot verify %s integrity\n" "$label" >&2
      exit 1
    fi
    if [[ "$actual_hash" != "$expected_hash" ]]; then
      rm -f "$file"
      printf "[ERROR] %s integrity check failed\n  Expected: %s\n  Actual:   %s\n" "$label" "$expected_hash" "$actual_hash" >&2
      exit 1
    fi
  fi
}

has_payload_marker() {
  local file="$1"
  [[ -f "$file" ]] && grep -q "$PAYLOAD_MARKER" "$file"
}

clone_nemoclaw_ref() {
  local ref="$1" dest="$2"

  git init --quiet "$dest"
  git -C "$dest" remote add origin https://github.com/NVIDIA/NemoClaw.git
  git -C "$dest" fetch --quiet --depth 1 origin "$ref"
  git -C "$dest" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
}

exec_installer_from_ref() {
  local ref="$1"
  shift

  local tmpdir source_root payload_script legacy_script
  tmpdir="$(mktemp -d)"
  BOOTSTRAP_TMPDIR="$tmpdir"
  trap 'rm -rf "${BOOTSTRAP_TMPDIR:-}"' EXIT
  source_root="${tmpdir}/source"

  clone_nemoclaw_ref "$ref" "$source_root"

  payload_script="${source_root}/scripts/install.sh"
  legacy_script="${source_root}/install.sh"

  if has_payload_marker "$payload_script"; then
    verify_downloaded_script "$payload_script" "versioned installer"
    NEMOCLAW_INSTALL_REF="$ref" NEMOCLAW_INSTALL_TAG="$ref" NEMOCLAW_BOOTSTRAP_PAYLOAD=1 \
      bash "$payload_script" "$@"
    return
  fi

  verify_downloaded_script "$legacy_script" "legacy installer"
  NEMOCLAW_INSTALL_TAG="$ref" bash "$legacy_script" "$@"
}

bootstrap_version() {
  printf "nemoclaw-installer\n"
}

bootstrap_usage() {
  printf "\n"
  printf "  NemoClaw Installer\n\n"
  printf "  Usage:\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- [options]\n\n"
  printf "  Options:\n"
  printf "    --non-interactive    Skip prompts (uses env vars / defaults)\n"
  printf "    --yes-i-accept-third-party-software Accept the third-party software notice in non-interactive mode\n"
  printf "    --fresh              Discard any failed/interrupted onboarding session and start over\n"
  printf "    --version, -v        Print installer version and exit\n"
  printf "    --help, -h           Show this help message and exit\n\n"
  printf "  Environment:\n"
  printf "    NEMOCLAW_INSTALL_REF         Exact Git ref/SHA to install\n"
  printf "    NEMOCLAW_INSTALL_TAG         Git ref to install (default: latest release)\n"
  printf "    NEMOCLAW_NON_INTERACTIVE=1   Same as --non-interactive\n"
  printf "    NEMOCLAW_FRESH=1             Same as --fresh\n"
  printf "    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 Same as --yes-i-accept-third-party-software\n"
  printf "    NEMOCLAW_SANDBOX_NAME        Sandbox name to create/use\n"
  printf "    NEMOCLAW_PROVIDER            build | openai | anthropic | anthropicCompatible\n"
  printf "                                 | gemini | ollama | custom | nim-local | vllm\n"
  printf "                                 (aliases: cloud -> build, nim -> nim-local)\n"
  printf "    NEMOCLAW_POLICY_MODE         suggested | custom | skip\n"
  printf "\n"
}

bootstrap_main() {
  for arg in "$@"; do
    case "$arg" in
      --help | -h)
        bootstrap_usage
        return 0
        ;;
      --version | -v)
        bootstrap_version
        return 0
        ;;
    esac
  done

  local ref
  ref="$(resolve_release_tag)"
  exec_installer_from_ref "$ref" "$@"
}

if has_payload_marker "$LOCAL_PAYLOAD"; then
  # shellcheck source=/dev/null
  . "$LOCAL_PAYLOAD"
fi

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]] || { [[ -z "${BASH_SOURCE[0]:-}" ]] && { [[ "$0" == "bash" ]] || [[ "$0" == "-bash" ]]; }; }; then
  if has_payload_marker "$LOCAL_PAYLOAD"; then
    main "$@"
  else
    bootstrap_main "$@"
  fi
fi
