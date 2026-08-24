// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../../adapters/openshell/runtime";
import type { SandboxLogsOptions } from "../../domain/sandbox/log-options";
import {
  buildEnableSandboxAuditLogsArgs,
  buildSandboxLogsArgs,
  getLogsProbeTimeoutMs,
} from "../../domain/sandbox/logs";
import { findRecentPolicyDenial, type PolicyDenialMatch } from "./exec-policy-hint-detection";
import {
  buildPolicyDenialExecHint,
  buildScopeUpgradeExecHint,
  hasPendingDeviceRequest,
  shouldProbePolicyDenial,
  shouldProbeScopeUpgrade,
} from "./exec-policy-hint-rendering";

/** Number of recent log lines to scan for a denial event. */
export const POLICY_HINT_TAIL_LINES = 200;
// Three reads 120 ms apart cover a bounded 240 ms log-settling window. Tests
// override both values through PolicyDenialHintDeps; production keeps the
// denial probe's budget fixed so optional guidance cannot materially delay
// exec completion.
export const POLICY_HINT_PROBE_ATTEMPTS = 3;
export const POLICY_HINT_PROBE_RETRY_MS = 120;
export const POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS = 1_000;
// The pending-devices probe is not the host-side audit-log read the ceiling
// above was sized for. It enters the sandbox and starts the OpenClaw CLI
// before any JSON is printed. That does not fit in one second on a slower
// host. A probe that times out is indistinguishable from "nothing is
// pending", so the hint never appears in the one case it exists for
// (#10070). This budget is fixed rather than derived from the log-read
// setting, so no unrelated setting can extend how long a failed exec waits
// for optional guidance. The probe runs only after an OpenClaw command
// already failed, so the operator is reading an error either way.
export const POLICY_HINT_DEVICE_PROBE_TIMEOUT_MS = 5_000;

export type PolicyDenialLogProbe = (sandboxName: string, gatewayName?: string) => string;
export type PolicyDenialAuditEnabler = (sandboxName: string, gatewayName?: string) => void;

export type PendingDeviceProbe = (sandboxName: string, gatewayName?: string) => string;

export type PolicyDenialHintDeps = {
  probeLogs?: PolicyDenialLogProbe;
  probePendingDevices?: PendingDeviceProbe;
  enableAudit?: PolicyDenialAuditEnabler;
  env?: NodeJS.ProcessEnv;
  writeStderr?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  retryDelayMs?: number;
};

// This timer must keep the event loop alive until execSandbox reaches
// process.exit(completion.code) with the original command result.
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runtimeTimeoutMs(): number {
  return Math.min(getLogsProbeTimeoutMs(), POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS);
}

function defaultEnableAudit(sandboxName: string, gatewayName?: string): void {
  const result = captureOpenshell(buildEnableSandboxAuditLogsArgs(sandboxName, gatewayName), {
    ignoreError: true,
    includeStderr: true,
    timeout: runtimeTimeoutMs(),
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`failed to enable audit logs (exit ${result.status})`);
  }
}

function defaultProbeLogs(sandboxName: string, gatewayName?: string): string {
  const options: SandboxLogsOptions = {
    follow: false,
    lines: String(POLICY_HINT_TAIL_LINES),
    since: null,
  };
  const result = captureOpenshell(buildSandboxLogsArgs(sandboxName, options, gatewayName), {
    ignoreError: true,
    includeStderr: true,
    timeout: runtimeTimeoutMs(),
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`failed to read audit logs (exit ${result.status})`);
  }
  return String(result.output ?? "");
}

function defaultProbePendingDevices(sandboxName: string, gatewayName?: string): string {
  // Built inline rather than through buildOpenshellExecArgs so this optional
  // probe does not create an emission -> exec import cycle.
  const argv = ["sandbox", "exec", "--name", sandboxName];
  if (gatewayName) argv.push("-g", gatewayName);
  argv.push("--no-tty", "--", "openclaw", "devices", "list", "--json");
  const result = captureOpenshell(argv, {
    ignoreError: true,
    includeStderr: false,
    timeout: POLICY_HINT_DEVICE_PROBE_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`failed to list pending devices (exit ${result.status})`);
  }
  return String(result.output ?? "");
}

