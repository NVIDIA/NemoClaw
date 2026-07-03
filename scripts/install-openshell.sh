#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[install]${NC} $1"; }
warn() { echo -e "${YELLOW}[install]${NC} $1"; }
fail() {
  echo -e "${RED}[install]${NC} $1" >&2
  exit 1
}

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_LABEL="macOS" ;;
  Linux) OS_LABEL="Linux" ;;
  *) fail "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64 | amd64) ARCH_LABEL="x86_64" ;;
  aarch64 | arm64) ARCH_LABEL="aarch64" ;;
  *) fail "Unsupported architecture: $ARCH" ;;
esac

info "Detected $OS_LABEL ($ARCH_LABEL)"

# Minimum version required for native messaging credential rewrite and
# round-trippable base policies: WebSocket text frames, provider-shaped
# aliases, REST request bodies, and `policy get --base` for MCP/JSON-RPC-safe
# read-modify-write operations.
MIN_VERSION="0.0.72"
# Maximum version validated for this NemoClaw release. Newer OpenShell builds
# may change sandbox semantics; upgrade NemoClaw before upgrading past this.
MAX_VERSION="0.0.72"
# Pin fresh installs to this version. The TS installer normally overrides this
# via NEMOCLAW_OPENSHELL_PIN_VERSION after resolving the highest published
# OpenShell release that satisfies the blueprint's max_openshell_version
# (see #3404). The hardcoded value is the fallback for offline runs.
PIN_VERSION="$MAX_VERSION"
DEV_MIN_VERSION="0.0.72"

CHANNEL="${NEMOCLAW_OPENSHELL_CHANNEL:-auto}"
case "$CHANNEL" in
  stable | dev | auto) ;;
  *) fail "NEMOCLAW_OPENSHELL_CHANNEL must be one of: stable, dev, auto" ;;
esac

if [ "$CHANNEL" = "auto" ]; then
  RESOLVED_CHANNEL="stable"
else
  RESOLVED_CHANNEL="$CHANNEL"
fi

if [ "$RESOLVED_CHANNEL" = "dev" ]; then
  if [ "${NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL:-}" != "1" ]; then
    fail "Dev channel install skips SHA-256 verification. Set NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL=1 to explicitly accept an unverified OpenShell dev-channel install."
  fi
  warn "Dev channel install skips SHA-256 verification. Use only in trusted environments."
fi

