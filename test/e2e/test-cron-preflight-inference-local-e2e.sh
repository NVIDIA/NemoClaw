#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Cron preflight inference.local E2E.
#
# Onboards a fresh sandbox against the managed cloud provider (whose base URL
# resolves through `inference.local`), then loads OpenClaw's cron isolated-agent
# preflight runtime directly from the in-sandbox dist and invokes
# `preflightCronModelProvider` against the onboarded provider/model. Asserts
# the call returns `status: "available"` and never reports `EAI_AGAIN` or the
# "local provider endpoint is not reachable" message.
#
# This probes the exact runtime path Patch 6 modifies — the cron CLI surfaces
# (`openclaw cron add` / `openclaw cron run`) need `operator.admin` scope, which
# the in-sandbox auto-pair approval sweep deliberately omits from its allowlist,
# so the scheduler boundary is intentionally bypassed in favour of a direct
# runtime probe.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Environment:
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-cron-preflight)
#   NEMOCLAW_RECREATE_SANDBOX=1            — destroy + recreate if exists
#   NEMOCLAW_CRON_PREFLIGHT_MODEL          — cloud model (default: nvidia/nemotron-3-super-120b-a12b)
#   NEMOCLAW_CRON_PREFLIGHT_KEEP=1         — keep the sandbox after the test for inspection
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-cron-preflight-inference-local-e2e.sh

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  SKIP=$((SKIP + 1))
  TOTAL=$((TOTAL + 1))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# ── Repo root ──
_script_dir="$(cd "$(dirname "$0")" && pwd)"
_candidate="$(cd "${_script_dir}/../.." && pwd)"
if [ -d /workspace ] && [ -f /workspace/package.json ] && [ -d /workspace/test/e2e ]; then
  REPO="/workspace"
elif [ -f "${_candidate}/package.json" ] && [ -d "${_candidate}/test/e2e" ]; then
  REPO="${_candidate}"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi
unset _script_dir _candidate
cd "$REPO" || {
  echo "ERROR: Cannot cd into repo root '$REPO'."
  exit 1
}

E2E_DIR="${REPO}/test/e2e"
SANDBOX="${NEMOCLAW_SANDBOX_NAME:-e2e-cron-preflight}"
MODEL="${NEMOCLAW_CRON_PREFLIGHT_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
INSTALL_LOG="/tmp/nemoclaw-e2e-cron-preflight-install.log"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "${E2E_DIR}/lib/sandbox-teardown.sh"
# shellcheck source=test/e2e/lib/install-path-refresh.sh
. "${E2E_DIR}/lib/install-path-refresh.sh"

# ── Prereqs ──
section "Prerequisites"
if ! command -v docker >/dev/null 2>&1; then
  skip "docker not installed"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  skip "jq not installed"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if [ -z "${NVIDIA_API_KEY:-}" ]; then
  skip "NVIDIA_API_KEY not set"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if [ "${NVIDIA_API_KEY:0:6}" != "nvapi-" ]; then
  skip "NVIDIA_API_KEY does not start with nvapi-"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  skip "NEMOCLAW_NON_INTERACTIVE must be 1; refusing to risk an interactive onboard prompt"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  skip "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE must be 1; refusing to risk an interactive onboard prompt"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
pass "prerequisites satisfied"

# ── Install NemoClaw + onboard sandbox ──
section "Install NemoClaw + onboard sandbox '$SANDBOX'"
export NEMOCLAW_SANDBOX_NAME="$SANDBOX"
export NEMOCLAW_RECREATE_SANDBOX="${NEMOCLAW_RECREATE_SANDBOX:-1}"
export NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-build}"
export NEMOCLAW_MODEL="${NEMOCLAW_MODEL:-$MODEL}"

info "Installing NemoClaw via install.sh --non-interactive..."
bash install.sh --non-interactive --yes-i-accept-third-party-software >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait "$install_pid"
install_exit=$?
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true

nemoclaw_refresh_install_env
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nemoclaw_ensure_local_bin_on_path

if [ "$install_exit" -ne 0 ]; then
  fail "install.sh failed (exit $install_exit)"
  tail -30 "$INSTALL_LOG"
  exit 1
fi
pass "NemoClaw installed + sandbox onboarded"

command -v nemoclaw >/dev/null 2>&1 || {
  fail "nemoclaw not on PATH after install"
  exit 1
}

# Wire the documented `NEMOCLAW_CRON_PREFLIGHT_KEEP` flag through to the shared
# teardown helper (which honours only `NEMOCLAW_E2E_KEEP_SANDBOX`) so the
# documented escape hatch actually preserves the sandbox for inspection.
export NEMOCLAW_E2E_KEEP_SANDBOX="${NEMOCLAW_E2E_KEEP_SANDBOX:-${NEMOCLAW_CRON_PREFLIGHT_KEEP:-}}"
register_sandbox_for_teardown "$SANDBOX"

# ── Probe the cron preflight directly ──
#
# The cron CLI surfaces (`openclaw cron add` / `openclaw cron run`) require
# `operator.admin` scope, which the in-sandbox auto-pair approval sweep
# deliberately excludes from its allowlist. There is no declarative way for
# an external CLI to call those RPCs without an interactive scope-upgrade
# approval, which is plumbing noise for what this test is actually checking.
#
# Patch 6 only changes the `fetchWithSsrFGuard` call inside
# `probeLocalProviderEndpoint`. Invoke that function directly via a node
# script loaded from the in-sandbox OpenClaw dist instead: the probe asserts
# the same behaviour (managed inference base URL reachable from cron
# preflight) without any gateway, scheduler, or device pairing involvement.
section "Probe cron preflight against managed inference base URL"

