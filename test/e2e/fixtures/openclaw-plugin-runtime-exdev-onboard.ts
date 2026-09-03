// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandExitResult } from "./clients/command.ts";
import {
  runBoundedRetry,
  type BoundedRetryResult,
  type RetryEvidence,
} from "../../../tools/e2e/retry-evidence.mts";

const ONBOARD_OPERATION = "openclaw-plugin-runtime-exdev.onboard-pairing";
const RECREATE_OPERATION = "openclaw-plugin-runtime-exdev.recreate-pairing";
const OWNER = "openclaw-plugin-runtime-exdev";
const RECREATE_ARTIFACT = "openclaw-weather-plugin-recreate";
const RECREATE_DIAGNOSTICS_ARTIFACT = "openclaw-weather-plugin-recreate-pairing-diagnostics";
const RECREATE_RETRY_EVIDENCE_ARTIFACT = "openclaw-weather-plugin-recreate-retry.json";

type OnboardPairingEvidenceOptions<T extends CommandExitResult> = {
  captureDiagnostics(): Promise<unknown>;
  sandboxName: string;
  run(): Promise<T>;
  onEvidence(evidence: RetryEvidence): Promise<void> | void;
};

type RecreatePairingEvidenceOptions<T extends CommandExitResult> = {
  captureDiagnostics(artifactName: string): Promise<unknown>;
  cliEntrypoint: string;
  fromDockerfile: string;
  runCommand(args: string[], artifactName: string): Promise<T>;
  sandboxName: string;
  writeEvidence(artifactName: string, evidence: RetryEvidence): Promise<void> | void;
};

export function classifyOpenClawPluginOnboard<T extends CommandExitResult>(
  value: T | undefined,
  error: unknown,
  sandboxName: string,
):
  | { outcome: "passed" }
  | { outcome: "failed"; failureClass: "ambiguous-mutation" | "deterministic" } {
  if (error === undefined && value?.exitCode === 0) return { outcome: "passed" };
  const message = `OpenClaw onboarding for '${sandboxName}' is incomplete because its canonical CLI device pairing did not appear. Resume or rerun onboarding.`;
  const output = value ? `${value.stdout}\n${value.stderr}` : "";
  return {
    outcome: "failed",
    failureClass:
      error === undefined && output.includes(message) ? "ambiguous-mutation" : "deterministic",
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

function runOpenClawPluginWithFailureEvidence<T extends CommandExitResult>(
  options: OnboardPairingEvidenceOptions<T>,
  operation: string,
): Promise<BoundedRetryResult<T>> {
  return runBoundedRetry({
    operation,
    owner: OWNER,
    idempotence: "reconciled-mutation",
    maxAttempts: 1,
    run: () => capturePairingFailure(options.run, options.sandboxName, options.captureDiagnostics),
    classify: (value, error) => classifyOpenClawPluginOnboard(value, error, options.sandboxName),
    onEvidence: options.onEvidence,
  });
}

/** Run initial onboarding once and retain evidence for any canonical pairing failure. */
export function runOpenClawPluginOnboardWithFailureEvidence<T extends CommandExitResult>(
  options: OnboardPairingEvidenceOptions<T>,
): Promise<BoundedRetryResult<T>> {
  return runOpenClawPluginWithFailureEvidence(options, ONBOARD_OPERATION);
}

/** Run sandbox recreation once and retain evidence for any canonical pairing failure. */
export function runOpenClawPluginRecreateWithFailureEvidence<T extends CommandExitResult>(
  options: RecreatePairingEvidenceOptions<T>,
): Promise<BoundedRetryResult<T>> {
  return runOpenClawPluginWithFailureEvidence(
    {
      sandboxName: options.sandboxName,
      run: () =>
        options.runCommand(
          [
            options.cliEntrypoint,
            "onboard",
            "--fresh",
            "--recreate-sandbox",
            "--non-interactive",
            "--yes",
            "--yes-i-accept-third-party-software",
            "--name",
            options.sandboxName,
            "--agent",
            "openclaw",
            "--from",
            options.fromDockerfile,
          ],
          RECREATE_ARTIFACT,
        ),
      captureDiagnostics: () => options.captureDiagnostics(RECREATE_DIAGNOSTICS_ARTIFACT),
      onEvidence: (evidence) => options.writeEvidence(RECREATE_RETRY_EVIDENCE_ARTIFACT, evidence),
    },
    RECREATE_OPERATION,
  );
}
