// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The lazy `require` calls avoid an import cycle because connect.ts and
// process-recovery.ts both import onboarding helpers.
type ProcessRecoveryDeps = Pick<
  typeof import("../../actions/sandbox/process-recovery"),
  "checkAndRecoverSandboxProcesses" | "waitForRecreatedSandboxOpenShellReady"
>;

export const finalizationHandlerRuntime = {
  loadProcessRecovery: () =>
    require("../../actions/sandbox/process-recovery") as ProcessRecoveryDeps,
  loadRegistryPersistence: () =>
    require("../../state/registry/persistence") as typeof import("../../state/registry/persistence"),
};

export const finalizationHandlerDeps = {
  waitForSandboxControlPlaneReady(name: string): boolean {
    return finalizationHandlerRuntime
      .loadProcessRecovery()
      .waitForRecreatedSandboxOpenShellReady(name);
  },
  checkAndRecoverSandboxProcesses(name: string, options: { quiet: boolean }): void {
    const processRecovery = finalizationHandlerRuntime.loadProcessRecovery();
    processRecovery.checkAndRecoverSandboxProcesses(name, options);
  },
  // Best-effort device-approval sweep that clears pending allowlisted
  // CLI/webchat scope upgrades so onboard hands off without a stuck pairing
  // request (#4504). Never throws.
  autoPairScopeApproval(name: string): void {
    const {
      runConnectAutoPairApprovalPass,
    }: typeof import("../../actions/sandbox/auto-pair-approval") = require("../../actions/sandbox/auto-pair-approval");
    runConnectAutoPairApprovalPass(name);
  },
  // Provoke the operator.write scope upgrade with a throwaway in-sandbox agent
  // run so the request is PENDING when the approval pass above clears it,
  // letting the user's first real run connect without an embedded fallback
  // (#4504-v2). Best-effort; never throws.
  warmupScopeUpgrade(name: string): void {
    const warmup: typeof import("../../actions/sandbox/auto-pair-warmup") = require("../../actions/sandbox/auto-pair-warmup");
    warmup.runSandboxScopeWarmupRun(name);
  },
  readRegistryAgent(name: string): string | null {
    try {
      const value = finalizationHandlerRuntime.loadRegistryPersistence().load().sandboxes[
        name
      ]?.agent;
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  },
  settlePortablePairing(
    name: string,
    options: { readonly portableRequired: true },
  ): ReturnType<
    (typeof import("../../actions/sandbox/launch-readiness"))["settlePortableOpenClawPairing"]
  > {
    const pairing: typeof import("../../actions/sandbox/launch-readiness") = require("../../actions/sandbox/launch-readiness");
    return pairing.settlePortableOpenClawPairing(name, options);
  },
  portablePairingIncompleteMessage(
    name: string,
    reason: Parameters<
      (typeof import("../../actions/sandbox/launch-readiness"))["portableOpenClawPairingIncompleteMessage"]
    >[1],
  ): string {
    const pairing: typeof import("../../actions/sandbox/launch-readiness") = require("../../actions/sandbox/launch-readiness");
    return pairing.portableOpenClawPairingIncompleteMessage(name, reason);
  },
  isDeploymentHealthy(result: import("../../verify-deployment").VerifyDeploymentResult): boolean {
    return result.healthy;
  },
  reportDeploymentReadiness(healthy: boolean): void {
    if (!healthy) process.exitCode = 1;
  },
};