# Honour the TS installer's blueprint-derived env overrides only on the stable
# channel — the dev channel installs from the `dev` tag and uses DEV_MIN_VERSION
# instead, so a malformed override should not abort a dev install (#3446 review).
# The TS layer passes MIN/MAX/PIN from the blueprint so a single source of truth
# (nemoclaw-blueprint/blueprint.yaml) drives the install (#3404).
#
# Validation is inlined (rather than wrapped in a helper that returns via
# $(...)) so a `fail` triggered here is not captured into the variable
# assignment. `fail` now writes to stderr (#3446 CodeRabbit), but keeping
# the validation outside of $(...) avoids relying on that.
if [ "$RESOLVED_CHANNEL" != "dev" ]; then
  if [ -n "${NEMOCLAW_OPENSHELL_MIN_VERSION:-}" ]; then
    if [[ "$NEMOCLAW_OPENSHELL_MIN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      MIN_VERSION="$NEMOCLAW_OPENSHELL_MIN_VERSION"
    else
      fail "NEMOCLAW_OPENSHELL_MIN_VERSION='$NEMOCLAW_OPENSHELL_MIN_VERSION' is not a valid X.Y.Z version."
    fi
  fi
  if [ -n "${NEMOCLAW_OPENSHELL_MAX_VERSION:-}" ]; then
    if [[ "$NEMOCLAW_OPENSHELL_MAX_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      MAX_VERSION="$NEMOCLAW_OPENSHELL_MAX_VERSION"
      # Intentionally do NOT default PIN_VERSION to the overridden MAX here.
      # If the TS resolver couldn't reach GitHub (rate-limited / offline) it
      # only sets MIN/MAX, never PIN — falling through to the script's
      # hardcoded PIN_VERSION is the known-good safe path (#3446 CodeRabbit).
    else
      fail "NEMOCLAW_OPENSHELL_MAX_VERSION='$NEMOCLAW_OPENSHELL_MAX_VERSION' is not a valid X.Y.Z version."
    fi
  fi
  if [ -n "${NEMOCLAW_OPENSHELL_PIN_VERSION:-}" ]; then
    if [[ "$NEMOCLAW_OPENSHELL_PIN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      PIN_VERSION="$NEMOCLAW_OPENSHELL_PIN_VERSION"
    else
      fail "NEMOCLAW_OPENSHELL_PIN_VERSION='$NEMOCLAW_OPENSHELL_PIN_VERSION' is not a valid X.Y.Z version."
    fi
  fi
fi

if [ "$RESOLVED_CHANNEL" = "dev" ]; then
  RELEASE_TAG="dev"
else
  RELEASE_TAG="v${PIN_VERSION}"
fi

# invalidState: a consumed OpenShell release asset differs from the digest
# published for the immutable v0.0.72 release, or a mutable registry tag moves.
# sourceBoundary: NVIDIA/OpenShell owns the release workflow, GitHub release
# assets, and GHCR manifests; NemoClaw owns which exact artifacts it trusts.
# whyNotSourceFix: NemoClaw cannot retroactively make an upstream publication
# immutable, so it independently pins every consumed archive and supervisor.
# regressionTest: test/install-openshell-version-check.test.ts exercises all
# eight mappings, and scripts/check-installer-hash.sh compares them with the
# GitHub release API on every PR, main push, weekly run, and manual dispatch.
# removalCondition: remove these v0.0.72 entries only when NemoClaw drops that
# supported release or replaces them with independently verified newer pins.
openshell_pinned_sha256() {
  local release_tag="$1" asset="$2"
  case "${release_tag}:${asset}" in
    v0.0.72:openshell-x86_64-unknown-linux-musl.tar.gz)
      printf '%s\n' "37836c3b50383e03249c5e16512c1806e591fba8451408a84fb2f628ddb318c4"
      ;;
    v0.0.72:openshell-aarch64-unknown-linux-musl.tar.gz)
      printf '%s\n' "a5ff01a3240d73c72ec1700eda6cc6c752a86cf50c5dd1b5bdc459f544d03045"
      ;;
    v0.0.72:openshell-aarch64-apple-darwin.tar.gz)
      printf '%s\n' "117b5354cc42d80bc4d5e070ea5ac4e341208ff6d3c29b516d8a9c80e2310f8d"
      ;;
    v0.0.72:openshell-gateway-x86_64-unknown-linux-gnu.tar.gz)
      printf '%s\n' "03225fb9388b682af1a5f1614b26b75f828da6031e3ffc1fd920b6fbe5f70877"
      ;;
    v0.0.72:openshell-gateway-aarch64-unknown-linux-gnu.tar.gz)
      printf '%s\n' "a97dcb3acb04fb2d1170c1a2170228990c2337e25bb8c18817e5a6e952204108"
      ;;
    v0.0.72:openshell-gateway-aarch64-apple-darwin.tar.gz)
      printf '%s\n' "8c07362107393eb5f4ae4b9ee9f4257fd53862c51ad8dd96f2fe31bb6d8d7ffb"
      ;;
    v0.0.72:openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz)
      printf '%s\n' "811f914b6a6a3a3f4533449ddebebb6422333861a27a5fa848db6cbfdffdd230"
      ;;
    v0.0.72:openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz)
      printf '%s\n' "2cf62cbd651e55d0f8750804e2b4025e0d6c8eea4564c87cda47a2c922941db0"
      ;;
    *)
      return 1
      ;;
  esac
}

openshell_checksum_line() {
  local checksum_file="$1" asset="$2"
  awk -v asset="$asset" '$2 == asset { print; found=1; exit } END { if (!found) exit 1 }' "$checksum_file"
}

version_gte() {
  # Returns 0 (true) if $1 >= $2 — portable, no sort -V (BSD compat)
  local IFS=.
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    local ai=${a[$i]:-0} bi=${b[$i]:-0}
    if ((ai > bi)); then return 0; fi
    if ((ai < bi)); then return 1; fi
  done
  return 0
}

required_driver_bins_present() {
  case "$OS" in
    Linux)
      command -v openshell-gateway >/dev/null 2>&1 && command -v openshell-sandbox >/dev/null 2>&1
      ;;
    Darwin)
      command -v openshell-gateway >/dev/null 2>&1
      ;;
    *)
      return 0
      ;;
  esac
}

OPENSHELL_FEATURE_CHECK_ERROR=""

