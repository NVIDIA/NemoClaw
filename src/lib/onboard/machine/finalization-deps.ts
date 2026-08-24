// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OPENCLAW_PAIRING_OBSERVATION_TIMEOUT_MS,
  type OpenClawPairingSettlementObservation,
} from "../../actions/sandbox/launch-readiness/openclaw-pairing-qualification";
import type { OpenClawPairingSettlementTarget } from "../../actions/sandbox/launch-readiness";
import { WARMUP_TIMEOUT_MS } from "../../actions/sandbox/auto-pair-warmup";
import { CONNECT_AUTO_PAIR_TIMEOUT_MS } from "../../actions/sandbox/connect-autopair-budget";

// The lazy `require` calls avoid an import cycle because connect.ts and
// process-recovery.ts both import onboarding helpers.
type ProcessRecoveryDeps = Pick<
  typeof import("../../actions/sandbox/process-recovery"),
  "checkAndRecoverSandboxProcesses" | "waitForRecreatedSandboxOpenShellReady"
>;
type SandboxLifecycleLock = typeof import("../../state/mcp-lifecycle-lock").withMcpLifecycleLock;
type GatewayRouteLock =
  typeof import("../../inference/gateway-route-mutation-lock").withGatewayRouteMutationLock;

// A contended gateway list can consume the watcher's full 10-second child
// bound. Keep enough room for another complete observation window after the
// first three attempts instead of racing the watcher at 30 seconds (#9817).
export const OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS = 60_000;
export const OPENCLAW_ONBOARDING_PAIRING_POLL_MS = 1_000;
export const OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS = 30_000;
// Keep one outer cap while reserving each bounded child's fixed budget,
// including the settled/already-pending precheck. Pairing appearance retains
// its existing limit, and
// a capped warm-up can no longer consume the approval or final-read budget.
export const OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS =
  OPENCLAW_PAIRING_OBSERVATION_TIMEOUT_MS +
  OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS +
  WARMUP_TIMEOUT_MS +
  CONNECT_AUTO_PAIR_TIMEOUT_MS +
  OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS;

export type OrdinaryOpenClawPairingSettlementResult =
  | { readonly kind: "settled" }
  | {
      readonly kind: "incomplete";
      readonly reason:
        | "runtime-identity-invalid"
        | "pairing-lock-unavailable"
        | "pairing-unavailable"
        | "scope-upgrade-incomplete";
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
  "scope-upgrade-incomplete":
    "its canonical CLI device did not receive the required baseline scopes",
};

