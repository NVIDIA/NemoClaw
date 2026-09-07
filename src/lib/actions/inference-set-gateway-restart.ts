// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import type { ConfigObject } from "../security/credential-filter";
import type { OperationalAuditEntry } from "../state/audit/operational";
import { type InferenceApi, readOpenClawPrimaryRouteApi } from "./inference-route-api";
import { InferenceSetError } from "./inference-set-error";
import {
  runPortableOpenClawPairingApproval,
  runPortableOpenClawPairingRequestProducer,
  type PortableOpenClawPairingApprovalReceipt,
} from "./sandbox/auto-pair-approval";
import type { GatewayRestartResult } from "./sandbox/gateway-restart";
import {
  observeOpenClawPairingSettlement,
  type OpenClawPairingSettlementObservation,
} from "./sandbox/launch-readiness/openclaw-pairing-qualification";

export type InferenceSetOpenClawPairingTarget = {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly openclawVersion: string;
  readonly stateDirectory: string;
};

export type InferenceSetOpenClawPairingFailureLayer =
  | "initial-state-unavailable"
  | "final-state-unavailable"
  | "final-state-unsettled"
  | "pairing-operation-failed"
  | "pairing-target-unavailable"
  | `approval-${Exclude<PortableOpenClawPairingApprovalReceipt, "approved">}`;

export type InferenceSetOpenClawPairingResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failureLayer: InferenceSetOpenClawPairingFailureLayer;
    };

export type InferenceSetOpenClawPairingDeps = {
  observePairing: (
    target: InferenceSetOpenClawPairingTarget,
  ) => OpenClawPairingSettlementObservation;
  publishScopeRequest: (target: InferenceSetOpenClawPairingTarget) => void;
  approveScopeRequest: (
    target: InferenceSetOpenClawPairingTarget,
    deviceIdentitySha256: string,
  ) => PortableOpenClawPairingApprovalReceipt;
};

const defaultOpenClawPairingDeps: InferenceSetOpenClawPairingDeps = {
  observePairing: (target) =>
    observeOpenClawPairingSettlement(
      target.sandboxName,
      target.gatewayName,
      target.openclawVersion,
      target.stateDirectory,
    ),
  publishScopeRequest: (target) =>
    runPortableOpenClawPairingRequestProducer(target.sandboxName, target.gatewayName),
  approveScopeRequest: (target, deviceIdentitySha256) =>
    runPortableOpenClawPairingApproval(
      target.sandboxName,
      target.gatewayName,
      deviceIdentitySha256,
    ),
};

/**
 * Reconcile the local OpenClaw CLI device after an inference route change.
 *
 * The state observer accepts only the exact operator pairing/read/write projection.
 * The request producer runs only for a pairing-only device. The approval helper then
 * binds one allowlisted request to the observed device identity. A final state read,
 * not command output, decides whether the inference switch can report success.
 */
export function settleInferenceSetOpenClawPairing(
  target: InferenceSetOpenClawPairingTarget,
  deps: InferenceSetOpenClawPairingDeps = defaultOpenClawPairingDeps,
): InferenceSetOpenClawPairingResult {
  let initial: OpenClawPairingSettlementObservation;
  try {
    initial = deps.observePairing(target);
  } catch {
    return { ok: false, failureLayer: "initial-state-unavailable" };
  }
  if (initial.state === "settled") return { ok: true };

  let approval: PortableOpenClawPairingApprovalReceipt;
  try {
    deps.publishScopeRequest(target);
    approval = deps.approveScopeRequest(target, initial.deviceIdentitySha256);
  } catch {
    return { ok: false, failureLayer: "pairing-operation-failed" };
  }

  let final: OpenClawPairingSettlementObservation;
  try {
    final = deps.observePairing(target);
  } catch {
    return { ok: false, failureLayer: "final-state-unavailable" };
  }
  if (final.state === "settled") return { ok: true };
  return {
    ok: false,
    failureLayer: approval === "approved" ? "final-state-unsettled" : `approval-${approval}`,
  };
}

