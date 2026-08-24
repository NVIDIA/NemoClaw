#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Exit codes consumed by the TypeScript lifecycle adapter. Keep these stable:
# they are the machine-readable contract between formula presence, repair, and
# the temporary Homebrew trust boundary. Raw Homebrew diagnostics never
# authorize standalone startup while a formula or installed keg can retain
# gateway lifecycle authority.
readonly OPENSHELL_HOMEBREW_FORMULA_ABSENT=65
readonly OPENSHELL_HOMEBREW_FORMULA_REPAIR=66
readonly OPENSHELL_HOMEBREW_TRUST_FAILED=67
readonly OPENSHELL_HOMEBREW_UNTRUST_FAILED=68
readonly OPENSHELL_HOMEBREW_OPERATION_FAILED=69

run_trusted_openshell_homebrew_operation() {
  local expected_sha256="$1"
  shift
  [ "${1:-}" = "--" ] || return 64
  shift
  [ "${1:-}" = "brew" ] || return 64
  [ "$#" -gt 1 ] || return 64

  (
    local actual_sha256 cellar formula_file formula_ref status tap_repo trust_active
    formula_ref="nvidia/openshell/openshell"
    trust_active=0

    tap_repo="$(brew --repository nvidia/openshell 2>/dev/null || true)"
    formula_file="${tap_repo}/Formula/openshell.rb"
    if [ -z "$tap_repo" ] || [ ! -f "$formula_file" ]; then
      cellar="$(brew --cellar 2>/dev/null || true)"
      if [ -n "$cellar" ] && [ -d "${cellar}/openshell" ]; then
        exit "$OPENSHELL_HOMEBREW_FORMULA_REPAIR"
      fi
      exit "$OPENSHELL_HOMEBREW_FORMULA_ABSENT"
    fi
    [ ! -L "$formula_file" ] || exit "$OPENSHELL_HOMEBREW_FORMULA_REPAIR"

    if [ "$expected_sha256" != "unverified-dev" ]; then
      [[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]] \
        || exit "$OPENSHELL_HOMEBREW_FORMULA_REPAIR"
      if command -v sha256sum >/dev/null 2>&1; then
        actual_sha256="$(sha256sum "$formula_file" | awk '{print $1}')"
      elif command -v shasum >/dev/null 2>&1; then
        actual_sha256="$(shasum -a 256 "$formula_file" | awk '{print $1}')"
      else
        exit "$OPENSHELL_HOMEBREW_FORMULA_REPAIR"
      fi
      [ "$actual_sha256" = "$expected_sha256" ] \
        || exit "$OPENSHELL_HOMEBREW_FORMULA_REPAIR"
    fi

    # shellcheck disable=SC2317,SC2329 # Invoked indirectly by the EXIT trap below.
    cleanup_openshell_homebrew_formula_trust() {
      status=$?
      trap - EXIT
      if [ "$trust_active" = "1" ] && ! brew untrust --formula "$formula_ref" >/dev/null 2>&1; then
        exit "$OPENSHELL_HOMEBREW_UNTRUST_FAILED"
      fi
      exit "$status"
    }
    trap cleanup_openshell_homebrew_formula_trust EXIT
    trap 'exit 70' HUP INT TERM

    brew help trust >/dev/null 2>&1 \
      || exit "$OPENSHELL_HOMEBREW_TRUST_FAILED"
    brew help untrust >/dev/null 2>&1 \
      || exit "$OPENSHELL_HOMEBREW_TRUST_FAILED"
    brew untrust --formula "$formula_ref" >/dev/null 2>&1 \
      || exit "$OPENSHELL_HOMEBREW_TRUST_FAILED"
    trust_active=1
    if [ "$expected_sha256" != "unverified-dev" ]; then
      brew trust --formula "$formula_ref" >/dev/null 2>&1 \
        || exit "$OPENSHELL_HOMEBREW_TRUST_FAILED"
    fi

    "$@" || exit "$OPENSHELL_HOMEBREW_OPERATION_FAILED"
  )
}

if [ "${1:-}" = "--homebrew-formula-operation" ]; then
  shift
  [ "$#" -ge 4 ] || exit 64
  run_trusted_openshell_homebrew_operation "$@"
  exit $?
fi

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
# aliases, REST request bodies, MCP/JSON-RPC L7 enforcement, and
# `policy get --base` for MCP/JSON-RPC-safe read-modify-write operations.
MIN_VERSION="0.0.106"
# Maximum version validated for this NemoClaw release. Newer OpenShell builds
# may change sandbox semantics; upgrade NemoClaw before upgrading past this.
MAX_VERSION="0.0.106"
# Pin fresh installs to this version. The TS installer normally overrides this
# via NEMOCLAW_OPENSHELL_PIN_VERSION after resolving the highest published
# OpenShell release that satisfies the blueprint's max_openshell_version
# (see #3404). The hardcoded value is the fallback for offline runs.
PIN_VERSION="$MAX_VERSION"
DEV_MIN_VERSION="0.0.106"

