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
import { buildPolicyDenialExecHint, shouldProbePolicyDenial } from "./exec-policy-hint-rendering";

/** Number of recent log lines to scan for a denial event. */
export const POLICY_HINT_TAIL_LINES = 200;
// Three reads 120 ms apart cover a bounded 240 ms log-settling window. Tests
// override both values through PolicyDenialHintDeps; production keeps the
// budget fixed so optional guidance cannot materially delay exec completion.
export const POLICY_HINT_PROBE_ATTEMPTS = 3;
export const POLICY_HINT_PROBE_RETRY_MS = 120;
export const POLICY_HINT_MAX_RUNTIME_TIMEOUT_MS = 1_000;

export type PolicyDenialLogProbe = (sandboxName: string) => string;
export type PolicyDenialAuditEnabler = (sandboxName: string) => void;

export type PolicyDenialHintDeps = {
  probeLogs?: PolicyDenialLogProbe;
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

function defaultEnableAudit(sandboxName: string): void {
  const result = captureOpenshell(buildEnableSandboxAuditLogsArgs(sandboxName), {
    ignoreError: true,
    includeStderr: true,
    timeout: runtimeTimeoutMs(),
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`failed to enable audit logs (exit ${result.status})`);
  }
}

function defaultProbeLogs(sandboxName: string): string {
  const options: SandboxLogsOptions = {
    follow: false,
    lines: String(POLICY_HINT_TAIL_LINES),
    since: null,
  };
  const result = captureOpenshell(buildSandboxLogsArgs(sandboxName, options), {
    ignoreError: true,
    includeStderr: true,
    timeout: runtimeTimeoutMs(),
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`failed to read audit logs (exit ${result.status})`);
  }
  return String(result.output ?? "");
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
): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (!shouldProbePolicyDenial(commandCode, hadInvocationError, env)) return null;

  const probeLogs = deps.probeLogs ?? defaultProbeLogs;
  const enableAudit = deps.enableAudit ?? defaultEnableAudit;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = deps.attempts ?? POLICY_HINT_PROBE_ATTEMPTS;
  const retryDelayMs = deps.retryDelayMs ?? POLICY_HINT_PROBE_RETRY_MS;

  try {
    enableAudit(sandboxName);
  } catch {
    // Deliberately silent: audit setup is optional and retained logs may still
    // contain the denial. Printing this diagnostic, even under a new debug
    // contract, would alter child stderr without a confirmed policy denial.
  }

  let match: PolicyDenialMatch | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let logOutput: string;
    try {
      logOutput = probeLogs(sandboxName);
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