interface OrdinaryOpenClawPairingSettlementDeps {
  getTarget(name: string): OpenClawPairingSettlementTarget | null;
  observePairing(
    name: string,
    gatewayName: string,
    version: string,
    stateDirectory: string,
  ): OpenClawPairingSettlementObservation;
  runWarmup(name: string, gatewayName: string): Promise<void> | void;
  runApproval(name: string, gatewayName: string): Promise<void> | void;
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
  loadAutoPairApproval: () =>
    require("../../actions/sandbox/auto-pair-approval") as typeof import("../../actions/sandbox/auto-pair-approval"),
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
  | { readonly kind: "timeout" };

async function waitForPairingObservation(
  name: string,
  target: OpenClawPairingSettlementTarget,
  deadline: number,
  accept: (value: OpenClawPairingSettlementObservation) => boolean,
  deps: OrdinaryOpenClawPairingSettlementDeps,
): Promise<PairingWaitResult> {
  while (true) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { kind: "timeout" };
    if (!samePairingTarget(target, deps.getTarget(name))) return { kind: "target-changed" };
    try {
      const value = deps.observePairing(
        name,
        target.gatewayName,
        target.version,
        target.stateDirectory,
      );
      if (!samePairingTarget(target, deps.getTarget(name))) return { kind: "target-changed" };
      if (deadline - deps.now() <= 0) return { kind: "timeout" };
      if (accept(value)) return { kind: "observed", value };
    } catch {
      // Pairing state can be absent or changing while the startup watcher runs.
    }
    const remainingAfterAttempt = deadline - deps.now();
    if (remainingAfterAttempt <= 0) return { kind: "timeout" };
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
      finalizationHandlerRuntime
        .loadAutoPairWarmup()
        .runSandboxScopeWarmupRun(name, gatewayName),
    runApproval: (name, gatewayName) => {
      finalizationHandlerRuntime.loadAutoPairApproval().runSandboxAutoPairApprovalPass(name, {
        budget: {
          timeoutMs: CONNECT_AUTO_PAIR_TIMEOUT_MS,
          listTimeoutS: 5,
          approveTimeoutS: 8,
          maxApprovals: 1,
        },
        gatewayName,
        localDeviceOnly: true,
      });
    },
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
 * Observe canonical state, run one bounded request producer when needed, then
 * wait for its exact pending write upgrade before approving it once.
 * A final read verifies the exact device and no pending request for that device.
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
          const settlementDeadline = deps.now() + OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS;

          // Avoid creating another hidden warm-up session when re-onboarding an
          // already-settled device, and reuse an exact upgrade already pending.
          let initial: OpenClawPairingSettlementObservation | null = null;
          let sawCanonicalPairing = false;
          try {
            initial = deps.observePairing(
              name,
              target.gatewayName,
              target.version,
              target.stateDirectory,
            );
            sawCanonicalPairing = true;
          } catch {
            // Pairing may not have appeared yet; the producer handles that path.
          }
          if (!samePairingTarget(target, deps.getTarget(name))) {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          if (deps.now() >= settlementDeadline) {
            return { kind: "incomplete", reason: "pairing-unavailable" };
          }
          if (initial?.state === "settled") return { kind: "settled" };

          let baseline: PairingWaitResult;
          if (initial?.state === "scope-upgrade-pending") {
            baseline = { kind: "observed", value: initial };
          } else {
            // A valid non-interactive path can reach finalization before the
            // startup watcher publishes its first CLI request. Run the bounded
            // direct producer once, then require canonical evidence that its
            // exact write upgrade is pending before the approval pass (#10014).
            try {
              await deps.runWarmup(name, target.gatewayName);
            } catch {
              // The bounded observation below remains fail closed.
            }
            if (!samePairingTarget(target, deps.getTarget(name))) {
              return { kind: "incomplete", reason: "runtime-identity-invalid" };
            }
            const pairingAppearanceDeadline = Math.min(
              settlementDeadline,
              deps.now() + OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS,
            );
            baseline = await waitForPairingObservation(
              name,
              target,
              pairingAppearanceDeadline,
              (value) => {
                sawCanonicalPairing = true;
                return value.state !== "pairing-only";
              },
              deps,
            );
          }
          if (baseline.kind === "target-changed") {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          if (baseline.kind === "timeout") {
            return {
              kind: "incomplete",
              reason: sawCanonicalPairing ? "scope-upgrade-incomplete" : "pairing-unavailable",
            };
          }
          if (
            initial &&
            baseline.value.deviceIdentitySha256 !== initial.deviceIdentitySha256
          ) {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          if (baseline.value.state === "settled") return { kind: "settled" };
          if (!samePairingTarget(target, deps.getTarget(name))) {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          if (deps.now() >= settlementDeadline) {
            return { kind: "incomplete", reason: "scope-upgrade-incomplete" };
          }

          let approvalFailed = false;
          try {
            await deps.runApproval(name, target.gatewayName);
          } catch {
            approvalFailed = true;
          }
          if (!samePairingTarget(target, deps.getTarget(name))) {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          if (approvalFailed) {
            return { kind: "incomplete", reason: "scope-upgrade-incomplete" };
          }

          const finalObservationDeadline = Math.min(
            settlementDeadline,
            deps.now() + OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS,
          );
          const final = await waitForPairingObservation(
            name,
            target,
            finalObservationDeadline,
            (value) =>
              value.state === "settled" &&
              value.deviceIdentitySha256 === baseline.value.deviceIdentitySha256,
            deps,
          );
          if (final.kind === "target-changed") {
            return { kind: "incomplete", reason: "runtime-identity-invalid" };
          }
          return final.kind === "observed"
            ? { kind: "settled" }
            : { kind: "incomplete", reason: "scope-upgrade-incomplete" };
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
  settleOrdinaryOpenClawPairing,
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
    options: {
      readonly portableRequired: true;
    },
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
