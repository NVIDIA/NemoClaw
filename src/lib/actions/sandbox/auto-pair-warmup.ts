// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Onboard scope-upgrade warm-up (#4504-v2).
 *
 * The connect-time approval pass (`auto-pair-approval.ts`) is purely
 * request-driven: it can only approve a scope upgrade that is already PENDING.
 * During fresh onboard the device is auto-paired with `operator.pairing` only;
 * the `operator.write` upgrade is not requested until the user's *first* real
 * `openclaw agent` run — which happens *after* onboard finalization's approval
 * pass already found nothing pending. The result is one silent embedded
 * fallback on that first run, then `connect`/`recover` fixes it.
 *
 * This warm-up provokes the upgrade ourselves: it runs a single, throwaway,
 * bounded `openclaw agent --agent main -m "ping"` inside the sandbox during
 * finalization. That connects to the gateway exactly as the user's first run
 * will, triggers the identical `operator.write` scope-upgrade request, and
 * makes it PENDING. The existing `runConnectAutoPairApprovalPass` (run
 * immediately after) then approves it, so `operator.write` is persisted before
 * handoff and the user's first run connects clean.
 *
 * Contract: best-effort, non-blocking, idempotent. The warm-up run will itself
 * fall back to embedded mode on this first invocation (EXIT 0) — that is
 * expected; its output is discarded. Any failure (exec timeout, gateway not up,
 * agent error) is swallowed so finalization is never blocked; behavior then
 * degrades to the v1 first-run-falls-back-then-recover path, strictly no worse
 * than today. On re-onboard where `operator.write` is already paired the run
 * connects clean (no new pending) and the approval pass is a no-op.
 *
 * Workaround boundary (NemoClaw#4462): OpenClaw owns device-pairing semantics
 * and exposes only `devices list/get/approve` — there is no way to pre-grant a
 * scope the device has not requested. Remove this warm-up when OpenClaw can
 * pre-approve the full scope set at pairing time.
 */

import { spawnSync } from "node:child_process";

import { ROOT } from "../../state/paths";
import { wrapSandboxShellScript } from "./auto-pair-approval";

// Outer spawnSync cap (ms) for the throwaway warm-up agent run. The `-m`
// one-shot prompt ("ping") returns fast even when it falls back to embedded
// mode, so 30s comfortably covers gateway-connect + scope-upgrade request, the
// bounded pending-upgrade poll below, plus shell/agent startup, while never
// letting a wedged sandbox block onboard.
export const WARMUP_TIMEOUT_MS = 30_000;

// Bounded in-sandbox poll for the pending scope upgrade after the provoke run.
// Worst case = WARMUP_POLL_ATTEMPTS × WARMUP_POLL_LIST_TIMEOUT_S list calls plus
// (WARMUP_POLL_ATTEMPTS - 1) inter-attempt 1s sleeps = 5×2 + 4×1 = 14s, which
// leaves clear headroom under WARMUP_TIMEOUT_MS (30s) for shell startup and the
// throwaway agent run that runs first. The gateway persists the upgrade
// requestId once created (#4504 evidence), so once the poll sees it pending the
// downstream approval pass deterministically finds and approves it before
// handoff — making "very first real run, zero fallback" deterministic even on
// slow/contended gateways.
export const WARMUP_POLL_ATTEMPTS = 5;
export const WARMUP_POLL_LIST_TIMEOUT_S = 2;

// Best-effort in-sandbox warm-up script. Always exits 0. It connects to the
// gateway and provokes the `operator.write` scope-upgrade so the request is
// PENDING, then POLLS `devices list` until that allowlisted upgrade is visible
// (or the bounded deadline elapses) before returning — closing the race where
// the approval pass that runs immediately after could otherwise list devices
// before the gateway has registered the upgrade. The poll bounds are
// interpolated so the cap is asserted on real values, not source text.
const WARMUP_SCRIPT = `
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
command -v openclaw >/dev/null 2>&1 || exit 0
openclaw agent --agent main -m "ping" \\
  --session-id "nemoclaw-onboard-warmup-$$-$(date +%s)" >/dev/null 2>&1 || true
command -v python3 >/dev/null 2>&1 || exit 0
OPENCLAW_BIN="$(command -v openclaw)"
i=0
while [ "$i" -lt ${WARMUP_POLL_ATTEMPTS} ]; do
  OPENCLAW_BIN="$OPENCLAW_BIN" python3 - <<'PYPOLL'
import json
import os
import subprocess
import sys

OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')
try:
    proc = subprocess.run(
        [OPENCLAW, 'devices', 'list', '--json'],
        capture_output=True, text=True, timeout=${WARMUP_POLL_LIST_TIMEOUT_S},
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

/**
 * Run the bounded, throwaway scope-upgrade warm-up inside the named sandbox via
 * `openshell sandbox exec`. All failure modes (timeout, sandbox-exec errors,
 * missing openclaw, gateway unreachable) are swallowed: this is best-effort and
 * must never throw — onboard finalization must not be blocked.
 */
export function runSandboxScopeWarmupRun(sandboxName: string): void {
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
      [
        "sandbox",
        "exec",
        "--name",
        sandboxName,
        "--",
        "sh",
        "-c",
        wrapSandboxShellScript(WARMUP_SCRIPT),
      ],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: WARMUP_TIMEOUT_MS,
      },
    );
  } catch {
    /* defense-in-depth — never throw from the onboard finalization path */
  }
}
