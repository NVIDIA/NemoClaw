#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Reporter-workflow coverage guard for NemoClaw#4522 — the in-sandbox WhatsApp
# pairing QR (`openclaw channels login --channel whatsapp`) must render compact
# enough to scan with a phone.
#
# WHY THIS SHAPE: a full live pairing cannot be automated — it needs a real
# WhatsApp account and a phone to scan the code. But the bug is purely in QR
# *rendering*, which happens in the plugin's `onQr` callback BEFORE any phone
# interaction. That callback renders through `renderQrTerminal()` in
# `openclaw/plugin-sdk/media-runtime`, which calls the `qrcode` package's
# `toString(text, { type: "terminal", small })`. This test installs the EXACT
# `@openclaw/whatsapp` + `openclaw` versions the sandbox bundles (pinned to the
# OPENCLAW_VERSION ARG in Dockerfile.base) and drives that real renderer with a
# representative WhatsApp pairing payload, measuring the rendered dimensions
# with and without the NemoClaw compact-QR preload.
#
# This proves rendered QR *size* (not merely that the preload file exists),
# through the same upstream symbol the reporter workflow invokes. It is fully
# hermetic: it needs only npm (to fetch the pinned plugin) and node — no Docker,
# no GPU, no NVIDIA_API_KEY, no sandbox.
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/4522

set -uo pipefail

PASS=0
FAIL=0