/**
 * Emit the scope-upgrade remedy after a failed in-sandbox OpenClaw command.
 * #5324 added `openclaw devices approve`; this names it at the point of failure
 * so the operator does not have to already know the command. Every dependency
 * is best-effort and never replaces the command's output or exit code.
 *
 * The probe is a presence check. NemoClaw cannot correlate a pending request
 * with the failed command, the expected device, or an acceptable scope set, so
 * no field of the payload reaches the hint and the approve line keeps its
 * literal placeholder. Naming an id here would present an unrelated pending
 * `operator.admin` request as this command's remedy.
 */
export async function maybeEmitScopeUpgradeHint(
  cliName: string,
  sandboxName: string,
  commandCode: number,
  hadInvocationError: boolean,
  command: readonly string[],
  deps: PolicyDenialHintDeps = {},
  gatewayName?: string,
): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (!shouldProbeScopeUpgrade(commandCode, hadInvocationError, command, env)) return null;

  let devicesOutput: string;
  try {
    devicesOutput = (deps.probePendingDevices ?? defaultProbePendingDevices)(
      sandboxName,
      gatewayName,
    );
  } catch {
    // Deliberately silent: a failed optional probe must not append host
    // diagnostics to the child's error output.
    return null;
  }

  if (!hasPendingDeviceRequest(devicesOutput)) return null;

  try {
    const hint = buildScopeUpgradeExecHint(cliName, sandboxName);
    (deps.writeStderr ?? ((line: string) => console.error(line)))(hint);
    return hint;
  } catch {
    return null;
  }
}

/**
 * Emit a denial-adjacent hint after a failed exec. Every dependency is
 * best-effort: failures return null and never replace the command's exit code.
 * Exec leaves stdout and stderr inherited byte-for-byte, so proxy error text is
 * intentionally not captured for a cheaper prefilter; nonzero status is the
 * only safe pre-probe gate, and the timestamp-correlated structured denial is
 * the confirmation.
 * Log-read failures are terminal rather than retried, while successful empty
 * reads get two 120 ms settling retries (240 ms total).
 */
export async function maybeEmitPolicyDenialHint(
  cliName: string,
  sandboxName: string,
  commandCode: number,
  hadInvocationError: boolean,
  commandStartedAtMs: number,
  deps: PolicyDenialHintDeps = {},
  gatewayName?: string,
): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (!shouldProbePolicyDenial(commandCode, hadInvocationError, env)) return null;

  const probeLogs = deps.probeLogs ?? defaultProbeLogs;
  const enableAudit = deps.enableAudit ?? defaultEnableAudit;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = deps.attempts ?? POLICY_HINT_PROBE_ATTEMPTS;
  const retryDelayMs = deps.retryDelayMs ?? POLICY_HINT_PROBE_RETRY_MS;

  try {
    enableAudit(sandboxName, gatewayName);
  } catch {
    // Deliberately silent: audit setup is optional and retained logs may still
    // contain the denial. Printing this diagnostic, even under a new debug
    // contract, would alter child stderr without a confirmed policy denial.
  }

  let match: PolicyDenialMatch | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let logOutput: string;
    try {
      logOutput = probeLogs(sandboxName, gatewayName);
    } catch {
      // Deliberately silent for the same output-preservation boundary: a failed
      // optional probe must not append host diagnostics to the child's error.
      return null;
    }
    match = findRecentPolicyDenial(logOutput, commandStartedAtMs);
    if (match) break;
    if (attempt < attempts) {
      try {
        await sleep(retryDelayMs);
      } catch {
        return null;
      }
    }
  }
  if (!match) return null;

  try {
    const hint = buildPolicyDenialExecHint(cliName, sandboxName, match.endpoint);
    (deps.writeStderr ?? ((line: string) => console.error(line)))(hint);
    return hint;
  } catch {
    // A broken optional sink cannot replace the command's output or exit code.
    return null;
  }
}
