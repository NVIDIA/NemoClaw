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
import { buildTrustedProxyEnvSourceShell } from "./trusted-proxy-env";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

// Outer spawnSync cap (ms) for the direct write-scope probe. The cap prevents a
// wedged sandbox from blocking onboard or restore.
export const WARMUP_TIMEOUT_MS = 30_000;
export const WARMUP_PROBE_TIMEOUT_S = 5;
export const WARMUP_OPENCLAW_BIN = "/usr/local/bin/openclaw";
const WARMUP_PYTHON_BIN = "/usr/bin/python3";
const WARMUP_DATE_BIN = "/bin/date";

// Best-effort in-sandbox request producer. Probe failures exit 0; rejecting an
// unsafe trusted-proxy source can exit nonzero before the outer wrapper ignores
// the result. Keep the trusted gateway credential for the initial request,
// before a CLI device credential exists. OpenClaw 2026.7.1 can omit CLI
// identity on loopback shared auth, so force device pairing only on this
// command. Finalization's canonical observer owns pairing-state polling.
// Validate each executable before loading the gateway credential, then invoke
// only absolute root-owned paths.
export const WARMUP_SCRIPT = `
WARMUP_TRUSTED_OWNER_UID=0
warmup_is_trusted_executable() {
  candidate="$1"
  test -f "$candidate" && test -x "$candidate" || return 1
  set -- $(/bin/ls -ldnL "$candidate" 2>/dev/null) || return 1
  case "\${1:-}" in
    -*) ;;
    *) return 1 ;;
  esac
  test "\${3:-}" = "$WARMUP_TRUSTED_OWNER_UID" || return 1
  # Root ownership protects the owner-write bit. Reject write access available
  # to the sandbox group or any other user before credentials enter the shell.
  case "$1" in
    ?????w????*|????????w?*) return 1 ;;
  esac
}
warmup_is_trusted_executable ${WARMUP_OPENCLAW_BIN} || exit 0
warmup_is_trusted_executable ${WARMUP_PYTHON_BIN} || exit 0
warmup_is_trusted_executable ${WARMUP_DATE_BIN} || exit 0
${buildTrustedProxyEnvSourceShell()}
unset OPENCLAW_GATEWAY_URL NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING \\
  NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT || exit 0
session_key="agent:main:${WARMUP_SESSION_ID_PREFIX}$$-$(${WARMUP_DATE_BIN} +%s)"
params="$(printf '{"key":"%s","agentId":"main"}' "$session_key")"
OPENCLAW_BIN="${WARMUP_OPENCLAW_BIN}" NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \\
  ${WARMUP_PYTHON_BIN} - "$params" <<'PYPROBE'
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
${buildTrustedProxyEnvSourceShell()}
command -v openclaw >/dev/null 2>&1 || exit 0
unset OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD \
  NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING || exit 0
session_key="agent:main:${WARMUP_SESSION_ID_PREFIX}$$-$(date +%s)"
params="$(printf '{"key":"%s","agentId":"main"}' "$session_key")"
NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \\
  openclaw gateway call sessions.create --params "$params" --json >/dev/null 2>&1 || true
exit 0
`;

export function sandboxWarmupExecArgs(
  sandboxName: string,
  gatewayName: string | undefined,
  script: string,
): string[] {
  const target = ["sandbox", "exec", "--name", sandboxName];
  if (gatewayName) target.push("-g", gatewayName);
  return [...target, "--", "sh", "-c", script];
}

function runSandboxWarmupScript(
  sandboxName: string,
  gatewayName: string | undefined,
  script: string,
): void {
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
    spawnSync(openshellBinary, sandboxWarmupExecArgs(sandboxName, gatewayName, script), {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: WARMUP_TIMEOUT_MS,
    });
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
export function runSandboxScopeWarmupRun(sandboxName: string, gatewayName: string): void {
  runSandboxWarmupScript(sandboxName, gatewayName, WARMUP_SCRIPT);
}

/**
 * Attempt to publish a restored clone's write-scope request without an
 * embedded fallback. Failures remain non-blocking.
 */
export function runRestoredSandboxScopeWarmupRun(sandboxName: string): void {
  runSandboxWarmupScript(sandboxName, undefined, RESTORED_CLONE_WARMUP_SCRIPT);
}
