// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OPENCLAW_ONBOARDING_PAIRING_POLL_MS,
  OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS,
  OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS,
  type OpenClawPairingSettlementObservation,
} from "../../actions/sandbox/launch-readiness/openclaw-pairing-qualification";
import type { OpenClawPairingSettlementTarget } from "../../actions/sandbox/launch-readiness";
import type {
  AutoPairWatcherStatus,
  SandboxScopeWarmupResult,
} from "../../actions/sandbox/auto-pair-warmup";
import { WATCHER_STATUS_TIMEOUT_MS } from "../../actions/sandbox/auto-pair-warmup";

export {
  OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS,
  OPENCLAW_ONBOARDING_PAIRING_POLL_MS,
  OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS,
  OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS,
} from "../../actions/sandbox/launch-readiness/openclaw-pairing-qualification";

// The lazy `require` calls avoid an import cycle because connect.ts and
// process-recovery.ts both import onboarding helpers.
type ProcessRecoveryDeps = Pick<
  typeof import("../../actions/sandbox/process-recovery"),
  "checkAndRecoverSandboxProcesses" | "waitForRecreatedSandboxOpenShellReady"
>;
type SandboxLifecycleLock = typeof import("../../state/mcp-lifecycle-lock").withMcpLifecycleLock;
type GatewayRouteLock =
  typeof import("../../inference/gateway-route-mutation-lock").withGatewayRouteMutationLock;

export type OrdinaryOpenClawPairingSettlementResult =
  | { readonly kind: "settled" }
  | {
      readonly kind: "incomplete";
      readonly reason:
        | "runtime-identity-invalid"
        | "pairing-lock-unavailable"
        | "pairing-unavailable"
        | "scope-warmup-failed"
        | "scope-upgrade-not-requested"
        | "scope-upgrade-not-approved"
        | "scope-upgrade-rejected"
        | "scope-upgrade-approval-timeout"
        | "scope-upgrade-approval-failed"
        | "scope-upgrade-watcher-unavailable";
    };

type OrdinaryOpenClawPairingIncompleteReason = Extract<
  OrdinaryOpenClawPairingSettlementResult,
  { kind: "incomplete" }
>["reason"];

const ORDINARY_OPENCLAW_PAIRING_INCOMPLETE_CAUSES: Record<
  OrdinaryOpenClawPairingIncompleteReason,
  string
> = {
  "runtime-identity-invalid": "its recorded OpenClaw runtime identity changed or is invalid",
  "pairing-lock-unavailable": "NemoClaw could not acquire the pairing settlement locks",
  "pairing-unavailable": "its canonical CLI device pairing did not appear",
  "scope-warmup-failed": "the bounded CLI scope warm-up could not run",
  "scope-upgrade-not-requested": "its canonical CLI scope upgrade was not requested",
  "scope-upgrade-not-approved": "its canonical CLI scope upgrade remained pending",
  "scope-upgrade-rejected": "the sandbox watcher rejected its canonical CLI scope upgrade",
  "scope-upgrade-approval-timeout":
    "the sandbox watcher timed out while approving its canonical CLI scope upgrade",
  "scope-upgrade-approval-failed":
    "the sandbox watcher failed to approve its canonical CLI scope upgrade",
  "scope-upgrade-watcher-unavailable": "the sandbox scope-upgrade approval watcher was not running",
};

