// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Onboard scope-upgrade warm-up (#4504-v2).
 *
 * During fresh onboard the device is auto-paired with `operator.pairing` only;
 * the `operator.write` upgrade is not requested until the user's first
 * write-scope command. Without an onboarding request producer, the user's first
 * run can fall back to embedded mode.
 *
 * This warm-up provokes the upgrade with one bounded `sessions.create` gateway
 * call inside the sandbox during finalization. The direct call cannot fall back
 * to an embedded inference turn, so it publishes the `operator.write`
 * scope-upgrade request without consuming the readiness deadline on model work.
 * The in-sandbox watcher is the only ordinary onboarding approval owner. The
 * host observes the same device until canonical state has the exact baseline
 * scopes and no same-device pending request.
 *
 * Contract: bounded and idempotent. The direct call returns a fixed non-secret
 * result. Onboarding uses that result only to classify failures. Canonical
 * pairing state remains the only success authority.
 *
 * Workaround boundary (NemoClaw#4462): OpenClaw owns device-pairing semantics
 * and exposes only `devices list/get/approve`. There is no way to pre-grant a
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
// Match the in-sandbox watcher child bound on loaded hosts while retaining the fixed outer cap.
export const WARMUP_PROBE_TIMEOUT_S = 10;

const WARMUP_RESULT_MARKER = "NEMOCLAW_OPENCLAW_WARMUP_RESULT=";
const WATCHER_STATUS_MARKER = "NEMOCLAW_OPENCLAW_WATCHER_STATUS=";
export const AUTO_PAIR_STATUS_PATH = "/tmp/nemoclaw-auto-pair-status.json";

export const WATCHER_STATUS_TIMEOUT_MS = 10_000;

export type AutoPairWatcherState =
  | "running"
  | "request-not-produced"
  | "request-observed"
  | "request-rejected"
  | "approval-timeout"
  | "approval-failed"
  | "approval-completed"
  | "canonical-settled"
  | "stopped"
  | "unavailable";

export interface AutoPairWatcherStatus {
  readonly schemaVersion: 1;
  readonly state: AutoPairWatcherState;
  readonly watcherActive: boolean;
}

export type SandboxScopeWarmupResult =
  | "request-issued"
  | "already-settled"
  | "exec-timeout"
  | "exec-failed";

// Bounded in-sandbox request producer. Use the stored CLI
// device credential for the direct `sessions.create` call. Shared gateway
// overrides would authorize the owner instead of publishing the device's scope
// request. Finalization's canonical observer owns pairing-state polling.
// OpenClaw 2026.7.1 can omit CLI identity on loopback shared auth, so force
// device pairing only on this command.
export const WARMUP_SCRIPT = `
${buildTrustedProxyEnvSourceShell()}
command -v openclaw >/dev/null 2>&1 || { printf '${WARMUP_RESULT_MARKER}exec-failed\\n'; exit 0; }
command -v python3 >/dev/null 2>&1 || { printf '${WARMUP_RESULT_MARKER}exec-failed\\n'; exit 0; }
unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT \\
  OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD \\
  NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING \\
  NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT || { printf '${WARMUP_RESULT_MARKER}exec-failed\\n'; exit 0; }
session_key="agent:main:${WARMUP_SESSION_ID_PREFIX}$$-$(date +%s)"
params="$(printf '{"key":"%s","agentId":"main"}' "$session_key")"
OPENCLAW_BIN="$(command -v openclaw)"
OPENCLAW_BIN="$OPENCLAW_BIN" NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \\
  python3 - "$params" <<'PYPROBE'
import os
import re
import subprocess
import sys

try:
    result = subprocess.run(
        [os.environ['OPENCLAW_BIN'], 'gateway', 'call', 'sessions.create', '--params', sys.argv[1], '--json'],
        capture_output=True, text=True,
        timeout=${WARMUP_PROBE_TIMEOUT_S}, env=dict(os.environ),
    )
    output = (result.stdout + '\\n' + result.stderr)[:65536]
    request_published = re.search(
        r'scope upgrade pending approval|pairing required: device is asking for more scopes',
        output,
        re.IGNORECASE,
    ) is not None
    if result.returncode == 0:
        outcome = 'already-settled'
    elif request_published:
        outcome = 'request-issued'
    else:
        outcome = 'exec-failed'
except subprocess.TimeoutExpired:
    outcome = 'exec-timeout'
except (FileNotFoundError, OSError):
    outcome = 'exec-failed'
print('${WARMUP_RESULT_MARKER}' + outcome)
PYPROBE
exit 0
`;

export const WATCHER_STATUS_SCRIPT = `
command -v python3 >/dev/null 2>&1 || { printf '${WATCHER_STATUS_MARKER}{"schemaVersion":1,"state":"unavailable","watcherActive":false}\\n'; exit 0; }
python3 - <<'PYSTATUS'
import json
import os
import stat

allowed_states = {
    'running', 'request-not-produced', 'request-observed', 'request-rejected',
    'approval-timeout', 'approval-failed', 'approval-completed',
    'canonical-settled', 'stopped',
}
state = 'unavailable'
status_fd = None
try:
    status_fd = os.open(
        ${JSON.stringify(AUTO_PAIR_STATUS_PATH)},
        os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
    )
    metadata = os.fstat(status_fd)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
        or metadata.st_gid != os.getegid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_size > 4096
    ):
        raise OSError('unsafe watcher status metadata')
    raw = os.read(status_fd, 4097)
    if len(raw) > 4096:
        raise OSError('oversized watcher status')
    value = json.loads(raw.decode('utf-8'))
    if (
        isinstance(value, dict)
        and set(value) == {'schemaVersion', 'state'}
        and value.get('schemaVersion') == 1
        and value.get('state') in allowed_states
    ):
        state = value['state']
except Exception:
    pass
finally:
    if status_fd is not None:
        os.close(status_fd)

watcher_active = False
try:
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            with open('/proc/%s/cmdline' % entry, 'rb') as handle:
                command = handle.read().replace(b'\\x00', b' ').decode('utf-8', 'replace')
        except Exception:
            continue
        if 'python3' not in command:
            continue
        for descriptor in ('1', '2'):
            try:
                target = os.readlink('/proc/%s/fd/%s' % (entry, descriptor))
            except Exception:
                continue
            if target == '/tmp/auto-pair.log':
                watcher_active = True
                break
        if watcher_active:
            break
except Exception:
    watcher_active = False

print('${WATCHER_STATUS_MARKER}' + json.dumps({
    'schemaVersion': 1,
    'state': state,
    'watcherActive': watcher_active,
}, separators=(',', ':')))
PYSTATUS
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
): ReturnType<typeof spawnSync> | null {
  // Lazy require: `adapters/openshell/resolve` pulls in `runner`, whose
  // load-time `require("./platform")` cannot be resolved by the Vitest TS
  // loader. Importing it here keeps this module unit-testable in-process.
  // Use `resolveOpenshell` (returns null) rather than `getOpenshellBinary`,
  // which `process.exit(1)`s when the CLI is missing. That fail-fast escapes
  // this try/catch. A missing OpenShell returns the fixed `exec-failed` result
  // for ordinary onboarding, while the restored-clone caller remains
  // non-blocking.
  const { resolveOpenshell } =
    require("../../adapters/openshell/resolve") as typeof import("../../adapters/openshell/resolve");
  try {
    const openshellBinary = resolveOpenshell();
    if (!openshellBinary) return null;
    return spawnSync(openshellBinary, sandboxWarmupExecArgs(sandboxName, gatewayName, script), {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: WARMUP_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

function runSandboxStatusScript(
  sandboxName: string,
  gatewayName: string,
): ReturnType<typeof spawnSync> | null {
  const { resolveOpenshell } =
    require("../../adapters/openshell/resolve") as typeof import("../../adapters/openshell/resolve");
  try {
    const openshellBinary = resolveOpenshell();
    if (!openshellBinary) return null;
    return spawnSync(
      openshellBinary,
      sandboxWarmupExecArgs(sandboxName, gatewayName, WATCHER_STATUS_SCRIPT),
      {
        cwd: ROOT,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: WATCHER_STATUS_TIMEOUT_MS,
      },
    );
  } catch {
    return null;
  }
}

export function parseSandboxScopeWarmupResult(output: string): SandboxScopeWarmupResult | null {
  const lines = output.trimEnd().split(/\r?\n/);
  const markers = lines.filter((line) => line.startsWith(WARMUP_RESULT_MARKER));
  if (markers.length !== 1 || lines.at(-1) !== markers[0]) return null;
  const value = markers[0]!.slice(WARMUP_RESULT_MARKER.length);
  return value === "request-issued" ||
    value === "already-settled" ||
    value === "exec-timeout" ||
    value === "exec-failed"
    ? value
    : null;
}

export function parseAutoPairWatcherStatus(output: string): AutoPairWatcherStatus | null {
  const lines = output.trimEnd().split(/\r?\n/);
  const markers = lines.filter((line) => line.startsWith(WATCHER_STATUS_MARKER));
  if (markers.length !== 1 || lines.at(-1) !== markers[0]) return null;
  let value: unknown;
  try {
    value = JSON.parse(markers[0]!.slice(WATCHER_STATUS_MARKER.length));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  const states: readonly AutoPairWatcherState[] = [
    "running",
    "request-not-produced",
    "request-observed",
    "request-rejected",
    "approval-timeout",
    "approval-failed",
    "approval-completed",
    "canonical-settled",
    "stopped",
    "unavailable",
  ];
  if (
    Object.keys(status).sort().join(",") !== "schemaVersion,state,watcherActive" ||
    status.schemaVersion !== 1 ||
    typeof status.state !== "string" ||
    !states.includes(status.state as AutoPairWatcherState) ||
    typeof status.watcherActive !== "boolean"
  ) {
    return null;
  }
  return status as unknown as AutoPairWatcherStatus;
}

/**
 * Run the bounded, throwaway scope-upgrade warm-up inside the named sandbox via
 * `openshell sandbox exec`. All failure modes (timeout, sandbox-exec errors,
 * missing OpenClaw, and gateway failures) return fixed classifications. The
 * finalization settlement gate decides readiness from canonical state.
 */
export function runSandboxScopeWarmupRun(
  sandboxName: string,
  gatewayName: string,
): SandboxScopeWarmupResult {
  const result = runSandboxWarmupScript(sandboxName, gatewayName, WARMUP_SCRIPT);
  if (!result) return "exec-failed";
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    return "exec-timeout";
  }
  if (result.status !== 0 || typeof result.stdout !== "string") return "exec-failed";
  return parseSandboxScopeWarmupResult(result.stdout) ?? "exec-failed";
}

export function readSandboxAutoPairWatcherStatus(
  sandboxName: string,
  gatewayName: string,
): AutoPairWatcherStatus | null {
  const result = runSandboxStatusScript(sandboxName, gatewayName);
  if (!result || result.status !== 0 || typeof result.stdout !== "string") return null;
  return parseAutoPairWatcherStatus(result.stdout);
}

/**
 * Attempt to publish a restored clone's write-scope request without an
 * embedded fallback. Failures remain non-blocking.
 */
export function runRestoredSandboxScopeWarmupRun(sandboxName: string): void {
  runSandboxWarmupScript(sandboxName, undefined, RESTORED_CLONE_WARMUP_SCRIPT);
}