CHANNEL="${NEMOCLAW_OPENSHELL_CHANNEL:-auto}"
case "$CHANNEL" in
  stable | dev | auto) ;;
  *) fail "NEMOCLAW_OPENSHELL_CHANNEL must be one of: stable, dev, auto" ;;
esac

FORCE_INSTALL="${NEMOCLAW_OPENSHELL_FORCE_INSTALL:-0}"
case "$FORCE_INSTALL" in
  0 | 1) ;;
  *) fail "NEMOCLAW_OPENSHELL_FORCE_INSTALL must be 0 or 1." ;;
esac

if [ "$CHANNEL" = "auto" ]; then
  RESOLVED_CHANNEL="stable"
else
  RESOLVED_CHANNEL="$CHANNEL"
fi

if [ "$RESOLVED_CHANNEL" = "dev" ]; then
  # invalidState: a mutable dev artifact is consumed as if it were a verified
  # stable release. sourceBoundary: OpenShell owns the moving dev tag; NemoClaw
  # owns this explicit compatibility-only opt-in. whyNotSourceFix: NemoClaw
  # cannot make that upstream tag immutable. regressionTest:
  # test/install-openshell-version-check.test.ts covers rejection without the
  # opt-in and acceptance with it. removalCondition: remove this path when dev
  # compatibility testing ends or OpenShell publishes an independently
  # verifiable immutable development channel. See the v0.0.72 compatibility
  # review's "Dev Channel Opt-In" section.
  if [ "${NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL:-}" != "1" ]; then
    fail "Dev channel install skips SHA-256 verification. Set NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL=1 to explicitly accept an unverified OpenShell dev-channel install."
  fi
  warn "Dev channel install skips SHA-256 verification. Use only in trusted environments."
fi

HOMEBREW_TAP="nvidia/openshell"
HOMEBREW_FORMULA_NAME="openshell"

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
# published for the selected immutable release, or a mutable registry tag moves.
# sourceBoundary: NVIDIA/OpenShell owns the release workflow, GitHub release
# assets, and GHCR manifests; NemoClaw owns which exact artifacts it trusts.
# whyNotSourceFix: NemoClaw cannot retroactively make an upstream publication
# immutable, so it independently pins every consumed archive and supervisor.
# regressionTest: test/install-openshell-version-check.test.ts exercises all
# nine mappings, and scripts/check-installer-hash.sh compares them with the
# GitHub release API on every PR, main push, weekly run, and manual dispatch.
# removalCondition: remove these entries only when NemoClaw drops that
# supported release or replaces them with independently verified newer pins.
openshell_pinned_sha256() {
  local release_tag="$1" asset="$2"
  case "${release_tag}:${asset}" in
    v0.0.106:openshell-x86_64-unknown-linux-musl.tar.gz)
      printf '%s\n' "d1a885a91b3e5aaa006c36aca95dc78bed0638c1ba1a79b55f1da93211b8a0a0"
      ;;
    v0.0.106:openshell-aarch64-unknown-linux-musl.tar.gz)
      printf '%s\n' "ce981904ae8febd9cd6b3fbceb04e1dcfb48da6042bac08eadf0c2211f83fe55"
      ;;
    v0.0.106:openshell-aarch64-apple-darwin.tar.gz)
      printf '%s\n' "969493205e3d3462226ff613eaba0b9cde0f582e3026294169d533d41e87c905"
      ;;
    v0.0.106:openshell-gateway-x86_64-unknown-linux-gnu.tar.gz)
      printf '%s\n' "b7760cb752a4363c2f21d32298dd0c683dc438f6edfd16c2e4242bc0baefbb7c"
      ;;
    v0.0.106:openshell-gateway-aarch64-unknown-linux-gnu.tar.gz)
      printf '%s\n' "22b7781249e3487085694d0f0f3797a0e549018b81144cd24b2f1118c730d1c7"
      ;;
    v0.0.106:openshell-gateway-aarch64-apple-darwin.tar.gz)
      printf '%s\n' "de8f90db9dd0d3b47855b2b6d2542660730917bd1249e53140300990a8690b94"
      ;;
    v0.0.106:openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz)
      printf '%s\n' "559b8aaad3a8eeab45c511e7de531d9baa98a311282dcb0c2c5f38cc2d4ca355"
      ;;
    v0.0.106:openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz)
      printf '%s\n' "5e5d758d53c6abc6d7a936be907dafa9dfce10423289536f39b50abe294dfafd"
      ;;
    v0.0.106:openshell.rb)
      printf '%s\n' "f0f86519e227b3b326431410058ba690b1a7b83e5af7384014e4b96283d3a642"
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