interface OrdinaryOpenClawPairingSettlementDeps {
  getTarget(name: string): OpenClawPairingSettlementTarget | null;
  observePairing(
    name: string,
    gatewayName: string,
    version: string,
    stateDirectory: string,
  ): OpenClawPairingSettlementObservation;
  runWarmup(
    name: string,
    gatewayName: string,
  ): Promise<SandboxScopeWarmupResult> | SandboxScopeWarmupResult;
  readWatcherStatus(name: string, gatewayName: string): AutoPairWatcherStatus | null;
  withSandboxLock: SandboxLifecycleLock;
  withGatewayLock: GatewayRouteLock;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const finalizationHandlerRuntime = {
  loadProcessRecovery: () =>
    require("../../actions/sandbox/process-recovery") as ProcessRecoveryDeps,
  loadRegistryPersistence: () =>
    require("../../state/registry/persistence") as typeof import("../../state/registry/persistence"),
  loadLaunchReadiness: () =>
    require("../../actions/sandbox/launch-readiness") as typeof import("../../actions/sandbox/launch-readiness"),
  loadPairingQualification: () =>
    require("../../actions/sandbox/launch-readiness/openclaw-pairing-qualification") as typeof import("../../actions/sandbox/launch-readiness/openclaw-pairing-qualification"),
  loadAutoPairWarmup: () =>
    require("../../actions/sandbox/auto-pair-warmup") as typeof import("../../actions/sandbox/auto-pair-warmup"),
  loadSandboxLifecycleLock: () =>
    require("../../state/mcp-lifecycle-lock") as typeof import("../../state/mcp-lifecycle-lock"),
  loadGatewayRouteLock: () =>
    require("../../inference/gateway-route-mutation-lock") as typeof import("../../inference/gateway-route-mutation-lock"),
};

function samePairingTarget(
  left: OpenClawPairingSettlementTarget,
  right: OpenClawPairingSettlementTarget | null,
): right is OpenClawPairingSettlementTarget {
  return (
    right !== null &&
    left.gatewayName === right.gatewayName &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.lifecycleLiveIdentityFingerprint === right.lifecycleLiveIdentityFingerprint &&
    left.stateDirectory === right.stateDirectory &&
    left.version === right.version
  );
}

type PairingWaitResult =
  | { readonly kind: "observed"; readonly value: OpenClawPairingSettlementObservation }
  | { readonly kind: "target-changed" }
  | { readonly kind: "identity-changed" }
  | {
      readonly kind: "timeout";
      readonly last: OpenClawPairingSettlementObservation | null;
    };

async function waitForPairingObservation(
  name: string,
  target: OpenClawPairingSettlementTarget,
  deadline: number,
  accept: (value: OpenClawPairingSettlementObservation) => boolean,
  deps: OrdinaryOpenClawPairingSettlementDeps,
  expectedDeviceIdentitySha256?: string,
): Promise<PairingWaitResult> {
  let last: OpenClawPairingSettlementObservation | null = null;
  while (true) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { kind: "timeout", last };
    if (!samePairingTarget(target, deps.getTarget(name))) return { kind: "target-changed" };
    try {
      const value = deps.observePairing(
        name,
        target.gatewayName,
        target.version,
        target.stateDirectory,
      );
      if (
        expectedDeviceIdentitySha256 &&
        value.deviceIdentitySha256 !== expectedDeviceIdentitySha256
      ) {
        return { kind: "identity-changed" };
      }
      last = value;
      if (!samePairingTarget(target, deps.getTarget(name))) return { kind: "target-changed" };
      if (deadline - deps.now() <= 0) return { kind: "timeout", last };
      if (accept(value)) return { kind: "observed", value };
    } catch {
      // Pairing state can be absent or changing while the startup watcher runs.
    }
    const remainingAfterAttempt = deadline - deps.now();
    if (remainingAfterAttempt <= 0) return { kind: "timeout", last };
    await deps.sleep(Math.min(OPENCLAW_ONBOARDING_PAIRING_POLL_MS, remainingAfterAttempt));
  }
}

