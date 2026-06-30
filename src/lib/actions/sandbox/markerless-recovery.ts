// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type MarkerlessSandboxCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
} | null;

export type SandboxProcessRecoveryAttempt = {
  recovered: boolean;
  mayHaveStarted: boolean;
};

export function sandboxRecoveryAttempt(
  recovered: boolean,
  mayHaveStarted = false,
): SandboxProcessRecoveryAttempt {
  return { recovered, mayHaveStarted };
}

export function outputLooksLikeMarkerlessGatewayLaunch(
  result: MarkerlessSandboxCommandResult,
): boolean {
  if (!result || result.status !== 0) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/RECOVERY_FAILED|GATEWAY_FAILED|OPENCLAW_MISSING|GATEWAY_STALE_PROCESSES/i.test(output)) {
    return false;
  }
  // Source boundary: newer OpenShell sandbox exec/relaunch output can omit the
  // legacy NemoClaw recovery markers even when the gateway launcher started.
  // This text heuristic only marks "may have started"; recovery is not accepted
  // until waitForRecoveredSandboxGateway() verifies a serving gateway. Require
  // gateway/OpenClaw-specific wording so unrelated sandbox output like
  // "launcher started for debugging" does not burn the health-probe timeout.
  // Remove this shim when OpenShell exposes a stable machine-readable recovery
  // marker for sandbox exec relaunch output.
  return (
    /\b(gateway|openclaw)\b/i.test(output) &&
    /\b(gateway run|launcher|started|nohup)\b/i.test(output)
  );
}

export function sandboxRecoveryAttemptFromExecResult(
  result: MarkerlessSandboxCommandResult,
  hasRecoveryMarker: boolean,
): SandboxProcessRecoveryAttempt | null {
  if (hasRecoveryMarker) return sandboxRecoveryAttempt(true);
  if (result === null) return null;
  return sandboxRecoveryAttempt(false, outputLooksLikeMarkerlessGatewayLaunch(result));
}
