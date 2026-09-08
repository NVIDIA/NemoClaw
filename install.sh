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
DEFAULT_INSTALL_REF="lkg"
INSTALL_TAG_EXAMPLE="vX.Y.Z"
BOOTSTRAP_LOOKUP_TIMEOUT_SECONDS=30

resolve_release_tag() {
  if [[ -n "${NEMOCLAW_INSTALL_REF:-}" ]]; then
    printf "%s" "${NEMOCLAW_INSTALL_REF}"
    return
  fi
  printf "%s" "${NEMOCLAW_INSTALL_TAG:-$DEFAULT_INSTALL_REF}"
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

  (
    # Git applies the process umask when it creates the authoritative source checkout.
    umask 022
    git init --quiet "$dest"
    git -C "$dest" remote add origin https://github.com/NVIDIA/NemoClaw.git
    if ! git -C "$dest" fetch --quiet --depth 1 origin "+${ref}:refs/nemoclaw-install/target"; then
      printf "[ERROR] Requested install ref '%s' is not available from https://github.com/NVIDIA/NemoClaw.git.\n" "$ref" >&2
      printf "        Check NEMOCLAW_INSTALL_TAG/NEMOCLAW_INSTALL_REF and try again.\n" >&2
      exit 1
    fi
    git -C "$dest" -c advice.detachedHead=false checkout --quiet --detach refs/nemoclaw-install/target
  )
}

installed_nemoclaw_release_version() {
  local cli_path output status
  cli_path="$(command -v nemoclaw 2>/dev/null || true)"
  [[ -n "$cli_path" ]] || return 3
  output="$(run_bounded_bootstrap_lookup "installed NemoClaw version lookup" "$cli_path" --version)" || {
    status=$?
    ((status == 124)) && return 124
    ((status >= 128)) && return "$status"
    return 2
  }
  if [[ "$output" =~ ^nemoclaw[[:space:]]+v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 2
}

checkout_release_version() {
  local source_root="$1" target_commit refs status ref version
  target_commit="$(git -C "$source_root" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$target_commit" ]] || return 0
  refs="$(run_bounded_bootstrap_lookup "maintained release tag lookup" git -C "$source_root" ls-remote --tags origin 'refs/tags/v*')" || {
    status=$?
    ((status == 124)) && exit 1
    ((status >= 128)) && exit "$status"
    return 0
  }
  while read -r commit ref; do
    [[ "$commit" == "$target_commit" ]] || continue
    ref="${ref%\^\{\}}"
    version="${ref#refs/tags/v}"
    if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf '%s' "$version"
      return 0
    fi
  done <<<"$refs"
}

