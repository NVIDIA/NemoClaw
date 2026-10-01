#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Build browser-vm loader.js: merge the existing OpenWebUI loader + the
# self-contained vm-panel.js into the single deploy artifact bind-mounted into
# the container at /app/build/static/loader.js.
#
# The mount is read-only and static files are served fresh per request, so no
# container restart is required after running this — just a browser refresh.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_loader="${here}/loader-source.js"
panel="${here}/vm-panel.js"
# openwebui/static — two levels up from browser-vm/loader/
out="${here}/../../static/loader.js"

if [[ ! -f "${src_loader}" ]]; then
  echo "error: ${src_loader} missing — copy the current static/loader.js there first" >&2
  exit 1
fi
if [[ ! -f "${panel}" ]]; then
  echo "error: ${panel} missing" >&2
  exit 1
fi

# ── Validate BEFORE overwriting the deploy artifact ────────────────────────
# loader.js is one concatenated file, so a single syntax error anywhere kills
# the WHOLE script: the chad-shim injection AND the browser-vm panel stop
# running, and the only symptom is a silently missing UI. A half-merged
# vm-panel.js is exactly how that shipped once, so the merge is now gated.
# Build into a temp file, validate, and only then swap it in.
tmpdir="$(mktemp -d)"
tmp="${tmpdir}/loader.js"
trap 'rm -rf "${tmpdir}"' EXIT

{
  cat "${src_loader}"
  printf '\n/* ===== browser-vm vm-panel.js appended by build.sh ===== */\n'
  cat "${panel}"
} > "${tmp}"

fail() {
  echo "error: $1" >&2
  echo "refusing to overwrite ${out}" >&2
  exit 1
}

# 1. Hard syntax gate. `node --check` parses without executing, so it needs no
#    browser and no runtime.
if command -v node >/dev/null 2>&1; then
  if ! node --check "${tmp}"; then
    fail "merged loader.js is not valid JavaScript (node --check output above)"
  fi
  echo "ok: syntax check passed"
else
  echo "warn: node not found — skipping the syntax gate (install node to enable it)" >&2
fi

# 2. Duplicate `case "x":` labels are a SyntaxError, and are easy to
#    reintroduce when reconciling two versions of the message switch.
dupes="$(grep -oE 'case "[a-z:]+":' "${tmp}" | sort | uniq -d || true)"
[[ -z "${dupes}" ]] || fail "duplicate switch cases in vm-panel.js: ${dupes}"

# 3. The panel must actually be present, or the build silently ships a loader
#    with no VM support at all.
grep -q "browser-vm vm-panel.js appended" "${tmp}" || fail "vm-panel section missing from merge"

# 4. Structural sanity on the panel's own entry points, so a truncated edit
#    cannot pass the syntax gate while leaving the UI dead.
# Anchored to the declaration so a rename (toggleTerminal -> toggleTerminalXX)
# is caught instead of matching as a prefix.
for sym in openTerminal toggleTerminal ensureDock ensureChip dropRelay; do
  grep -qE "^[[:space:]]*(async[[:space:]]+)?function[[:space:]]+${sym}[[:space:]]*\\(" "${tmp}" \
    || fail "vm-panel.js is missing 'function ${sym}('"
done
grep -qF "window.__owuiVm" "${tmp}" || fail "vm-panel.js never exports window.__owuiVm"

# 5. The interactive dock and the chat chip are the user-facing entry points;
#    if their markup is gone the build is not the panel we think it is.
for hook in bv-vmbar-term bv-term; do
  grep -qF "${hook}" "${tmp}" || fail "vm-panel.js is missing the ${hook} hook"
done

# 6. Behavioural gate. `node --check` only proves the file parses; it happily
#    accepts a panel that throws on load or calls a helper that does not exist.
#    That is not hypothetical: b64ToBinary was referenced but never defined, so
#    every base64 keystroke from the native terminal threw a ReferenceError and
#    the user could not type at all. test_vm_panel.js runs the real IIFE
#    against a stub DOM in two modes (mock pod, fake CheerpX) and asserts the
#    dock, the chip, the share toggle, and the agent<->user terminal bridge.
if command -v node >/dev/null 2>&1; then
  if [[ ! -f "${here}/test_vm_panel.js" ]]; then
    fail "test_vm_panel.js missing — refusing to ship an unverified panel"
  fi
  if ! node "${here}/test_vm_panel.js" "${panel}" > "${tmpdir}/test.log" 2>&1; then
    sed 's/^/    /' "${tmpdir}/test.log" >&2
    fail "vm-panel.js smoke test failed (output above)"
  fi
  echo "ok: smoke test passed ($(grep -c '\[PASS\]' "${tmpdir}/test.log") assertions)"
else
  echo "warn: node not found — skipping the smoke test gate" >&2
fi

if [[ -f "${out}" ]]; then
  cp "${out}" "${out}.bak.$(date +%Y%m%dT%H%M%SZ)"
fi
mv "${tmp}" "${out}"
trap - EXIT

echo "wrote $(wc -l < "${out}" | tr -d ' ') lines to ${out}"
echo "backed up previous loader.js (if any) alongside it"
echo "deploy mount: ${out} -> /app/build/static/loader.js"
echo
echo "note: OpenWebUI does NOT watch that mount. open_webui/config.py copies"
echo "      /app/build/static/* into STATIC_DIR (/app/backend/open_webui/static)"
echo "      exactly once, when the module is imported at container boot — and"
echo "      STATIC_DIR is what the app actually serves. So a rebuilt loader only"
echo "      goes live after:"
echo "        docker restart nemoclaw-openwebui"
echo "      For a live patch without a restart, copy straight into STATIC_DIR:"
echo "        docker cp ${out} nemoclaw-openwebui:/app/backend/open_webui/static/loader.js"
echo "      (docker cp into /app/build/static fails with 'device or resource"
echo "      busy' — it is a live bind mount, which is the point of it.)"
echo "      Hard-reload the browser afterwards; loader.js is served uncached-ish"
echo "      but the SPA does not re-evaluate it on a soft reload."
