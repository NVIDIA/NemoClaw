// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import type { ConfigObject } from "../security/credential-filter";
import type { ShieldsAuditEntry } from "../shields/audit";
import { type InferenceApi, readOpenClawPrimaryRouteApi } from "./inference-route-api";
import { InferenceSetError } from "./inference-set-error";
import type { GatewayRestartResult } from "./sandbox/gateway-restart";

export interface InferenceGatewayRestartDeps {
  appendAuditEntry: (entry: ShieldsAuditEntry) => void;
  log: (message: string) => void;
  restartSandboxGateway: (sandboxName: string) => GatewayRestartResult;
}

interface InferenceResultForGateway {
  sandboxName: string;
  provider: string;
  model: string;
  primaryModelRef: string;
  inSandboxConfigSynced: boolean;
}

export interface InferenceMutation<T extends InferenceResultForGateway> {
  result: T;
  openClawGatewayRestartRequired: boolean;
}

// SOURCE_OF_TRUTH_REVIEW (cross-family OpenClaw restart; gateway regression
// #4504, OpenClaw 2026.6.10 adopted in #5595): that version hot-reloads model
// identity but retains request shaping when the API family changes. NemoClaw
// therefore restarts only after the route, config, and integrity hash commit,
// and outside the config transition lock. Unit coverage proves restart,
// no-restart, redaction, audit-failure, and post-commit recovery behavior;
// openclaw-inference-switch live coverage proves gateway health and forwarding.
// Remove this coordination when the minimum supported OpenClaw hot-reloads
// request shaping across API-family changes, keeping the tests until then.

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
  entry: ShieldsAuditEntry,
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
    previousApi: InferenceApi | null;
    result: T;
  },
  deps: Pick<InferenceGatewayRestartDeps, "appendAuditEntry" | "log">,
): InferenceMutation<T> {
  const { agentName, configChanged, nextApi, previousApi, result } = options;
  const openClawGatewayRestartRequired =
    agentName === "openclaw" &&
    configChanged &&
    result.inSandboxConfigSynced &&
    previousApi !== null &&
    previousApi !== nextApi;

  const auditEntry: ShieldsAuditEntry = {
    action: "inference_set",
    sandbox: result.sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set ${agentName}:${result.provider}:${result.model}${
      !result.inSandboxConfigSynced
        ? " (in-sandbox sync incomplete)"
        : openClawGatewayRestartRequired
          ? " (gateway restart pending)"
          : ""
    }`,
  };
  if (openClawGatewayRestartRequired) {
    appendPostCommitInferenceAudit(deps, auditEntry);
  } else {
    deps.appendAuditEntry(auditEntry);
  }

  if (result.inSandboxConfigSynced && !openClawGatewayRestartRequired) {
    deps.log(
      agentName === "hermes"
        ? `  Inference route synced for '${result.sandboxName}': ${result.model}`
        : `  Inference route synced for '${result.sandboxName}': ${result.primaryModelRef}`,
    );
  }

  return { result, openClawGatewayRestartRequired };
}

export function completeInferenceGatewayRestart<T extends InferenceResultForGateway>(
  mutation: InferenceMutation<T>,
  deps: InferenceGatewayRestartDeps,
): void {
  if (!mutation.openClawGatewayRestartRequired) return;

  const { result } = mutation;
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
  appendPostCommitInferenceAudit(deps, {
    action: "inference_set",
    sandbox: result.sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set openclaw:${result.provider}:${result.model} (gateway restart completed)`,
  });
  deps.log(`  Inference route synced for '${result.sandboxName}': ${result.primaryModelRef}`);
}