export interface InferenceGatewayRestartDeps {
  appendAuditEntry: (entry: OperationalAuditEntry) => void;
  log: (message: string) => void;
  restartSandboxGateway: (sandboxName: string) => GatewayRestartResult;
  settleOpenClawPairing: (
    target: InferenceSetOpenClawPairingTarget,
  ) => InferenceSetOpenClawPairingResult;
}

interface InferenceResultForGateway {
  sandboxName: string;
  provider: string;
  model: string;
  primaryModelRef: string;
  inSandboxConfigSynced: boolean;
  /**
   * Hermes only: whether the isolated Web Dashboard profile converged onto the
   * switched model (#6893). `undefined` for agents/switches with no Dashboard to
   * converge (treated as converged). When explicitly `false` the "Inference route
   * synced" line is withheld and the caller raises a post-commit failure so the
   * command cannot claim a route it did not fully apply.
   */
  dashboardConverged?: boolean;
}

export interface InferenceMutation<T extends InferenceResultForGateway> {
  result: T;
  openClawGatewayRestartRequired: boolean;
  openClawPairing:
    | { readonly state: "not-required" }
    | {
        readonly state: "required";
        readonly target: InferenceSetOpenClawPairingTarget;
      }
    | { readonly state: "target-unavailable" };
}

// SOURCE_OF_TRUTH_REVIEW (OpenClaw post-switch convergence; gateway regressions
// #4504 and #9527): OpenClaw 2026.6.10 adopted in #5595 hot-reloads model
// identity but retains request shaping when the API family changes. NemoClaw
// restarts only after the route, config, and integrity hash commit. Every
// changed OpenClaw route then requires exact local device-scope convergence
// before the command reports success. Both operations run outside the config
// transition lock and inside the sandbox lifecycle lock. Unit coverage proves
// restart, no-restart, scope convergence, redaction, audit-failure, and
// post-commit recovery behavior. The openclaw-inference-switch live target
// proves gateway health and forwarding. Remove the restart when the minimum
// supported OpenClaw hot-reloads request shaping across API-family changes.
// Remove pairing settlement when OpenClaw no longer requires a separate
// allowlisted device-scope upgrade after a route change.

export function defaultInferenceGatewayRestart(sandboxName: string): GatewayRestartResult {
  const recovery: typeof import("./sandbox/process-recovery") = require("./sandbox/process-recovery");
  return recovery.restartSandboxGateway(sandboxName, { quiet: true });
}

export function readPreviousOpenClawInferenceApi(
  agentName: string,
  config: ConfigObject,
): InferenceApi | null {
  return agentName === "openclaw" ? readOpenClawPrimaryRouteApi(config) : null;
}

function appendPostCommitInferenceAudit(
  deps: Pick<InferenceGatewayRestartDeps, "appendAuditEntry" | "log">,
  entry: OperationalAuditEntry,
): void {
  try {
    deps.appendAuditEntry(entry);
  } catch {
    // Config and possibly the running gateway are already committed. Audit
    // persistence is best-effort here so it cannot hide the real restart
    // outcome or the operator recovery command.
    deps.log(
      `  Warning: could not record the post-commit inference audit entry for '${entry.sandbox}'.`,
    );
  }
}

