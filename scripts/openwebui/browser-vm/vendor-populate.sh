#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# vendor-populate.sh — rebuild scripts/openwebui/static/vendor/ (the self-hosted
# CheerpX 1.3.9 runtime for the in-browser WebVM terminal). The whole vendor/
# dir is .gitignore'd (reproducible runtime assets, incl. a ~600MB disk image —
# never source), so run this after a fresh checkout before deploying the loader.
#
# It fetches the COMPLETE CheerpX tree cx_esm.js eagerly imports (see
# ../../../docs/design/MASTER-REVIEW... and TERMINAL_INTEGRATION.md): miss one
# and Linux.create() throws a 404 and the VM never boots.
#
#   usage: scripts/openwebui/browser-vm/vendor-populate.sh

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="${here}/../static/vendor"
BASE="https://cxrtnc.leaningtech.com/1.3.9"
mkdir -p "${VENDOR}/r1/tun"

# cheerpx_v3.esm.js is our tiny shim (imports ./cx_esm.js?v=2); write it, not fetch.
cat > "${VENDOR}/r1/cheerpx_v3.esm.js" <<'SHIM'
import cx from './cx_esm.js?v=2'
const CheerpX = (await cx()).CheerpX;
export const Linux = CheerpX.Linux;
export const HttpBytesDevice = CheerpX.HttpBytesDevice;
export const CloudDevice = CheerpX.CloudDevice;
export const IDBDevice = CheerpX.IDBDevice;
export const OverlayDevice = CheerpX.OverlayDevice;
export const DataDevice = CheerpX.DataDevice;
export const WebDevice = CheerpX.WebDevice;
export const GitHubDevice = CheerpX.GitHubDevice;
export const System = CheerpX.System;
export const TailscaleNetwork = CheerpX.TailscaleNetwork;
export const DirectSocketsNetwork = CheerpX.DirectSocketsNetwork;
SHIM

core="cx_esm.js cheerpOS.js cxcore.js cxcore-no-return-call.js cxbridge.js workerclock.js cxcore.wasm cxcore-no-return-call.wasm"
tun="direct.js tailscale_tun_auto.js tailscale_tun.js ipstack.js wasm_exec.js tailscale.wasm ipstack.wasm"

fetch() { # url dest
  local code; code=$(curl -fsS -o "$2" -w '%{http_code}' "$1" || echo 000)
  echo "  $(basename "$2") <- HTTP ${code} ($(wc -c <"$2" 2>/dev/null || echo 0)b)"
}

echo "== core (r1/) =="; for f in $core; do fetch "${BASE}/${f}" "${VENDOR}/r1/${f}"; done
echo "== tun (r1/tun/) =="; for f in $tun; do fetch "${BASE}/tun/${f}" "${VENDOR}/r1/tun/${f}"; done
# Optional/debug assets the CDN returns 204 (empty) for — stub so they 200 not 404.
for f in runtime.wasm dump.wasm fail.wasm t.wasm; do : > "${VENDOR}/r1/${f}"; done

# xterm (the dock terminal emulator) — also self-hosted.
fetch "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs" "${VENDOR}/xterm.mjs"
fetch "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs" "${VENDOR}/addon-fit.mjs"
fetch "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css" "${VENDOR}/xterm.css"

echo
echo "NOTE: debian.ext2 (~600MB rootfs) is NOT fetched here — provide it at"
echo "      ${VENDOR}/debian.ext2 (served at /static/vendor/debian.ext2 via"
echo "      HttpBytesDevice). Copy it from a prior host or an ext2 Debian image."
echo "done. CFG.cheerpxUrl should point at /static/vendor/r1/cheerpx_v3.esm.js"
