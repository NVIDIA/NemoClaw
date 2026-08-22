// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Onboard scope-upgrade warm-up (#4504-v2).
 *
 * The connect-time approval pass (`auto-pair-approval.ts`) is purely
 * request-driven: it can only approve a scope upgrade that is already PENDING.
 * During fresh onboard the device is auto-paired with `operator.pairing` only;
 * the `operator.write` upgrade is not requested until the user's first
 * write-scope command, after onboard finalization's approval pass already found
 * nothing pending. The result is one silent embedded fallback on that first
 * run, then `connect`/`recover` fixes it.
 *
 * This warm-up provokes the upgrade with one bounded `sessions.create` gateway
 * call inside the sandbox during finalization. The direct call cannot fall back
 * to an embedded inference turn, so it publishes the `operator.write`
 * scope-upgrade request without consuming the readiness deadline on model work.
 * The existing `runConnectAutoPairApprovalPass` then approves it, so
 * `operator.write` is persisted before handoff and the user's first run
 * connects without an embedded fallback.
 *
 * Contract: best-effort, bounded, idempotent. The direct call normally returns
 * the pending-scope failure after it publishes the request, and its output is
 * discarded. The leaf swallows execution failures, and onboarding separately
 * observes the canonical pairing state before it reports success. On re-onboard
 * where `operator.write` is already paired the call succeeds and the approval
 * pass is a no-op.
 *
 * Workaround boundary (NemoClaw#4462): OpenClaw owns device-pairing semantics
 * and exposes only `devices list/get/approve` — there is no way to pre-grant a
 * scope the device has not requested. Remove this warm-up when OpenClaw can
 * pre-approve the full scope set at pairing time.
 */

import { spawnSync } from "node:child_process";

import { ROOT } from "../../state/paths";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

// Outer spawnSync cap (ms) for the direct write-scope probe and its bounded
// pending-upgrade poll. The cap prevents a wedged sandbox from blocking onboard
// or restore.
export const WARMUP_TIMEOUT_MS = 30_000;
export const WARMUP_PROBE_TIMEOUT_S = 5;

// Bounded in-sandbox poll for the pending scope upgrade after the provoke run.
// Worst case = WARMUP_POLL_ATTEMPTS × WARMUP_POLL_LIST_TIMEOUT_S list calls plus
// (WARMUP_POLL_ATTEMPTS - 1) inter-attempt 1s sleeps = 5×2 + 4×1 = 14s, which
// plus the 5s direct-probe timeout consume at most 19s. This leaves clear
// headroom under WARMUP_TIMEOUT_MS (30s) for shell and Python startup. The
// gateway persists the upgrade requestId once created (#4504 evidence), so
// once the poll sees it pending, the downstream approval pass finds and
// approves it before
// handoff — making "very first real run, zero fallback" deterministic even on
// slow/contended gateways.
export const WARMUP_POLL_ATTEMPTS = 5;
export const WARMUP_POLL_LIST_TIMEOUT_S = 2;

// Best-effort in-sandbox warm-up script. Always exits 0. It connects to the
// gateway and provokes the `operator.write` scope-upgrade so the request is
// PENDING, then POLLS `devices list` until that allowlisted upgrade is visible
// (or the bounded deadline elapses) before returning, closing the race where
// the approval pass that runs immediately after could otherwise list devices
// before the gateway has registered the upgrade. The poll bounds are
// interpolated so the cap is asserted on real values, not source text. Use the
// stored CLI device credential for the provoke. Shared gateway overrides would
// authorize the owner instead of publishing the device's scope request.
// OpenClaw 2026.7.1 can omit CLI identity on loopback shared auth, so force
// device pairing only on this command.
export const WARMUP_SCRIPT = `
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
command -v openclaw >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT \\
  OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD \\
  NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING \\
  NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT || exit 0
session_key="agent:main:${WARMUP_SESSION_ID_PREFIX}$$-$(date +%s)"
params="$(printf '{"key":"%s","agentId":"main"}' "$session_key")"
OPENCLAW_BIN="$(command -v openclaw)"
OPENCLAW_BIN="$OPENCLAW_BIN" NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \\
  python3 - "$params" <<'PYPROBE'
import os
import subprocess
import sys

try:
    subprocess.run(
        [os.environ['OPENCLAW_BIN'], 'gateway', 'call', 'sessions.create', '--params', sys.argv[1], '--json'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=${WARMUP_PROBE_TIMEOUT_S}, env=dict(os.environ),
    )
except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
    pass
PYPROBE
i=0
while [ "$i" -lt ${WARMUP_POLL_ATTEMPTS} ]; do
  OPENCLAW_BIN="$OPENCLAW_BIN" python3 - <<'PYPOLL'
import json
import os
import subprocess
import sys

OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')
# The proxy environment is shared gateway routing. Settlement must instead use
# the paired CLI identity with its current pairing-only credential so the list
# call can observe the write-scope request that the provoke command created.
list_env = dict(os.environ)
for key in (
    'OPENCLAW_GATEWAY_URL',
    'OPENCLAW_GATEWAY_PORT',
    'OPENCLAW_GATEWAY_TOKEN',
    'OPENCLAW_GATEWAY_PASSWORD',
    'NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING',
    'NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING',
):
    list_env.pop(key, None)
list_env['NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT'] = '1'
try:
    proc = subprocess.run(
        [OPENCLAW, 'devices', 'list', '--json'],
        capture_output=True, text=True, timeout=${WARMUP_POLL_LIST_TIMEOUT_S}, env=list_env,
    )
except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
    sys.exit(1)
if proc.returncode != 0 or not proc.stdout.strip():
    sys.exit(1)
try:
    data = json.loads(proc.stdout)
except ValueError:
    sys.exit(1)
if not isinstance(data, dict):
    sys.exit(1)
# Terminal success = operator.write is satisfied, whether it is a PENDING
# upgrade (the approval pass will grant it next) or ALREADY GRANTED on a
# re-onboard (idempotent no-op — nothing left to do before handoff). Scan
# every device collection the response exposes (pending plus any granted/
# approved/paired/devices list, and any other top-level list of device dicts)
# rather than only 'pending', so the already-paired path short-circuits
# immediately instead of burning the whole poll budget.
devices = []
for value in data.values():
    if isinstance(value, list):
        devices.extend(d for d in value if isinstance(d, dict))
for device in devices:
    scopes = device.get('scopes') or device.get('requestedScopes')
    if isinstance(scopes, str):
        scopes = scopes.replace(',', ' ').split()
    if isinstance(scopes, list) and 'operator.write' in scopes:
        sys.exit(0)
sys.exit(1)
PYPOLL
  if [ "$?" -eq 0 ]; then
    break
  fi
  i=$((i + 1))
  [ "$i" -lt ${WARMUP_POLL_ATTEMPTS} ] && sleep 1
done
exit 0
`;

// A restored clone must publish its write-scope request before the strict
// local-state approval pass from #7834. Use a direct gateway call here: unlike
// `openclaw agent`, this command cannot silently continue in embedded mode.
// The runtime env carries shared gateway auth for owned admin RPCs; remove it
// before this ordinary CLI call so OpenClaw uses the clone's stored device
// credential and publishes the exact write-scope upgrade request.
// When the clone is already fully paired, the call creates only a tagged empty
// warm-up session, matching the existing user-facing session filter contract.
export const RESTORED_CLONE_WARMUP_SCRIPT = `
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
command -v openclaw >/dev/null 2>&1 || exit 0
unset OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD \
  NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING || exit 0
session_key="agent:main:${WARMUP_SESSION_ID_PREFIX}$$-$(date +%s)"
params="$(printf '{"key":"%s","agentId":"main"}' "$session_key")"
NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \\
  openclaw gateway call sessions.create --params "$params" --json >/dev/null 2>&1 || true
exit 0
`;

function runSandboxWarmupScript(sandboxName: string, script: string): void {
  // Lazy require: `adapters/openshell/resolve` pulls in `runner`, whose
  // load-time `require("./platform")` cannot be resolved by the Vitest TS
  // loader. Importing it here keeps this module unit-testable in-process.
  // Use `resolveOpenshell` (returns null) rather than `getOpenshellBinary`,
  // which `process.exit(1)`s when the CLI is missing — that fail-fast escapes
  // this try/catch and would turn the best-effort warm-up into a hard onboard
  // exit. A missing OpenShell here is a no-op instead.
  const { resolveOpenshell } =
    require("../../adapters/openshell/resolve") as typeof import("../../adapters/openshell/resolve");
  try {
    const openshellBinary = resolveOpenshell();
    if (!openshellBinary) return;
    spawnSync(
      openshellBinary,
      ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", script],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: WARMUP_TIMEOUT_MS,
      },
    );
  } catch {
    /* defense-in-depth — never throw from a warm-up path */
  }
}

/**
 * Run the bounded, throwaway scope-upgrade warm-up inside the named sandbox via
 * `openshell sandbox exec`. All failure modes (timeout, sandbox-exec errors,
 * missing openclaw, gateway unreachable) are swallowed. The finalization
 * settlement gate decides readiness from a later canonical observation.
 */
export function runSandboxScopeWarmupRun(sandboxName: string): void {
  runSandboxWarmupScript(sandboxName, WARMUP_SCRIPT);
}

/**
 * Attempt to publish a restored clone's write-scope request without an
 * embedded fallback. Failures remain non-blocking.
 */
export function runRestoredSandboxScopeWarmupRun(sandboxName: string): void {
  runSandboxWarmupScript(sandboxName, RESTORED_CLONE_WARMUP_SCRIPT);
}