export function finalizeInferenceMutation<T extends InferenceResultForGateway>(
  options: {
    agentName: string;
    configChanged: boolean;
    nextApi: string;
    openClawPairingTarget?: InferenceSetOpenClawPairingTarget;
    previousApi: InferenceApi | null;
    result: T;
  },
  deps: Pick<InferenceGatewayRestartDeps, "appendAuditEntry" | "log">,
): InferenceMutation<T> {
  const { agentName, configChanged, nextApi, openClawPairingTarget, previousApi, result } = options;
  const openClawGatewayRestartRequired =
    agentName === "openclaw" &&
    configChanged &&
    result.inSandboxConfigSynced &&
    previousApi !== null &&
    previousApi !== nextApi;
  const openClawPairingConvergenceRequired =
    agentName === "openclaw" && configChanged && result.inSandboxConfigSynced;

  const auditEntry: OperationalAuditEntry = {
    action: "inference_set",
    sandbox: result.sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set ${agentName}:${result.provider}:${result.model}${
      !result.inSandboxConfigSynced
        ? " (in-sandbox sync incomplete)"
        : openClawGatewayRestartRequired
          ? " (gateway restart and pairing convergence pending)"
          : openClawPairingConvergenceRequired
            ? " (pairing convergence pending)"
            : ""
    }`,
  };
  if (openClawGatewayRestartRequired || openClawPairingConvergenceRequired) {
    appendPostCommitInferenceAudit(deps, auditEntry);
  } else {
    deps.appendAuditEntry(auditEntry);
  }

  // A Hermes switch whose Web Dashboard profile did not converge is not fully
  // applied, so withhold the success line (the caller already warned) (#6893).
  const hermesDashboardStale = agentName === "hermes" && result.dashboardConverged === false;
  if (
    result.inSandboxConfigSynced &&
    !openClawGatewayRestartRequired &&
    !openClawPairingConvergenceRequired &&
    !hermesDashboardStale
  ) {
    deps.log(
      agentName === "hermes"
        ? `  Inference route synced for '${result.sandboxName}': ${result.model}`
        : `  Inference route synced for '${result.sandboxName}': ${result.primaryModelRef}`,
    );
  }

  return {
    result,
    openClawGatewayRestartRequired,
    openClawPairing: !openClawPairingConvergenceRequired
      ? { state: "not-required" }
      : openClawPairingTarget
        ? { state: "required", target: openClawPairingTarget }
        : { state: "target-unavailable" },
  };
}

export function completeInferencePostCommit<T extends InferenceResultForGateway>(
  mutation: InferenceMutation<T>,
  deps: InferenceGatewayRestartDeps,
): void {
  const { result } = mutation;
  if (mutation.openClawGatewayRestartRequired) {
    deps.log(
      `  Restarting the OpenClaw gateway in '${result.sandboxName}' to apply the new inference API family...`,
    );
    let restartFailure: string | null = null;
    try {
      const restart = deps.restartSandboxGateway(result.sandboxName);
      if (!restart.ok) restartFailure = restart.failureLayer;
    } catch {
      restartFailure = "restart exception";
    }
    if (restartFailure) {
      appendPostCommitInferenceAudit(deps, {
        action: "inference_set",
        sandbox: result.sandboxName,
        timestamp: new Date().toISOString(),
        reason: `inference set openclaw:${result.provider}:${result.model} (config committed; gateway restart failed: ${restartFailure})`,
      });
      throw new InferenceSetError(
        `Inference route and config were updated for '${result.sandboxName}', but the managed OpenClaw gateway restart/recovery did not complete successfully. ` +
          `The committed route was not rolled back. Retry with '${CLI_NAME} ${result.sandboxName} gateway restart'.`,
      );
    }
  }
  const pairingMutation = mutation.openClawPairing;
  if (pairingMutation.state === "not-required") return;
  let pairing: InferenceSetOpenClawPairingResult;
  if (pairingMutation.state === "target-unavailable") {
    pairing = { ok: false, failureLayer: "pairing-target-unavailable" };
  } else {
    try {
      pairing = deps.settleOpenClawPairing(pairingMutation.target);
    } catch {
      pairing = { ok: false, failureLayer: "pairing-operation-failed" };
    }
  }
  if (!pairing.ok) {
    appendPostCommitInferenceAudit(deps, {
      action: "inference_set",
      sandbox: result.sandboxName,
      timestamp: new Date().toISOString(),
      reason: `inference set openclaw:${result.provider}:${result.model} (config committed; ${
        mutation.openClawGatewayRestartRequired ? "gateway restart completed; " : ""
      }pairing convergence failed: ${pairing.failureLayer})`,
    });
    throw new InferenceSetError(
      `Inference route and config were updated for '${result.sandboxName}', but OpenClaw gateway pairing did not converge (${pairing.failureLayer}). ` +
        `The committed route was not rolled back. Run '${CLI_NAME} ${result.sandboxName} doctor --fix', then retry the agent turn.`,
    );
  }
  appendPostCommitInferenceAudit(deps, {
    action: "inference_set",
    sandbox: result.sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set openclaw:${result.provider}:${result.model} (${
      mutation.openClawGatewayRestartRequired ? "gateway restart and " : ""
    }pairing convergence completed)`,
  });
  deps.log(`  Inference route synced for '${result.sandboxName}': ${result.primaryModelRef}`);
}