openshell_has_required_messaging_features() {
  local openshell_bin
  OPENSHELL_FEATURE_CHECK_ERROR=""
  openshell_bin="${1:-$(command -v openshell 2>/dev/null || true)}"
  if [ -z "$openshell_bin" ]; then
    OPENSHELL_FEATURE_CHECK_ERROR="openshell binary was not found."
    return 1
  fi
  if ! command -v strings >/dev/null 2>&1; then
    OPENSHELL_FEATURE_CHECK_ERROR="'strings' is required to verify OpenShell messaging credential rewrite support. Install binutils or an equivalent package and retry."
    return 2
  fi

  # Keep this independent of a live gateway. `policy update --dry-run` still
  # needs gateway metadata, but the CLI binary must contain the endpoint-option
  # parser for request-body/WebSocket rewrite support released in OpenShell 0.0.39.
  local binary_strings
  binary_strings="$(strings "$openshell_bin" 2>/dev/null || true)"
  if [[ "$binary_strings" != *"request-body-credential-rewrite"* ]]; then
    OPENSHELL_FEATURE_CHECK_ERROR="OpenShell binary is missing request-body-credential-rewrite support."
    return 1
  fi
  if [[ "$binary_strings" != *"websocket-credential-rewrite"* ]]; then
    OPENSHELL_FEATURE_CHECK_ERROR="OpenShell binary is missing websocket-credential-rewrite support."
    return 1
  fi
  return 0
}

require_openshell_messaging_features() {
  local openshell_bin="$1"
  openshell_has_required_messaging_features "$openshell_bin" \
    || fail "${OPENSHELL_FEATURE_CHECK_ERROR:-OpenShell binary is missing required messaging credential rewrite support.}"
}

macos_vm_driver_bin() {
  command -v openshell-driver-vm 2>/dev/null || true
}

macos_vm_driver_has_hypervisor_entitlement() {
  local bin="$1"
  [ "$OS" = "Darwin" ] || return 0
  [ -n "$bin" ] && [ -x "$bin" ] || return 1
  command -v codesign >/dev/null 2>&1 || return 1
  codesign -d --entitlements :- "$bin" 2>/dev/null \
    | grep -q "com.apple.security.hypervisor"
}

sign_macos_vm_driver() {
  local bin="$1"
  local use_sudo="${2:-0}"
  local entitlements

  [ "$OS" = "Darwin" ] || return 0
  [ -n "$bin" ] && [ -x "$bin" ] || return 0

  if macos_vm_driver_has_hypervisor_entitlement "$bin"; then
    return 0
  fi
  command -v codesign >/dev/null 2>&1 \
    || fail "codesign is required to prepare openshell-driver-vm for macOS Hypervisor.framework."

  entitlements="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-openshell-driver-vm-entitlements.XXXXXX.plist")"
  cat >"$entitlements" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.hypervisor</key>
  <true/>
</dict>
</plist>
EOF

  info "Signing openshell-driver-vm with the macOS Hypervisor entitlement..."
  if [ "$use_sudo" = "1" ]; then
    sudo codesign --force --sign - --entitlements "$entitlements" "$bin" \
      || {
        rm -f "$entitlements"
        fail "Failed to sign openshell-driver-vm with the macOS Hypervisor entitlement."
      }
  else
    codesign --force --sign - --entitlements "$entitlements" "$bin" \
      || {
        rm -f "$entitlements"
        fail "Failed to sign openshell-driver-vm with the macOS Hypervisor entitlement."
      }
  fi
  rm -f "$entitlements"

  macos_vm_driver_has_hypervisor_entitlement "$bin" \
    || fail "openshell-driver-vm was signed but the macOS Hypervisor entitlement was not present afterward."
}

repair_existing_macos_vm_driver() {
  local bin
  [ "$OS" = "Darwin" ] || return 0
  bin="$(macos_vm_driver_bin)"
  [ -n "$bin" ] && [ -x "$bin" ] || return 1
  if macos_vm_driver_has_hypervisor_entitlement "$bin"; then
    return 0
  fi

  warn "openshell-driver-vm is missing the macOS Hypervisor entitlement — repairing..."
  if [ -w "$bin" ]; then
    sign_macos_vm_driver "$bin" 0
    return 0
  fi
  if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ] && [ -t 0 ] && command -v sudo >/dev/null 2>&1; then
    sign_macos_vm_driver "$bin" 1
    return 0
  fi
  return 1
}