release_version_is_newer() {
  local left="$1" right="$2" left_major left_minor left_patch right_major right_minor right_patch
  left="${left%%+*}"
  left="${left%%-*}"
  IFS=. read -r left_major left_minor left_patch <<<"$left"
  IFS=. read -r right_major right_minor right_patch <<<"$right"
  ((10#$left_major > 10#$right_major)) && return 0
  ((10#$left_major < 10#$right_major)) && return 1
  ((10#$left_minor > 10#$right_minor)) && return 0
  ((10#$left_minor < 10#$right_minor)) && return 1
  ((10#$left_patch > 10#$right_patch))
}

run_bounded_bootstrap_lookup() {
  local label="$1" output_file command_pid status ticks=0
  shift
  output_file="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-bootstrap-lookup.XXXXXX")"
  set -m
  "$@" >"$output_file" 2>/dev/null &
  command_pid=$!
  set +m
  trap 'trap - INT TERM EXIT; terminate_bootstrap_lookup_group "$command_pid"; rm -f "$output_file"; exit 130' INT
  trap 'trap - INT TERM EXIT; terminate_bootstrap_lookup_group "$command_pid"; rm -f "$output_file"; exit 143' TERM
  trap 'status=$?; trap - INT TERM EXIT; terminate_bootstrap_lookup_group "$command_pid"; rm -f "$output_file"; exit "$status"' EXIT
  while kill -0 "$command_pid" 2>/dev/null; do
    if ((ticks >= BOOTSTRAP_LOOKUP_TIMEOUT_SECONDS * 10)); then
      trap - INT TERM EXIT
      terminate_bootstrap_lookup_group "$command_pid"
      rm -f "$output_file"
      printf '[ERROR] Timed out during %s after %s seconds.\n' "$label" "$BOOTSTRAP_LOOKUP_TIMEOUT_SECONDS" >&2
      printf '        The installed CLI was not changed. Retry or select an explicit immutable release tag.\n' >&2
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  if wait "$command_pid"; then
    status=0
  else
    status=$?
  fi
  if ((status == 0)); then
    cat "$output_file"
  fi
  trap - INT TERM EXIT
  rm -f "$output_file"
  return "$status"
}

terminate_bootstrap_lookup_group() {
  local command_pid="$1" grace_ticks
  kill -0 "$command_pid" 2>/dev/null || {
    wait "$command_pid" 2>/dev/null || true
    return
  }
  kill -TERM -- "-$command_pid" 2>/dev/null || kill -TERM "$command_pid" 2>/dev/null || true
  for ((grace_ticks = 0; grace_ticks < 10; grace_ticks++)); do
    kill -0 "$command_pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$command_pid" 2>/dev/null; then
    kill -KILL -- "-$command_pid" 2>/dev/null || kill -KILL "$command_pid" 2>/dev/null || true
  fi
  wait "$command_pid" 2>/dev/null || true
}

guard_implicit_maintained_downgrade() {
  local source_root="$1" selected_ref="$2" installed_version target_version status
  case "$selected_ref" in
    lkg | refs/tags/lkg) ;;
    *) return 0 ;;
  esac
  installed_version="$(installed_nemoclaw_release_version)" || {
    status=$?
    ((status == 3)) && return 0
    ((status == 124)) && exit 1
    ((status >= 128)) && exit "$status"
    printf '[ERROR] Cannot verify the installed NemoClaw version before selecting maintained lkg.\n' >&2
    printf '        The installed CLI was not changed. Repair it or select an explicit immutable release tag.\n' >&2
    exit 1
  }
  target_version="$(checkout_release_version "$source_root")"
  if [[ -z "$target_version" ]]; then
    printf "[ERROR] Cannot verify the maintained lkg version before replacing installed NemoClaw v%s.\n" "$installed_version" >&2
    printf "        The installed CLI was not changed. Set NEMOCLAW_INSTALL_TAG=v%s to reinstall this release.\n" "$installed_version" >&2
    exit 1
  fi
  if release_version_is_newer "$installed_version" "$target_version"; then
    printf "[ERROR] Refusing to replace installed NemoClaw v%s with maintained lkg v%s.\n" "$installed_version" "$target_version" >&2
    printf "        The installed CLI was not changed. Set NEMOCLAW_INSTALL_TAG=v%s to reinstall this release.\n" "$installed_version" >&2
    exit 1
  fi
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

  guard_implicit_maintained_downgrade "$source_root" "$ref"

  payload_script="${source_root}/scripts/install.sh"
  legacy_script="${source_root}/install.sh"

  if has_payload_marker "$payload_script"; then
    # The public curl|bash boundary deliberately executes from the complete
    # selected-ref checkout, not from a standalone payload file. Installer
    # helpers beside scripts/install.sh (including DGX Station preparation)
    # are therefore staged from the same ref before payload execution.
    verify_downloaded_script "$payload_script" "versioned installer"
    NEMOCLAW_INSTALL_REF="$ref" NEMOCLAW_INSTALL_TAG="$ref" NEMOCLAW_BOOTSTRAP_PAYLOAD=1 \
      bash "$payload_script" "$@"
    return
  fi

  verify_downloaded_script "$legacy_script" "legacy installer"
  NEMOCLAW_INSTALL_TAG="$ref" bash "$legacy_script" "$@"
}

require_supported_platform() {
  # macOS ships only an Apple Silicon (aarch64) OpenShell gateway build, so an
  # Intel Mac (x86_64 Darwin) install always fails once that binary is fetched.
  # Reject it here, before any ref resolution or clone, so the user gets an
  # actionable message instead of a mid-install failure and needless downloads.
  if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "x86_64" ]]; then
    printf "[ERROR] Apple Silicon (aarch64) is required on macOS. Intel Mac (x86_64) is not supported.\n" >&2
    exit 1
  fi
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
  printf "    --station-deepseek   Use DeepSeek V4 Flash for DGX Station express install\n"
  printf "    --yes-i-accept-third-party-software Accept the third-party software notice without prompting\n"
  printf "    --defer-onboarding   Install Hermes without onboarding when NVIDIA inference credentials are absent\n"
  printf "                          Use only with NEMOCLAW_AGENT=hermes, no registered sandboxes, no local model profile,\n"
  printf "                          and the build, cloud, or routed NVIDIA hosted provider\n"
  printf "    --fresh              Discard any failed/interrupted onboarding session and start over\n"
  printf "    --version, -v        Print installer version and exit\n"
  printf "    --help, -h           Show this help message and exit\n\n"
  printf "  Environment:\n"
  printf "    NEMOCLAW_INSTALL_REF         Exact Git ref/SHA to install\n"
  printf "    NEMOCLAW_INSTALL_TAG         Git ref to install (default: %s)\n" "$DEFAULT_INSTALL_REF"
  printf "                                 In curl pipes, set this on bash or export it first.\n"
  printf "                                 Example: curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=%s bash\n" "$INSTALL_TAG_EXAMPLE"
  printf "    NEMOCLAW_NON_INTERACTIVE=1   Same as --non-interactive\n"
  printf "    NEMOCLAW_DEFER_ONBOARDING=1  Same as --defer-onboarding\n"
  printf "                                 Use only with NEMOCLAW_AGENT=hermes, no registered sandboxes, no local model profile,\n"
  printf "                                 and the build, cloud, or routed NVIDIA hosted provider\n"
  printf "    NEMOCLAW_FRESH=1             Same as --fresh\n"
  printf "    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 Same as --yes-i-accept-third-party-software\n"
  printf "    NEMOCLAW_NO_EXPRESS=1        Skip express install prompt on supported platforms\n"
  printf "    NEMOCLAW_SANDBOX_NAME        Sandbox name to create/use\n"
  printf "    HF_TOKEN                     Optional Hugging Face read token for managed-vLLM downloads\n"
  printf "                                 Create one at https://huggingface.co/settings/tokens and export it before curl | bash.\n"
  printf "    HUGGING_FACE_HUB_TOKEN       Compatibility alias for HF_TOKEN\n"
  printf "    NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE=1\n"
  printf "                                 Allow automatic pre-0.0.37 OpenShell gateway upgrade\n"
  printf "    NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1\n"
  printf "                                 Continue after manually backing up and retiring old gateway\n"
  printf "    NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE\n"
  printf "                                 Exact JSON array of pre-fingerprint managed sandbox names\n"
  printf "    NEMOCLAW_PROVIDER            build | openrouter | openai | anthropic | anthropicCompatible\n"
  printf "                                 | gemini | ollama | custom | nim-local | vllm | routed\n"
  printf "                                 | hermes-provider | llama-cpp | install-llama-cpp\n"
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

  require_supported_platform

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