function defaultPairingSettlementDeps(): OrdinaryOpenClawPairingSettlementDeps {
  return {
    getTarget: (name) => {
      try {
        return finalizationHandlerRuntime
          .loadLaunchReadiness()
          .resolveOrdinaryOpenClawPairingTarget(name);
      } catch {
        return null;
      }
    },
    observePairing: (...args) =>
      finalizationHandlerRuntime
        .loadPairingQualification()
        .observeOrdinaryOpenClawPairingSettlement(...args),
    runWarmup: (name, gatewayName) =>
      finalizationHandlerRuntime.loadAutoPairWarmup().runSandboxScopeWarmupRun(name, gatewayName),
    readWatcherStatus: (name, gatewayName) =>
      finalizationHandlerRuntime
        .loadAutoPairWarmup()
        .readSandboxAutoPairWatcherStatus(name, gatewayName),
    withSandboxLock: (name, operation, options) =>
      finalizationHandlerRuntime
        .loadSandboxLifecycleLock()
        .withMcpLifecycleLock(name, operation, options),
    withGatewayLock: (gatewayName, operation, options) =>
      finalizationHandlerRuntime
        .loadGatewayRouteLock()
        .withGatewayRouteMutationLock(gatewayName, operation, options),
    now: () => performance.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

/**
 * Observe canonical state, run one bounded request producer for an exact
 * pairing-only device, then wait while the sandbox watcher owns approval.
 * Canonical state for the same device is the only success authority.
 */
export async function settleOrdinaryOpenClawPairing(
  name: string,
  deps: OrdinaryOpenClawPairingSettlementDeps = defaultPairingSettlementDeps(),
): Promise<OrdinaryOpenClawPairingSettlementResult> {
  let sandboxBodyEntered = false;
  try {
    return await deps.withSandboxLock(name, async () => {
      sandboxBodyEntered = true;
      const firstTarget = deps.getTarget(name);
      if (!firstTarget) return { kind: "incomplete", reason: "runtime-identity-invalid" };

      let gatewayBodyEntered = false;
      try {
        return await deps.withGatewayLock(firstTarget.gatewayName, async () => {
          gatewayBodyEntered = true;
          const target = deps.getTarget(name);
          if (!samePairingTarget(firstTarget, target)) {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          const settlementDeadline =
            deps.now() +
            OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS -
            WATCHER_STATUS_TIMEOUT_MS;

          // Avoid creating another hidden warm-up session when re-onboarding an
          // already-settled device, and reuse an exact upgrade already pending.
          let initial: OpenClawPairingSettlementObservation | null = null;
          try {
            initial = deps.observePairing(
              name,
              target.gatewayName,
              target.version,
              target.stateDirectory,
            );
          } catch {
            // Pairing may not have appeared yet. Wait for the canonical device
            // before running the request producer.
          }
          if (!samePairingTarget(target, deps.getTarget(name))) {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          if (deps.now() >= settlementDeadline) {
            return { kind: "incomplete", reason: "pairing-unavailable" };
          }
          if (initial?.state === "settled") {
            return { kind: "settled" };
          }

          if (!initial) {
            const pairingAppearance = await waitForPairingObservation(
              name,
              target,
              Math.min(settlementDeadline, deps.now() + OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS),
              () => true,
              deps,
            );
            if (
              pairingAppearance.kind === "target-changed" ||
              pairingAppearance.kind === "identity-changed"
            ) {
              return { kind: "incomplete", reason: "runtime-identity-invalid" };
            }
            if (pairingAppearance.kind === "timeout") {
              return { kind: "incomplete", reason: "pairing-unavailable" };
            }
            initial = pairingAppearance.value;
          }
          if (initial.state === "settled") {
            return { kind: "settled" };
          }

          const deviceIdentitySha256 = initial.deviceIdentitySha256;
          let warmupResult: SandboxScopeWarmupResult | null = null;
          if (initial.state === "pairing-only") {
            try {
              warmupResult = await deps.runWarmup(name, target.gatewayName);
            } catch {
              warmupResult = "exec-failed";
            }
          }
          if (!samePairingTarget(target, deps.getTarget(name))) {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          const final = await waitForPairingObservation(
            name,
            target,
            settlementDeadline,
            (value) => value.state === "settled",
            deps,
            deviceIdentitySha256,
          );
          if (final.kind === "target-changed" || final.kind === "identity-changed") {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          if (final.kind === "observed") {
            return { kind: "settled" };
          }

          if (
            final.last?.state === "pairing-only" &&
            (warmupResult === "exec-failed" || warmupResult === "exec-timeout")
          ) {
            return { kind: "incomplete", reason: "scope-warmup-failed" };
          }
          if (final.last?.state === "pairing-only") {
            return { kind: "incomplete", reason: "scope-upgrade-not-requested" };
          }

          const watcher = deps.readWatcherStatus(name, target.gatewayName);
          if (watcher && (!watcher.watcherActive || watcher.state === "stopped")) {
            return { kind: "incomplete", reason: "scope-upgrade-watcher-unavailable" };
          }
          if (watcher?.state === "request-rejected") {
            return { kind: "incomplete", reason: "scope-upgrade-rejected" };
          }
          if (watcher?.state === "approval-timeout") {
            return { kind: "incomplete", reason: "scope-upgrade-approval-timeout" };
          }
          if (watcher?.state === "approval-failed") {
            return { kind: "incomplete", reason: "scope-upgrade-approval-failed" };
          }
          return { kind: "incomplete", reason: "scope-upgrade-not-approved" };
        });
      } catch (error) {
        if (gatewayBodyEntered) throw error;
        return { kind: "incomplete", reason: "pairing-lock-unavailable" };
      }
    });
  } catch (error) {
    if (sandboxBodyEntered) throw error;
    return { kind: "incomplete", reason: "pairing-lock-unavailable" };
  }
}

export function ordinaryOpenClawPairingIncompleteMessage(
  name: string,
  reason: OrdinaryOpenClawPairingIncompleteReason,
): string {
  const cause = ORDINARY_OPENCLAW_PAIRING_INCOMPLETE_CAUSES[reason];
  return `OpenClaw onboarding for '${name}' is incomplete because ${cause}. Resume or rerun onboarding.`;
}

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
  settleOrdinaryOpenClawPairing(name: string): Promise<OrdinaryOpenClawPairingSettlementResult> {
    return settleOrdinaryOpenClawPairing(name, defaultPairingSettlementDeps());
  },
  ordinaryOpenClawPairingIncompleteMessage,
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
