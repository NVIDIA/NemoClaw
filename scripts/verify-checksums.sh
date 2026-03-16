#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# scripts/verify-checksums.sh
#
# Pinned SHA3-256 digests for every external asset install.sh downloads.
# Compatible with bash 3.2+ (macOS system bash — no associative arrays used).
#
# USAGE (from install.sh)
#   source "$(dirname "$0")/scripts/verify-checksums.sh"
#   verify_file "nvm-install.sh" "/tmp/nvm-install-XXXX.sh"
#
# REGENERATE PINNED DIGESTS (run once after bumping any URL or version)
#   bash scripts/verify-checksums.sh --regenerate
#
# Requires: sha3sum  (brew install sha3sum)
# Fallback: shasum -a 256  (built into macOS — SHA-256, not SHA3-256;
#           only used when sha3sum is absent — checksums are algorithm-specific,
#           so always regenerate with the same tool present on this machine)

set -euo pipefail

# ---------------------------------------------------------------------------
# Asset registry
# One URL_ and one CHECKSUM_ variable per asset.
# Run --regenerate to fill in CHECKSUM_ values automatically.
# Both variables MUST be updated in the same PR when bumping a version.
# ---------------------------------------------------------------------------

# nvm — https://github.com/nvm-sh/nvm/releases/tag/v0.40.4
URL_nvm_install_sh="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh"
CHECKSUM_nvm_install_sh="be7c62f3acc1727fcaa999092e641d0e7d66719183f9ed6e18f1ee880e394084"

# Ollama — https://ollama.com/install.sh
URL_ollama_install_sh="https://ollama.com/install.sh"
CHECKSUM_ollama_install_sh="84a5dafe8b48dd4f48de5d53d972da95245dfdd7cd2e2b913d74c442f1a8ea02"

# Ordered list of all asset keys (used by --regenerate)
ASSET_KEYS=(nvm-install.sh ollama-install.sh)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# Convert an asset key (e.g. "nvm-install.sh") to its variable-name suffix
# (e.g. "nvm_install_sh") so we can look up URL_* and CHECKSUM_* variables.
_key_to_suffix() {
  local s="$1"
  s="${s//-/_}"   # hyphens → underscores
  s="${s//./_}"   # dots    → underscores
  echo "$s"
}

# Compute the digest of a file using the best available tool.
_digest() {
  local file="$1"
  if command -v sha3sum >/dev/null 2>&1; then
    sha3sum -a 256 "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    echo "[ERROR] No hash tool found. Install sha3sum: brew install sha3sum" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# verify_file KEY [FILE_PATH]
#   KEY       - asset name matching one of the CHECKSUM_* variables above
#   FILE_PATH - path to the downloaded file (defaults to KEY if omitted)
#
# Aborts and removes the file if the digest does not match the pinned value.
# ---------------------------------------------------------------------------
verify_file() {
  local key="$1"
  local file="${2:-$1}"
  local suffix
  suffix=$(_key_to_suffix "$key")

  local varname="CHECKSUM_${suffix}"
  local expected
  expected=$(eval echo \"\$\{${varname}:-\}\")

  if [ -z "$expected" ] || [ "$expected" = "PENDING" ]; then
    echo "[ERROR] No pinned checksum for '${key}'." >&2
    echo "        Run:  bash scripts/verify-checksums.sh --regenerate" >&2
    exit 1
  fi

  local actual
  actual=$(_digest "$file")

  if [ "$actual" != "$expected" ]; then
    echo "[ERROR] Integrity check FAILED for '${key}'" >&2
    echo "  expected : ${expected}" >&2
    echo "  actual   : ${actual}" >&2
    rm -f "$file"   # do not leave a potentially malicious file on disk
    exit 1
  fi

  echo "[OK] ${key} verified"
}

export -f verify_file

# ---------------------------------------------------------------------------
# --regenerate: download each asset, compute its digest, patch this file
# ---------------------------------------------------------------------------
_regenerate() {
  local script_path
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

  echo "Regenerating checksums in ${script_path} ..."
  echo ""

  local tool_label
  if command -v sha3sum >/dev/null 2>&1; then
    tool_label="sha3sum -a 256"
  elif command -v shasum >/dev/null 2>&1; then
    tool_label="shasum -a 256"
  elif command -v sha256sum >/dev/null 2>&1; then
    tool_label="sha256sum"
  else
    echo "[ERROR] No hash tool found. Install sha3sum: brew install sha3sum" >&2
    exit 1
  fi
  echo "  Using: ${tool_label}"
  echo ""

  local key
  for key in "${ASSET_KEYS[@]}"; do
    local suffix
    suffix=$(_key_to_suffix "$key")

    local url_var="URL_${suffix}"
    local url
    url=$(eval echo \"\$\{${url_var}:-\}\")

    if [ -z "$url" ]; then
      echo "[WARN] No URL registered for '${key}' — skipping" >&2
      continue
    fi

    local tmp
    tmp=$(mktemp /tmp/verify-regen-XXXXXX)

    printf "  %-26s  fetching ...\n" "$key"
    curl -fsSL "$url" -o "$tmp"

    local digest
    digest=$(_digest "$tmp")
    rm -f "$tmp"

    printf "  %-26s  %s\n\n" "" "$digest"

    # Patch CHECKSUM_<suffix>="..." in-place (portable: BSD sed on macOS, GNU on Linux)
    local pattern="^CHECKSUM_${suffix}=.*"
    local replacement="CHECKSUM_${suffix}=\"${digest}\""
    if sed --version 2>/dev/null | grep -q GNU; then
      sed -i "s|${pattern}|${replacement}|" "$script_path"
    else
      sed -i '' "s|${pattern}|${replacement}|" "$script_path"
    fi
  done

  echo "Done. Review the diff and commit:"
  echo "  git diff scripts/verify-checksums.sh"
  echo "  git add scripts/verify-checksums.sh && git commit -s -m 'chore: pin asset checksums'"
}

# ---------------------------------------------------------------------------
# Entry point when executed directly (not sourced)
# BASH_SOURCE is bash-only; guard so the script is safe to source from zsh.
# ---------------------------------------------------------------------------
if [ -n "${BASH_VERSION:-}" ] && [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    --regenerate) _regenerate ;;
    *)
      echo "Usage: bash scripts/verify-checksums.sh --regenerate" >&2
      echo "  Downloads each registered asset and updates CHECKSUM_* values in-place." >&2
      exit 1
      ;;
  esac
fi