ACTIVE_OPENSHELL_BIN=""
if command -v openshell >/dev/null 2>&1; then
  ACTIVE_OPENSHELL_BIN="$(command -v openshell 2>/dev/null || true)"
  INSTALLED_VERSION_OUTPUT="$(openshell --version 2>&1 || true)"
  INSTALLED_VERSION="$(printf '%s\n' "$INSTALLED_VERSION_OUTPUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  [ -n "$INSTALLED_VERSION" ] || INSTALLED_VERSION="0.0.0"
  if [ "$RESOLVED_CHANNEL" = "dev" ]; then
    if version_gte "$INSTALLED_VERSION" "$DEV_MIN_VERSION" \
      && printf '%s\n' "$INSTALLED_VERSION_OUTPUT" | grep -qi 'dev'; then
      if openshell_has_required_messaging_features; then
        info "openshell already installed: $INSTALLED_VERSION_OUTPUT (dev channel)"
        exit 0
      else
        feature_status=$?
        if [ "$feature_status" = "2" ]; then
          fail "$OPENSHELL_FEATURE_CHECK_ERROR"
        fi
      fi
    fi
    warn "openshell $INSTALLED_VERSION is not the required dev-channel messaging-rewrite build — upgrading..."
  else
    if version_gte "$INSTALLED_VERSION" "$MIN_VERSION"; then
      if ! version_gte "$MAX_VERSION" "$INSTALLED_VERSION"; then
        warn "openshell $INSTALLED_VERSION is above the maximum ($MAX_VERSION) supported by this NemoClaw release — reinstalling pinned OpenShell ${PIN_VERSION}..."
      elif ! required_driver_bins_present; then
        warn "openshell $INSTALLED_VERSION is missing Docker-driver binaries — reinstalling pinned OpenShell ${PIN_VERSION}..."
      elif ! openshell_has_required_messaging_features; then
        fail "${OPENSHELL_FEATURE_CHECK_ERROR:-openshell $INSTALLED_VERSION is missing required messaging credential rewrite support. Install an OpenShell build that includes provider aliases, WebSocket text rewrite, and request-body credential rewrite.}"
      else
        info "openshell already installed: $INSTALLED_VERSION (>= $MIN_VERSION, <= $MAX_VERSION, messaging rewrite and policy --base capable)"
        exit 0
      fi
    else
      warn "openshell $INSTALLED_VERSION is below minimum $MIN_VERSION — upgrading..."
    fi
  fi
fi

info "Installing OpenShell from release '$RELEASE_TAG'..."

case "$OS" in
  Darwin)
    case "$ARCH_LABEL" in
      x86_64) ASSET="openshell-x86_64-apple-darwin.tar.gz" ;;
      aarch64) ASSET="openshell-aarch64-apple-darwin.tar.gz" ;;
    esac
    ;;
  Linux)
    case "$ARCH_LABEL" in
      x86_64) ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
      aarch64) ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
    esac
    ;;
esac

declare -a ASSETS=("$ASSET")
declare -a CHECKSUM_FILES=("openshell-checksums-sha256.txt")
case "$OS" in
  Darwin)
    case "$ARCH_LABEL" in
      aarch64)
        ASSETS+=("openshell-gateway-aarch64-apple-darwin.tar.gz")
        CHECKSUM_FILES+=("openshell-gateway-checksums-sha256.txt")
        ;;
      x86_64)
        fail "OpenShell ${PIN_VERSION} does not publish macOS x86_64 standalone gateway assets."
        ;;
    esac
    ;;
  Linux)
    case "$ARCH_LABEL" in
      x86_64)
        ASSETS+=("openshell-gateway-x86_64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz")
        ;;
      aarch64)
        ASSETS+=("openshell-gateway-aarch64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz")
        ;;
    esac
    CHECKSUM_FILES+=("openshell-gateway-checksums-sha256.txt")
    CHECKSUM_FILES+=("openshell-sandbox-checksums-sha256.txt")
    ;;
esac

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

download_with_curl() {
  local name
  local -a curl_progress
  # Show a live progress bar on a terminal so the (often slow) release download
  # is not a silent gap; stay quiet (errors only) when non-interactive. (#4431)
  if [ -t 1 ] || [ -t 2 ]; then
    curl_progress=(--progress-bar)
  else
    curl_progress=(-sS)
  fi
  for name in "${ASSETS[@]}" "${CHECKSUM_FILES[@]}"; do
    curl -fL "${curl_progress[@]}" "https://github.com/NVIDIA/OpenShell/releases/download/${RELEASE_TAG}/$name" \
      -o "$tmpdir/$name"
  done
}