# A pinned digest authenticates bytes, but it does not make extraction safe.
# Every consumed OpenShell archive must contain exactly the one regular binary
# selected by its asset name. This rejects absolute/parent paths, extra or
# duplicate members, and links/devices before tar can write anything.
validate_openshell_archive() {
  local archive="$1" expected_member="$2" members verbose
  members="$(LC_ALL=C tar -tzf "$archive")" \
    || fail "Unable to list OpenShell archive $(basename "$archive")"
  [ "$members" = "$expected_member" ] \
    || fail "Unsafe OpenShell archive $(basename "$archive"): expected exactly one member named $expected_member"
  verbose="$(LC_ALL=C tar -tvzf "$archive")" \
    || fail "Unable to inspect OpenShell archive $(basename "$archive")"
  [[ "$verbose" != *$'\n'* && "${verbose:0:1}" = "-" && "${verbose##* }" = "$expected_member" ]] \
    || fail "Unsafe OpenShell archive $(basename "$archive"): $expected_member must be one regular file"
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

installed_component_path() {
  local openshell_bin="$1"
  local component_name="$2"
  local explicit_path="${3:-}"
  if [ -n "$explicit_path" ]; then
    printf '%s\n' "$explicit_path"
  else
    printf '%s/%s\n' "$(dirname "$openshell_bin")" "$component_name"
  fi
}

selected_sandbox_component_path() {
  local openshell_bin="$1"
  local explicit_path="${NEMOCLAW_OPENSHELL_SANDBOX_BIN:-}"
  # Darwin uses the VM driver and ships no standalone sandbox supervisor.
  # Ignore a leftover sibling unless the operator explicitly selected it.
  if [ "$OS" = "Darwin" ] && [ -z "$explicit_path" ]; then
    return 0
  fi
  installed_component_path "$openshell_bin" openshell-sandbox "$explicit_path"
}

canonical_file_path() {
  local target="$1"
  local link dir
  local iterations=0
  [ -n "$target" ] || return 1
  case "$target" in
    /*) ;;
    *) target="$PWD/$target" ;;
  esac
  while [ -L "$target" ]; do
    iterations=$((iterations + 1))
    [ "$iterations" -le 40 ] || return 1
    link="$(readlink "$target")" || return 1
    dir="$(cd -P "$(dirname "$target")" 2>/dev/null && pwd)" || return 1
    case "$link" in
      /*) target="$link" ;;
      *) target="$dir/$link" ;;
    esac
  done
  dir="$(cd -P "$(dirname "$target")" 2>/dev/null && pwd)" || return 1
  printf '%s/%s\n' "$dir" "$(basename "$target")"
}

component_shares_install_root() {
  local openshell_bin="$1"
  local component_bin="$2"
  local canonical_openshell canonical_component
  canonical_openshell="$(canonical_file_path "$openshell_bin")" || return 1
  canonical_component="$(canonical_file_path "$component_bin")" || return 1
  [ "$(dirname "$canonical_openshell")" = "$(dirname "$canonical_component")" ]
}

file_sha256() {
  local component_bin="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$component_bin" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$component_bin" | awk '{print $1}'
  else
    return 1
  fi
}

is_pinned_openshell_v00106_linux_x86_64_install() {
  local openshell_bin="$1"
  local gateway_bin="$2"
  local sandbox_bin="$3"
  local openshell_sha gateway_sha sandbox_sha

  [ "$OS" = "Linux" ] && [ "$ARCH_LABEL" = "x86_64" ] || return 1
  openshell_sha="$(file_sha256 "$openshell_bin")" || return 1
  gateway_sha="$(file_sha256 "$gateway_bin")" || return 1
  sandbox_sha="$(file_sha256 "$sandbox_bin")" || return 1
  [ "$openshell_sha" = "98ecf95113fea999e94a928043e57b04cf58a45a1b66ae8bffc73d1bc8bb1d59" ] \
    && [ "$gateway_sha" = "e6cde8a54568aa1926ff6584ffd6984314c68dad64d2722509618a74094c622c" ] \
    && [ "$sandbox_sha" = "019301ec8618abbed8135e8d39dde7bea47e5e92813bbc17768550de34db59f8" ]
}

pinned_sandbox_build_version() {
  local digest="$1"
  case "$digest" in
    # OpenShell v0.0.72 standalone sandbox binaries. These are bind-mounted
    # into the supervisor container and can require a newer glibc than the
    # host that runs the CLI/gateway, so `--version` is not always runnable.
    f9f991a24d10772ad5d24ae27a8ea6baad8cac671695bd90fcd0355e0e0ad198 | \
      32ca44fe7d9e6d332f2a753c6b8a1a6117b7388281dad9b5274d23ffc67e216f)
      printf '%s\n' "0.0.72"
      ;;
    # OpenShell v0.0.82 standalone sandbox binaries.
    145246049bd73c60452ac3c2b4b1801663196c8e2f80575af820289c78c1cf09 | \
      76bc19b70d9f1e1e9871307045796cd39cc7b8fc4c08ffc90593cc934f36d500)
      printf '%s\n' "0.0.82"
      ;;
    # OpenShell v0.0.99 standalone sandbox binaries.
    a4b0c38ed90a6dd4b4f312ad3727824a25ec478d88d4e65d22a82377b18e6214 | \
      f60ce5b76e4dbd645f690c8519852d261c8cf6a70b5fc56db329a23d68bc7b2e)
      printf '%s\n' "0.0.99"
      ;;
    # OpenShell v0.0.101 standalone sandbox binaries.
    a2704babbb468fd0a359bfdd9844de71095b730758541b4ca8cbab77d4018920 | \
      88300e35f153123e4dc3021c537834dd6c0a09665a4a6d3974cd285d512345c4)
      printf '%s\n' "0.0.101"
      ;;
    # OpenShell v0.0.106 standalone sandbox binaries.
    019301ec8618abbed8135e8d39dde7bea47e5e92813bbc17768550de34db59f8 | \
      0031c6b257a23ecc1a2333153918324f3af0005e68abde388858d682ec646c55)
      printf '%s\n' "0.0.106"
      ;;
    *)
      return 1
      ;;
  esac
}

component_build_version() {
  local component_bin="$1"
  local component_role="${2:-component}"
  local version_output version digest
  if version_output="$("$component_bin" --version 2>/dev/null)"; then
    version="$(printf '%s\n' "$version_output" \
      | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^[:space:]]*' \
      | head -1)"
    if [ -n "$version" ]; then
      printf '%s\n' "$version"
      return 0
    fi
  fi

  # Do not infer an identity from arbitrary embedded version strings. Only the
  # exact pinned sandbox release artifacts may fall back when the host loader
  # cannot execute their version probe (for example, GLIBC_2.39 on Brev).
  [ "$component_role" = "sandbox" ] || return 1
  digest="$(file_sha256 "$component_bin")" || return 1
  pinned_sandbox_build_version "$digest"
}

component_build_versions_match() {
  local left="$1"
  local right="$2"
  local left_prefix right_prefix left_hash right_hash
  [ "$left" = "$right" ] && return 0
  case "$left:$right" in
    *+g*:*+g*) ;;
    *) return 1 ;;
  esac
  left_prefix="${left%+g*}"
  right_prefix="${right%+g*}"
  left_hash="${left##*+g}"
  right_hash="${right##*+g}"
  [ "$left_prefix" = "$right_prefix" ] || return 1
  [[ "$left_hash" =~ ^[0-9a-fA-F]{7,}$ ]] || return 1
  [[ "$right_hash" =~ ^[0-9a-fA-F]{7,}$ ]] || return 1
  case "$left_hash" in "$right_hash"*) return 0 ;; esac
  case "$right_hash" in "$left_hash"*) return 0 ;; esac
  return 1
}

component_matches_cli_build() {
  local openshell_bin="$1"
  local component_bin="$2"
  local component_role="${3:-component}"
  local openshell_version component_version
  openshell_version="$(component_build_version "$openshell_bin" cli)"
  component_version="$(component_build_version "$component_bin" "$component_role")"
  [ -n "$openshell_version" ] && [ -n "$component_version" ] \
    && component_build_versions_match "$openshell_version" "$component_version"
}

required_driver_bins_present() {
  local openshell_bin="${1:-$(command -v openshell 2>/dev/null || true)}"
  local gateway_bin sandbox_bin
  [ -n "$openshell_bin" ] || return 1
  gateway_bin="$(installed_component_path "$openshell_bin" openshell-gateway "${NEMOCLAW_OPENSHELL_GATEWAY_BIN:-}")"
  sandbox_bin="$(selected_sandbox_component_path "$openshell_bin")"
  case "$OS" in
    Linux)
      [ -f "$gateway_bin" ] && [ -x "$gateway_bin" ] \
        && [ -f "$sandbox_bin" ] && [ -x "$sandbox_bin" ]
      ;;
    Darwin)
      [ -f "$gateway_bin" ] && [ -x "$gateway_bin" ]
      ;;
    *)
      return 0
      ;;
  esac
}

required_driver_bins_installed_in_dir() {
  local dir="$1"
  case "$OS" in
    Linux)
      [ -x "$dir/openshell-gateway" ] && [ -x "$dir/openshell-sandbox" ]
      ;;
    Darwin)
      [ -x "$dir/openshell-gateway" ]
      ;;
    *)
      return 0
      ;;
  esac
}

OPENSHELL_FEATURE_CHECK_ERROR=""
OPENSHELL_SANDBOX_MCP_FEATURE="allow_all_known_mcp_methods"

openshell_required_feature_strings() {
  local openshell_bin="$1"
  local gateway_bin sandbox_bin candidate seen candidate_strings binary_strings
  local -a candidates

  gateway_bin="$(installed_component_path "$openshell_bin" openshell-gateway "${NEMOCLAW_OPENSHELL_GATEWAY_BIN:-}")"
  sandbox_bin="$(selected_sandbox_component_path "$openshell_bin")"
  # Treat the CLI and its sibling release artifacts as one install. Arbitrary
  # PATH hits must not be combined into a synthetic capability set. Advanced
  # cross-prefix layouts remain available only through the explicit overrides.
  candidates=("$openshell_bin" "$gateway_bin" "$sandbox_bin")

  seen=":"
  binary_strings=""
  for candidate in "${candidates[@]}"; do
    [ -n "$candidate" ] || continue
    [ -f "$candidate" ] || continue
    case "$seen" in
      *":$candidate:"*) continue ;;
    esac
    seen="${seen}${candidate}:"
    candidate_strings="$(strings "$candidate" 2>/dev/null)" || return 1
    binary_strings="${binary_strings}
${candidate_strings}"
    if [[ "$binary_strings" == *"request-body-credential-rewrite"* ]] \
      && [[ "$binary_strings" == *"websocket-credential-rewrite"* ]] \
      && [[ "$binary_strings" == *"$OPENSHELL_SANDBOX_MCP_FEATURE"* ]]; then
      break
    fi
  done
  printf '%s\n' "$binary_strings"
}

openshell_has_required_messaging_features() {
  local openshell_bin gateway_bin sandbox_bin sandbox_strings
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
  gateway_bin="$(installed_component_path "$openshell_bin" openshell-gateway "${NEMOCLAW_OPENSHELL_GATEWAY_BIN:-}")"
  sandbox_bin="$(selected_sandbox_component_path "$openshell_bin")"
  if [ ! -f "$openshell_bin" ] || [ ! -r "$openshell_bin" ] || [ ! -x "$openshell_bin" ]; then
    OPENSHELL_FEATURE_CHECK_ERROR="The selected OpenShell CLI '$openshell_bin' is not a readable executable regular file."
    return 1
  fi
  if [ -n "${NEMOCLAW_OPENSHELL_GATEWAY_BIN:-}" ] \
    && { [ ! -f "$gateway_bin" ] || [ ! -r "$gateway_bin" ] || [ ! -x "$gateway_bin" ]; }; then
    OPENSHELL_FEATURE_CHECK_ERROR="The explicit OpenShell gateway binary '$gateway_bin' is missing, unreadable, or not executable."
    return 1
  fi
  if [ -n "${NEMOCLAW_OPENSHELL_SANDBOX_BIN:-}" ] \
    && { [ ! -f "$sandbox_bin" ] || [ ! -r "$sandbox_bin" ] || [ ! -x "$sandbox_bin" ]; }; then
    OPENSHELL_FEATURE_CHECK_ERROR="The explicit OpenShell sandbox binary '$sandbox_bin' is missing, unreadable, or not executable."
    return 1
  fi
  if [ -f "$gateway_bin" ] && { [ ! -r "$gateway_bin" ] || [ ! -x "$gateway_bin" ]; }; then
    OPENSHELL_FEATURE_CHECK_ERROR="The selected OpenShell gateway is not readable and executable."
    return 1
  fi
  if [ -f "$sandbox_bin" ] && { [ ! -r "$sandbox_bin" ] || [ ! -x "$sandbox_bin" ]; }; then
    OPENSHELL_FEATURE_CHECK_ERROR="The selected OpenShell sandbox is not readable and executable."
    return 1
  fi
  if [ -z "${NEMOCLAW_OPENSHELL_GATEWAY_BIN:-}" ] && [ -f "$gateway_bin" ] \
    && ! component_shares_install_root "$openshell_bin" "$gateway_bin"; then
    OPENSHELL_FEATURE_CHECK_ERROR="The selected OpenShell gateway resolves outside the active CLI install root. Use an explicit component override for a deliberate cross-prefix layout."
    return 1
  fi
  if [ -z "${NEMOCLAW_OPENSHELL_SANDBOX_BIN:-}" ] && [ -f "$sandbox_bin" ] \
    && ! component_shares_install_root "$openshell_bin" "$sandbox_bin"; then
    OPENSHELL_FEATURE_CHECK_ERROR="The selected OpenShell sandbox resolves outside the active CLI install root. Use an explicit component override for a deliberate cross-prefix layout."
    return 1
  fi
  if [ -f "$gateway_bin" ] && ! component_matches_cli_build "$openshell_bin" "$gateway_bin" gateway; then
    OPENSHELL_FEATURE_CHECK_ERROR="The selected OpenShell gateway does not match the active CLI build. Install one coherent OpenShell release."
    return 1
  fi
  if [ -f "$sandbox_bin" ] && ! component_matches_cli_build "$openshell_bin" "$sandbox_bin" sandbox; then
    OPENSHELL_FEATURE_CHECK_ERROR="The selected OpenShell sandbox does not match the active CLI build. Install one coherent OpenShell release."
    return 1
  fi

  # The v0.0.106 release binaries are stripped and no longer retain every
  # source-level capability marker used by the development-build fallback
  # below. Accept only the reviewed executable byte identities as the stable
  # release capability proof; arbitrary binaries that merely report 0.0.106
  # must still pass the fail-closed marker checks.
  if is_pinned_openshell_v00106_linux_x86_64_install \
    "$openshell_bin" "$gateway_bin" "$sandbox_bin"; then
    return 0
  fi

  # OpenShell #1865 has no authoritative CLI/RPC capability query yet. Scan the
  # release-coherent binary set selected beside the CLI (or by explicit
  # component overrides) and fail closed; replace this when that API exists.
  # Version alone is insufficient for moving dev builds.
  local binary_strings
  if ! binary_strings="$(openshell_required_feature_strings "$openshell_bin")"; then
    OPENSHELL_FEATURE_CHECK_ERROR="OpenShell selected binaries could not be read for capability verification."
    return 1
  fi
  if [[ "$binary_strings" != *"request-body-credential-rewrite"* ]]; then
    OPENSHELL_FEATURE_CHECK_ERROR="OpenShell installed binaries are missing request-body-credential-rewrite support."
    return 1
  fi
  if [[ "$binary_strings" != *"websocket-credential-rewrite"* ]]; then
    OPENSHELL_FEATURE_CHECK_ERROR="OpenShell installed binaries are missing websocket-credential-rewrite support."
    return 1
  fi
  if [[ "$binary_strings" != *"$OPENSHELL_SANDBOX_MCP_FEATURE"* ]]; then
    OPENSHELL_FEATURE_CHECK_ERROR="OpenShell installed binaries are missing MCP/JSON-RPC L7 policy support."
    return 1
  fi

  # MCP policy enforcement and credential replacement execute in
  # openshell-sandbox. When that host artifact is present, require the native
  # MCP policy marker from that exact binary.
  if [ -z "$sandbox_bin" ] || [ ! -f "$sandbox_bin" ]; then
    # VM drivers embed a compressed supervisor, so scanning the host driver is
    # not authoritative. Docker/VM packaging can also keep the supervisor out
    # of the host filesystem entirely.
    # The MCP lifecycle's authoritative runtime check loads the exact generated
    # protocol:mcp policy with --wait and exact-matches the effective state
    # before it creates or updates any credential provider.
    return 0
  fi
  sandbox_strings="$(strings "$sandbox_bin" 2>/dev/null || true)"
  if [[ "$sandbox_strings" != *"$OPENSHELL_SANDBOX_MCP_FEATURE"* ]]; then
    OPENSHELL_FEATURE_CHECK_ERROR="OpenShell sandbox runtime is missing MCP/JSON-RPC L7 policy support."
    return 1
  fi
  return 0
}

validate_explicit_component_override() {
  local component_name="$1"
  local component_path="$2"
  [ -n "$component_path" ] || return 0
  if [ ! -f "$component_path" ] || [ ! -r "$component_path" ] || [ ! -x "$component_path" ]; then
    fail "The explicit OpenShell $component_name binary '$component_path' is missing, unreadable, or not executable."
  fi
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

macos_homebrew_formula_installed() {
  local formula_info formula_operation_pin
  [ "$OS" = "Darwin" ] || return 1
  command -v brew >/dev/null 2>&1 || return 1
  if [ "$RELEASE_TAG" = "dev" ]; then
    formula_operation_pin="unverified-dev"
  else
    formula_operation_pin="$(openshell_pinned_sha256 "$RELEASE_TAG" "openshell.rb")" \
      || return 1
  fi
  run_trusted_openshell_homebrew_operation "$formula_operation_pin" -- \
    brew list --formula "$HOMEBREW_FORMULA_NAME" >/dev/null 2>&1 \
    || return 1
  formula_info="$(run_trusted_openshell_homebrew_operation "$formula_operation_pin" -- \
    brew info --json=v2 "$HOMEBREW_FORMULA_NAME" 2>/dev/null)" \
    || return 1
  printf '%s\n' "$formula_info" \
    | grep -Eq '"tap"[[:space:]]*:[[:space:]]*"nvidia/openshell"'
}

download_openshell_formula() {
  local release_tag="$1" output="$2" output_dir
  output_dir="$(dirname "$output")"
  if command -v gh >/dev/null 2>&1; then
    if GH_PROMPT_DISABLED=1 GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" gh release download "$release_tag" --repo NVIDIA/OpenShell \
      --pattern "openshell.rb" --dir "$output_dir" --clobber 2>/dev/null; then
      [ -f "$output" ] && return 0
    fi
    warn "gh CLI formula download failed (auth may not be configured) — falling back to curl"
    rm -f "$output"
  fi
  curl --proto '=https' --tlsv1.2 -fL -sS \
    --connect-timeout 10 --max-time 30 --retry 3 --retry-delay 1 --retry-all-errors \
    "https://github.com/NVIDIA/OpenShell/releases/download/${release_tag}/openshell.rb" \
    -o "$output"
}

homebrew_formula_path() {
  local tap="$1" formula="$2" tap_dir formula_dir
  if ! brew tap-info "$tap" >/dev/null 2>&1; then
    info "creating local Homebrew tap ${tap}..." >&2
    brew tap-new --no-git "$tap" >/dev/null
  fi

  tap_dir="$(brew --repository "$tap" 2>/dev/null || true)"
  [ -n "$tap_dir" ] || fail "could not locate Homebrew tap ${tap}"

  formula_dir="${tap_dir}/Formula"
  mkdir -p "$formula_dir"
  printf '%s/%s.rb\n' "$formula_dir" "$formula"
}

cleanup_macos_homebrew_formula() {
  local status=$?
  trap - EXIT
  if ! rm -rf "${OPENSHELL_HOMEBREW_FORMULA_TMPDIR:-}"; then
    warn "Could not remove temporary OpenShell Homebrew formula files"
    status=1
  fi
  exit "$status"
}

install_macos_homebrew_formula() {
  local tmpdir formula_file tap_formula_file formula_ref expected_sha actual_sha brew_prefix openshell_bin
  local formula_operation_pin homebrew_operation_status install_action
  [ "$OS" = "Darwin" ] || return 1
  [ "$ARCH_LABEL" = "aarch64" ] || fail "OpenShell ${PIN_VERSION} supports the Homebrew gateway service only on Apple Silicon macOS."
  command -v brew >/dev/null 2>&1 || fail "Homebrew is required to install the OpenShell macOS gateway service. Install Homebrew and retry."

  tmpdir="$(mktemp -d)"
  OPENSHELL_HOMEBREW_FORMULA_TMPDIR="$tmpdir"
  trap cleanup_macos_homebrew_formula EXIT
  formula_file="${tmpdir}/openshell.rb"

  info "Downloading OpenShell Homebrew formula..."
  download_openshell_formula "$RELEASE_TAG" "$formula_file" \
    || fail "failed to download OpenShell Homebrew formula for ${RELEASE_TAG}"
  chmod 0644 "$formula_file"

  if [ "$RELEASE_TAG" != "dev" ]; then
    expected_sha="$(openshell_pinned_sha256 "$RELEASE_TAG" "openshell.rb")" \
      || fail "No NemoClaw-pinned SHA-256 for OpenShell $RELEASE_TAG Homebrew formula"
    actual_sha="$(file_sha256 "$formula_file")" \
      || fail "No SHA-256 tool available (sha256sum/shasum)"
    [ "$actual_sha" = "$expected_sha" ] \
      || fail "OpenShell Homebrew formula checksum does not match NemoClaw-pinned $RELEASE_TAG digest"
    formula_operation_pin="$expected_sha"
  else
    formula_operation_pin="unverified-dev"
  fi

  formula_ref="${HOMEBREW_TAP}/${HOMEBREW_FORMULA_NAME}"
  tap_formula_file="$(homebrew_formula_path "$HOMEBREW_TAP" "$HOMEBREW_FORMULA_NAME")"
  info "staging Homebrew formula in tap ${HOMEBREW_TAP}..."
  cp "$formula_file" "$tap_formula_file"
  chmod 0644 "$tap_formula_file"

  homebrew_operation_status=0
  run_trusted_openshell_homebrew_operation "$formula_operation_pin" -- \
    brew list --formula "$HOMEBREW_FORMULA_NAME" >/dev/null 2>&1 \
    || homebrew_operation_status=$?
  if [ "$homebrew_operation_status" = "0" ]; then
    install_action="reinstall"
    info "reinstalling OpenShell with Homebrew..."
  elif [ "$homebrew_operation_status" = "$OPENSHELL_HOMEBREW_OPERATION_FAILED" ]; then
    install_action="install"
    info "installing OpenShell with Homebrew..."
  else
    fail "OpenShell Homebrew formula verification or temporary trust setup failed (status ${homebrew_operation_status}); rerun the pinned NemoClaw installer."
  fi
  homebrew_operation_status=0
  run_trusted_openshell_homebrew_operation "$formula_operation_pin" -- \
    brew "$install_action" --formula "$formula_ref" \
    || homebrew_operation_status=$?
  [ "$homebrew_operation_status" = "0" ] \
    || fail "OpenShell Homebrew ${install_action} failed inside the temporary formula trust boundary (status ${homebrew_operation_status})."

  brew_prefix="$(brew --prefix 2>/dev/null || true)"
  openshell_bin="${brew_prefix}/bin/openshell"
  if [ -z "$brew_prefix" ] || [ ! -x "$openshell_bin" ]; then
    openshell_bin="$(command -v openshell 2>/dev/null || true)"
  fi
  if [ -z "$openshell_bin" ] || [ ! -x "$openshell_bin" ]; then
    fail "Homebrew completed but the openshell binary was not found on PATH."
  fi
  require_openshell_messaging_features "$openshell_bin"
  info "$("$openshell_bin" --version 2>&1 || echo openshell) installed"
  info "OpenShell Homebrew service staged; onboarding will start it after gateway validation."
  exit 0
}

validate_explicit_component_override gateway "${NEMOCLAW_OPENSHELL_GATEWAY_BIN:-}"
validate_explicit_component_override sandbox "${NEMOCLAW_OPENSHELL_SANDBOX_BIN:-}"

ACTIVE_OPENSHELL_BIN=""
if command -v openshell >/dev/null 2>&1; then
  ACTIVE_OPENSHELL_BIN="$(command -v openshell 2>/dev/null || true)"
  INSTALLED_VERSION_OUTPUT="$(openshell --version 2>&1 || true)"
  INSTALLED_VERSION="$(printf '%s\n' "$INSTALLED_VERSION_OUTPUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  [ -n "$INSTALLED_VERSION" ] || INSTALLED_VERSION="0.0.0"
  if [ "$RESOLVED_CHANNEL" = "dev" ]; then
    if version_gte "$INSTALLED_VERSION" "$DEV_MIN_VERSION" \
      && printf '%s\n' "$INSTALLED_VERSION_OUTPUT" | grep -qi 'dev'; then
      if required_driver_bins_present "$ACTIVE_OPENSHELL_BIN" && openshell_has_required_messaging_features "$ACTIVE_OPENSHELL_BIN"; then
        if [ "$FORCE_INSTALL" != "1" ]; then
          if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1 && ! macos_homebrew_formula_installed; then
            warn "NemoClaw cannot confirm the Homebrew gateway formula for openshell $INSTALLED_VERSION_OUTPUT — installing OpenShell with Homebrew..."
          else
            if [ "$OS" = "Darwin" ] && ! command -v brew >/dev/null 2>&1; then
              warn "Homebrew is not installed; reusing the standalone OpenShell gateway without reboot persistence."
            fi
            info "openshell already installed: $INSTALLED_VERSION_OUTPUT (dev channel)"
            exit 0
          fi
        fi
        warn "Current OpenShell dev build requested — refreshing the moving dev release instead of reusing the installed binary."
      else
        feature_status=$?
        if [ "$feature_status" = "2" ]; then
          fail "$OPENSHELL_FEATURE_CHECK_ERROR"
        fi
      fi
    fi
    if [ "$FORCE_INSTALL" != "1" ]; then
      warn "openshell $INSTALLED_VERSION is not the required dev-channel messaging-rewrite/MCP-L7 build — upgrading..."
    fi
  else
    if version_gte "$INSTALLED_VERSION" "$MIN_VERSION"; then
      if ! version_gte "$MAX_VERSION" "$INSTALLED_VERSION"; then
        warn "openshell $INSTALLED_VERSION is above the maximum ($MAX_VERSION) supported by this NemoClaw release — reinstalling pinned OpenShell ${PIN_VERSION}..."
      elif ! required_driver_bins_present "$ACTIVE_OPENSHELL_BIN"; then
        warn "openshell $INSTALLED_VERSION is missing Docker-driver binaries — reinstalling pinned OpenShell ${PIN_VERSION}..."
      elif ! openshell_has_required_messaging_features "$ACTIVE_OPENSHELL_BIN"; then
        fail "${OPENSHELL_FEATURE_CHECK_ERROR:-openshell $INSTALLED_VERSION is missing required messaging credential rewrite and MCP L7 policy support. Install an OpenShell build that includes provider aliases, WebSocket text rewrite, request-body credential rewrite, and MCP/JSON-RPC L7 policy enforcement.}"
      elif [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1 && ! macos_homebrew_formula_installed; then
        warn "NemoClaw cannot confirm the pinned Homebrew gateway formula for openshell $INSTALLED_VERSION — reinstalling pinned OpenShell ${PIN_VERSION} with Homebrew..."
      else
        if [ "$OS" = "Darwin" ] && ! command -v brew >/dev/null 2>&1; then
          warn "Homebrew is not installed; reusing the standalone OpenShell gateway without reboot persistence."
        fi
        info "openshell already installed: $INSTALLED_VERSION (>= $MIN_VERSION, <= $MAX_VERSION, messaging rewrite, MCP L7, and policy --base capable)"
        exit 0
      fi
    else
      warn "openshell $INSTALLED_VERSION is below minimum $MIN_VERSION — upgrading..."
    fi
  fi
fi

info "Installing OpenShell from release '$RELEASE_TAG'..."

if [ "$OS" = "Darwin" ]; then
  if command -v brew >/dev/null 2>&1; then
    install_macos_homebrew_formula
  else
    warn "Homebrew is not installed; installing the standalone OpenShell gateway without reboot persistence."
  fi
fi

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
        fail "OpenShell ${PIN_VERSION} supports the macOS Homebrew gateway service only on Apple Silicon."
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

select_sha_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then
    SHA_CMD="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHA_CMD="shasum -a 256"
  else
    fail "No SHA-256 tool available (sha256sum/shasum)"
  fi
}

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
select_sha_cmd
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
  case "$asset_name" in
    openshell-gateway-*) expected_member="openshell-gateway" ;;
    openshell-sandbox-*) expected_member="openshell-sandbox" ;;
    openshell-*) expected_member="openshell" ;;
    *) fail "No expected archive member is defined for $asset_name" ;;
  esac
  validate_openshell_archive "$tmpdir/$asset_name" "$expected_member"
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

required_driver_bins_installed_in_dir "$target_dir" \
  || fail "OpenShell release '$RELEASE_TAG' did not install the required Docker-driver binaries."
require_openshell_messaging_features "$target_dir/openshell"

info "$("$target_dir/openshell" --version 2>&1 || echo openshell) installed"