PROBE_SRC=$(
  cat <<'PROBE_JS'
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");

const AUDIT_CONTEXT = "cron-model-provider-preflight";
const EXPORT_NAME = "preflightCronModelProvider";
const EXPECTED_HOSTNAME = "inference.local";
const DIST_ROOTS = [
  "/usr/local/lib/node_modules/openclaw/dist",
  "/usr/lib/node_modules/openclaw/dist",
];

function isExpectedManagedProvider(provider) {
  if (!provider || typeof provider.baseUrl !== "string") return false;
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase() === EXPECTED_HOSTNAME;
  } catch {
    return false;
  }
}

function findPreflightModule(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!(full.endsWith(".js") || full.endsWith(".mjs") || full.endsWith(".cjs"))) continue;
      let body;
      try {
        body = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (body.includes(AUDIT_CONTEXT) && body.includes(EXPORT_NAME)) {
        return full;
      }
    }
  }
  return null;
}

(async () => {
  let target = null;
  const scanned = [];
  for (const root of DIST_ROOTS) {
    if (!fs.existsSync(root)) continue;
    scanned.push(root);
    target = findPreflightModule(root);
    if (target) break;
  }
  if (!target) {
    console.error(JSON.stringify({ error: "preflight-source-not-found", scanned }));
    process.exit(3);
  }

  let mod;
  try {
    mod = await import(url.pathToFileURL(target).href);
  } catch (err) {
    console.error(
      JSON.stringify({
        error: "preflight-import-threw",
        target,
        message: String(err && err.stack ? err.stack : err),
      }),
    );
    process.exit(3);
  }
  const preflightCronModelProvider = mod[EXPORT_NAME];
  if (typeof preflightCronModelProvider !== "function") {
    console.error(
      JSON.stringify({
        error: "preflight-export-missing",
        target,
        exports: Object.keys(mod),
      }),
    );
    process.exit(3);
  }

  const configPath = process.env.OPENCLAW_CONFIG_PATH || "/sandbox/.openclaw/openclaw.json";
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(
      JSON.stringify({ error: "config-read-failed", configPath, message: String(err) }),
    );
    process.exit(3);
  }

  const providers = (cfg.models && cfg.models.providers) || {};
  const providerKey = Object.keys(providers).find((key) =>
    isExpectedManagedProvider(providers[key]),
  );
  if (!providerKey) {
    console.error(
      JSON.stringify({
        error: "no-managed-inference-local-provider",
        expectedHost: EXPECTED_HOSTNAME,
        providers: Object.entries(providers).map(([key, value]) => ({
          key,
          baseUrl: value && typeof value.baseUrl === "string" ? value.baseUrl : null,
        })),
      }),
    );
    process.exit(3);
  }
  const providerCfg = providers[providerKey];
  const modelKey =
    providerCfg.defaultModel ||
    (Array.isArray(providerCfg.models) ? providerCfg.models[0] : undefined) ||
    "ping";

  try {
    const result = await preflightCronModelProvider({
      cfg,
      provider: providerKey,
      model: modelKey,
    });
    console.log(
      JSON.stringify({ providerKey, modelKey, baseUrl: providerCfg.baseUrl, target, result }),
    );
    process.exit(result && result.status === "available" ? 0 : 1);
  } catch (err) {
    console.error(
      JSON.stringify({
        error: "preflight-threw",
        message: String(err && err.stack ? err.stack : err),
      }),
    );
    process.exit(2);
  }
})();
PROBE_JS
)
PROBE_B64="$(printf '%s' "$PROBE_SRC" | base64 -w 0)"

# openshell sandbox exec rejects any command argument that contains a newline
# or carriage return ("command argument N contains newline or carriage return
# characters"), so the inner `sh -c` payload must be a single physical line.
# Chain with `&&` for success-only steps and `;` for the cleanup tail so the
# probe exit code is preserved end-to-end.
PROBE_SHELL=". /tmp/nemoclaw-proxy-env.sh && __probe=\"\$(mktemp /tmp/nemoclaw-preflight-probe.XXXXXX.cjs)\" && printf %s '$PROBE_B64' | base64 -d > \"\$__probe\" && node \"\$__probe\"; __rc=\$?; rm -f \"\$__probe\"; exit \"\$__rc\""
PROBE_OUT="$(nemoclaw "$SANDBOX" exec -- sh -c "$PROBE_SHELL" 2>&1)"
PROBE_RC=$?
info "preflight probe output (rc=$PROBE_RC):"
printf '%s\n' "$PROBE_OUT" | sed 's/^/    /'

# Probe stdout/stderr are interleaved (captured via 2>&1). Pick the structured
# JSON result line (the only line that starts with `{"providerKey"`) before
# parsing, so undici experimental-feature warnings on stderr do not break jq.
PROBE_JSON="$(printf '%s\n' "$PROBE_OUT" | grep -E '^\s*\{"providerKey"' | tail -n 1)"
STATUS="$(printf '%s' "$PROBE_JSON" | jq -r '.result.status // empty' 2>/dev/null || true)"
REASON="$(printf '%s' "$PROBE_JSON" | jq -r '.result.reason // ""' 2>/dev/null || true)"

section "Assertions"
if [ "$PROBE_RC" -ge 2 ]; then
  fail "probe harness failed (rc=$PROBE_RC); preflight did not run"
elif printf '%s' "$REASON" | grep -qi "EAI_AGAIN"; then
  fail "preflight raised EAI_AGAIN; reason='$REASON'"
elif printf '%s' "$REASON" | grep -qi "local provider endpoint is not reachable"; then
  fail "preflight reported endpoint unreachable; reason='$REASON'"
elif [ "$STATUS" = "available" ]; then
  pass "preflight status=available"
else
  fail "unexpected probe status='$STATUS' rc=$PROBE_RC reason='$REASON'"
fi

section "Summary"
echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