pass() {
  ((PASS++))
  echo "  OK: $1"
}
fail() {
  ((FAIL++))
  echo "  ERROR: $1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PRELOAD="${REPO}/nemoclaw-blueprint/scripts/whatsapp-qr-compact.js"

# Scan-friendly ceiling: a half-block WhatsApp QR is ~29 rows. 40 leaves head
# room for QR-version drift while staying well under the ~56-row full-size form
# the reporter saw. The oversize floor (50) guards that we are still measuring
# the real, un-compacted render in the baseline.
COMPACT_MAX_ROWS="${WHATSAPP_QR_COMPACT_MAX_ROWS:-40}"
OVERSIZE_MIN_ROWS="${WHATSAPP_QR_OVERSIZE_MIN_ROWS:-50}"

WORKDIR="$(mktemp -d /tmp/nemoclaw-wa-qr-e2e.XXXXXX)"
# shellcheck disable=SC2329 # invoked via the EXIT trap below
cleanup() { rm -rf "$WORKDIR" 2>/dev/null || true; }
trap cleanup EXIT

section "Prerequisites"
if command -v node >/dev/null 2>&1; then
  pass "node is available: $(node --version)"
else
  fail "node is required"
  exit 1
fi
if command -v npm >/dev/null 2>&1; then
  pass "npm is available: $(npm --version)"
else
  fail "npm is required"
  exit 1
fi
if [ -f "$PRELOAD" ]; then
  pass "compact-QR preload present: $PRELOAD"
else
  fail "compact-QR preload missing: $PRELOAD"
  exit 1
fi

section "Resolve bundled OpenClaw / WhatsApp plugin version"
# Single source of truth: the OPENCLAW_VERSION ARG default in Dockerfile.base.
# The sandbox installs @openclaw/whatsapp pinned to this same version
# (scripts/openclaw-build-messaging-plugins.py), so the rendered QR we measure
# matches what a real sandbox would show.
OC_VERSION="$(grep -m1 -E '^ARG OPENCLAW_VERSION=' "${REPO}/Dockerfile.base" | cut -d= -f2 | tr -d '[:space:]')"
if [ -n "$OC_VERSION" ]; then
  pass "bundled OpenClaw version resolved: ${OC_VERSION}"
else
  fail "could not parse OPENCLAW_VERSION from Dockerfile.base"
  exit 1
fi

section "Install pinned @openclaw/whatsapp + openclaw"
(cd "$WORKDIR" && printf '{ "name": "wa-qr-e2e", "version": "1.0.0", "private": true }\n' >package.json)
# Keep the install log outside WORKDIR (which the EXIT trap removes) so CI can
# upload it as a failure artifact for debugging.
install_log="${E2E_WHATSAPP_QR_INSTALL_LOG:-/tmp/nemoclaw-e2e-whatsapp-qr-install.log}"
if (cd "$WORKDIR" && npm install --no-audit --no-fund \
  "openclaw@${OC_VERSION}" "@openclaw/whatsapp@${OC_VERSION}" >"$install_log" 2>&1); then
  pass "installed openclaw@${OC_VERSION} and @openclaw/whatsapp@${OC_VERSION}"
else
  fail "npm install failed; see ${install_log}"
  tail -20 "$install_log" || true
  exit 1
fi

section "Plugin renders the pairing QR via renderQrTerminal (real path)"
# Confirm the precondition the bug depends on: the channel-login QR path uses
# renderQrTerminal from the openclaw media-runtime SDK. If a future plugin
# version stops using it, this guard should be revisited.
if grep -rqs "renderQrTerminal" "${WORKDIR}/node_modules/@openclaw/whatsapp/dist/"; then
  pass "plugin channel-login renders through renderQrTerminal"
else
  fail "plugin no longer references renderQrTerminal — revisit this guard"
  exit 1
fi

# Probe program: import the EXACT symbol the plugin's onQr callback calls
# (renderQrTerminal from openclaw/plugin-sdk/media-runtime), render a
# representative WhatsApp Web Linked-Devices pairing payload, and print the
# visible (ANSI-stripped) terminal dimensions as JSON.
cat >"${WORKDIR}/probe.mjs" <<'PROBE'
import { renderQrTerminal } from "openclaw/plugin-sdk/media-runtime";
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// ref,noiseKey,signedIdentityKey,advSecret — the four comma-joined fields a
// baileys WhatsApp Web QR carries; long and dense like the real payload.
const qr =
  "2@" + "ABcd12".repeat(8) + "," + "a8K3".repeat(11) + "=," +
  "Xy90".repeat(11) + "=," + "Qr5T".repeat(9) + "=";
// Call EXACTLY as the plugin does at session login: renderQrTerminal(qr),
// with no { small } — so we exercise the real default, not a contrived opt-in.
const out = strip(await renderQrTerminal(qr));
const lines = out.split("\n");
process.stdout.write(JSON.stringify({
  rows: lines.length,
  cols: Math.max(...lines.map((l) => [...l].length)),
}));
PROBE

run_probe() {
  # $1: "with" | "without" preload
  if [ "$1" = "with" ]; then
    (cd "$WORKDIR" && NODE_OPTIONS="--require ${PRELOAD}" node probe.mjs)
  else
    (cd "$WORKDIR" && node probe.mjs)
  fi
}

section "Baseline (no preload) reproduces the oversized QR"
baseline_json="$(run_probe without)" || {
  fail "baseline probe failed"
  exit 1
}
baseline_rows="$(printf '%s' "$baseline_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).rows))')"
info "baseline rendered dimensions: ${baseline_json}"
if [ "$baseline_rows" -ge "$OVERSIZE_MIN_ROWS" ]; then
  pass "baseline QR is oversized (${baseline_rows} rows >= ${OVERSIZE_MIN_ROWS}) — reproduces NemoClaw#4522"
else
  fail "baseline QR was only ${baseline_rows} rows; expected >= ${OVERSIZE_MIN_ROWS} (precondition for the bug)"
  exit 1
fi

section "With NemoClaw compact-QR preload, the QR is scan-friendly"
patched_json="$(run_probe with)" || {
  fail "patched probe failed"
  exit 1
}
patched_rows="$(printf '%s' "$patched_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).rows))')"
info "compact rendered dimensions: ${patched_json}"
if [ "$patched_rows" -le "$COMPACT_MAX_ROWS" ]; then
  pass "compact QR fits a scan frame (${patched_rows} rows <= ${COMPACT_MAX_ROWS})"
else
  fail "compact QR was ${patched_rows} rows; expected <= ${COMPACT_MAX_ROWS}"
fi
if [ "$patched_rows" -lt "$baseline_rows" ]; then
  pass "preload strictly shrinks the QR (${baseline_rows} -> ${patched_rows} rows)"
else
  fail "preload did not shrink the QR (${baseline_rows} -> ${patched_rows} rows)"
fi

section "Summary"
echo "  PASS=${PASS} FAIL=${FAIL}"
if [ "$FAIL" -eq 0 ]; then
  echo "  WhatsApp compact-QR reporter-workflow E2E passed"
  exit 0
fi
exit 1
