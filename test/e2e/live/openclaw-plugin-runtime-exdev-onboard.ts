// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type CommandExitResult, outputContainsReadySandbox } from "../fixtures/clients/command.ts";
import {
  runBoundedRetry,
  type BoundedRetryResult,
  type RetryEvidence,
} from "../fixtures/retry-policy.ts";

const OPERATION = "openclaw-plugin-runtime-exdev.onboard-pairing";
const OWNER = "openclaw-plugin-runtime-exdev";

type OnboardPairingRetryOptions<T extends CommandExitResult> = {
  sandboxName: string;
  run(attempt: number): Promise<T>;
  reconcile(value: T | undefined, error: unknown, attempt: number): Promise<boolean>;
  onEvidence(evidence: RetryEvidence): Promise<void> | void;
};

type PairingTarget = {
  gatewayName: string;
};

type OnboardPairingSession = {
  agent: string | null;
  failure: unknown;
  machine: { state: string };
  metadata: { fromDockerfile: string | null; gatewayName: string };
  resumable: boolean;
  sandboxName: string | null;
  status: string;
};

type OnboardPairingReconciliationOptions<T extends CommandExitResult> = {
  expectedFromDockerfile: string;
  sandboxName: string;
  captureDiagnostics(): Promise<void>;
  listSandbox(): Promise<T>;
  loadSession(): OnboardPairingSession | null;
  resolveTarget(): PairingTarget | null;
};

export function classifyOpenClawPluginOnboard<T extends CommandExitResult>(
  value: T | undefined,
  error: unknown,
  sandboxName: string,
):
  | { outcome: "passed" }
  | { outcome: "failed"; failureClass: "deterministic" | "transient-external" } {
  if (error === undefined && value?.exitCode === 0) return { outcome: "passed" };
  const message = `OpenClaw onboarding for '${sandboxName}' is incomplete because its canonical CLI device pairing did not appear. Resume or rerun onboarding.`;
  const output = value ? `${value.stdout}\n${value.stderr}` : "";
  return {
    outcome: "failed",
    failureClass:
      error === undefined && output.includes(message) ? "transient-external" : "deterministic",
  };
}

/** Resume once when the startup watcher has not yet published canonical pairing. */
export function runOpenClawPluginOnboardWithPairingResume<T extends CommandExitResult>(
  options: OnboardPairingRetryOptions<T>,
): Promise<BoundedRetryResult<T>> {
  return runBoundedRetry({
    operation: OPERATION,
    owner: OWNER,
    idempotence: "reconciled-mutation",
    maxAttempts: 2,
    run: options.run,
    classify: (value, error) => classifyOpenClawPluginOnboard(value, error, options.sandboxName),
    reconcile: options.reconcile,
    onEvidence: options.onEvidence,
  });
}

/** Require the paused finalization session and its live runtime before resume can continue. */
export async function reconcileOpenClawPluginOnboardPairing<T extends CommandExitResult>(
  options: OnboardPairingReconciliationOptions<T>,
): Promise<boolean> {
  try {
    await options.captureDiagnostics();
    const list = await options.listSandbox();
    if (list.exitCode !== 0 || !outputContainsReadySandbox(list, options.sandboxName)) return false;
    const target = options.resolveTarget();
    if (!target) return false;
    const session = options.loadSession();
    return (
      session !== null &&
      session.status === "in_progress" &&
      session.resumable === true &&
      session.failure === null &&
      session.sandboxName === options.sandboxName &&
      session.agent === "openclaw" &&
      session.machine.state === "post_verify" &&
      session.metadata.gatewayName === target.gatewayName &&
      session.metadata.fromDockerfile === options.expectedFromDockerfile
    );
  } catch {
    return false;
  }
}
