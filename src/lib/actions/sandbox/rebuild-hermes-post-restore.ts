// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import * as processRecovery from "./process-recovery";

export type HermesPostRestoreGatewayState =
  | "not-applicable"
  | "healthy"
  | "recovered"
  | "unverified";

type GatewayRecoveryObservation = {
  checked: boolean;
  wasRunning: boolean | null;
  recovered: boolean;
  forwardRecoveryFailed?: boolean;
  secretBoundaryRefused?: boolean;
  mcpReconciliationRefused?: boolean;
};

interface HermesPostRestoreGatewayDeps {
  checkAndRecoverSandboxProcesses?: (
    sandboxName: string,
    options: { quiet: boolean },
  ) => GatewayRecoveryObservation;
}

/**
 * Re-prove Hermes gateway health after workspace state restoration.
 *
 * Inner onboarding verifies the fresh image before rebuild restores the prior
 * state. That restore can still stop or wedge the gateway, so its earlier
 * readiness message is not authoritative for rebuild completion.
 */
export function ensureHermesGatewayAfterStateRestore(
  sandboxName: string,
  agentName: string,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayState {
  if (agentName !== "hermes") return "not-applicable";
  const checkAndRecover =
    deps.checkAndRecoverSandboxProcesses ?? processRecovery.checkAndRecoverSandboxProcesses;
  const observation: GatewayRecoveryObservation = checkAndRecover(sandboxName, { quiet: true });
  if (
    !observation.checked ||
    observation.forwardRecoveryFailed === true ||
    observation.secretBoundaryRefused === true ||
    observation.mcpReconciliationRefused === true
  ) {
    return "unverified";
  }
  if (observation.wasRunning === true) return "healthy";
  if (observation.recovered) return "recovered";
  return "unverified";
}

export function printHermesGatewayRestoreRecovery(
  sandboxName: string,
  state: HermesPostRestoreGatewayState,
  writeLine: (message: string) => void = console.log,
): void {
  if (state !== "unverified") return;
  writeLine(
    `    Hermes gateway health was not verified after state restore — run \`${CLI_NAME} ${sandboxName} recover\` before relying on this sandbox`,
  );
}
