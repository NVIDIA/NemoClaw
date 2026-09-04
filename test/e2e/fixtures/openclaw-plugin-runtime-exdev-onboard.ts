// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandExitResult } from "./clients/command.ts";
import { ordinaryOpenClawPairingIncompleteMessage } from "../../../src/lib/onboard/machine/finalization-deps.ts";
import {
  runBoundedRetry,
  type BoundedRetryResult,
  type RetryEvidence,
} from "../../../tools/e2e/retry-evidence.mts";

const OWNER = "openclaw-plugin-runtime-exdev";
const DIAGNOSTIC_PAIRING_FAILURE_REASONS = [
  "pairing-unavailable",
  "scope-warmup-failed",
] as const satisfies readonly Parameters<typeof ordinaryOpenClawPairingIncompleteMessage>[1][];

type PairingEvidenceOptions<T extends CommandExitResult> = {
  captureDiagnostics(): Promise<unknown>;
  operation:
    | "openclaw-plugin-runtime-exdev.onboard-pairing"
    | "openclaw-plugin-runtime-exdev.recreate-pairing";
  sandboxName: string;
  run(): Promise<T>;
  onEvidence(evidence: RetryEvidence): Promise<void> | void;
};

export function classifyOpenClawPluginOnboard<T extends CommandExitResult>(
  value: T | undefined,
  error: unknown,
  sandboxName: string,
):
  | { outcome: "passed" }
  | { outcome: "failed"; failureClass: "ambiguous-mutation" | "deterministic" } {
  if (error === undefined && value?.exitCode === 0) return { outcome: "passed" };
  const output = value ? `${value.stdout}\n${value.stderr}` : "";
  const preservesPairingDiagnostics = DIAGNOSTIC_PAIRING_FAILURE_REASONS.some((reason) =>
    output.includes(ordinaryOpenClawPairingIncompleteMessage(sandboxName, reason)),
  );
  return {
    outcome: "failed",
    failureClass:
      error === undefined && preservesPairingDiagnostics ? "ambiguous-mutation" : "deterministic",
  };
}

async function capturePairingFailure<T extends CommandExitResult>(
  run: () => Promise<T>,
  sandboxName: string,
  captureDiagnostics: () => Promise<unknown>,
): Promise<T> {
  const value = await run();
  const classification = classifyOpenClawPluginOnboard(value, undefined, sandboxName);
  if (classification.outcome === "failed" && classification.failureClass === "ambiguous-mutation") {
    try {
      await captureDiagnostics();
    } catch {
      // Preserve the primary pairing failure when diagnostics are unavailable.
    }
  }
  return value;
}

/** Run one pairing-sensitive lifecycle operation and retain its bounded evidence. */
export function runOpenClawPluginWithFailureEvidence<T extends CommandExitResult>(
  options: PairingEvidenceOptions<T>,
): Promise<BoundedRetryResult<T>> {
  return runBoundedRetry({
    operation: options.operation,
    owner: OWNER,
    idempotence: "reconciled-mutation",
    maxAttempts: 1,
    run: () => capturePairingFailure(options.run, options.sandboxName, options.captureDiagnostics),
    classify: (value, error) => classifyOpenClawPluginOnboard(value, error, options.sandboxName),
    onEvidence: options.onEvidence,
  });
}
