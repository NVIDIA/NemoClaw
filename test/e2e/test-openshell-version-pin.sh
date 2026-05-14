#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Coverage guard for #3474 — a host with an already-installed OpenShell newer
# than NemoClaw's max supported version must not get stuck in an uninstall /
# reinstall loop. The installer should replace the too-new OpenShell with the
# pinned compatible version instead of failing before the reinstall path.
#
# Expected result on unfixed main: FAIL. scripts/install-openshell.sh sees the
# fake installed `openshell 0.0.40`, compares it to MAX_VERSION=0.0.39, and
# exits with "above the maximum" before downloading the pinned 0.0.39 release.
#
# Expected result after the fix: PASS. The script warns about the too-new
# installed OpenShell, downloads v0.0.39, replaces openshell plus helper
# binaries, and exits successfully.

set -euo pipefail

LOG_FILE="/tmp/nemoclaw-e2e-openshell-version-pin.log"
INSTALL_LOG="/tmp/nemoclaw-e2e-openshell-version-pin-install.log"
DOWNLOAD_LOG="/tmp/nemoclaw-e2e-openshell-version-pin-downloads.log"
FAKE_BIN="/tmp/nemoclaw-e2e-openshell-version-pin-bin"

exec > >(tee "$LOG_FILE") 2>&1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
diag() { echo -e "${YELLOW}[DIAG]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  diag "install log tail:"
  tail -120 "$INSTALL_LOG" 2>/dev/null || true
  diag "download log:"
  cat "$DOWNLOAD_LOG" 2>/dev/null || true
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cleanup() {
  rm -rf "$FAKE_BIN"
}
trap cleanup EXIT

write_executable() {
  local target="$1"
  cat >"$target"
  chmod 755 "$target"
}

mkdir -p "$FAKE_BIN"
: >"$DOWNLOAD_LOG"

# Force Linux/x86_64 asset selection so this guard is stable on any host that
# dispatches the regression workflow.
write_executable "$FAKE_BIN/uname" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "-m" ]; then
  echo "x86_64"
else
  echo "Linux"
fi
SH

# Existing sticky OpenShell: newer than NemoClaw's MAX_VERSION. This is the
# Margaret/Aaron failure mode we want the eventual fix to repair by reinstalling
# the pinned compatible release.
write_executable "$FAKE_BIN/openshell" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then echo "openshell 0.0.40"; exit 0; fi
# request-body-credential-rewrite websocket-credential-rewrite
exit 0
SH

# Helper binaries exist so the only reason to reinstall is the too-new version,
# not missing Docker-driver helpers.
write_executable "$FAKE_BIN/openshell-gateway" <<'SH'
#!/usr/bin/env bash
exit 0
SH
write_executable "$FAKE_BIN/openshell-sandbox" <<'SH'
#!/usr/bin/env bash
exit 0
SH

write_executable "$FAKE_BIN/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "release" ] && [ "${2:-}" = "download" ]; then
  tag="${3:-}"
  pattern=""
  dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) shift; pattern="${1:-}" ;;
      --dir) shift; dir="${1:-}" ;;
    esac
    shift || true
  done
  [ -n "$tag" ] && [ -n "$pattern" ] && [ -n "$dir" ] || exit 2
  printf 'gh download %s %s\n' "$tag" "$pattern" >> "${DOWNLOAD_LOG:?}"
  mkdir -p "$dir"
  case "$pattern" in
    openshell-checksums-sha256.txt)
      printf 'ignored  openshell-x86_64-unknown-linux-musl.tar.gz\n' > "$dir/$pattern"
      ;;
    openshell-gateway-checksums-sha256.txt)
      printf 'ignored  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz\n' > "$dir/$pattern"
      ;;
    openshell-sandbox-checksums-sha256.txt)
      printf 'ignored  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz\n' > "$dir/$pattern"
      ;;
    *)
      : > "$dir/$pattern"
      ;;
  esac
  exit 0
fi
exit 1
SH

write_executable "$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "${DOWNLOAD_LOG:?}"
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="${1:-}"
  fi
  shift || true
done
[ -n "$out" ] || exit 0
case "$(basename "$out")" in
  openshell-checksums-sha256.txt)
    printf 'ignored  openshell-x86_64-unknown-linux-musl.tar.gz\n' > "$out"
    ;;
  openshell-gateway-checksums-sha256.txt)
    printf 'ignored  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz\n' > "$out"
    ;;
  openshell-sandbox-checksums-sha256.txt)
    printf 'ignored  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz\n' > "$out"
    ;;
  *)
    : > "$out"
    ;;
esac
SH

write_executable "$FAKE_BIN/shasum" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
echo "checksum OK"
exit 0
SH

# The installer extracts three archives. Create the binary each archive would
# have produced. The replacement openshell reports 0.0.39 and contains the
# feature strings checked by install-openshell.sh.
write_executable "$FAKE_BIN/tar" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
outdir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ]; then
    outdir="$arg"
    break
  fi
  prev="$arg"
done
[ -n "$outdir" ] || exit 1
case "$*" in
  *openshell-gateway*) name="openshell-gateway" ;;
  *openshell-sandbox*) name="openshell-sandbox" ;;
  *) name="openshell" ;;
esac
cat > "$outdir/$name" <<'EOS'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then echo "openshell 0.0.39"; exit 0; fi
# request-body-credential-rewrite websocket-credential-rewrite
exit 0
EOS
chmod 755 "$outdir/$name"
SH

# Keep the feature-probe hermetic. It only needs to see the marker comments in
# the fake installed binary.
write_executable "$FAKE_BIN/strings" <<'SH'
#!/usr/bin/env bash
cat "$@" 2>/dev/null || true
SH

cd "$REPO_ROOT"
info "Running install-openshell.sh with sticky openshell 0.0.40 and max 0.0.39"
set +e
env \
  PATH="$FAKE_BIN:/usr/bin:/bin" \
  HOME="${HOME}" \
  DOWNLOAD_LOG="$DOWNLOAD_LOG" \
  bash scripts/install-openshell.sh >"$INSTALL_LOG" 2>&1
install_rc=$?
set -e

if [ "$install_rc" -ne 0 ]; then
  if grep -q "openshell 0.0.40 is above the maximum (0.0.39)" "$INSTALL_LOG"; then
    fail "Installer hard-failed on sticky OpenShell 0.0.40 instead of reinstalling pinned 0.0.39 (#3474)"
  fi
  fail "install-openshell.sh failed before proving sticky-version recovery (exit ${install_rc})"
fi
pass "install-openshell.sh completed"

if ! grep -q "v0.0.39" "$DOWNLOAD_LOG"; then
  fail "Expected installer to download pinned OpenShell v0.0.39"
fi
pass "Installer downloaded pinned OpenShell v0.0.39"

if grep -q "v0.0.40" "$DOWNLOAD_LOG"; then
  fail "Installer downloaded OpenShell v0.0.40 despite NemoClaw max 0.0.39"
fi
pass "Installer did not download too-new OpenShell v0.0.40"

if ! "$FAKE_BIN/openshell" --version 2>&1 | grep -q "0.0.39"; then
  fail "openshell binary was not replaced with pinned 0.0.39"
fi
pass "Sticky openshell 0.0.40 was replaced with pinned 0.0.39"

info "OpenShell sticky-version pin guard complete"