info "Downloading OpenShell release assets (this may take a minute)..."
if command -v gh >/dev/null 2>&1; then
  gh_ok=1
  for name in "${ASSETS[@]}" "${CHECKSUM_FILES[@]}"; do
    if ! GH_PROMPT_DISABLED=1 GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" gh release download "$RELEASE_TAG" --repo NVIDIA/OpenShell \
      --pattern "$name" --dir "$tmpdir" --clobber 2>/dev/null; then
      gh_ok=0
      break
    fi
  done
  if [ "$gh_ok" = "1" ]; then
    : # gh succeeded
  else
    warn "gh CLI download failed (auth may not be configured) — falling back to curl"
    rm -f "$tmpdir"/*
    download_with_curl
  fi
else
  download_with_curl
fi

info "Verifying SHA-256 checksum..."
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  fail "No SHA-256 tool available (sha256sum/shasum)"
fi
for i in "${!ASSETS[@]}"; do
  asset_name="${ASSETS[$i]}"
  checksum_file="${CHECKSUM_FILES[$i]}"
  checksum_line="$(openshell_checksum_line "$tmpdir/$checksum_file" "$asset_name")" \
    || fail "OpenShell checksum file $checksum_file does not list $asset_name"
  if [ "$RELEASE_TAG" != "dev" ]; then
    expected_sha="$(openshell_pinned_sha256 "$RELEASE_TAG" "$asset_name")" \
      || fail "No NemoClaw-pinned SHA-256 for OpenShell $RELEASE_TAG asset $asset_name"
    release_sha="$(printf '%s\n' "$checksum_line" | awk '{print $1}')"
    [ "$release_sha" = "$expected_sha" ] \
      || fail "OpenShell release checksum for $asset_name does not match NemoClaw-pinned $RELEASE_TAG digest"
  fi
  (cd "$tmpdir" && printf '%s\n' "$checksum_line" | $SHA_CMD -c -) \
    || fail "SHA-256 checksum verification failed for $asset_name"
done

for asset_name in "${ASSETS[@]}"; do
  tar xzf "$tmpdir/$asset_name" -C "$tmpdir"
done

target_dir="/usr/local/bin"
if [[ -n "$ACTIVE_OPENSHELL_BIN" && "$ACTIVE_OPENSHELL_BIN" = /* ]]; then
  active_dir="$(dirname "$ACTIVE_OPENSHELL_BIN")"
  if [ -d "$active_dir" ] && [ -w "$active_dir" ]; then
    target_dir="$active_dir"
  fi
fi

install_bins() {
  local dir="$1"
  install -m 755 "$tmpdir/openshell" "$dir/openshell"
  if [ -x "$tmpdir/openshell-gateway" ]; then
    install -m 755 "$tmpdir/openshell-gateway" "$dir/openshell-gateway"
  fi
  if [ -x "$tmpdir/openshell-sandbox" ]; then
    install -m 755 "$tmpdir/openshell-sandbox" "$dir/openshell-sandbox"
  fi
  if [ -x "$tmpdir/openshell-driver-vm" ]; then
    install -m 755 "$tmpdir/openshell-driver-vm" "$dir/openshell-driver-vm"
    sign_macos_vm_driver "$dir/openshell-driver-vm" 0
  fi
}

if [ -w "$target_dir" ]; then
  install_bins "$target_dir"
elif [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || [ ! -t 0 ]; then
  target_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  mkdir -p "$target_dir"
  install_bins "$target_dir"
  warn "Installed openshell to $target_dir/openshell (user-local path)"
  warn "For future shells, run: export PATH=\"$target_dir:\$PATH\""
  warn "Add that export to your shell profile, or open a new shell before using openshell directly."
else
  sudo install -m 755 "$tmpdir/openshell" "$target_dir/openshell"
  if [ -x "$tmpdir/openshell-gateway" ]; then
    sudo install -m 755 "$tmpdir/openshell-gateway" "$target_dir/openshell-gateway"
  fi
  if [ -x "$tmpdir/openshell-sandbox" ]; then
    sudo install -m 755 "$tmpdir/openshell-sandbox" "$target_dir/openshell-sandbox"
  fi
  if [ -x "$tmpdir/openshell-driver-vm" ]; then
    sudo install -m 755 "$tmpdir/openshell-driver-vm" "$target_dir/openshell-driver-vm"
    sign_macos_vm_driver "$target_dir/openshell-driver-vm" 1
  fi
fi

require_openshell_messaging_features "$target_dir/openshell"

info "$("$target_dir/openshell" --version 2>&1 || echo openshell) installed"
